'use strict';

const path = require('path');
const { log, fatal, readFile, escapeRegExp, header } = require('./utils');

function resolveSymbols(extractedDir, files) {
  header('Phase 2: Symbol Resolution');

  const pcSymbols = resolveProviderConfig(extractedDir, files);
  const msSymbols = resolveModelStore(extractedDir, files, pcSymbols);
  const mpSymbols = resolveModelPicker(extractedDir, files, pcSymbols, msSymbols);

  return { pcSymbols, msSymbols, mpSymbols };
}

function resolveProviderConfig(extractedDir, files) {
  console.log('  --- Provider Config Exports ---');
  const pcPath = path.join(extractedDir, files.provider_config);
  const content = readFile(pcPath);

  const symbols = { provider_exports: {} };

  // Parse export statement
  const exportMatch = content.match(/export\{([^}]+)\}/);
  if (!exportMatch) fatal('Cannot parse export statement in provider config');

  const exportsStr = exportMatch[1];
  const exportPairs = {};  // alias -> localVar
  const localToAlias = {}; // localVar -> alias
  for (const pair of exportsStr.split(',')) {
    const trimmed = pair.trim();
    const m = trimmed.match(/^(\w+)\s+as\s+(\w+)$/);
    if (m) {
      exportPairs[m[2]] = m[1];
      localToAlias[m[1]] = m[2];
    } else if (/^\w+$/.test(trimmed)) {
      exportPairs[trimmed] = trimmed;
      localToAlias[trimmed] = trimmed;
    }
  }

  log(`Parsed ${Object.keys(exportPairs).length} exports`, 'OK');

  let semanticMap = {};

  // v0.2.12 FAST PATH: Object.freeze
  const freezeMatch = content.match(/Object\.freeze\(Object\.defineProperty\(\{__proto__:null,([^}]+)\}/);
  if (freezeMatch) {
    log('Using v0.2.12 Object.freeze resolution (fast path)', 'OK');

    const allFreezeRe = /Object\.freeze\(Object\.defineProperty\(\{__proto__:null,([^}]+)\}/g;
    let fm;
    while ((fm = allFreezeRe.exec(content)) !== null) {
      const freezeStr = fm[1];
      for (const entry of freezeStr.split(',')) {
        const em = entry.trim().match(/^(\w+):(\w+)$/);
        if (em) {
          const [, semName, localVar] = em;
          const alias = localToAlias[localVar] || localVar;
          semanticMap[semName] = alias;
          log(`  ${semName} \u2192 export '${alias}' (local '${localVar}')`, 'OK');
        }
      }
    }

    const canonical = {
      parseCompoundModelId: 'parseCompoundModelId',
      ACP_PROVIDERS: 'ACP_PROVIDERS',
      getDefaultProviderId: 'getDefaultProviderId',
      getProviderConfig: 'getProviderConfigById',
      getProviderConfigById: 'getProviderConfigById',
      getDefaultModelForProvider: 'getDefaultModelForProvider',
      isModelValidForProvider: 'isModelValidForProvider',
      PROVIDER_MODEL_TIERS: 'PROVIDER_MODEL_TIERS',
      activeProviderStore: 'activeProviderStore',
    };

    const resolvedSemantic = {};
    for (const [freezeName, ourName] of Object.entries(canonical)) {
      if (semanticMap[freezeName]) {
        resolvedSemantic[ourName] = semanticMap[freezeName];
      }
    }

    if (!resolvedSemantic.activeProviderStore) {
      log('activeProviderStore not in provider config (expected for v0.2.12)', 'OK');
      resolvedSemantic._v0212_mode = true;
    } else {
      log(`activeProviderStore \u2192 '${resolvedSemantic.activeProviderStore}' (from freeze block)`, 'OK');
    }

    symbols.provider_exports = resolvedSemantic;

    const requiredInPc = ['parseCompoundModelId', 'ACP_PROVIDERS', 'getDefaultProviderId'];
    const missing = requiredInPc.filter(s => !(s in resolvedSemantic));
    if (missing.length === 0) {
      return symbols;
    }
    log(`Fast-path missing symbols ${JSON.stringify(missing)}, falling back to v0.2.11 regex`, 'WARN');
  }

  // v0.2.11 FALLBACK
  log('Using v0.2.11 regex resolution (fallback path)', 'OK');
  semanticMap = {};

  // parseCompoundModelId: function with .split(":")
  for (const [alias, local] of Object.entries(exportPairs)) {
    const pat = new RegExp(`function\\s+${escapeRegExp(local)}\\s*\\([^)]*\\)\\s*\\{[^}]*\\.split\\(":`, 's');
    if (pat.test(content)) {
      semanticMap.parseCompoundModelId = alias;
      log(`parseCompoundModelId \u2192 export '${alias}' (local '${local}')`, 'OK');
      break;
    }
  }

  // ACP_PROVIDERS: object with isDefault
  for (const [alias, local] of Object.entries(exportPairs)) {
    const pat = new RegExp(
      `(?:const|let|var)\\s+${escapeRegExp(local)}\\s*=\\s*\\{[^;]*?isDefault:!0[^;]*?isDefault:!1`, 's'
    );
    if (pat.test(content)) {
      semanticMap.ACP_PROVIDERS = alias;
      log(`ACP_PROVIDERS \u2192 export '${alias}' (local '${local}')`, 'OK');
      break;
    }
  }

  // activeProviderStore: new instance of class with activeProviderId + setActiveProvider
  for (const [alias, local] of Object.entries(exportPairs)) {
    const pat = new RegExp(`(?:const|let|var)\\s+${escapeRegExp(local)}\\s*=\\s*new\\s+(\\w+)`);
    const m = pat.exec(content);
    if (m) {
      const className = m[1];
      const classPat = new RegExp(
        `class\\s+${escapeRegExp(className)}\\b[^{]*\\{.*?activeProviderId.*?setActiveProvider`, 's'
      );
      if (classPat.test(content)) {
        semanticMap.activeProviderStore = alias;
        log(`activeProviderStore \u2192 export '${alias}' (local '${local}')`, 'OK');
        break;
      }
    }
  }

  // getDefaultProviderId: function returning .id
  for (const [alias, local] of Object.entries(exportPairs)) {
    const pat = new RegExp(`function\\s+${escapeRegExp(local)}\\s*\\(\\)\\s*\\{\\s*return\\s+\\w+\\(\\)\\.id\\s*\\}`);
    if (pat.test(content)) {
      semanticMap.getDefaultProviderId = alias;
      log(`getDefaultProviderId \u2192 export '${alias}' (local '${local}')`, 'OK');
      break;
    }
  }

  // getProviderConfigById: function looking up from ACP_PROVIDERS
  const acpLocal = exportPairs[semanticMap.ACP_PROVIDERS] || '';
  if (acpLocal) {
    for (const [alias, local] of Object.entries(exportPairs)) {
      if (Object.values(semanticMap).includes(alias)) continue;
      const pat = new RegExp(
        `function\\s+${escapeRegExp(local)}\\s*\\(\\w+\\)\\s*\\{[^}]*${escapeRegExp(acpLocal)}\\[`, 's'
      );
      if (pat.test(content)) {
        semanticMap.getProviderConfigById = alias;
        log(`getProviderConfigById \u2192 export '${alias}' (local '${local}')`, 'OK');
        break;
      }
    }
  }

  // getDefaultModelForProvider: function taking 2 args with "auggie" or "balanced"
  for (const [alias, local] of Object.entries(exportPairs)) {
    if (Object.values(semanticMap).includes(alias)) continue;
    const pat = new RegExp(`function\\s+${escapeRegExp(local)}\\s*\\(\\w+\\s*,\\s*\\w+\\)\\s*\\{`);
    const m = pat.exec(content);
    if (m) {
      const snippet = content.slice(m.index, m.index + 500);
      if (snippet.includes('auggie') || snippet.includes('balanced')) {
        semanticMap.getDefaultModelForProvider = alias;
        log(`getDefaultModelForProvider \u2192 export '${alias}' (local '${local}')`, 'OK');
        break;
      }
    }
  }

  // isModelValidForProvider: function calling parseCompoundModelId
  const parseLocal = exportPairs[semanticMap.parseCompoundModelId] || '';
  if (parseLocal) {
    for (const [alias, local] of Object.entries(exportPairs)) {
      if (Object.values(semanticMap).includes(alias)) continue;
      const pat = new RegExp(
        `function\\s+${escapeRegExp(local)}\\s*\\(\\w+\\s*,\\s*\\w+\\)\\s*\\{[^}]*${escapeRegExp(parseLocal)}\\(`, 's'
      );
      if (pat.test(content)) {
        semanticMap.isModelValidForProvider = alias;
        log(`isModelValidForProvider \u2192 export '${alias}' (local '${local}')`, 'OK');
        break;
      }
    }
  }

  // PROVIDER_MODEL_TIERS: object with fast/balanced/smart
  for (const [alias, local] of Object.entries(exportPairs)) {
    if (Object.values(semanticMap).includes(alias)) continue;
    const pat = new RegExp(
      `(?:const|let|var)\\s+${escapeRegExp(local)}\\s*=\\s*\\{[^;]*?fast:\\s*"[^"]*"[^;]*?balanced:\\s*"[^"]*"[^;]*?smart:\\s*"[^"]*"`, 's'
    );
    if (pat.test(content)) {
      semanticMap.PROVIDER_MODEL_TIERS = alias;
      log(`PROVIDER_MODEL_TIERS \u2192 export '${alias}' (local '${local}')`, 'OK');
      break;
    }
  }

  symbols.provider_exports = semanticMap;

  const required = ['parseCompoundModelId', 'ACP_PROVIDERS', 'activeProviderStore',
    'getDefaultProviderId', 'getProviderConfigById'];
  const missing = required.filter(s => !(s in semanticMap));
  if (missing.length > 0) {
    fatal(`Failed to resolve provider config symbols: ${JSON.stringify(missing)}`);
  }

  return symbols;
}

function resolveModelStore(extractedDir, files, pcSymbols) {
  console.log('  --- ModelStore Imports ---');
  const msPath = path.join(extractedDir, files.model_store);
  const content = readFile(msPath);

  const symbols = {
    provider_exports: pcSymbols.provider_exports,
    provider_imports: {},
    resolved: {},
  };

  // Parse import from provider config
  const pcFilename = files.provider_config_filename || path.basename(files.provider_config);
  const importPat = new RegExp(`import\\s*\\{([^}]+)\\}\\s*from\\s*"\\./${escapeRegExp(pcFilename)}"`);
  const m = importPat.exec(content);
  if (!m) fatal('Cannot find import from provider config in ModelStore');

  const importMap = {};
  for (const pair of m[1].split(',')) {
    const trimmed = pair.trim();
    const m2 = trimmed.match(/^(\w+)\s+as\s+(\w+)$/);
    if (m2) {
      importMap[m2[1]] = m2[2];
    } else if (trimmed) {
      importMap[trimmed] = trimmed;
    }
  }
  symbols.provider_imports = importMap;

  // Build resolved map
  const resolved = {};
  for (const [semanticName, exportAlias] of Object.entries(pcSymbols.provider_exports)) {
    if (semanticName.startsWith('_')) continue;
    if (importMap[exportAlias]) {
      resolved[semanticName] = importMap[exportAlias];
      log(`${semanticName} \u2192 '${importMap[exportAlias]}' (via export '${exportAlias}')`, 'OK');
    }
  }

  // v0.2.12: activeProviderStore from separate chunk
  const isV0212 = pcSymbols.provider_exports._v0212_mode;
  if (isV0212 && !resolved.activeProviderStore) {
    const allImports = [...content.matchAll(/import\s*\{([^}]+)\}\s*from\s*"([^"]+)"/g)];
    for (const [, impStr, impSource] of allImports) {
      if (impSource.endsWith(pcFilename)) continue;
      for (const pair of impStr.split(',')) {
        const trimmed = pair.trim();
        const m2 = trimmed.match(/^(\w+)\s+as\s+(\w+)$/);
        const localAlias = m2 ? m2[2] : trimmed;
        if (content.includes(`${localAlias}.activeProviderId`)) {
          resolved.activeProviderStore = localAlias;
          log(`activeProviderStore \u2192 '${localAlias}' (from ${path.basename(impSource)})`, 'OK');
          break;
        }
      }
      if (resolved.activeProviderStore) break;
    }
  }

  symbols.resolved = resolved;

  const required = ['parseCompoundModelId', 'ACP_PROVIDERS', 'activeProviderStore'];
  const missingMs = required.filter(s => !(s in resolved));
  if (missingMs.length > 0) {
    fatal(`Failed to resolve ModelStore symbols: ${JSON.stringify(missingMs)}`);
  }

  // Cross-validate
  const parseAlias = resolved.parseCompoundModelId;
  const acpAlias = resolved.ACP_PROVIDERS;
  const apsAlias = resolved.activeProviderStore;
  const patchMarker = '"__all__"';

  if (!content.includes(`${apsAlias}.activeProviderId`) && !content.includes(patchMarker)) {
    log(`Warning: ${apsAlias}.activeProviderId not found in ModelStore (may already be patched)`, 'WARN');
  }
  if (!content.includes(acpAlias) && !content.includes(patchMarker)) {
    log(`Warning: ${acpAlias} not found in ModelStore`, 'WARN');
  }

  return symbols;
}

