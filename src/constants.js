'use strict';

const path = require('path');
const os = require('os');

// Intent app paths
const INTENT_APP = '/Applications/Intent by Augment.app';
const INTENT_RESOURCES = path.join(INTENT_APP, 'Contents', 'Resources');
const INTENT_ASAR = path.join(INTENT_RESOURCES, 'app.asar');
const INTENT_UNPACKED = path.join(INTENT_RESOURCES, 'app.asar.unpacked');
const INTENT_PLIST = path.join(INTENT_APP, 'Contents', 'Info.plist');

// State directory (persists across npx runs)
const STATE_DIR = path.join(os.homedir(), '.intent-patch');
const BACKUP_ASAR = path.join(STATE_DIR, 'app.asar.backup');
const BACKUP_UNPACKED = path.join(STATE_DIR, 'app.asar.backup.unpacked');
const DEFAULT_EXTRACTED = path.join(STATE_DIR, 'extracted');
const OUTPUT_ASAR = path.join(STATE_DIR, 'app.asar');
const VERSION_FILE = path.join(STATE_DIR, '.patched-version');

// Relative paths within extracted app
const AGENT_FACTORY_REL = 'dist/features/agent/services/agent-factory.js';
const AGENT_INTERACTION_TOOLS_REL = 'dist/features/mcp/main/mcp/agent-interaction-tools.js';
const CHUNKS_DIR_REL = 'dist/renderer/app/immutable/chunks';
const MAIN_INDEX_REL = 'dist/main/index.js';

// Patch marker
const PATCH_MARKER = '"__all__"';

// Patch states
const PatchState = Object.freeze({
  NOT_APPLIED: 'not_applied',
  APPLIED: 'applied',
  CONFLICT: 'conflict',
});

module.exports = {
  INTENT_APP,
  INTENT_RESOURCES,
  INTENT_ASAR,
  INTENT_UNPACKED,
  INTENT_PLIST,
  STATE_DIR,
  BACKUP_ASAR,
  BACKUP_UNPACKED,
  DEFAULT_EXTRACTED,
  OUTPUT_ASAR,
  VERSION_FILE,
  AGENT_FACTORY_REL,
  AGENT_INTERACTION_TOOLS_REL,
  CHUNKS_DIR_REL,
  MAIN_INDEX_REL,
  PATCH_MARKER,
  PatchState,
};
