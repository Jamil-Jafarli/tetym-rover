#!/usr/bin/env bash
#
# Generates the React Native app and drops the ARKit scanner into it.
#
# WHY A SCRIPT AND NOT A CHECKED-IN XCODE PROJECT
# An .xcodeproj is a generated artefact with absolute-ish paths, a pbxproj
# format that changes between Xcode releases, and a dependency on whichever
# React Native version you actually install. Hand-writing one produces a file
# that looks right and fails on someone else's machine. So: let the official
# CLI generate the project, then add our sources to it programmatically.
#
#   ./setup.sh [AppName] [target-directory]
#
set -euo pipefail

APP_NAME="${1:-WebScanner}"
TARGET_DIR="${2:-$(pwd)/$APP_NAME}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

say()  { printf '\033[36m▸\033[0m %s\n' "$1"; }
ok()   { printf '\033[32m✓\033[0m %s\n' "$1"; }
die()  { printf '\033[31m✗\033[0m %s\n' "$1" >&2; exit 1; }

# ---------------------------------------------------------------- preflight
[ "$(uname)" = "Darwin" ] || die "iOS builds need macOS. You are on $(uname)."
command -v node >/dev/null || die "node not found. Install Node 20+ (brew install node)."
command -v xcodebuild >/dev/null || die "Xcode not found. Install it from the App Store, then run: sudo xcode-select -s /Applications/Xcode.app"
command -v pod >/dev/null || die "CocoaPods not found. Install it: sudo gem install cocoapods"
ruby -e "require 'xcodeproj'" 2>/dev/null || die "The xcodeproj gem is missing. Install it: sudo gem install xcodeproj"

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || die "Node 20+ required, found $(node -v)."

say "app name:   $APP_NAME"
say "target dir: $TARGET_DIR"

# ---------------------------------------------------------- generate the app
if [ -d "$TARGET_DIR" ]; then
  say "$TARGET_DIR already exists — skipping project generation"
else
  say "Generating the React Native project (this pulls a few hundred MB)…"
  npx --yes @react-native-community/cli@latest init "$APP_NAME" \
      --directory "$TARGET_DIR" \
      --install-pods false \
      --skip-git-init true
  ok "React Native project created"
fi

cd "$TARGET_DIR"

# --------------------------------------------------------- JS / TS sources
say "Installing the app sources…"
mkdir -p src/native
cp "$HERE/app/App.tsx" ./App.tsx
cp "$HERE/app/src/types.ts" ./src/types.ts
cp "$HERE/app/src/useScanner.ts" ./src/useScanner.ts
cp "$HERE/app/src/native/ARScanner.ts" ./src/native/ARScanner.ts
ok "TypeScript sources in place"

# ------------------------------------------------------------ native module
say "Adding the ARKit module to the Xcode project…"
ruby "$HERE/scripts/add_native_files.rb" "$TARGET_DIR/ios" "$HERE/native/ios" "$HERE/native/tests"
bash "$HERE/scripts/patch_ios_config.sh" "$TARGET_DIR/ios"

# ------------------------------------------------------------------ install
say "Installing npm dependencies…"
npm install

say "Installing pods (first run compiles a lot of React Native)…"
( cd ios && pod install )

ok "Done."
cat <<NEXT

  Next
  ────
  1. Start the rover server, from the tetym-rover root:
         node server.js --marlin      (or: npm run fake, no hardware)
     Note the LAN address it prints, e.g. ws://192.168.1.20:8090

  2. Open the workspace and run on a REAL DEVICE (ARKit does not exist in the
     simulator — it will build and then fail at runtime):
         open ios/$APP_NAME.xcworkspace
     Pick your iPhone, set Signing → your Apple ID team, press ⌘R.

  3. The app finds the rover by itself (mDNS). If it does not, type
     ws://<that-LAN-ip>:8090, keep the room "default", then open the map:
         http://<that-LAN-ip>:8090/lidar

  4. ⌘U runs the cross-language protocol test.

NEXT
