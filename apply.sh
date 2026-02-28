#!/bin/bash
set -e

# Apply Intent multi-provider patches.
# Auto-detects version changes and cleans stale artifacts before patching.
#
# Modes:
#   bash apply.sh                   # Auto-patch: check version → extract → patch → verify → install
#   bash apply.sh --no-install      # Auto-patch without installing
#   bash apply.sh --legacy          # Legacy mode: copy pre-built patches (v0.2.11 only)
#   bash apply.sh --discover-only   # Just discover files + resolve symbols
#   bash apply.sh --status          # Print patch status and exit
#   bash apply.sh <extracted_dir>    # Compat: same as --extracted-dir <path>

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP="/Applications/Intent by Augment.app"
PLIST="$APP/Contents/Info.plist"
VERSION_FILE="$SCRIPT_DIR/.patched-version"

# ─── Version helpers ────────────────────────────────────────────────────────
get_app_version() {
    if [ ! -d "$APP" ]; then echo ""; return; fi
    defaults read "$PLIST" CFBundleShortVersionString 2>/dev/null || echo ""
}

get_patched_version() {
    [ -f "$VERSION_FILE" ] && cat "$VERSION_FILE" || echo ""
}

save_patched_version() {
    echo "$1" > "$VERSION_FILE"
}

# ─── --status: print and exit ──────────────────────────────────────────────
if [ "$1" = "--status" ]; then
    APP_VERSION=$(get_app_version)
    PATCHED_VERSION=$(get_patched_version)
    if [ -z "$APP_VERSION" ]; then
        echo "[intent-patch] Intent not found"; exit 1
    elif [ "$APP_VERSION" = "$PATCHED_VERSION" ]; then
        echo "[intent-patch] v$APP_VERSION — patched ✓"
    elif [ -z "$PATCHED_VERSION" ]; then
        echo "[intent-patch] v$APP_VERSION — not patched! Run: bash $SCRIPT_DIR/apply.sh"
    else
        echo "[intent-patch] v$APP_VERSION — update detected (was v$PATCHED_VERSION)! Run: bash $SCRIPT_DIR/apply.sh"
    fi
    exit 0
fi

# ─── Legacy mode ────────────────────────────────────────────────────────────
if [ "$1" = "--legacy" ]; then
    shift
    echo "=== Legacy Mode (pre-built patches) ==="
    echo "Warning: Legacy mode only works for Intent v0.2.11"
    echo ""

    PATCHES="$SCRIPT_DIR/patches"
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
    exit 0
fi

# ─── Auto-patch mode (version-independent) ──────────────────────────────────

APP_VERSION=$(get_app_version)
PATCHED_VERSION=$(get_patched_version)

if [ -z "$APP_VERSION" ]; then
    echo "Intent by Augment not found at $APP"
    exit 1
fi

echo "=== Intent Patch ==="
echo "  App version:     $APP_VERSION"
echo "  Patched version: ${PATCHED_VERSION:-none}"

# Determine mode label
if [ "$APP_VERSION" = "$PATCHED_VERSION" ]; then
    echo "  Mode: Repair (re-patch v$APP_VERSION)"
else
    if [ -n "$PATCHED_VERSION" ]; then
        echo "  ! Version changed: v$PATCHED_VERSION → v$APP_VERSION"
    fi
    echo "  Mode: Install"
    # Version changed → clean stale artifacts
    rm -rf "$SCRIPT_DIR/extracted"
    rm -f "$SCRIPT_DIR/app.asar.backup"
    rm -rf "$SCRIPT_DIR/app.asar.backup.unpacked"
    rm -f "$SCRIPT_DIR/app.asar"
fi

echo ""

# Backward compat: treat bare positional path as --extracted-dir
if [ -n "$1" ] && [ "${1#-}" = "$1" ]; then
    set -- --extracted-dir "$1" "${@:2}"
fi

# Run autopatch
if python3 "$SCRIPT_DIR/autopatch.py" "$@"; then
    save_patched_version "$APP_VERSION"
    echo ""
    echo "  ✓ Patched v$APP_VERSION"
else
    echo ""
    echo "  ✗ Auto-patch failed for v$APP_VERSION"
    exit 1
fi
