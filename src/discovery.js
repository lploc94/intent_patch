'use strict';

const fs = require('fs');
const path = require('path');
const { log, fatal, readFile, header } = require('./utils');
const { AGENT_FACTORY_REL, AGENT_INTERACTION_TOOLS_REL, CHUNKS_DIR_REL, MAIN_INDEX_REL, AGENT_MISSING_IPC_REL } = require('./constants');

function discoverFiles(extractedDir) {
  header('Phase 1: File Discovery');

  const files = {
    agent_factory: AGENT_FACTORY_REL,
    agent_interaction_tools: AGENT_INTERACTION_TOOLS_REL,
    main_index: MAIN_INDEX_REL,
    agent_missing_ipc: AGENT_MISSING_IPC_REL,
    provider_config: null,
    model_store: null,
    model_picker: null,
    provider_config_filename: null,
    model_store_filename: null,
  };

  const chunksDir = path.join(extractedDir, CHUNKS_DIR_REL);
  if (!fs.existsSync(chunksDir) || !fs.statSync(chunksDir).isDirectory()) {
    fatal(`Chunks directory not found: ${chunksDir}`);
  }

  // 1.1 agent-factory.js
  const afPath = path.join(extractedDir, AGENT_FACTORY_REL);
  if (fs.existsSync(afPath)) {
    log(`agent-factory.js: ${AGENT_FACTORY_REL}`, 'OK');
  } else {
    fatal(`agent-factory.js not found at ${afPath}`);
  }

  // 1.1b agent-interaction-tools.js (optional)
  const aitPath = path.join(extractedDir, AGENT_INTERACTION_TOOLS_REL);
  if (fs.existsSync(aitPath)) {
    log(`agent-interaction-tools.js: ${AGENT_INTERACTION_TOOLS_REL}`, 'OK');
  } else {
    log('agent-interaction-tools.js not found \u2014 patches 8A-8D will be skipped', 'WARN');
    files.agent_interaction_tools = null;
  }

  // 1.1c main/index.js (optional — for auto-update patch 9A)
  const miPath = path.join(extractedDir, MAIN_INDEX_REL);
  if (fs.existsSync(miPath)) {
    log(`main/index.js: ${MAIN_INDEX_REL}`, 'OK');
  } else {
    log('main/index.js not found \u2014 auto-update patch 9A will be SKIPPED!', 'WARN');
    log('WARNING: Auto-update will remain active, which may cause disk bloat', 'WARN');
    files.main_index = null;
  }

  // 1.1d agent-missing.ipc.js (required — for enhancer patches 10A-10B)
  const amiPath = path.join(extractedDir, AGENT_MISSING_IPC_REL);
  if (fs.existsSync(amiPath)) {
    log(`agent-missing.ipc.js: ${AGENT_MISSING_IPC_REL}`, 'OK');
  } else {
    fatal(`agent-missing.ipc.js not found at ${amiPath}`);
  }

  // 1.2 Provider Config Chunk
  const pcResult = _discoverProviderConfig(chunksDir);
  files.provider_config = pcResult.relPath;
  files.provider_config_filename = pcResult.filename;

  // 1.3 ModelStore Chunk
  const msResult = _discoverModelStore(chunksDir, files.provider_config_filename);
  files.model_store = msResult.relPath;
  files.model_store_filename = msResult.filename;

  // 1.4 ModelPicker Chunk
  const mpResult = _discoverModelPicker(chunksDir, files.model_store_filename);
  files.model_picker = mpResult.relPath;

  return files;
}

