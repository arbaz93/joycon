"""Socket.IO bridge that maps web controller input to Linux virtual gamepads.

This service accepts websocket events from the frontend and emits low-latency
input events via ``evdev.UInput``. Each connected client gets an isolated
virtual controller state so multiple players can connect at once.
"""

from __future__ import annotations

import atexit
import logging
import math
import os
import threading
import time
from collections import deque
from dataclasses import dataclass, field
from typing import Any

from evdev import UInput, ecodes as e
from flask import Flask, render_template, request
from flask_socketio import SocketIO

LOGGER = logging.getLogger("webcontroller.server")
logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO").upper(),
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)


def env_int(name: str, default: int) -> int:
    """Read an integer environment variable with fallback.

    Args:
        name: Environment variable key.
        default: Value used when key is missing or invalid.

    Returns:
        Parsed integer value or ``default``.

    Side Effects:
        Logs a warning when the value exists but cannot be parsed.
    """
    raw = os.getenv(name)
    if raw is None:
        return default
    try:
        return int(raw)
    except ValueError:
        LOGGER.warning("Invalid %s=%r; using default=%d", name, raw, default)
        return default


def env_float(name: str, default: float) -> float:
    """Read a float environment variable with fallback.

    Args:
        name: Environment variable key.
        default: Value used when key is missing or invalid.

    Returns:
        Parsed float value or ``default``.

    Side Effects:
        Logs a warning when the value exists but cannot be parsed.
    """
    raw = os.getenv(name)
    if raw is None:
        return default
    try:
        return float(raw)
    except ValueError:
        LOGGER.warning("Invalid %s=%r; using default=%s", name, raw, default)
        return default


def env_origins(name: str, default: str = "*") -> str | list[str]:
    """Parse CORS origin configuration from environment.

    Args:
        name: Environment variable key.
        default: Default value to use when unset.

    Returns:
        ``"*"``
            to allow all origins, or
        ``list[str]``
            of allowed origins when comma-separated values are provided.

    Side Effects:
        None.
    """
    raw = os.getenv(name, default).strip()
    if raw == "*":
        return raw
    origins = [origin.strip() for origin in raw.split(",") if origin.strip()]
    return origins or ["http://localhost:5000"]


APP = Flask(__name__)
SOCKETIO = SocketIO(APP, cors_allowed_origins=env_origins("CORS_ALLOWED_ORIGINS"), async_mode="threading")
# Backward-compatible aliases for existing imports/tests.
app = APP
socketio = SOCKETIO

MAX_PLAYERS = env_int("MAX_PLAYERS", 4)
EVENT_QUEUE_MAXLEN = env_int("QUEUE_MAXLEN", 512)
MAX_EVENTS_PER_TICK = env_int("MAX_EVENTS_PER_TICK", 256)
PROCESS_HZ = env_float("PROCESS_HZ", 120.0)
# FIXME: PROCESS_HZ <= 0 causes invalid timing math (division by zero).
PROCESS_DT = 1.0 / PROCESS_HZ
PAD_NAME = os.getenv("PAD_NAME", "Microsoft X-Box 360 pad")

STICK_MIN = -32768
STICK_MAX = 32767
TRIGGER_MIN = 0
TRIGGER_MAX = 255

STICK_DEADZONE = env_float("STICK_DEADZONE", 0.15)
TRIGGER_DEADZONE = env_float("TRIGGER_DEADZONE", 0.02)

STICK_SMOOTH_ALPHA = env_float("STICK_SMOOTH_ALPHA", 0.35)
TRIGGER_SMOOTH_ALPHA = env_float("TRIGGER_SMOOTH_ALPHA", 0.45)

STICK_MAX_STEP = env_int("STICK_MAX_STEP", 6000)
TRIGGER_MAX_STEP = env_int("TRIGGER_MAX_STEP", 48)

BUTTON_MAP = {
    "A": e.BTN_SOUTH,
    "B": e.BTN_EAST,
    "X": e.BTN_WEST,
    "Y": e.BTN_NORTH,
    "LB": e.BTN_TL,
    "RB": e.BTN_TR,
    "START": e.BTN_START,
    "SELECT": e.BTN_SELECT,
    "HOME": e.BTN_MODE,
    "L3": e.BTN_THUMBL,
    "R3": e.BTN_THUMBR,
}

