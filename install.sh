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
MANIFEST="$EXTRACTED/patched-files.json"
if [ ! -f "$MANIFEST" ]; then
    echo "Error: patched-files.json not found at $MANIFEST"
    echo "Run 'bash apply.sh' first to patch and generate the manifest."
    exit 1
fi
read -r MODEL_STORE MODEL_PICKER CHUNKS_DIR <<< "$(python3 -c "
import json, sys
d = json.load(open(sys.argv[1], encoding='utf-8'))
print(d['model_store'], d['model_picker'], d['chunks_dir'])
" "$MANIFEST")"
sudo cp "$EXTRACTED/$CHUNKS_DIR/$MODEL_STORE" "$UNPACKED/$CHUNKS_DIR/$MODEL_STORE"
sudo cp "$EXTRACTED/$CHUNKS_DIR/$MODEL_PICKER" "$UNPACKED/$CHUNKS_DIR/$MODEL_PICKER"

echo "Removing ElectronAsarIntegrity..."
sudo /usr/libexec/PlistBuddy -c "Delete :ElectronAsarIntegrity" "$APP/Contents/Info.plist" 2>/dev/null || true

echo "Re-signing app..."
sudo codesign --force --deep --sign - "$APP"

echo "Done! Open Intent by Augment to verify."
