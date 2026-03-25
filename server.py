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
    """Read an integer environment variable with safe fallback."""
    raw = os.getenv(name)
    if raw is None:
        return default
    try:
        return int(raw)
    except ValueError:
        LOGGER.warning("Invalid %s=%r; using default=%d", name, raw, default)
        return default


def env_float(name: str, default: float) -> float:
    """Read a float environment variable with safe fallback."""
    raw = os.getenv(name)
    if raw is None:
        return default
    try:
        return float(raw)
    except ValueError:
        LOGGER.warning("Invalid %s=%r; using default=%s", name, raw, default)
        return default


def env_origins(name: str, default: str = "*") -> str | list[str]:
    """Parse comma-separated CORS origins; ``*`` stays wildcard."""
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
    """Clamp ``value`` into [low, high]."""
    return low if value < low else high if value > high else value


def clamp_int(value: int, low: int, high: int) -> int:
    """Clamp integer ``value`` into [low, high]."""
    return low if value < low else high if value > high else value


def is_valid_number(value: Any) -> bool:
    """True for finite int/float values (bool excluded)."""
    if isinstance(value, bool):
        return False
    if not isinstance(value, (int, float)):
        return False
    return math.isfinite(float(value))


def safe_unit(value: Any) -> float | None:
    """Normalize untrusted value into [-1.0, 1.0], else None."""
    if not is_valid_number(value):
        return None
    return float(clamp(float(value), -1.0, 1.0))


def safe_trigger_unit(value: Any) -> float | None:
    """Normalize untrusted trigger value into [0.0, 1.0], else None."""
    if not is_valid_number(value):
        return None
    return float(clamp(float(value), 0.0, 1.0))


def unit_to_stick_axis(value: float) -> int:
    """Convert normalized stick value into Xbox-like ABS range."""
    v = clamp(value, -1.0, 1.0)
    if v >= 0.0:
        out = int(round(v * STICK_MAX))
    else:
        out = int(round(v * (-STICK_MIN)))
    return clamp_int(out, STICK_MIN, STICK_MAX)


def unit_to_trigger_axis(value: float) -> int:
    """Convert normalized trigger value into trigger ABS range."""
    v = clamp(value, 0.0, 1.0)
    out = int(round(v * TRIGGER_MAX))
    return clamp_int(out, TRIGGER_MIN, TRIGGER_MAX)


def radial_deadzone(x: float, y: float, deadzone: float) -> tuple[float, float]:
    """Apply radial deadzone and return re-scaled normalized vector."""
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
    """Map analog-ish hat axis input to {-1, 0, 1}, else None."""
    if not is_valid_number(value):
        return None
    v = clamp(float(value), -1.0, 1.0)
    if v >= 0.5:
        return 1
    if v <= -0.5:
        return -1
    return 0


def smooth_step(current: int, target: int, alpha: float, max_step: int) -> int:
    """Filter axis transitions to reduce jitter and sudden spikes."""
    a = clamp(alpha, 0.0, 1.0)
    filtered = current + (target - current) * a
    stepped = int(round(filtered))
    delta = clamp_int(stepped - current, -max_step, max_step)
    return current + delta


def safe_button_state(value: Any) -> int | None:
    """Accept only 0/1 or bool button state values."""
    if isinstance(value, bool):
        return 1 if value else 0
    if not isinstance(value, int):
        return None
    if value not in (0, 1):
        return None
    return value


def create_gamepad(player_id: int) -> UInput:
    """Create a single virtual gamepad instance for a connected player."""
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
    """Runtime state for one connected controller client."""

    sid: str
    ui: UInput
    queue: deque[tuple[str, dict[str, Any]]] = field(default_factory=lambda: deque(maxlen=EVENT_QUEUE_MAXLEN))
    lock: threading.Lock = field(default_factory=threading.Lock)
    target_abs: dict[int, int] = field(default_factory=lambda: {code: 0 for code in ALL_ABS_CODES})
    output_abs: dict[int, int] = field(default_factory=lambda: {code: 0 for code in ALL_ABS_CODES})
    target_btn: dict[int, int] = field(default_factory=lambda: {code: 0 for code in ALL_BUTTON_CODES})
    output_btn: dict[int, int] = field(default_factory=lambda: {code: 0 for code in ALL_BUTTON_CODES})

    def enqueue(self, event_type: str, payload: dict[str, Any]) -> None:
        """Queue raw socket event payload for deferred processing."""
        with self.lock:
            self.queue.append((event_type, payload))

    def drain(self) -> list[tuple[str, dict[str, Any]]]:
        """Drain a bounded batch of pending events from the queue."""
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
    """Render the controller shell page."""
    return render_template("index.html")


def get_client(sid: str) -> ClientState | None:
    """Lookup client by Socket.IO session id."""
    with clients_lock:
        return clients.get(sid)


def add_client(sid: str) -> bool:
    """Create and register a virtual gamepad for a new websocket client."""
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
    """Release virtual controller resources for a disconnected client."""
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
    """Socket.IO connect hook; reject when capacity is exhausted."""
    sid = request.sid
    if not add_client(sid):
        return False
    return None


@SOCKETIO.on("disconnect")
def on_disconnect() -> None:
    """Socket.IO disconnect hook."""
    remove_client(request.sid)


def enqueue_event(event_type: str, data: Any) -> None:
    """Push validated websocket payload into the per-client queue."""
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
    """Map one input event onto target button/axis state."""
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
    """Add axis write only when output value changed."""
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
    """Convert desired state into a minimal list of evdev writes."""
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
    """Background loop: process queued events and emit UInput updates."""
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
    """Best-effort shutdown cleanup for all connected virtual gamepads."""
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
