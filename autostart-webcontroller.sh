#!/bin/bash
# FILE OVERVIEW:
# Convenience startup helper for Batocera/Linux sessions.
# Loads uinput support, starts the Flask server in background, and prints a
# LAN-accessible URL (prefers mDNS hostname when available).

cd /home/mage/Development/webcontroller-batocera || exit
source venv/bin/activate

sudo modprobe uinput
sudo chmod 666 /dev/uinput
# Start server
# TODO: Consider replacing `nohup` with a systemd unit for restart policies.
nohup python server.py > server.log 2>&1 &

# Give the server a moment to start
sleep 2

# Default fallback: IP address
IP=$(ip route get 1.1.1.1 | awk '{print $7; exit}')
URL="http://$IP:5000"

# Check if Avahi (mDNS) is available
HOSTNAME=$(hostname)

IP=$(ip route get 1.1.1.1 | awk '{print $7; exit}')

# NOTE: mDNS hostnames may not resolve on all client devices/networks.
if ping -c 1 "$HOSTNAME.local" >/dev/null 2>&1; then
    URL="http://$HOSTNAME.local:5000"
else
    URL="http://$IP:5000"
fi

echo "Server running at: $URL"
notify-send "WebController" "Running at $URL" 2>/dev/null