function resolveModelPicker(extractedDir, files, pcSymbols, msSymbols) {
  console.log('  --- ModelPicker Imports ---');
  const mpPath = path.join(extractedDir, files.model_picker);
  const content = readFile(mpPath);

  const symbols = {
    provider_imports: {},
    modelstore_imports: {},
    svelte_imports: {},
    resolved: {},
  };

  // Parse import from provider config
  const pcFilename = files.provider_config_filename || path.basename(files.provider_config);
  const importPat = new RegExp(`import\\s*\\{([^}]+)\\}\\s*from\\s*"\\./${escapeRegExp(pcFilename)}"`);
  const m = importPat.exec(content);
  if (!m) fatal('Cannot find import from provider config in ModelPicker');

  const pcImportMap = {};
  for (const pair of m[1].split(',')) {
    const trimmed = pair.trim();
    const m2 = trimmed.match(/^(\w+)\s+as\s+(\w+)$/);
    if (m2) pcImportMap[m2[1]] = m2[2];
    else if (trimmed) pcImportMap[trimmed] = trimmed;
  }
  symbols.provider_imports = pcImportMap;

  // Resolve provider config symbols in ModelPicker
  const resolved = {};
  for (const [semanticName, exportAlias] of Object.entries(pcSymbols.provider_exports)) {
    if (pcImportMap[exportAlias]) {
      resolved[semanticName] = pcImportMap[exportAlias];
    }
  }

  // Parse import from ModelStore
  const msFilename = files.model_store_filename || path.basename(files.model_store);
  const msImportPat = new RegExp(`import\\s*\\{([^}]+)\\}\\s*from\\s*"\\./${escapeRegExp(msFilename)}"`);
  const msM = msImportPat.exec(content);
  if (msM) {
    const msImportMap = {};
    for (const pair of msM[1].split(',')) {
      const trimmed = pair.trim();
      const m2 = trimmed.match(/^(\w+)\s+as\s+(\w+)$/);
      if (m2) msImportMap[m2[1]] = m2[2];
      else if (trimmed) msImportMap[trimmed] = trimmed;
    }
    symbols.modelstore_imports = msImportMap;
  }

  // Parse import from Svelte runtime
  const svelteImportPat = /import\s*\{([^}]+)\}\s*from\s*"\.\/(\w+\.js)"/g;
  let svelteM;
  while ((svelteM = svelteImportPat.exec(content)) !== null) {
    const importStr = svelteM[1];
    const asCount = (importStr.match(/ as /g) || []).length;
    if (asCount > 10) {
      const svelteMap = {};
      for (const pair of importStr.split(',')) {
        const trimmed = pair.trim();
        const m2 = trimmed.match(/^(\w+)\s+as\s+(\w+)$/);
        if (m2) svelteMap[m2[1]] = m2[2];
        else if (trimmed) svelteMap[trimmed] = trimmed;
      }
      symbols.svelte_imports = svelteMap;
      break;
    }
  }

  // Resolve Svelte primitives by structural patterns
  // activeProviderStore
  let apsAlias = resolved.activeProviderStore;
  if (!apsAlias) {
    // v0.2.12 fallback
    const apsMatches = [...content.matchAll(/(\w+)\.activeProviderId/g)].map(m2 => m2[1]);
    if (apsMatches.length > 0) {
      const counter = {};
      for (const a of apsMatches) counter[a] = (counter[a] || 0) + 1;
      apsAlias = Object.entries(counter).sort((a, b) => b[1] - a[1])[0][0];
      resolved.activeProviderStore = apsAlias;
    }
  }
  if (apsAlias) {
    log(`activeProviderStore \u2192 '${apsAlias}' in ModelPicker`, 'OK');
  } else {
    log('activeProviderStore not found in ModelPicker', 'WARN');
  }

  const gpcbiAlias = resolved.getProviderConfigById;
  if (gpcbiAlias) {
    log(`getProviderConfigById \u2192 '${gpcbiAlias}' in ModelPicker`, 'OK');
  }

  // isAgentProviderOverride pattern
  if (apsAlias) {
    const overridePat = new RegExp(
      `(\\w+)\\s*=\\s*(\\w+)\\s*\\(\\s*\\(\\s*\\)\\s*=>\\s*(\\w+)\\s*\\(\\s*(\\w+)\\s*\\)\\s*!==\\s*`
      + escapeRegExp(apsAlias) + `\\.activeProviderId\\s*\\)`
    );
    const om = overridePat.exec(content);
    if (om) {
      resolved.isAgentProviderOverride = om[1];
      resolved.computed = om[2];
      resolved.get = om[3];
      resolved.effectiveProviderId = om[4];
      log(`isAgentProviderOverride \u2192 '${om[1]}' (override pattern found)`, 'OK');
      log(`computed \u2192 '${om[2]}', get \u2192 '${om[3]}', effectiveProviderId \u2192 '${om[4]}'`, 'OK');
    } else {
      log('isAgentProviderOverride original pattern not found (may be patched)', 'WARN');
      _resolvePatchedModelPicker(content, resolved, apsAlias);
    }
  }

  // Identify effect and set
  let effectAlias = null;
  const epid = resolved.effectiveProviderId;
  const getAlias = resolved.get;
  if (epid && getAlias) {
    const effectPat = new RegExp(
      `(\\w+)\\s*\\(\\s*\\(\\s*\\)\\s*=>\\s*\\{[^}]*?`
      + escapeRegExp(getAlias) + `\\s*\\(\\s*` + escapeRegExp(epid) + `\\s*\\)`
    );
    for (const em of content.matchAll(new RegExp(effectPat.source, 'g'))) {
      effectAlias = em[1];
      resolved.effect = effectAlias;
      log(`effect \u2192 '${effectAlias}'`, 'OK');
      break;
    }
  }

  // Find set (signal setter)
  if (epid && getAlias && effectAlias) {
    const setPat = /(\w+)\s*\(\s*(\w+)\s*,\s*(?:null|!0|!1)\s*\)/g;
    const effSearch = `${effectAlias}(()=>{`;
    let startPos = 0;
    while (true) {
      const effIdx = content.indexOf(effSearch, startPos);
      if (effIdx < 0) break;
      const effBody = content.slice(effIdx, effIdx + 500);
      if (effBody.includes('getModelsForProvider') || effBody.includes('activeProviderId')) {
        const setMatches = [...effBody.matchAll(setPat)];
        if (setMatches.length > 0) {
          resolved.set = setMatches[0][1];
          resolved.agentProviderModels = setMatches[0][2];
          if (setMatches.length > 1) resolved.isLoadingAgentModels = setMatches[1][2];
          if (setMatches.length > 2) resolved.agentModelError = setMatches[2][2];
          log(`set \u2192 '${resolved.set}'`, 'OK');
          log(`agentProviderModels \u2192 '${resolved.agentProviderModels}', isLoadingAgentModels \u2192 '${resolved.isLoadingAgentModels || '?'}', agentModelError \u2192 '${resolved.agentModelError || '?'}'`, 'OK');
        }
        break;
      }
      startPos = effIdx + effSearch.length;
    }
  }

  // modelStore instance
  const msMatches = [...content.matchAll(/(\w+)\.availableModels/g)].map(m2 => m2[1]);
  if (msMatches.length > 0) {
    const counter = {};
    for (const a of msMatches) counter[a] = (counter[a] || 0) + 1;
    const msAlias = Object.entries(counter).sort((a, b) => b[1] - a[1])[0][0];
    if (msAlias !== 'this') {
      resolved.modelStore = msAlias;
      log(`modelStore \u2192 '${msAlias}'`, 'OK');
    }
  }

  symbols.resolved = resolved;
  return symbols;
}

