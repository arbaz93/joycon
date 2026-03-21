from flask import Flask, render_template, request
from flask_socketio import SocketIO
import uinput

app = Flask(__name__)
socketio = SocketIO(app)

MAX_PLAYERS = 8
devices = {}  # sid -> device

def clamp_unit(value):
    return max(-1, min(1, float(value)))

def to_axis(value):
    return int(clamp_unit(value) * 32767)

def to_trigger(value):
    return int(max(0, min(1, float(value))) * 32767)

def create_gamepad(name):
    return uinput.Device([
        # Face buttons
        uinput.BTN_SOUTH,   # A
        uinput.BTN_EAST,    # B
        uinput.BTN_WEST,    # X
        uinput.BTN_NORTH,   # Y

        # Shoulders
        uinput.BTN_TL,      # LB
        uinput.BTN_TR,      # RB

        # Center buttons
        uinput.BTN_START,
        uinput.BTN_SELECT,
        uinput.BTN_MODE,    # Xbox / Guide

        # Thumbstick press
        uinput.BTN_THUMBL,
        uinput.BTN_THUMBR,

        # Axes
        uinput.ABS_X + (-32768, 32767, 0, 0),
        uinput.ABS_Y + (-32768, 32767, 0, 0),
        uinput.ABS_RX + (-32768, 32767, 0, 0),
        uinput.ABS_RY + (-32768, 32767, 0, 0),

        # D-pad
        uinput.ABS_HAT0X + (-1, 1, 0, 0),
        uinput.ABS_HAT0Y + (-1, 1, 0, 0),

        # Triggers
        uinput.ABS_Z + (0, 32767, 0, 0),   # LT
        uinput.ABS_RZ + (0, 32767, 0, 0),  # RT

    ], name=name)

@app.route('/')
def index():
    return render_template("index.html")

# =========================
# Connection Handling
# =========================

@socketio.on('connect')
def handle_connect(auth=None):
    sid = request.sid

    if len(devices) >= MAX_PLAYERS:
        print("Max players reached. Rejecting:", sid)
        return False  # reject connection

    player_id = len(devices) + 1
    name = f"Xbox 360 Controller P{player_id}"

    device = create_gamepad(name)
    devices[sid] = device

    print(f"Connected: {sid} -> {name}")

@socketio.on('disconnect')
def handle_disconnect():
    sid = request.sid
    device = devices.pop(sid, None)

    if device:
        del device

    print(f"Disconnected: {sid}")

def get_device():
    return devices.get(request.sid)

# =========================
# Input Handlers
# =========================

@socketio.on('button')
def handle_button(data):
    device = get_device()
    if not device:
        return

    btn = data.get('button')
    state = int(data.get('state', 0))

    mapping = {
        "A": uinput.BTN_SOUTH,
        "B": uinput.BTN_EAST,
        "X": uinput.BTN_WEST,
        "Y": uinput.BTN_NORTH,
        "LB": uinput.BTN_TL,
        "RB": uinput.BTN_TR,
        "START": uinput.BTN_START,
        "SELECT": uinput.BTN_SELECT,
        "HOME": uinput.BTN_MODE,
        "L3": uinput.BTN_THUMBL,
        "R3": uinput.BTN_THUMBR,
    }

    if btn in mapping:
        device.emit(mapping[btn], state)

@socketio.on('joystick')
def handle_joystick(data):
    device = get_device()
    if not device:
        return

    stick = data.get('stick', 'left')
    x = to_axis(data.get('x', 0))
    y = to_axis(data.get('y', 0))

    axes = {
        "left": (uinput.ABS_X, uinput.ABS_Y),
        "right": (uinput.ABS_RX, uinput.ABS_RY),
    }

    ax_x, ax_y = axes.get(stick, axes["left"])

    device.emit(ax_x, x)
    device.emit(ax_y, y)

@socketio.on('dpad')
def handle_dpad(data):
    device = get_device()
    if not device:
        return

    x = int(clamp_unit(data.get('x', 0)))
    y = int(clamp_unit(data.get('y', 0)))

    device.emit(uinput.ABS_HAT0X, x)
    device.emit(uinput.ABS_HAT0Y, y)

@socketio.on('trigger')
def handle_trigger(data):
    device = get_device()
    if not device:
        return

    trigger = data.get('trigger')
    value = to_trigger(data.get('value', 0))

    mapping = {
        "LT": uinput.ABS_Z,
        "RT": uinput.ABS_RZ,
    }

    if trigger in mapping:
        device.emit(mapping[trigger], value)

# =========================
# Run Server
# =========================

if __name__ == '__main__':
    socketio.run(app, host='0.0.0.0', port=5000)