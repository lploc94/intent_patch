'use strict';

const fs = require('fs');
const { execSync } = require('child_process');
const { log, fatal, runCmd, header } = require('./utils');
const { INTENT_APP, INTENT_ASAR } = require('./constants');

function which(cmd) {
  try {
    execSync(`command -v ${cmd}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    return true;
  } catch { return false; }
}

function checkAsarApi() {
  try {
    const asar = require('@electron/asar');
    if (typeof asar.extractAll !== 'function' ||
        typeof asar.createPackage !== 'function' ||
        typeof asar.extractFile !== 'function') {
      throw new Error('Incomplete asar API');
    }
    return 'library';
  } catch {
    try {
      runCmd('npx asar --version');
      log('Using npx asar as fallback (library unavailable)', 'WARN');
      return 'cli';
    } catch {
      fatal('@electron/asar not available as library or CLI');
    }
  }
}

function preflightChecks(skipInstall = false) {
  header('Phase 0: Preflight Checks');
  let ok = true;

  // Node.js version
  const ver = process.version;
  const major = parseInt(ver.slice(1).split('.')[0], 10);
  if (major < 18) {
    log(`Node.js ${ver} too old, need >=18`, 'FAIL');
    ok = false;
  } else {
    log(`Node.js ${ver}`, 'OK');
  }

  // @electron/asar
  const asarMode = checkAsarApi();
  log(`@electron/asar available (${asarMode})`, 'OK');

  if (!skipInstall) {
    // codesign
    if (which('codesign')) {
      log('codesign available', 'OK');
    } else {
      log('codesign not found', 'FAIL');
      ok = false;
    }

    // PlistBuddy
    if (fs.existsSync('/usr/libexec/PlistBuddy')) {
      log('PlistBuddy available', 'OK');
    } else {
      log('PlistBuddy not found', 'FAIL');
      ok = false;
    }

    // Intent app
    if (fs.existsSync(INTENT_APP) && fs.statSync(INTENT_APP).isDirectory()) {
      log(`Intent app found at ${INTENT_APP}`, 'OK');
    } else {
      log(`Intent app not found at ${INTENT_APP}`, 'FAIL');
      ok = false;
    }

    // app.asar
    if (fs.existsSync(INTENT_ASAR)) {
      log('app.asar exists', 'OK');
    } else {
      log('app.asar not found in Intent bundle', 'FAIL');
      ok = false;
    }

    // Check TTY for sudo
    if (!process.stdin.isTTY) {
      log('No interactive terminal detected (sudo may fail)', 'WARN');
    }
  }

  if (!ok) {
    fatal('Preflight checks failed. Fix the issues above and retry.');
  }

  log('All preflight checks passed.', 'OK');
  return asarMode;
}

module.exports = { preflightChecks, checkAsarApi };
