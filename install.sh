#!/bin/bash
set -e

APP="/Applications/Intent by Augment.app"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
EXTRACTED="$SCRIPT_DIR/extracted"
ASAR="$SCRIPT_DIR/app.asar"
UNPACKED="$APP/Contents/Resources/app.asar.unpacked"

echo "Killing Intent by Augment..."
pkill -f "Intent by Augment" 2>/dev/null || true
sleep 2

echo "Removing macOS protection flags..."
sudo xattr -cr "$APP"

echo "Installing patched app.asar..."
sudo cp "$ASAR" "$APP/Contents/Resources/app.asar"

echo "Installing patched unpacked files..."
sudo cp "$EXTRACTED/dist/renderer/app/immutable/chunks/BTPDcoPQ.js" \
  "$UNPACKED/dist/renderer/app/immutable/chunks/BTPDcoPQ.js"
sudo cp "$EXTRACTED/dist/renderer/app/immutable/chunks/CfKn743W.js" \
  "$UNPACKED/dist/renderer/app/immutable/chunks/CfKn743W.js"

echo "Removing ElectronAsarIntegrity..."
sudo /usr/libexec/PlistBuddy -c "Delete :ElectronAsarIntegrity" "$APP/Contents/Info.plist" 2>/dev/null || true

echo "Re-signing app..."
sudo codesign --force --deep --sign - "$APP"

echo "Done! Open Intent by Augment to verify."
