'use strict';

const fs = require('fs');
const path = require('path');
const {
  STATE_DIR, INTENT_APP, INTENT_ASAR, INTENT_PLIST, VERSION_FILE,
  DEFAULT_EXTRACTED, BACKUP_ASAR, BACKUP_UNPACKED, OUTPUT_ASAR,
  CHUNKS_DIR_REL,
} = require('./constants');
const { log, fatal, readFile, writeFile, runCmd, runCmdArgs, c, header, banner } = require('./utils');
const { preflightChecks } = require('./preflight');
const { discoverFiles } = require('./discovery');
const { resolveSymbols } = require('./symbols');
const { buildPatches } = require('./patches');
const { applyPatches } = require('./engine');
const { verifyPatches } = require('./verify');
const { extractApp, repackAndInstall, writePatchedFilesManifest } = require('./install');

function parseArgs(argv) {
  const args = {
    extractedDir: null,
    dryRun: false,
    discoverOnly: false,
    noInstall: false,
    legacy: false,
    status: false,
    rollback: false,
  };

  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--extracted-dir') {
      if (i + 1 >= rest.length || rest[i + 1].startsWith('-')) {
        fatal('--extracted-dir requires a path argument');
      }
      args.extractedDir = rest[++i];
    } else if (arg === '--dry-run') {
      args.dryRun = true;
    } else if (arg === '--discover-only') {
      args.discoverOnly = true;
    } else if (arg === '--no-install') {
      args.noInstall = true;
    } else if (arg === '--legacy') {
      args.legacy = true;
    } else if (arg === '--status') {
      args.status = true;
    } else if (arg === '--rollback') {
      args.rollback = true;
    } else if (arg === '--help' || arg === '-h') {
      console.log(`Usage: intent-patch [options]

Options:
  --extracted-dir <path>  Path to pre-extracted app directory
  --dry-run               Show what would be done without modifying files
  --discover-only         Only discover files and resolve symbols
  --no-install            Patch and verify but don't install
  --legacy                Legacy mode: copy pre-built patches (v0.2.11 only)
  --status                Print patch status and exit
  --rollback              Restore original unpatched app.asar from backup
  --help, -h              Show this help`);
      process.exit(0);
    } else if (arg.startsWith('-')) {
      fatal(`Unknown option: ${arg}\nRun with --help for usage.`);
    } else {
      // Bare positional path as --extracted-dir
      args.extractedDir = arg;
    }
  }

  return args;
}

function getAppVersion() {
  if (!fs.existsSync(INTENT_APP)) return '';
  try {
    return runCmd(`defaults read "${INTENT_PLIST}" CFBundleShortVersionString`, { check: false }) || '';
  } catch { return ''; }
}

function getPatchedVersion() {
  if (!fs.existsSync(VERSION_FILE)) return '';
  try { return readFile(VERSION_FILE).trim(); } catch { return ''; }
}

function savePatchedVersion(version) {
  writeFile(VERSION_FILE, version + '\n');
}

