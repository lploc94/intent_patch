'use strict';

const { execSync, execFileSync } = require('child_process');
const fs = require('fs');

// ── ANSI Colors ──────────────────────────────────────────────
const USE_COLOR = process.stdout.isTTY && !process.env.NO_COLOR;

const c = USE_COLOR ? {
  reset:   '\x1b[0m',
  bold:    '\x1b[1m',
  dim:     '\x1b[2m',
  green:   '\x1b[32m',
  red:     '\x1b[31m',
  yellow:  '\x1b[33m',
  cyan:    '\x1b[36m',
  gray:    '\x1b[90m',
} : { reset: '', bold: '', dim: '', green: '', red: '', yellow: '', cyan: '', gray: '' };

const PREFIXES = {
  INFO: '  ',
  OK:   `  ${c.green}✓${c.reset}`,
  FAIL: `  ${c.red}✗${c.reset}`,
  WARN: `  ${c.yellow}!${c.reset}`,
  SKIP: `  ${c.gray}→${c.reset}`,
};

function log(msg, level = 'INFO') {
  const prefix = PREFIXES[level] || '  ';
  console.log(`${prefix} ${msg}`);
}

function fatal(msg) {
  console.error(`\n  ${c.red}✗ FATAL:${c.reset} ${msg}`);
  process.exit(1);
}

// ── Spinner ──────────────────────────────────────────────────
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

function startSpinner(message) {
  if (!process.stdout.isTTY) {
    process.stdout.write(`  ${message}\n`);
    return { stop() {} };
  }

  let i = 0;
  const start = Date.now();
  // Hide cursor
  process.stdout.write('\x1b[?25l');
  const id = setInterval(() => {
    const frame = SPINNER_FRAMES[i % SPINNER_FRAMES.length];
    process.stdout.write(`\r  ${c.cyan}${frame}${c.reset} ${message}`);
    i++;
  }, 80);

  return {
    stop(level = 'OK') {
      clearInterval(id);
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      const prefix = PREFIXES[level] || '  ';
      // Clear line + show cursor
      process.stdout.write(`\r\x1b[K${prefix} ${message} ${c.dim}(${elapsed}s)${c.reset}\n`);
      process.stdout.write('\x1b[?25h');
    }
  };
}

// Ensure cursor is shown on exit
process.on('exit', () => {
  if (process.stdout.isTTY) process.stdout.write('\x1b[?25h');
});
process.on('SIGINT', () => {
  if (process.stdout.isTTY) process.stdout.write('\x1b[?25h');
  process.exit(130);
});

// ── Section header ───────────────────────────────────────────
function header(title) {
  console.log(`\n${c.bold}=== ${title} ===${c.reset}`);
}

// ── Banner ───────────────────────────────────────────────────
function banner(title) {
  const line = '='.repeat(60);
  console.log(`${c.bold}${line}`);
  console.log(`  ${title}`);
  console.log(`${line}${c.reset}`);
}

// ── Shell helpers ────────────────────────────────────────────
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

module.exports = { log, fatal, runCmd, runCmdArgs, readFile, writeFile, escapeRegExp, findSingleMatch, c, startSpinner, header, banner };