STICK_CODES = {
    "left": (e.ABS_X, e.ABS_Y),
    "right": (e.ABS_RX, e.ABS_RY),
}

TRIGGER_CODES = {
    "LT": e.ABS_Z,
    "RT": e.ABS_RZ,
}

DPAD_BUTTON_CODES = {
    "UP": e.BTN_DPAD_UP,
    "DOWN": e.BTN_DPAD_DOWN,
    "LEFT": e.BTN_DPAD_LEFT,
    "RIGHT": e.BTN_DPAD_RIGHT,
}

STICK_ABS_CODES = (e.ABS_X, e.ABS_Y, e.ABS_RX, e.ABS_RY)
TRIGGER_ABS_CODES = (e.ABS_Z, e.ABS_RZ)
HAT_ABS_CODES = (e.ABS_HAT0X, e.ABS_HAT0Y)
ALL_ABS_CODES = (*STICK_ABS_CODES, *TRIGGER_ABS_CODES, *HAT_ABS_CODES)
ALL_BUTTON_CODES = tuple(dict.fromkeys([*BUTTON_MAP.values(), *DPAD_BUTTON_CODES.values()]))

def clamp(value: float, low: float, high: float) -> float:
    """Clamp a floating-point value to the given range.

    Args:
        value: Candidate value.
        low: Lower inclusive bound.
        high: Upper inclusive bound.

    Returns:
        Value clamped to ``[low, high]``.

    Side Effects:
        None.
    """
    return low if value < low else high if value > high else value


def clamp_int(value: int, low: int, high: int) -> int:
    """Clamp an integer value to the given range.

    Args:
        value: Candidate value.
        low: Lower inclusive bound.
        high: Upper inclusive bound.

    Returns:
        Value clamped to ``[low, high]``.

    Side Effects:
        None.
    """
    return low if value < low else high if value > high else value


def is_valid_number(value: Any) -> bool:
    """Validate a numeric payload value.

    Args:
        value: Untrusted input from websocket payload.

    Returns:
        ``True`` when value is finite ``int`` or ``float`` and not ``bool``.

    Side Effects:
        None.
    """
    if isinstance(value, bool):
        return False
    if not isinstance(value, (int, float)):
        return False
    return math.isfinite(float(value))


def safe_unit(value: Any) -> float | None:
    """Validate and clamp a normalized axis value.

    Args:
        value: Untrusted value expected in ``[-1.0, 1.0]``.

    Returns:
        Normalized float in ``[-1.0, 1.0]``, or ``None`` if invalid.

    Side Effects:
        None.
    """
    if not is_valid_number(value):
        return None
    return float(clamp(float(value), -1.0, 1.0))


def safe_trigger_unit(value: Any) -> float | None:
    """Validate and clamp a normalized trigger value.

    Args:
        value: Untrusted value expected in ``[0.0, 1.0]``.

    Returns:
        Normalized float in ``[0.0, 1.0]``, or ``None`` if invalid.

    Side Effects:
        None.
    """
    if not is_valid_number(value):
        return None
    return float(clamp(float(value), 0.0, 1.0))


def unit_to_stick_axis(value: float) -> int:
    """Convert normalized stick value to signed ABS axis units.

    Args:
        value: Normalized axis value in ``[-1.0, 1.0]``.

    Returns:
        Integer axis value in ``[STICK_MIN, STICK_MAX]``.

    Side Effects:
        None.
    """
    v = clamp(value, -1.0, 1.0)
    if v >= 0.0:
        out = int(round(v * STICK_MAX))
    else:
        out = int(round(v * (-STICK_MIN)))
    return clamp_int(out, STICK_MIN, STICK_MAX)


def unit_to_trigger_axis(value: float) -> int:
    """Convert normalized trigger value to ABS trigger units.

    Args:
        value: Normalized trigger value in ``[0.0, 1.0]``.

    Returns:
        Integer trigger value in ``[TRIGGER_MIN, TRIGGER_MAX]``.

    Side Effects:
        None.
    """
    v = clamp(value, 0.0, 1.0)
    out = int(round(v * TRIGGER_MAX))
    return clamp_int(out, TRIGGER_MIN, TRIGGER_MAX)


