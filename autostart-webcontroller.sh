#!/bin/bash

cd /home/mage/Development/webcontroller-batocera || exit
source venv/bin/activate

sudo modprobe uinput
sudo chmod 666 /dev/uinput
# Start server
nohup python server.py > server.log 2>&1 &

# Give the server a moment to start
sleep 2

# Default fallback: IP address
IP=$(ip route get 1.1.1.1 | awk '{print $7; exit}')
URL="http://$IP:5000"

# Check if Avahi (mDNS) is available
HOSTNAME=$(hostname)

IP=$(ip route get 1.1.1.1 | awk '{print $7; exit}')

if ping -c 1 "$HOSTNAME.local" >/dev/null 2>&1; then
    URL="http://$HOSTNAME.local:5000"
else
    URL="http://$IP:5000"
fi

echo "Server running at: $URL"
notify-send "WebController" "Running at $URL" 2>/dev/null
