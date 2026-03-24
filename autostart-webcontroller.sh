#!/bin/bash

sudo modprobe uinput
sudo chmod 666 /dev/uinput

cd /home/mage/Development/webcontroller-batocera || exit
source venv/bin/activate

IP=$(ip route get 1.1.1.1 | awk '{print $7; exit}')

nohup python server.py > server.log 2>&1 &

notify-send "WebController" "Running at http://$IP:5000" 2>/dev/null
echo "Running at http://$IP:5000"