def radial_deadzone(x: float, y: float, deadzone: float) -> tuple[float, float]:
    """Apply radial deadzone and preserve directional intent.

    Args:
        x: Normalized X axis.
        y: Normalized Y axis.
        deadzone: Deadzone radius in normalized coordinates.

    Returns:
        Tuple of normalized ``(x, y)`` after deadzone processing.

    Side Effects:
        None.
    """
    dz = clamp(deadzone, 0.0, 0.95)
    mag = math.hypot(x, y)
    if mag <= dz:
        return 0.0, 0.0
    if mag > 1.0:
        x /= mag
        y /= mag
        mag = 1.0
    scale = (mag - dz) / (1.0 - dz)
    inv_mag = 1.0 / mag
    return x * inv_mag * scale, y * inv_mag * scale


def quantize_hat(value: Any) -> int | None:
    """Quantize hat/dpad scalar values.

    Args:
        value: Untrusted numeric payload.

    Returns:
        ``-1``, ``0``, or ``1`` when valid, otherwise ``None``.

    Side Effects:
        None.
    """
    if not is_valid_number(value):
        return None
    v = clamp(float(value), -1.0, 1.0)
    if v >= 0.5:
        return 1
    if v <= -0.5:
        return -1
    return 0


def smooth_step(current: int, target: int, alpha: float, max_step: int) -> int:
    """Interpolate axis output toward target with step limiting.

    Args:
        current: Current emitted axis value.
        target: Desired axis value.
        alpha: Interpolation factor in ``[0.0, 1.0]``.
        max_step: Maximum absolute delta per tick.

    Returns:
        Smoothed next axis value.

    Side Effects:
        None.
    """
    a = clamp(alpha, 0.0, 1.0)
    filtered = current + (target - current) * a
    stepped = int(round(filtered))
    delta = clamp_int(stepped - current, -max_step, max_step)
    return current + delta


def safe_button_state(value: Any) -> int | None:
    """Normalize button state payload.

    Args:
        value: Untrusted button state (bool or integer).

    Returns:
        ``0`` or ``1`` for valid values, otherwise ``None``.

    Side Effects:
        None.
    """
    if isinstance(value, bool):
        return 1 if value else 0
    if not isinstance(value, int):
        return None
    if value not in (0, 1):
        return None
    return value


def create_gamepad(player_id: int) -> UInput:
    """Create and configure one virtual gamepad device.

    Args:
        player_id: 1-based player slot id.

    Returns:
        Configured ``evdev.UInput`` device handle.

    Side Effects:
        Creates a kernel-visible virtual input device.
    """
    capabilities = {
        e.EV_KEY: list(ALL_BUTTON_CODES),
        # Some SDL/ES stacks check for MSC_SCAN and behave better when present.
        e.EV_MSC: [e.MSC_SCAN],
        # Use plain tuples for broad compatibility (notably evdev-binary on Batocera).
        # Format: (code, (value, min, max, fuzz, flat, resolution)).
        e.EV_ABS: [
            (e.ABS_X, (0, STICK_MIN, STICK_MAX, 0, 0, 0)),
            (e.ABS_Y, (0, STICK_MIN, STICK_MAX, 0, 0, 0)),
            (e.ABS_RX, (0, STICK_MIN, STICK_MAX, 0, 0, 0)),
            (e.ABS_RY, (0, STICK_MIN, STICK_MAX, 0, 0, 0)),
            (e.ABS_Z, (0, TRIGGER_MIN, TRIGGER_MAX, 0, 0, 0)),
            (e.ABS_RZ, (0, TRIGGER_MIN, TRIGGER_MAX, 0, 0, 0)),
            (e.ABS_HAT0X, (0, -1, 1, 0, 0, 0)),
            (e.ABS_HAT0Y, (0, -1, 1, 0, 0, 0)),
        ],
    }
    return UInput(
        capabilities,
        name=PAD_NAME,
        vendor=0x045E,
        product=0x028E,
        version=0x0110,
        bustype=0x03,
        phys=f"usb-webcontroller/player{player_id}",
    )


