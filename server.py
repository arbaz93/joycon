from __future__ import annotations

import math
import threading
import time
from collections import deque
from dataclasses import dataclass, field
from typing import Any

from evdev import UInput, ecodes as e
from flask import Flask, render_template, request
from flask_socketio import SocketIO

app = Flask(__name__)
socketio = SocketIO(app, cors_allowed_origins="*", async_mode="threading")

MAX_PLAYERS = 4
QUEUE_MAXLEN = 512
MAX_EVENTS_PER_TICK = 256
PROCESS_HZ = 120.0
PROCESS_DT = 1.0 / PROCESS_HZ
PAD_NAME = "Microsoft X-Box 360 pad"

STICK_MIN = -32768
STICK_MAX = 32767
TRIGGER_MIN = 0
TRIGGER_MAX = 255

STICK_DEADZONE = 0.15
TRIGGER_DEADZONE = 0.02

STICK_SMOOTH_ALPHA = 0.35
TRIGGER_SMOOTH_ALPHA = 0.45

STICK_MAX_STEP = 6000
TRIGGER_MAX_STEP = 48

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

ALL_BUTTON_CODES = tuple(dict.fromkeys([*BUTTON_MAP.values(), *DPAD_BUTTON_CODES.values()]))

def clamp(value: float, low: float, high: float) -> float:
    return low if value < low else high if value > high else value


def clamp_int(value: int, low: int, high: int) -> int:
    return low if value < low else high if value > high else value


def is_valid_number(value: Any) -> bool:
    if isinstance(value, bool):
        return False
    if not isinstance(value, (int, float)):
        return False
    return math.isfinite(float(value))


def safe_unit(value: Any) -> float | None:
    if not is_valid_number(value):
        return None
    return float(clamp(float(value), -1.0, 1.0))


def safe_trigger_unit(value: Any) -> float | None:
    if not is_valid_number(value):
        return None
    return float(clamp(float(value), 0.0, 1.0))


def unit_to_stick_axis(value: float) -> int:
    v = clamp(value, -1.0, 1.0)
    if v >= 0.0:
        out = int(round(v * STICK_MAX))
    else:
        out = int(round(v * (-STICK_MIN)))
    return clamp_int(out, STICK_MIN, STICK_MAX)


def unit_to_trigger_axis(value: float) -> int:
    v = clamp(value, 0.0, 1.0)
    out = int(round(v * TRIGGER_MAX))
    return clamp_int(out, TRIGGER_MIN, TRIGGER_MAX)


def radial_deadzone(x: float, y: float, deadzone: float) -> tuple[float, float]:
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
    if not is_valid_number(value):
        return None
    v = clamp(float(value), -1.0, 1.0)
    if v >= 0.5:
        return 1
    if v <= -0.5:
        return -1
    return 0


def smooth_step(current: int, target: int, alpha: float, max_step: int) -> int:
    a = clamp(alpha, 0.0, 1.0)
    filtered = current + (target - current) * a
    stepped = int(round(filtered))
    delta = clamp_int(stepped - current, -max_step, max_step)
    return current + delta


def safe_button_state(value: Any) -> int | None:
    if isinstance(value, bool):
        return 1 if value else 0
    if not isinstance(value, int):
        return None
    if value not in (0, 1):
        return None
    return value


def create_gamepad(player_id: int) -> UInput:
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
    sid: str
    ui: UInput
    queue: deque[tuple[str, dict[str, Any]]] = field(default_factory=lambda: deque(maxlen=QUEUE_MAXLEN))
    lock: threading.Lock = field(default_factory=threading.Lock)
    target_abs: dict[int, int] = field(
        default_factory=lambda: {
            e.ABS_X: 0,
            e.ABS_Y: 0,
            e.ABS_RX: 0,
            e.ABS_RY: 0,
            e.ABS_Z: 0,
            e.ABS_RZ: 0,
            e.ABS_HAT0X: 0,
            e.ABS_HAT0Y: 0,
        }
    )
    output_abs: dict[int, int] = field(
        default_factory=lambda: {
            e.ABS_X: 0,
            e.ABS_Y: 0,
            e.ABS_RX: 0,
            e.ABS_RY: 0,
            e.ABS_Z: 0,
            e.ABS_RZ: 0,
            e.ABS_HAT0X: 0,
            e.ABS_HAT0Y: 0,
        }
    )
    target_btn: dict[int, int] = field(default_factory=lambda: {code: 0 for code in ALL_BUTTON_CODES})
    output_btn: dict[int, int] = field(default_factory=lambda: {code: 0 for code in ALL_BUTTON_CODES})

    def enqueue(self, event_type: str, payload: dict[str, Any]) -> None:
        with self.lock:
            self.queue.append((event_type, payload))

    def drain(self) -> list[tuple[str, dict[str, Any]]]:
        with self.lock:
            count = min(len(self.queue), MAX_EVENTS_PER_TICK)
            drained = [self.queue.popleft() for _ in range(count)]
            if self.queue:
                # Keep only newest events under high load.
                while len(self.queue) > QUEUE_MAXLEN // 2:
                    self.queue.popleft()
            return drained