function _discoverProviderConfig(chunksDir) {
  const candidates = [];
  const jsFiles = fs.readdirSync(chunksDir).filter(f => f.endsWith('.js') && !f.endsWith('.map'));

  for (const filename of jsFiles) {
    const content = readFile(path.join(chunksDir, filename));

    // Strategy 1: v0.2.11
    const hasActiveProvider = content.includes('.activeProviderId');
    const hasParse = content.includes('.split(":")') || content.includes(".split(':')");
    const hasIsDefaultMinified = content.includes('isDefault:!0') || content.includes('isDefault:!1');
    const hasTiers = content.includes('fast:') && content.includes('balanced:') && content.includes('smart:');
    const hasLsKey = content.includes('"workspaces-active-provider"');

    if (hasActiveProvider && hasParse && hasIsDefaultMinified && hasTiers && hasLsKey) {
      candidates.push(filename);
      continue;
    }

    // Strategy 2: v0.2.12+
    const hasAcpProviders = content.includes('ACP_PROVIDERS');
    const hasParseCompound = content.includes('parseCompoundModelId');
    const hasGetDefaultProvider = content.includes('getDefaultProviderId');
    const hasIsDefaultAny = content.includes('isDefault');
    const hasProviderModelTiers = content.includes('PROVIDER_MODEL_TIERS');

    if (hasAcpProviders && hasParseCompound && hasGetDefaultProvider && hasIsDefaultAny && hasProviderModelTiers) {
      candidates.push(filename);
      continue;
    }
  }

  if (candidates.length === 0) {
    fatal('Provider config chunk not found. No file matches structural fingerprint.');
  }
  if (candidates.length > 1) {
    fatal(`Multiple provider config candidates: ${candidates.join(', ')}. Expected exactly 1.`);
  }

  const filename = candidates[0];
  const relPath = path.join(CHUNKS_DIR_REL, filename);
  log(`Provider config: ${filename}`, 'OK');
  return { relPath, filename };
}

function _discoverModelStore(chunksDir, providerConfigFilename) {
  if (!providerConfigFilename) {
    fatal('provider_config_filename required for ModelStore discovery');
  }

  const candidates = [];
  const jsFiles = fs.readdirSync(chunksDir).filter(f => f.endsWith('.js') && !f.endsWith('.map'));

  for (const filename of jsFiles) {
    const content = readFile(path.join(chunksDir, filename));

    const methods = ['loadModels', 'selectModel', 'getGroupedModels',
      'reloadModelsForProvider', 'fetchModelsForProvider',
      'availableModels', 'modelsLoaded'];
    const hasMethods = methods.every(m => content.includes(m));
    const hasLsKey = content.includes('"workspaces-selected-model"');
    const hasImport = content.includes(`from"./${providerConfigFilename}"`);

    if (hasMethods && hasLsKey && hasImport) {
      candidates.push(filename);
    }
  }

  if (candidates.length === 0) {
    fatal('ModelStore chunk not found. No file matches structural fingerprint.');
  }
  if (candidates.length > 1) {
    fatal(`Multiple ModelStore candidates: ${candidates.join(', ')}. Expected exactly 1.`);
  }

  const filename = candidates[0];
  const relPath = path.join(CHUNKS_DIR_REL, filename);
  log(`ModelStore: ${filename}`, 'OK');
  return { relPath, filename };
}

function _discoverModelPicker(chunksDir, modelStoreFilename) {
  if (!modelStoreFilename) {
    fatal('model_store_filename required for ModelPicker discovery');
  }

  const candidates = [];
  const jsFiles = fs.readdirSync(chunksDir).filter(f => f.endsWith('.js') && !f.endsWith('.map'));

  for (const filename of jsFiles) {
    const content = readFile(path.join(chunksDir, filename));

    const hasMsImport = content.includes(`from"./${modelStoreFilename}"`);
    const hasFallbackKey = content.includes('"workspaces-model-fallback:"');
    const hasPicker = content.includes('"ModelPicker"');

    if (hasMsImport && hasFallbackKey && hasPicker) {
      candidates.push(filename);
    }
  }

  if (candidates.length === 0) {
    fatal('ModelPicker chunk not found. No file matches structural fingerprint.');
  }
  if (candidates.length > 1) {
    fatal(`Multiple ModelPicker candidates: ${candidates.join(', ')}. Expected exactly 1.`);
  }

  const filename = candidates[0];
  const relPath = path.join(CHUNKS_DIR_REL, filename);
  log(`ModelPicker: ${filename}`, 'OK');
  return { relPath, filename };
}

module.exports = { discoverFiles };
