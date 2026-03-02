'use strict';

const path = require('path');
const { log, readFile, runCmd } = require('./utils');

function verifyPatches(patches, extractedDir, files) {
  console.log('\n=== Phase 4: Verification ===');

  const fileMap = {
    agent_factory: path.join(extractedDir, files.agent_factory),
    model_store: path.join(extractedDir, files.model_store),
    model_picker: path.join(extractedDir, files.model_picker),
  };
  if (files.agent_interaction_tools) {
    fileMap.agent_interaction_tools = path.join(extractedDir, files.agent_interaction_tools);
  }

  let passed = 0;
  let failed = 0;
  const errors = [];

  for (const patch of patches) {
    const filePath = fileMap[patch.file_key];
    const content = readFile(filePath);
    let ok = true;

    if (patch.verify_present && !content.includes(patch.verify_present)) {
      log(`${patch.name}: expected pattern not found`, 'FAIL');
      ok = false;
    }

    if (patch.verify_absent && content.includes(patch.verify_absent)) {
      log(`${patch.name}: old pattern still present`, 'FAIL');
      ok = false;
    }

    if (ok) {
      log(`${patch.name}: verified`, 'OK');
      passed++;
    } else {
      failed++;
      errors.push(patch.name);
    }
  }

  // Syntax check with node --check
  console.log('  --- Syntax Checks ---');
  for (const [fileKey, filePath] of Object.entries(fileMap)) {
    const result = runCmd(`node --check '${filePath}'`, { check: false });
    if (result !== null) {
      log(`Syntax OK: ${path.basename(filePath)}`, 'OK');
    } else {
      log(`Syntax error in ${path.basename(filePath)}`, 'FAIL');
      failed++;
      errors.push(`Syntax: ${path.basename(filePath)}`);
    }
  }

  // Structural invariant checks
  console.log('  --- Structural Invariants ---');

  const msContent = readFile(fileMap.model_store);
  if (msContent.includes('Promise.allSettled') && msContent.includes('"__all__"')) {
    log('ModelStore: loadModels uses Promise.allSettled + __all__', 'OK');
    passed++;
  } else {
    log('ModelStore: loadModels missing Promise.allSettled or __all__', 'FAIL');
    failed++;
    errors.push('Structural: loadModels');
  }

  if (msContent.includes('new Map') && msContent.includes('getGroupedModels')) {
    log('ModelStore: getGroupedModels uses Map', 'OK');
    passed++;
  } else {
    log('ModelStore: getGroupedModels missing Map', 'FAIL');
    failed++;
    errors.push('Structural: getGroupedModels');
  }

  const afContent = readFile(fileMap.agent_factory);
  const deriveIdx = afContent.indexOf('Derived provider from model ID');
  const activeIdx = afContent.indexOf('Using active provider from store');
  if (deriveIdx > 0 && activeIdx > 0 && deriveIdx < activeIdx) {
    log('AgentFactory: provider derivation before fallback', 'OK');
    passed++;
  } else {
    log('AgentFactory: provider derivation order incorrect', 'FAIL');
    failed++;
    errors.push('Structural: provider derivation order');
  }

  if (afContent.includes('aligning provider')) {
    log('AgentFactory: safety-net aligns provider', 'OK');
    passed++;
  } else {
    log('AgentFactory: safety-net missing align logic', 'FAIL');
    failed++;
    errors.push('Structural: safety-net align');
  }

  if (files.agent_interaction_tools) {
    const aitContent = readFile(fileMap.agent_interaction_tools);
    if (aitContent.includes("ACP_PROVIDERS, } from '../../../../shared/config/provider-config.js'")) {
      log('AgentInteractionTools: ACP_PROVIDERS import present', 'OK');
      passed++;
    } else {
      log('AgentInteractionTools: ACP_PROVIDERS import missing', 'FAIL');
      failed++;
      errors.push('Structural: ACP_PROVIDERS import');
    }

    const resolvedProviderCount = (aitContent.match(/provider: resolvedProvider/g) || []).length;
    if (resolvedProviderCount >= 4) {
      log(`AgentInteractionTools: resolvedProvider in ${resolvedProviderCount} createAgent calls`, 'OK');
      passed++;
    } else {
      log(`AgentInteractionTools: resolvedProvider only in ${resolvedProviderCount}/4 createAgent calls`, 'FAIL');
      failed++;
      errors.push('Structural: resolvedProvider createAgent calls');
    }

    if (!aitContent.includes('provider: ctx.provider, // Inherit ACP provider')) {
      log('AgentInteractionTools: no legacy ctx.provider in createAgent calls', 'OK');
      passed++;
    } else {
      log('AgentInteractionTools: legacy ctx.provider still present in createAgent', 'FAIL');
      failed++;
      errors.push('Structural: legacy ctx.provider');
    }
  }

  console.log(`\n  Results: ${passed} passed, ${failed} failed`);

  if (failed > 0) {
    console.log('  Failed checks:');
    for (const e of errors) {
      console.log(`    - ${e}`);
    }
    return false;
  }

  console.log('  All verifications passed.');
  return true;
}

module.exports = { verifyPatches };
