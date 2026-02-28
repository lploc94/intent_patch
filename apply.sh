#!/bin/bash
set -e

# Apply Intent multi-provider patches.
#
# Modes:
#   bash apply.sh                   # Auto-patch: extract → patch → verify → install
#   bash apply.sh --no-install      # Auto-patch without installing
#   bash apply.sh --legacy          # Legacy mode: copy pre-built patches (v0.2.11 only)
#   bash apply.sh --discover-only   # Just discover files + resolve symbols
#   bash apply.sh <extracted_dir>    # Compat: same as --extracted-dir <path>

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Forward to autopatch.py
if [ "$1" = "--legacy" ]; then
    shift
    echo "=== Legacy Mode (pre-built patches) ==="
    echo "Warning: Legacy mode only works for Intent v0.2.11"
    echo ""

    PATCHES="$SCRIPT_DIR/patches"
    APP="/Applications/Intent by Augment.app"
    UNPACKED="$APP/Contents/Resources/app.asar.unpacked"
    EXTRACTED="${1:-$SCRIPT_DIR/extracted}"

    if [ ! -d "$EXTRACTED" ]; then
        echo "Error: extracted directory not found at $EXTRACTED"
        echo ""
        echo "Extract first:"
        echo "  cp \"$APP/Contents/Resources/app.asar\" app.asar.backup"
        echo "  npx asar extract app.asar.backup extracted"
        exit 1
    fi

    echo "=== Step 1: Copy patched files ==="
    cp "$PATCHES/dist/features/agent/services/agent-factory.js" \
       "$EXTRACTED/dist/features/agent/services/agent-factory.js"
    cp "$PATCHES/dist/renderer/app/immutable/chunks/BTPDcoPQ.js" \
       "$EXTRACTED/dist/renderer/app/immutable/chunks/BTPDcoPQ.js"
    cp "$PATCHES/dist/renderer/app/immutable/chunks/CfKn743W.js" \
       "$EXTRACTED/dist/renderer/app/immutable/chunks/CfKn743W.js"
    echo "Done."

    echo ""
    echo "Writing patched-files.json manifest..."
    python3 -c "
import json, sys
manifest = {
    'model_store': 'BTPDcoPQ.js',
    'model_picker': 'CfKn743W.js',
    'chunks_dir': 'dist/renderer/app/immutable/chunks',
}
path = sys.argv[1] + '/patched-files.json'
with open(path, 'w', encoding='utf-8') as f:
    json.dump(manifest, f, indent=2)
    f.write('\n')
print('  OK  patched-files.json written')
" "$EXTRACTED"

    echo ""
    echo "=== Step 2: Verify ==="
    python3 "$SCRIPT_DIR/verify.py"

    echo ""
    echo "=== Step 3: Repack ==="
    npx --yes asar pack "$EXTRACTED" "$SCRIPT_DIR/app.asar"

    echo ""
    echo "=== Step 4: Install ==="
    pkill -f "Intent by Augment" 2>/dev/null || true
    sleep 2
    sudo xattr -cr "$APP"
    sudo cp "$SCRIPT_DIR/app.asar" "$APP/Contents/Resources/app.asar"
    sudo cp "$PATCHES/dist/renderer/app/immutable/chunks/BTPDcoPQ.js" \
      "$UNPACKED/dist/renderer/app/immutable/chunks/BTPDcoPQ.js"
    sudo cp "$PATCHES/dist/renderer/app/immutable/chunks/CfKn743W.js" \
      "$UNPACKED/dist/renderer/app/immutable/chunks/CfKn743W.js"
    sudo /usr/libexec/PlistBuddy -c "Delete :ElectronAsarIntegrity" "$APP/Contents/Info.plist" 2>/dev/null || true
    sudo codesign --force --deep --sign - "$APP"
    echo ""
    echo "Done! Open Intent by Augment to verify."
else
    # Auto-patch mode (version-independent)
    # Backward compat: treat bare positional path as --extracted-dir
    if [ -n "$1" ] && [ "${1#-}" = "$1" ]; then
        exec python3 "$SCRIPT_DIR/autopatch.py" --extracted-dir "$1" "${@:2}"
    fi
    exec python3 "$SCRIPT_DIR/autopatch.py" "$@"
fi
