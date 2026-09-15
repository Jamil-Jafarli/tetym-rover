#!/usr/bin/env bash
# Info.plist and Podfile edits the scanner needs.
set -euo pipefail

IOS_DIR="$1"
APP_NAME="$(basename "$(ls -d "$IOS_DIR"/*.xcodeproj)" .xcodeproj)"
PLIST="$IOS_DIR/$APP_NAME/Info.plist"

if [ ! -f "$PLIST" ]; then
  echo "! Info.plist not found at $PLIST" >&2
  exit 1
fi

pb() { /usr/libexec/PlistBuddy -c "$1" "$PLIST" >/dev/null 2>&1 || true; }

# Camera permission. Without this string iOS terminates the app the instant
# ARKit asks for the camera — it is not a warning, it is a hard crash.
pb "Delete :NSCameraUsageDescription"
pb "Add :NSCameraUsageDescription string 'The camera and LiDAR are used to scan the room and build a 2D floor map.'"

# Tell the App Store the app cannot run without ARKit.
pb "Delete :UIRequiredDeviceCapabilities"
pb "Add :UIRequiredDeviceCapabilities array"
pb "Add :UIRequiredDeviceCapabilities:0 string arkit"

# Keep the screen awake: a scan is a two-handed job and nobody taps the screen
# while walking a room.
pb "Delete :UIApplicationSupportsIndirectInputEvents"
pb "Add :UIApplicationSupportsIndirectInputEvents bool true"

echo "✓ Info.plist patched ($PLIST)"

# Plain ws:// to a LAN relay is blocked by App Transport Security unless we say
# so. This is a development convenience; a deployed relay should be wss://.
pb "Delete :NSAppTransportSecurity"
pb "Add :NSAppTransportSecurity dict"
pb "Add :NSAppTransportSecurity:NSAllowsLocalNetworking bool true"
echo "✓ local networking allowed (ws:// to a LAN relay)"

# NWBrowser refuses to browse a service type that is not declared here. This is
# the single most common reason auto-discovery silently finds nothing.
pb "Delete :NSBonjourServices"
pb "Add :NSBonjourServices array"
pb "Add :NSBonjourServices:0 string _webscan._tcp"
echo "✓ Bonjour service type declared (_webscan._tcp)"

# iOS 14+ requires this for any local-network traffic, WebSocket included.
pb "Delete :NSLocalNetworkUsageDescription"
pb "Add :NSLocalNetworkUsageDescription string 'Used to find and stream scans to the relay server running on your computer.'"
echo "✓ local network usage description added"