clients: dict[str, ClientState] = {}
clients_lock = threading.Lock()


@app.route("/")
def index() -> str:
    return render_template("index.html")


def get_client(sid: str) -> ClientState | None:
    with clients_lock:
        return clients.get(sid)


def add_client(sid: str) -> bool:
    with clients_lock:
        if len(clients) >= MAX_PLAYERS:
            return False
        player_id = len(clients) + 1
        ui = create_gamepad(player_id)
        clients[sid] = ClientState(sid=sid, ui=ui)
        return True


def remove_client(sid: str) -> None:
    with clients_lock:
        state = clients.pop(sid, None)
    if state is None:
        return
    try:
        state.ui.close()
    except Exception:
        pass


@socketio.on("connect")
def on_connect(auth: Any = None) -> bool | None:
    sid = request.sid
    if not add_client(sid):
        return False
    return None


@socketio.on("disconnect")
def on_disconnect() -> None:
    remove_client(request.sid)


def enqueue_event(event_type: str, data: Any) -> None:
    sid = request.sid
    state = get_client(sid)
    if state is None:
        return
    if not isinstance(data, dict):
        return
    state.enqueue(event_type, data)


@socketio.on("button")
def on_button(data: Any) -> None:
    enqueue_event("button", data)


@socketio.on("joystick")
def on_joystick(data: Any) -> None:
    enqueue_event("joystick", data)


@socketio.on("trigger")
def on_trigger(data: Any) -> None:
    enqueue_event("trigger", data)


@socketio.on("dpad")
def on_dpad(data: Any) -> None:
    enqueue_event("dpad", data)


def apply_event(state: ClientState, event_type: str, data: dict[str, Any]) -> None:
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
    if code in (e.ABS_X, e.ABS_Y, e.ABS_RX, e.ABS_RY):
        new_value = clamp_int(new_value, STICK_MIN, STICK_MAX)
    elif code in (e.ABS_Z, e.ABS_RZ):
        new_value = clamp_int(new_value, TRIGGER_MIN, TRIGGER_MAX)
    elif code in (e.ABS_HAT0X, e.ABS_HAT0Y):
        new_value = clamp_int(new_value, -1, 1)
    else:
        return

    if state.output_abs[code] == new_value:
        return
    state.output_abs[code] = new_value
    writes.append((e.EV_ABS, code, new_value))


def build_writes(state: ClientState) -> list[tuple[int, int, int]]:
    writes: list[tuple[int, int, int]] = []

    for code in (e.ABS_X, e.ABS_Y, e.ABS_RX, e.ABS_RY):
        cur = state.output_abs[code]
        tgt = clamp_int(state.target_abs[code], STICK_MIN, STICK_MAX)
        nxt = smooth_step(cur, tgt, STICK_SMOOTH_ALPHA, STICK_MAX_STEP)
        if abs(nxt) <= 6 and tgt == 0:
            nxt = 0
        emit_abs_if_changed(state, code, nxt, writes)

    for code in (e.ABS_Z, e.ABS_RZ):
        cur = state.output_abs[code]
        tgt = clamp_int(state.target_abs[code], TRIGGER_MIN, TRIGGER_MAX)
        nxt = smooth_step(cur, tgt, TRIGGER_SMOOTH_ALPHA, TRIGGER_MAX_STEP)
        if nxt <= 1 and tgt == 0:
            nxt = 0
        emit_abs_if_changed(state, code, nxt, writes)

    for code in (e.ABS_HAT0X, e.ABS_HAT0Y):
        emit_abs_if_changed(state, code, state.target_abs[code], writes)

    for code, tgt in state.target_btn.items():
        safe_tgt = 1 if tgt else 0
        if state.output_btn[code] == safe_tgt:
            continue
        state.output_btn[code] = safe_tgt
        writes.append((e.EV_KEY, code, safe_tgt))

    return writes


def reset_and_close_client(sid: str) -> None:
    remove_client(sid)


def processing_loop() -> None:
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
                reset_and_close_client(sid)

        elapsed = time.monotonic() - loop_start
        sleep_time = PROCESS_DT - elapsed
        if sleep_time > 0:
            time.sleep(sleep_time)


worker_thread = threading.Thread(target=processing_loop, daemon=True)
worker_thread.start()


if __name__ == "__main__":
    socketio.run(app, host="0.0.0.0", port=5000, allow_unsafe_werkzeug=True)