@dataclass
class ClientState:
    """Runtime state for one connected controller client.

    Attributes:
        sid: Socket.IO session id.
        ui: UInput handle bound to this client.
        queue: Pending raw socket events.
        lock: Queue lock for producer/consumer synchronization.
        target_abs: Desired ABS state after event processing.
        output_abs: Last emitted ABS state.
        target_btn: Desired button state after event processing.
        output_btn: Last emitted button state.
    """

    sid: str
    ui: UInput
    queue: deque[tuple[str, dict[str, Any]]] = field(default_factory=lambda: deque(maxlen=EVENT_QUEUE_MAXLEN))
    lock: threading.Lock = field(default_factory=threading.Lock)
    target_abs: dict[int, int] = field(default_factory=lambda: {code: 0 for code in ALL_ABS_CODES})
    output_abs: dict[int, int] = field(default_factory=lambda: {code: 0 for code in ALL_ABS_CODES})
    target_btn: dict[int, int] = field(default_factory=lambda: {code: 0 for code in ALL_BUTTON_CODES})
    output_btn: dict[int, int] = field(default_factory=lambda: {code: 0 for code in ALL_BUTTON_CODES})

    def enqueue(self, event_type: str, payload: dict[str, Any]) -> None:
        """Append one event into the client's bounded queue.

        Args:
            event_type: Logical event channel (button/joystick/trigger/dpad).
            payload: Event payload dictionary from Socket.IO.

        Returns:
            None.

        Side Effects:
            Mutates the internal queue under lock.
        """
        with self.lock:
            self.queue.append((event_type, payload))

    def drain(self) -> list[tuple[str, dict[str, Any]]]:
        """Pop a bounded event batch from the queue.

        Returns:
            List of ``(event_type, payload)`` tuples to process this tick.

        Side Effects:
            Mutates queue and may drop old backlog under high load.
        """
        with self.lock:
            count = min(len(self.queue), MAX_EVENTS_PER_TICK)
            drained = [self.queue.popleft() for _ in range(count)]
            if self.queue:
                # Keep only newest events under high load.
                while len(self.queue) > EVENT_QUEUE_MAXLEN // 2:
                    self.queue.popleft()
            return drained


clients: dict[str, ClientState] = {}
clients_lock = threading.Lock()


@APP.route("/")
def index() -> str:
    """Render the initial controller shell page.

    Returns:
        HTML response generated from ``templates/index.html``.

    Side Effects:
        None.
    """
    return render_template("index.html")


def get_client(sid: str) -> ClientState | None:
    """Lookup connected client state by session id.

    Args:
        sid: Socket.IO session id.

    Returns:
        Matching ``ClientState`` when present, else ``None``.

    Side Effects:
        None.
    """
    with clients_lock:
        return clients.get(sid)


def add_client(sid: str) -> bool:
    """Register a new websocket client and virtual gamepad.

    Args:
        sid: Socket.IO session id.

    Returns:
        ``True`` on success, ``False`` if max players reached.

    Side Effects:
        Creates and stores a new ``UInput`` device.
        Emits INFO logs for accepted/rejected connections.
    """
    with clients_lock:
        if len(clients) >= MAX_PLAYERS:
            LOGGER.info("Rejected connection %s: max players reached (%d)", sid, MAX_PLAYERS)
            return False
        player_id = len(clients) + 1
        ui = create_gamepad(player_id)
        clients[sid] = ClientState(sid=sid, ui=ui)
        LOGGER.info("Player %d connected (sid=%s)", player_id, sid)
        return True


def remove_client(sid: str) -> None:
    """Remove client state and release UInput resources.

    Args:
        sid: Socket.IO session id.

    Returns:
        None.

    Side Effects:
        Closes the kernel virtual input device handle.
        Emits INFO/ERROR logs.
    """
    with clients_lock:
        state = clients.pop(sid, None)
    if state is None:
        return
    try:
        state.ui.close()
    except Exception:
        LOGGER.exception("Failed to close virtual gamepad for sid=%s", sid)
    else:
        LOGGER.info("Client disconnected (sid=%s)", sid)