async function handleRollback() {
  banner('Intent Multi-Provider Auto-Patcher — Rollback');

  // Check backup exists
  if (!fs.existsSync(BACKUP_ASAR)) {
    fatal('No backup found at ' + BACKUP_ASAR + '\nCannot rollback. Backup is created during the first install.');
  }
  log('Backup found: ' + BACKUP_ASAR, 'OK');

  // Check if already unpatched
  const patchedVersion = getPatchedVersion();
  if (!patchedVersion) {
    log('No .patched-version found — may already be at original state', 'WARN');
  }

  // Check Intent app exists
  if (!fs.existsSync(INTENT_APP)) {
    fatal('Intent app not found at ' + INTENT_APP);
  }

  // Prompt sudo early
  log('Requesting sudo access...');
  if (process.stdin.isTTY) {
    runCmdArgs(['sudo', '-v'], { interactive: true, check: false });
  }

  // Kill Intent
  log('Killing Intent by Augment...');
  runCmdArgs(['pkill', '-f', 'Intent by Augment'], { check: false });
  await new Promise(resolve => setTimeout(resolve, 2000));

  // Restore backup asar
  log('Restoring original app.asar...');
  try {
    runCmdArgs(['sudo', 'cp', BACKUP_ASAR, INTENT_ASAR]);
    log('app.asar restored', 'OK');
  } catch (e) {
    fatal('Failed to restore app.asar: ' + e.message);
  }

  // Restore unpacked if backup symlink exists
  if (fs.existsSync(BACKUP_UNPACKED)) {
    try {
      const target = fs.readlinkSync(BACKUP_UNPACKED);
      // The unpacked dir in the app should already be the original
      // (backup.unpacked is a symlink to the original INTENT_UNPACKED)
      log('Unpacked files intact (symlink to original)', 'OK');
    } catch {
      log('Could not read backup unpacked symlink', 'WARN');
    }
  }

  // Remove xattr
  log('Removing macOS protection flags...');
  runCmdArgs(['sudo', 'xattr', '-cr', INTENT_APP], { check: false });

  // Remove ElectronAsarIntegrity
  log('Removing ElectronAsarIntegrity...');
  runCmdArgs(['sudo', '/usr/libexec/PlistBuddy', '-c', 'Delete :ElectronAsarIntegrity', INTENT_PLIST], { check: false });

  // Re-sign
  log('Re-signing app...');
  try {
    runCmdArgs(['sudo', 'codesign', '--force', '--deep', '--sign', '-', INTENT_APP]);
    log('App re-signed', 'OK');
  } catch (e) {
    log('Codesign failed: ' + e.message, 'FAIL');
  }

  // Clear patch state
  if (fs.existsSync(VERSION_FILE)) {
    try {
      fs.unlinkSync(VERSION_FILE);
      log('Cleared patch state', 'OK');
    } catch { /* ignore */ }
  }

  log('Rollback complete. Intent restored to original state.', 'OK');
}

function handleStatus() {
  const appVersion = getAppVersion();
  const patchedVersion = getPatchedVersion();

  if (!appVersion) {
    console.log(`[intent-patch] ${c.red}Intent not found${c.reset}`);
    process.exit(1);
  } else if (appVersion === patchedVersion) {
    console.log(`[intent-patch] v${appVersion} \u2014 ${c.green}patched \u2713${c.reset}`);
  } else if (!patchedVersion) {
    console.log(`[intent-patch] v${appVersion} \u2014 ${c.yellow}not patched!${c.reset} Run: npx github:lploc94/intent_patch`);
  } else {
    console.log(`[intent-patch] v${appVersion} \u2014 ${c.yellow}update detected${c.reset} (was v${patchedVersion})! Run: npx github:lploc94/intent_patch`);
  }
  process.exit(0);
}

