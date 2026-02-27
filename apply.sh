#!/bin/bash
set -e

# Apply patched files to extracted app directory and install
# Usage: bash apply.sh [extracted_dir]

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PATCHES="$SCRIPT_DIR/patches"
APP="/Applications/Intent by Augment.app"
UNPACKED="$APP/Contents/Resources/app.asar.unpacked"

# Determine extracted directory
if [ -n "$1" ]; then
    EXTRACTED="$1"
else
    EXTRACTED="$SCRIPT_DIR/extracted"
fi

if [ ! -d "$EXTRACTED" ]; then
    echo "Error: extracted directory not found at $EXTRACTED"
    echo ""
    echo "Extract first:"
    echo "  cp \"$APP/Contents/Resources/app.asar\" app.asar.backup"
    echo "  npx asar extract app.asar.backup extracted"
    exit 1
fi

echo "=== Step 1: Copy patched files to extracted/ ==="
cp "$PATCHES/dist/features/agent/services/agent-factory.js" \
   "$EXTRACTED/dist/features/agent/services/agent-factory.js"
cp "$PATCHES/dist/renderer/app/immutable/chunks/BTPDcoPQ.js" \
   "$EXTRACTED/dist/renderer/app/immutable/chunks/BTPDcoPQ.js"
cp "$PATCHES/dist/renderer/app/immutable/chunks/CfKn743W.js" \
   "$EXTRACTED/dist/renderer/app/immutable/chunks/CfKn743W.js"
echo "Done."

echo ""
echo "=== Step 2: Verify patches ==="
python3 "$SCRIPT_DIR/verify.py"

echo ""
echo "=== Step 3: Repack app.asar ==="
npx --yes asar pack "$EXTRACTED" "$SCRIPT_DIR/app.asar"
echo "Done."

echo ""
echo "=== Step 4: Install (requires sudo) ==="
echo "Killing Intent by Augment..."
pkill -f "Intent by Augment" 2>/dev/null || true
sleep 2

echo "Removing macOS protection flags..."
sudo xattr -cr "$APP"

echo "Installing patched app.asar..."
sudo cp "$SCRIPT_DIR/app.asar" "$APP/Contents/Resources/app.asar"

echo "Installing patched unpacked files..."
sudo cp "$PATCHES/dist/renderer/app/immutable/chunks/BTPDcoPQ.js" \
  "$UNPACKED/dist/renderer/app/immutable/chunks/BTPDcoPQ.js"
sudo cp "$PATCHES/dist/renderer/app/immutable/chunks/CfKn743W.js" \
  "$UNPACKED/dist/renderer/app/immutable/chunks/CfKn743W.js"

echo "Removing ElectronAsarIntegrity..."
sudo /usr/libexec/PlistBuddy -c "Delete :ElectronAsarIntegrity" "$APP/Contents/Info.plist" 2>/dev/null || true

echo "Re-signing app..."
sudo codesign --force --deep --sign - "$APP"

echo ""
echo "Done! Open Intent by Augment to verify."
