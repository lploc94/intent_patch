'use strict';

const fs = require('fs');
const path = require('path');
const { log, fatal, readFile, writeFile, runCmd, runCmdArgs } = require('./utils');
const {
  INTENT_APP, INTENT_ASAR, INTENT_UNPACKED, INTENT_PLIST,
  STATE_DIR, BACKUP_ASAR, BACKUP_UNPACKED, DEFAULT_EXTRACTED, OUTPUT_ASAR,
  CHUNKS_DIR_REL, PATCH_MARKER,
} = require('./constants');

function getAsarApi() {
  try {
    return require('@electron/asar');
  } catch { return null; }
}

async function extractApp(extractedDir, asarMode) {
  console.log('\n=== Extracting app.asar ===');

  // Choose source: backup if exists, app original if not
  const sourceAsar = fs.existsSync(BACKUP_ASAR) ? BACKUP_ASAR : INTENT_ASAR;
  if (!fs.existsSync(sourceAsar)) {
    fatal(`No asar source found. Expected: ${BACKUP_ASAR} or ${INTENT_ASAR}`);
  }

  log(`Extracting from ${path.basename(sourceAsar)}...`);

  // Stale detection
  if (fs.existsSync(extractedDir)) {
    try {
      const extractedPkg = JSON.parse(readFile(path.join(extractedDir, 'package.json')));

      let sourcePkgVersion;
      const asar = getAsarApi();
      if (asar && asarMode === 'library') {
        const buf = asar.extractFile(sourceAsar, 'package.json');
        sourcePkgVersion = JSON.parse(buf.toString('utf8')).version;
      } else {
        // CLI fallback — extract-file to temp dir
        const tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'intent-patch-'));
        try {
          runCmdArgs(['npx', '--yes', 'asar', 'extract-file', sourceAsar, 'package.json'], { cwd: tmpDir });
          sourcePkgVersion = JSON.parse(readFile(path.join(tmpDir, 'package.json'))).version;
        } finally {
          fs.rmSync(tmpDir, { recursive: true, force: true });
        }
      }

      if (extractedPkg.version !== sourcePkgVersion) {
        log(`Stale extracted/ (${extractedPkg.version} vs ${sourcePkgVersion}), re-extracting`, 'WARN');
        fs.rmSync(extractedDir, { recursive: true, force: true });
      } else {
        log('extracted/ up to date, skipping extract', 'OK');
        return;
      }
    } catch {
      // Re-extract if parse fails
      log('Cannot read version, forcing re-extract', 'WARN');
      fs.rmSync(extractedDir, { recursive: true, force: true });
    }
  }

  // Symlink .unpacked if needed (for asar extract)
  const sourceUnpacked = sourceAsar + '.unpacked';
  let createdLink = false;
  if (!fs.existsSync(sourceUnpacked) && fs.existsSync(INTENT_UNPACKED)) {
    try {
      fs.symlinkSync(INTENT_UNPACKED, sourceUnpacked);
      createdLink = true;
      log('Created symlink for unpacked files', 'OK');
    } catch (e) {
      log(`Warning: cannot create unpacked symlink: ${e.message}`, 'WARN');
    }
  }

  try {
    const asar = getAsarApi();
    if (asar && asarMode === 'library') {
      asar.extractAll(sourceAsar, extractedDir);
    } else {
      runCmdArgs(['npx', '--yes', 'asar', 'extract', sourceAsar, extractedDir], { timeout: 300000 });
    }
    log('Extraction complete', 'OK');
  } catch (e) {
    fatal(`asar extract failed: ${e.message}`);
  } finally {
    if (createdLink && fs.existsSync(sourceUnpacked)) {
      try { fs.unlinkSync(sourceUnpacked); } catch { /* ignore */ }
    }
  }
}