@SOCKETIO.on("connect")
def on_connect(auth: Any = None) -> bool | None:
    """Socket.IO connect hook.

    Args:
        auth: Optional handshake payload (unused).

    Returns:
        ``False`` to reject connection, ``None`` to accept.

    Side Effects:
        Allocates per-client state/UInput device on success.
    """
    # TODO: Add optional authentication/token gating for untrusted networks.
    sid = request.sid
    if not add_client(sid):
        return False
    return None


@SOCKETIO.on("disconnect")
def on_disconnect() -> None:
    """Socket.IO disconnect hook.

    Returns:
        None.

    Side Effects:
        Removes client state and closes UInput device.
    """
    remove_client(request.sid)


def enqueue_event(event_type: str, data: Any) -> None:
    """Validate and enqueue a Socket.IO event for later processing.

    Args:
        event_type: Logical event channel name.
        data: Raw event payload from client.

    Returns:
        None.

    Side Effects:
        Mutates target client's queue when payload is valid.
    """
    sid = request.sid
    state = get_client(sid)
    if state is None:
        return
    if not isinstance(data, dict):
        return
    state.enqueue(event_type, data)


@SOCKETIO.on("button")
def on_button(data: Any) -> None:
    enqueue_event("button", data)


@SOCKETIO.on("joystick")
def on_joystick(data: Any) -> None:
    enqueue_event("joystick", data)


@SOCKETIO.on("trigger")
def on_trigger(data: Any) -> None:
    enqueue_event("trigger", data)


@SOCKETIO.on("dpad")
def on_dpad(data: Any) -> None:
    enqueue_event("dpad", data)


def apply_event(state: ClientState, event_type: str, data: dict[str, Any]) -> None:
    """Apply one logical input event to target controller state.

    Args:
        state: Target client runtime state.
        event_type: Event channel name.
        data: Parsed payload for this event.

    Returns:
        None.

    Side Effects:
        Mutates ``state.target_abs`` and/or ``state.target_btn``.
    """
    if event_type == "joystick":
        stick = data.get("stick")
        if stick not in STICK_CODES:
            return
        x = safe_unit(data.get("x"))
        y = safe_unit(data.get("y"))
        if x is None or y is None:
            return
        x, y = radial_deadzone(x, y, STICK_DEADZONE)
        code_x, code_y = STICK_CODES[stick]
        state.target_abs[code_x] = unit_to_stick_axis(x)
        state.target_abs[code_y] = unit_to_stick_axis(y)
        return

    if event_type == "trigger":
        trig = data.get("trigger")
        if trig not in TRIGGER_CODES:
            return
        v = safe_trigger_unit(data.get("value"))
        if v is None:
            return
        if v < TRIGGER_DEADZONE:
            v = 0.0
        state.target_abs[TRIGGER_CODES[trig]] = unit_to_trigger_axis(v)
        return

    if event_type == "button":
        btn = data.get("button")
        if btn not in BUTTON_MAP:
            return
        state_val = safe_button_state(data.get("state"))
        if state_val is None:
            return
        state.target_btn[BUTTON_MAP[btn]] = state_val
        return

    if event_type == "dpad":
        x = quantize_hat(data.get("x"))
        y = quantize_hat(data.get("y"))
        if x is None or y is None:
            return
        state.target_abs[e.ABS_HAT0X] = x
        state.target_abs[e.ABS_HAT0Y] = y
        state.target_btn[DPAD_BUTTON_CODES["LEFT"]] = 1 if x < 0 else 0
        state.target_btn[DPAD_BUTTON_CODES["RIGHT"]] = 1 if x > 0 else 0
        state.target_btn[DPAD_BUTTON_CODES["UP"]] = 1 if y < 0 else 0
        state.target_btn[DPAD_BUTTON_CODES["DOWN"]] = 1 if y > 0 else 0