async function handleLegacy(args) {
  header('Legacy Mode (pre-built patches)');
  console.log(`  ${c.yellow}Warning: Legacy mode only works for Intent v0.2.11${c.reset}`);
  console.log('');

  const patchesDir = path.join(__dirname, '..', 'patches');
  const extractedDir = args.extractedDir || DEFAULT_EXTRACTED;

  if (!fs.existsSync(extractedDir)) {
    fatal(`extracted directory not found at ${extractedDir}\n\nExtract first:\n  npx intent-patch (without --legacy)`);
  }

  // Copy patched files
  header('Step 1: Copy patched files');
  const filesToCopy = [
    'dist/features/agent/services/agent-factory.js',
    'dist/renderer/app/immutable/chunks/BTPDcoPQ.js',
    'dist/renderer/app/immutable/chunks/CfKn743W.js',
  ];
  for (const rel of filesToCopy) {
    const src = path.join(patchesDir, rel);
    const dst = path.join(extractedDir, rel);
    if (!fs.existsSync(src)) fatal(`Patch file not found: ${src}`);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  }
  console.log('Done.');

  // Write manifest
  console.log('\nWriting patched-files.json manifest...');
  const manifest = {
    model_store: 'BTPDcoPQ.js',
    model_picker: 'CfKn743W.js',
    chunks_dir: 'dist/renderer/app/immutable/chunks',
  };
  writeFile(path.join(extractedDir, 'patched-files.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log('  OK  patched-files.json written');

  // Verify (hardcoded v0.2.11 checks)
  header('Step 2: Verify');
  const checks = [
    { rel: 'dist/features/agent/services/agent-factory.js', desc: 'Patch 6A: ACP_PROVIDERS import',
      must_contain: 'import { ACP_PROVIDERS, getDefaultModelForProvider' },
    { rel: 'dist/features/agent/services/agent-factory.js', desc: 'Patch 6B: derive provider from model ID',
      must_contain: "if (!provider && config.model) {\n                const { providerId } = parseCompoundModelId(config.model);",
      must_not_contain: "if (!provider && config.model && config.model.includes(':'))" },
    { rel: 'dist/features/agent/services/agent-factory.js', desc: 'Patch 6C: safety-net align provider',
      must_contain: 'Safety net: aligning provider to match compound model',
      must_not_contain: 'Safety net: cross-provider model mismatch in agent creation' },
    { rel: 'dist/features/agent/services/agent-factory.js', desc: 'Patch 6C+: re-validate after alignment',
      must_contain: 'Re-resolved model after provider alignment' },
    { rel: 'dist/renderer/app/immutable/chunks/BTPDcoPQ.js', desc: 'Patch 1: loadModels fetches all providers',
      must_contain: 'loadedForProviderId==="__all__"',
      must_not_contain: 'loadedForProviderId===e||this.isLoadingModels' },
    { rel: 'dist/renderer/app/immutable/chunks/BTPDcoPQ.js', desc: 'Patch 1: Promise.allSettled',
      must_contain: 'Promise.allSettled' },
    { rel: 'dist/renderer/app/immutable/chunks/BTPDcoPQ.js', desc: 'Patch 2: reloadModelsForProvider simplified',
      must_contain: 'Reloading models for all providers',
      must_not_contain: 'Reloading models for provider change' },
    { rel: 'dist/renderer/app/immutable/chunks/BTPDcoPQ.js', desc: 'Patch 3: selectModel uses parsed providerId',
      must_contain: 'Ce(e).providerId;this.providerModels.set(t,e)',
      must_not_contain: 'H.activeProviderId;this.providerModels.set(t,e)' },
    { rel: 'dist/renderer/app/immutable/chunks/BTPDcoPQ.js', desc: 'Patch 4: getGroupedModels groups by provider',
      must_contain: 'getGroupedModels(){if(this.availableModels.length===0)return[];const e=new Map',
      must_not_contain: 'getGroupedModels(){const e=H.activeProviderId' },
    { rel: 'dist/renderer/app/immutable/chunks/CfKn743W.js', desc: 'Patch 7A: isAgentProviderOverride always false',
      must_contain: 'Ie=H(()=>!1)',
      must_not_contain: 'Ie=H(()=>t(be)!==mt.activeProviderId)' },
    { rel: 'dist/renderer/app/immutable/chunks/CfKn743W.js', desc: 'Patch 7B: effect clears agentProviderModels',
      must_contain: 'nt(()=>{t(be);h(xe,null),h(re,!1),h(se,null)})',
      must_not_contain: 'ce.getModelsForProvider(r).then' },
  ];

  let passed = 0;
  let failedCount = 0;
  const errs = [];
  for (const check of checks) {
    const fullPath = path.join(extractedDir, check.rel);
    if (!fs.existsSync(fullPath)) {
      console.log(`  MISSING  ${check.desc}`);
      failedCount++;
      errs.push(check.desc);
      continue;
    }
    const content = readFile(fullPath);
    let ok = true;
    if (check.must_contain && !content.includes(check.must_contain)) {
      console.log(`  FAIL     ${check.desc}`);
      console.log('           Expected pattern not found');
      ok = false;
    }
    if (check.must_not_contain && content.includes(check.must_not_contain)) {
      console.log(`  FAIL     ${check.desc}`);
      console.log('           Old pattern still present');
      ok = false;
    }
    if (ok) {
      console.log(`  OK       ${check.desc}`);
      passed++;
    } else {
      failedCount++;
      errs.push(check.desc);
    }
  }

  console.log(`\nResults: ${passed} passed, ${failedCount} failed, ${passed + failedCount} total`);
  if (failedCount > 0) {
    console.log('\nFailed checks:');
    for (const e of errs) console.log(`  - ${e}`);
    fatal('Legacy verification failed');
  }
  console.log('All patches verified.');

  // Repack + Install
  if (!args.noInstall) {
    const { preflightChecks: pf } = require('./preflight');
    const asarMode = pf(false);
    await repackAndInstall(extractedDir, {
      model_store: path.join(CHUNKS_DIR_REL, 'BTPDcoPQ.js'),
      model_picker: path.join(CHUNKS_DIR_REL, 'CfKn743W.js'),
      agent_factory: 'dist/features/agent/services/agent-factory.js',
    }, false, asarMode);
    savePatchedVersion(getAppVersion());
  } else {
    // Just repack
    const { checkAsarApi } = require('./preflight');
    const asarMode = checkAsarApi();
    try {
      if (asarMode === 'library') {
        const asar = require('@electron/asar');
        await asar.createPackage(extractedDir, OUTPUT_ASAR);
      } else {
        runCmdArgs(['npx', '--yes', 'asar', 'pack', extractedDir, OUTPUT_ASAR], { timeout: 300000 });
      }
      log(`Repacked to ${OUTPUT_ASAR}`, 'OK');
    } catch (e) {
      fatal(`asar pack failed: ${e.message}`);
    }
  }
}

async function main() {
  const args = parseArgs(process.argv);

  // Ensure state directory exists
  fs.mkdirSync(STATE_DIR, { recursive: true });

  // --status: print and exit
  if (args.status) {
    handleStatus();
    return;
  }

  // --rollback: restore original app
  if (args.rollback) {
    await handleRollback();
    return;
  }

  // --legacy: legacy mode
  if (args.legacy) {
    await handleLegacy(args);
    return;
  }

  banner('Intent Multi-Provider Auto-Patcher');

  const skipInstall = args.noInstall || args.dryRun || args.discoverOnly;
  const extractedDir = args.extractedDir || DEFAULT_EXTRACTED;

  // Version tracking
  const appVersion = getAppVersion();
  const patchedVersion = getPatchedVersion();

  if (appVersion) {
    console.log(`  App version:     ${c.cyan}${appVersion}${c.reset}`);
    console.log(`  Patched version: ${patchedVersion ? c.green + patchedVersion + c.reset : c.dim + 'none' + c.reset}`);

    if (appVersion === patchedVersion) {
      console.log(`  Mode: ${c.yellow}Repair${c.reset} (re-patch v${appVersion})`);
    } else {
      if (patchedVersion) {
        console.log(`  ${c.yellow}!${c.reset} Version changed: v${patchedVersion} \u2192 v${appVersion}`);
      }
      console.log(`  Mode: ${c.green}Install${c.reset}`);
      // Clean stale artifacts
      if (!args.extractedDir) {
        for (const p of [DEFAULT_EXTRACTED, BACKUP_ASAR, BACKUP_UNPACKED, OUTPUT_ASAR]) {
          if (fs.existsSync(p)) {
            try {
              const stat = fs.lstatSync(p);
              if (stat.isDirectory()) {
                fs.rmSync(p, { recursive: true, force: true });
              } else {
                fs.unlinkSync(p);
              }
            } catch { /* ignore */ }
          }
        }
      }
    }
    console.log('');
  }

  // Phase 0: Preflight
  const asarMode = preflightChecks(skipInstall);

  // Extract if needed (extractApp handles stale detection internally)
  if (!args.extractedDir) {
    await extractApp(extractedDir, asarMode);
  }

  if (!fs.existsSync(extractedDir) || !fs.statSync(extractedDir).isDirectory()) {
    fatal(`Extracted directory not found: ${extractedDir}`);
  }

  // Phase 1: File Discovery
  const files = discoverFiles(extractedDir);

  // Phase 2: Symbol Resolution
  const { pcSymbols, msSymbols, mpSymbols } = resolveSymbols(extractedDir, files);

  if (args.discoverOnly) {
    header('Discovery Complete');
    console.log(`  Provider Config: ${files.provider_config}`);
    console.log(`  ModelStore:      ${files.model_store}`);
    console.log(`  ModelPicker:     ${files.model_picker}`);
    console.log(`  Agent Factory:   ${files.agent_factory}`);
    console.log(`  Agent Interact:  ${files.agent_interaction_tools || '(not found \u2014 patches 8A-8D skipped)'}`);
    console.log(`  Main Index:      ${files.main_index || '(not found \u2014 patch 9A skipped)'}`);
    console.log(`  Agent Missing:   ${files.agent_missing_ipc}`);
    console.log('\n  Provider Config Exports:');
    for (const [name, alias] of Object.entries(pcSymbols.provider_exports)) {
      console.log(`    ${name} \u2192 '${alias}'`);
    }
    console.log('\n  ModelStore Resolved:');
    for (const [name, alias] of Object.entries(msSymbols.resolved)) {
      console.log(`    ${name} \u2192 '${alias}'`);
    }
    console.log('\n  ModelPicker Resolved:');
    for (const [name, alias] of Object.entries(mpSymbols.resolved)) {
      console.log(`    ${name} \u2192 '${alias}'`);
    }
    return;
  }

  // Phase 3: Build and Apply Patches
  const patches = buildPatches(files, pcSymbols, msSymbols, mpSymbols, extractedDir);
  const success = applyPatches(patches, extractedDir, files, args.dryRun);

  if (!success) {
    fatal('Some patches failed to apply. See errors above.');
  }

  if (args.dryRun) {
    header('Dry Run Complete');
    console.log('  No files were modified.');
    return;
  }

  // Write manifest
  writePatchedFilesManifest(extractedDir, files);

  // Phase 4: Verification
  if (!verifyPatches(patches, extractedDir, files)) {
    fatal('Verification failed. Patches may be incomplete.');
  }

  // Create or migrate enhancer config
  if (!args.dryRun && !args.discoverOnly) {
    const enhancerCfg = path.join(STATE_DIR, 'enhancer.json');
    const defaultCfg = {
      providerTools: {
        'claude-code': { tool: 'claude', args: ['--print'] },
        'codex': { tool: 'codex', args: [] },
      },
      systemPrompt: 'You are a prompt enhancer. Your job is to take the user\'s prompt and rewrite it to be clearer, more specific, and more actionable.\n\nRules:\n- ALWAYS respond in the same language as the user\'s prompt. If the prompt is in Vietnamese, respond in Vietnamese. If in English, respond in English. If the language is ambiguous or the prompt is code-only, default to English.\n- Use the provided context (workspace path, conversation history) to make the prompt more grounded and specific.\n- Expand vague references into concrete details when context makes it possible.\n- Preserve the user\'s intent — do not change what they\'re asking for, only how they ask it.\n- Keep the enhanced prompt concise. Add detail where it helps, but don\'t pad with unnecessary filler.\n- At the end of the enhanced prompt, add a "## Suggested references" section listing specific files, functions, or concepts the agent should examine. ONLY include references that are explicitly mentioned in the provided context or conversation history — do not guess or fabricate paths. If no relevant references can be identified from the context, omit this section entirely. Examples:\n  - "Read `src/auth/login.ts` — contains the current login flow"\n  - "Check function `validateToken()` in `src/utils/jwt.ts`"\n  - "Search for usages of `UserContext` across the codebase"\n  - "Look up OAuth2 PKCE flow documentation"\n- Do not use any tools.\n- Reply with the enhanced prompt wrapped in <augment-enhanced-prompt> tags.',
      maxConversationMessages: 20,
      maxContextChars: 50000,
      maxBuffer: 5,
      timeout: 60000,
    };

    // Migration helper: detect old default prompts that should be overwritten
    const OLD_DEFAULTS = [
      // old cli.js default (exact, trimmed)
      'You are a prompt enhancer. Given the user\'s prompt and the provided workspace context and conversation history, rewrite the prompt to be clearer, more specific, less ambiguous, and leverage the available context. Do not use any tools. Reply with the enhanced prompt wrapped in <augment-enhanced-prompt> tags.',
      // old patches.js fallback (exact, trimmed)
      'You are a helpful assistant that enhances prompts. Do not use any tools.',
    ];

    function _isOldDefault(s) {
      if (!s || typeof s !== 'string') return true;  // null/undefined/empty → treat as old
      const t = s.trim();
      if (!t) return true;                            // whitespace-only → old
      return OLD_DEFAULTS.includes(t);                // full exact match only
    }

    if (!fs.existsSync(enhancerCfg)) {
      fs.writeFileSync(enhancerCfg, JSON.stringify(defaultCfg, null, 2) + '\n');
      log('Created default enhancer config: ~/.intent-patch/enhancer.json', 'OK');
    } else {
      // Migrate existing config — convert old tool/args to providerTools + update systemPrompt
      try {
        const existing = JSON.parse(fs.readFileSync(enhancerCfg, 'utf8'));
        let migrated = false;
        // Migrate old tool/args → providerTools
        if (!('providerTools' in existing)) {
          if ('tool' in existing) {
            if (existing.tool) {
              // Truthy tool → map to all built-in providers (preserve global behavior)
              existing.providerTools = {
                'claude-code': { tool: existing.tool, args: existing.args || ['--print'] },
                'codex':       { tool: existing.tool, args: existing.args || ['--print'] },
              };
            } else {
              // Falsy tool (empty string, null, false) → global opt-out
              existing.providerTools = {};
            }
          } else {
            // tool key absent → use defaults
            existing.providerTools = defaultCfg.providerTools;
          }
          migrated = true;
        }
        // Remove old keys
        if ('tool' in existing) { delete existing.tool; migrated = true; }
        if ('args' in existing) { delete existing.args; migrated = true; }
        // Backfill new keys if absent
        if (!('maxBuffer' in existing)) { existing.maxBuffer = 5; migrated = true; }
        if (!('maxContextChars' in existing)) { existing.maxContextChars = 50000; migrated = true; }
        // Migrate systemPrompt: overwrite old defaults, preserve user customizations
        if (_isOldDefault(existing.systemPrompt)) {
          existing.systemPrompt = defaultCfg.systemPrompt;
          migrated = true;
        }
        if (migrated) {
          fs.writeFileSync(enhancerCfg, JSON.stringify(existing, null, 2) + '\n');
          log('Migrated enhancer config: providerTools + backfilled missing keys', 'OK');
        }
      } catch {}
    }
  }

  // Phase 5: Repack & Install
  await repackAndInstall(extractedDir, files, args.noInstall, asarMode);

  // Warn if auto-update patch was skipped (show for both --no-install and full install)
  if (!files.main_index) {
    console.log(`\n  ${c.yellow}⚠ Auto-update patch (9A) was NOT applied — main/index.js not found.${c.reset}`);
    console.log(`  ${c.yellow}  Auto-update may remain active, potentially causing disk bloat.${c.reset}`);
  }

  // Save patched version
  if (!args.noInstall && appVersion) {
    savePatchedVersion(appVersion);
    console.log(`\n  ${c.green}✓${c.reset} Patched v${appVersion}`);

    // Cleanup temp data after successful install (~600 MB)
    const artifacts = [DEFAULT_EXTRACTED, OUTPUT_ASAR, BACKUP_ASAR, BACKUP_UNPACKED];
    // Don't delete user-provided extracted dir
    if (args.extractedDir) {
      artifacts.splice(artifacts.indexOf(DEFAULT_EXTRACTED), 1);
    }
    let freed = false;
    for (const p of artifacts) {
      if (fs.existsSync(p)) {
        try {
          const stat = fs.lstatSync(p);
          if (stat.isDirectory()) {
            fs.rmSync(p, { recursive: true, force: true });
          } else {
            fs.unlinkSync(p);
          }
          freed = true;
        } catch { /* ignore */ }
      }
    }
    if (freed) {
      log('Cleaned up temp data (extracted, asar, backup)', 'OK');
    }
  }
}

module.exports = { main };