async function repackAndInstall(extractedDir, files, skipInstall, asarMode) {
  console.log('\n=== Phase 5: Repack & Install ===');

  // 5.1 Repack
  log('Repacking asar...');
  try {
    const asar = getAsarApi();
    if (asar && asarMode === 'library') {
      await asar.createPackage(extractedDir, OUTPUT_ASAR);
    } else {
      runCmdArgs(['npx', '--yes', 'asar', 'pack', extractedDir, OUTPUT_ASAR], { timeout: 300000 });
    }
    log(`Repacked to ${OUTPUT_ASAR}`, 'OK');
  } catch (e) {
    fatal(`asar pack failed: ${e.message}`);
  }

  if (skipInstall) {
    log('Skip install (--no-install)', 'SKIP');
    return;
  }

  // 5.2 Backup
  if (fs.existsSync(BACKUP_ASAR)) {
    log('Backup already exists', 'SKIP');
  } else {
    log('Creating backup of app.asar...');
    try {
      fs.copyFileSync(INTENT_ASAR, BACKUP_ASAR);
      log(`Backup saved to ${BACKUP_ASAR}`, 'OK');
    } catch (e) {
      fatal(`Cannot create backup: ${e.message}`);
    }
    // Also backup .unpacked
    if (fs.existsSync(INTENT_UNPACKED) && !fs.existsSync(BACKUP_UNPACKED)) {
      try {
        fs.symlinkSync(INTENT_UNPACKED, BACKUP_UNPACKED);
        log('Symlinked backup unpacked', 'OK');
      } catch { /* ignore */ }
    }
  }

  // 5.3 Install
  // Prompt sudo early
  log('Requesting sudo access...');
  if (process.stdin.isTTY) {
    runCmdArgs(['sudo', '-v'], { interactive: true, check: false });
  }

  log('Killing Intent by Augment...');
  runCmdArgs(['pkill', '-f', 'Intent by Augment'], { check: false });
  // Wait for process to exit
  await new Promise(resolve => setTimeout(resolve, 2000));

  log('Removing macOS protection flags...');
  runCmdArgs(['sudo', 'xattr', '-cr', INTENT_APP], { check: false });

  log('Installing patched app.asar...');
  try {
    runCmdArgs(['sudo', 'cp', OUTPUT_ASAR, INTENT_ASAR]);
    log('app.asar installed', 'OK');
  } catch (e) {
    fatal(`Failed to install app.asar: ${e.message}`);
  }

  // Install unpacked files
  const msFile = path.basename(files.model_store);
  const mpFile = path.basename(files.model_picker);
  const unpackedChunks = path.join(INTENT_UNPACKED, CHUNKS_DIR_REL);

  log('Installing unpacked files...');
  for (const filename of [msFile, mpFile]) {
    const src = path.join(extractedDir, CHUNKS_DIR_REL, filename);
    const dst = path.join(unpackedChunks, filename);
    if (fs.existsSync(dst)) {
      try {
        runCmdArgs(['sudo', 'cp', src, dst]);
        log(`Unpacked: ${filename}`, 'OK');
      } catch (e) {
        log(`Failed to install unpacked ${filename}: ${e.message}`, 'FAIL');
      }
    } else {
      log(`Unpacked path not found: ${dst}`, 'WARN');
    }
  }

  // Remove ElectronAsarIntegrity
  log('Removing ElectronAsarIntegrity...');
  runCmdArgs(['sudo', '/usr/libexec/PlistBuddy', '-c', 'Delete :ElectronAsarIntegrity', INTENT_PLIST], { check: false });

  // Re-sign
  log('Re-signing app...');
  try {
    runCmdArgs(['sudo', 'codesign', '--force', '--deep', '--sign', '-', INTENT_APP]);
    log('App re-signed', 'OK');
  } catch (e) {
    log(`Codesign failed: ${e.message}`, 'FAIL');
  }

  log('Installation complete! Open Intent by Augment to verify.', 'OK');
}

function writePatchedFilesManifest(extractedDir, files) {
  const manifest = {
    model_store: path.basename(files.model_store),
    model_picker: path.basename(files.model_picker),
    chunks_dir: CHUNKS_DIR_REL,
  };
  const manifestPath = path.join(extractedDir, 'patched-files.json');
  writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  log(`Wrote patched-files.json (${manifest.model_store}, ${manifest.model_picker})`, 'OK');
}

module.exports = { extractApp, repackAndInstall, writePatchedFilesManifest };