def emit_abs_if_changed(state: ClientState, code: int, new_value: int, writes: list[tuple[int, int, int]]) -> None:
    """Queue ABS write only when value differs from previous output.

    Args:
        state: Client runtime state.
        code: ABS axis code.
        new_value: Candidate new axis value.
        writes: Accumulator for pending evdev writes.

    Returns:
        None.

    Side Effects:
        Mutates ``state.output_abs`` and appends to ``writes``.
    """
    if code in STICK_ABS_CODES:
        new_value = clamp_int(new_value, STICK_MIN, STICK_MAX)
    elif code in TRIGGER_ABS_CODES:
        new_value = clamp_int(new_value, TRIGGER_MIN, TRIGGER_MAX)
    elif code in HAT_ABS_CODES:
        new_value = clamp_int(new_value, -1, 1)
    else:
        return

    if state.output_abs[code] == new_value:
        return
    state.output_abs[code] = new_value
    writes.append((e.EV_ABS, code, new_value))


def build_writes(state: ClientState) -> list[tuple[int, int, int]]:
    """Build minimal evdev write set for current tick.

    Args:
        state: Client runtime state.

    Returns:
        List of ``(event_type, code, value)`` tuples for ``UInput.write``.

    Side Effects:
        Mutates cached output state fields in ``state``.
    """
    writes: list[tuple[int, int, int]] = []

    for code in STICK_ABS_CODES:
        cur = state.output_abs[code]
        tgt = clamp_int(state.target_abs[code], STICK_MIN, STICK_MAX)
        nxt = smooth_step(cur, tgt, STICK_SMOOTH_ALPHA, STICK_MAX_STEP)
        if abs(nxt) <= 6 and tgt == 0:
            nxt = 0
        emit_abs_if_changed(state, code, nxt, writes)

    for code in TRIGGER_ABS_CODES:
        cur = state.output_abs[code]
        tgt = clamp_int(state.target_abs[code], TRIGGER_MIN, TRIGGER_MAX)
        nxt = smooth_step(cur, tgt, TRIGGER_SMOOTH_ALPHA, TRIGGER_MAX_STEP)
        if nxt <= 1 and tgt == 0:
            nxt = 0
        emit_abs_if_changed(state, code, nxt, writes)

    for code in HAT_ABS_CODES:
        emit_abs_if_changed(state, code, state.target_abs[code], writes)

    for code, tgt in state.target_btn.items():
        safe_tgt = 1 if tgt else 0
        if state.output_btn[code] == safe_tgt:
            continue
        state.output_btn[code] = safe_tgt
        writes.append((e.EV_KEY, code, safe_tgt))

    return writes


def processing_loop() -> None:
    """Run the input processing worker loop.

    Returns:
        None.

    Side Effects:
        Continuously reads client queues, writes to UInput devices, sleeps per
        configured tick interval, and disconnects clients on write failures.
    """
    while True:
        loop_start = time.monotonic()

        with clients_lock:
            client_items = list(clients.items())

        for sid, state in client_items:
            events = state.drain()
            for event_type, data in events:
                apply_event(state, event_type, data)

            writes = build_writes(state)
            if not writes:
                continue

            try:
                for ev_type, code, value in writes:
                    state.ui.write(ev_type, code, value)
                # Exactly one SYN_REPORT for this update cycle.
                state.ui.syn()
            except Exception:
                LOGGER.exception("UInput write failed for sid=%s; closing client", sid)
                remove_client(sid)

        elapsed = time.monotonic() - loop_start
        sleep_time = PROCESS_DT - elapsed
        if sleep_time > 0:
            time.sleep(sleep_time)


def close_all_clients() -> None:
    """Close all active clients during process shutdown.

    Returns:
        None.

    Side Effects:
        Closes each connected client's UInput device.
    """
    with clients_lock:
        client_ids = list(clients.keys())
    for sid in client_ids:
        remove_client(sid)


atexit.register(close_all_clients)

worker_thread = threading.Thread(target=processing_loop, name="input-processing-loop", daemon=True)
worker_thread.start()


if __name__ == "__main__":
    host = os.getenv("HOST", "0.0.0.0")
    port = env_int("PORT", 5000)
    LOGGER.info("Starting webcontroller server on %s:%d", host, port)
    SOCKETIO.run(APP, host=host, port=port, allow_unsafe_werkzeug=True)
