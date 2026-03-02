'use strict';

const { execSync, execFileSync } = require('child_process');
const fs = require('fs');

const PREFIXES = {
  INFO: '  ',
  OK: '  \u2713',
  FAIL: '  \u2717',
  WARN: '  !',
  SKIP: '  \u2192',
};

function log(msg, level = 'INFO') {
  const prefix = PREFIXES[level] || '  ';
  console.log(`${prefix} ${msg}`);
}

function fatal(msg) {
  console.error(`\n  \u2717 FATAL: ${msg}`);
  process.exit(1);
}

function runCmd(cmd, { check = true, timeout = 120000, interactive = false, cwd } = {}) {
  const opts = { encoding: 'utf8', timeout };
  if (cwd) opts.cwd = cwd;
  if (interactive) {
    opts.stdio = 'inherit';
    opts.encoding = undefined;
  }
  try {
    const result = execSync(cmd, opts);
    return interactive ? '' : (result || '').toString().trim();
  } catch (err) {
    if (check) fatal(`Command failed: ${cmd}\n${err.message}`);
    return null;
  }
}

function readFile(p) {
  return fs.readFileSync(p, 'utf8');
}

function writeFile(p, content) {
  fs.writeFileSync(p, content, 'utf8');
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findSingleMatch(pattern, text, contextName = '') {
  const re = typeof pattern === 'string' ? new RegExp(pattern) : pattern;
  const matches = [...text.matchAll(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'))];
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) {
    log(`Pattern not found for ${contextName}: ${re.source.slice(0, 80)}...`, 'FAIL');
    return null;
  }
  log(`Multiple matches (${matches.length}) for ${contextName}: ${re.source.slice(0, 80)}...`, 'FAIL');
  return null;
}

function runCmdArgs(args, { check = true, timeout = 120000, interactive = false, cwd } = {}) {
  const opts = { encoding: 'utf8', timeout };
  if (cwd) opts.cwd = cwd;
  if (interactive) {
    opts.stdio = 'inherit';
    opts.encoding = undefined;
  }
  try {
    const result = execFileSync(args[0], args.slice(1), opts);
    return interactive ? '' : (result || '').toString().trim();
  } catch (err) {
    if (check) fatal(`Command failed: ${args.join(' ')}\n${err.message}`);
    return null;
  }
}

module.exports = { log, fatal, runCmd, runCmdArgs, readFile, writeFile, escapeRegExp, findSingleMatch };