function _resolvePatchedModelPicker(content, resolved, apsAlias) {
  const falseComputedPat = /(\w+)\s*=\s*(\w+)\s*\(\s*\(\s*\)\s*=>\s*!1\s*\)/g;
  for (const m of content.matchAll(falseComputedPat)) {
    const start = Math.max(0, m.index - 300);
    const end = Math.min(content.length, m.index + m[0].length + 500);
    const ctx = content.slice(start, end);

    if (apsAlias && ctx.includes(`${apsAlias}.activeProviderId`)) {
      resolved.isAgentProviderOverride = m[1];
      resolved.computed = m[2];
      log(`isAgentProviderOverride \u2192 '${m[1]}' (patched pattern)`, 'OK');
      log(`computed \u2192 '${m[2]}' (from patched pattern)`, 'OK');

      const effPat = /(\w+)\s*\(\s*\(\s*\)\s*=>\s*\{\s*(\w+)\s*\(\s*(\w+)\s*\)/;
      const effM = effPat.exec(ctx);
      if (effM) {
        resolved.effect = effM[1];
        resolved.get = effM[2];
        resolved.effectiveProviderId = effM[3];
        log(`effect \u2192 '${effM[1]}', get \u2192 '${effM[2]}', effectiveProviderId \u2192 '${effM[3]}'`, 'OK');
      }
      break;
    }
  }
}

module.exports = { resolveSymbols };
