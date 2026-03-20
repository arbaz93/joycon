from flask import Flask, render_template
from flask_socketio import SocketIO
import uinput

app = Flask(__name__)
socketio = SocketIO(app)

def clamp_unit(value):
    return max(-1, min(1, float(value)))

def to_axis(value):
    return int(clamp_unit(value) * 32767)

def to_trigger(value):
    return int(max(0, min(1, float(value))) * 32767)

# Define a virtual gamepad
device = uinput.Device([
    uinput.BTN_A,
    uinput.BTN_B,
    uinput.BTN_X,
    uinput.BTN_Y,
    uinput.BTN_TL,
    uinput.BTN_TR,
    uinput.BTN_START,
    uinput.BTN_SELECT,
    uinput.BTN_MODE,
    uinput.ABS_X + (-32768, 32767, 0, 0),
    uinput.ABS_Y + (-32768, 32767, 0, 0),
    uinput.ABS_RX + (-32768, 32767, 0, 0),
    uinput.ABS_RY + (-32768, 32767, 0, 0),
    uinput.ABS_HAT0X + (-1, 1, 0, 0),
    uinput.ABS_HAT0Y + (-1, 1, 0, 0),
    uinput.ABS_Z + (0, 32767, 0, 0),
    uinput.ABS_RZ + (0, 32767, 0, 0),
])

@app.route('/')
def index():
    return render_template("index.html")

@socketio.on('button')
def handle_button(data):
    btn = data['button']
    state = data['state']
    
    mapping = {
        "A": uinput.BTN_A,
        "B": uinput.BTN_B,
        "X": uinput.BTN_X,
        "Y": uinput.BTN_Y,
        "LB": uinput.BTN_TL,
        "RB": uinput.BTN_TR,
        "START": uinput.BTN_START,
        "SELECT": uinput.BTN_SELECT,
        "HOME": uinput.BTN_MODE,
    }

    if btn in mapping:
        device.emit(mapping[btn], state)

@socketio.on('joystick')
def handle_joystick(data):
    stick = data.get('stick', 'left')
    x = to_axis(data.get('x', 0))
    y = to_axis(data.get('y', 0))

    axes = {
        "left": (uinput.ABS_X, uinput.ABS_Y),
        "right": (uinput.ABS_RX, uinput.ABS_RY),
    }

    target_axes = axes.get(stick, axes["left"])
    device.emit(target_axes[0], x)
    device.emit(target_axes[1], y)

@socketio.on('dpad')
def handle_dpad(data):
    x = int(clamp_unit(data.get('x', 0)))
    y = int(clamp_unit(data.get('y', 0)))
    device.emit(uinput.ABS_HAT0X, x)
    device.emit(uinput.ABS_HAT0Y, y)

@socketio.on('trigger')
def handle_trigger(data):
    trigger = data.get('trigger')
    value = to_trigger(data.get('value', 0))
    mapping = {
        "LT": uinput.ABS_Z,
        "RT": uinput.ABS_RZ,
    }
    if trigger in mapping:
        device.emit(mapping[trigger], value)

if __name__ == '__main__':
    socketio.run(app, host='0.0.0.0', port=5000)
