'use strict';

const path = require('path');
const { log, fatal, readFile, writeFile, header } = require('./utils');
const { PatchState } = require('./constants');

function checkPatchState(patch, content) {
  let hasNew = false;
  let hasOld = false;

  // Check if patch result is present (new/patched state)
  if (patch.verify_present && content.includes(patch.verify_present)) {
    hasNew = true;
  } else if (!patch.verify_present && patch.new_body && content.includes(patch.new_body)) {
    hasNew = true;
  }

  // Check if original code is present (old/unpatched state)
  if (patch.verify_absent && content.includes(patch.verify_absent)) {
    hasOld = true;
  } else if (patch.search && content.includes(patch.search)) {
    hasOld = true;
  } else if (patch.search_regex && new RegExp(patch.search_regex, 's').test(content)) {
    hasOld = true;
  }

  if (hasNew && !hasOld) return PatchState.APPLIED;
  if (hasOld && !hasNew) return PatchState.NOT_APPLIED;

  // Neither old nor new found
  if (!hasOld && !hasNew) {
    if (patch.replace_template === '') return PatchState.APPLIED;
    if (!patch.verify_present && patch.verify_absent) return PatchState.APPLIED;
    if (patch.function_anchor && content.includes(patch.function_anchor)) return PatchState.NOT_APPLIED;
    return PatchState.CONFLICT;
  }

  return PatchState.CONFLICT;
}

function applySinglePatch(patch, content, dryRun = false) {
  if (patch.patch_type === 'text_replace') {
    if (!content.includes(patch.search)) {
      log(`Search pattern not found for ${patch.name}`, 'FAIL');
      return null;
    }
    const count = content.split(patch.search).length - 1;
    if (count > 1) {
      log(`Multiple matches (${count}) for ${patch.name}`, 'FAIL');
      return null;
    }
    if (dryRun) {
      log(`Would apply ${patch.name}`, 'SKIP');
      return content;
    }
    return content.replace(patch.search, patch.replace);
  }

  if (patch.patch_type === 'statement_replace') {
    if (patch.search_regex) {
      const re = new RegExp(patch.search_regex, 's');
      const m = re.exec(content);
      if (!m) {
        log(`Regex pattern not found for ${patch.name}`, 'FAIL');
        return null;
      }
      const allMatches = [...content.matchAll(new RegExp(patch.search_regex, 'gs'))];
      if (allMatches.length > 1) {
        log(`Multiple regex matches (${allMatches.length}) for ${patch.name}`, 'FAIL');
        return null;
      }
      if (dryRun) {
        log(`Would apply ${patch.name}`, 'SKIP');
        return content;
      }
      return content.slice(0, m.index) + patch.replace_template + content.slice(m.index + m[0].length);
    } else {
      if (!content.includes(patch.search)) {
        log(`Search pattern not found for ${patch.name}`, 'FAIL');
        return null;
      }
      if (dryRun) {
        log(`Would apply ${patch.name}`, 'SKIP');
        return content;
      }
      return content.replace(patch.search, patch.replace);
    }
  }

  if (patch.patch_type === 'function_replace') {
    return applyFunctionReplace(patch, content, dryRun);
  }

  fatal(`Unknown patch type: ${patch.patch_type}`);
  return null;
}

function applyFunctionReplace(patch, content, dryRun = false) {
  const anchor = patch.function_anchor;
  const idx = content.indexOf(anchor);
  if (idx < 0) {
    log(`Function anchor not found for ${patch.name}: ${anchor}`, 'FAIL');
    return null;
  }

  // Check for multiple occurrences
  const secondIdx = content.indexOf(anchor, idx + 1);
  if (secondIdx >= 0) {
    log(`Multiple function anchors for ${patch.name}`, 'FAIL');
    return null;
  }

  // Find opening brace
  const braceStart = content.indexOf('{', idx + anchor.length);
  if (braceStart < 0) {
    log(`Opening brace not found for ${patch.name}`, 'FAIL');
    return null;
  }

  // Match braces to find end of function
  let depth = 0;
  let i = braceStart;
  while (i < content.length) {
    const ch = content[i];
    if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) break;
    } else if (ch === '"' || ch === "'") {
      // Skip string literals
      const quote = ch;
      i++;
      while (i < content.length && content[i] !== quote) {
        if (content[i] === '\\') i++;
        i++;
      }
    } else if (ch === '`') {
      // Skip template literals
      i++;
      while (i < content.length && content[i] !== '`') {
        if (content[i] === '\\') {
          i++;
        } else if (content[i] === '$' && i + 1 < content.length && content[i + 1] === '{') {
          // Skip ${...} in template
          i += 2;
          let nested = 1;
          while (i < content.length && nested > 0) {
            if (content[i] === '{') nested++;
            else if (content[i] === '}') nested--;
            i++;
          }
          continue;
        }
        i++;
      }
    }
    i++;
  }

  if (depth !== 0) {
    log(`Unbalanced braces for ${patch.name}`, 'FAIL');
    return null;
  }

  const funcEnd = i + 1; // i is at the closing brace, +1 to exclude it from remainder

  // Find the start of the function (look back for 'async ')
  let funcStart = idx;
  const prefixCheck = content.slice(Math.max(0, idx - 10), idx);
  if (prefixCheck.includes('async ')) {
    funcStart = idx - (prefixCheck.length - prefixCheck.indexOf('async '));
  }

  const oldFunc = content.slice(funcStart, funcEnd);

  if (dryRun) {
    log(`Would replace function (${oldFunc.length} chars) for ${patch.name}`, 'SKIP');
    return content;
  }

  return content.slice(0, funcStart) + patch.new_body + content.slice(funcEnd);
}

function applyPatches(patches, extractedDir, files, dryRun = false) {
  header('Phase 3: Patch Application');

  // Group patches by file
  const filePatchesMap = {};
  for (const p of patches) {
    if (!filePatchesMap[p.file_key]) filePatchesMap[p.file_key] = [];
    filePatchesMap[p.file_key].push(p);
  }

  // Map file_key to actual path
  const fileMap = {
    agent_factory: path.join(extractedDir, files.agent_factory),
    model_store: path.join(extractedDir, files.model_store),
    model_picker: path.join(extractedDir, files.model_picker),
  };
  if (files.agent_interaction_tools) {
    fileMap.agent_interaction_tools = path.join(extractedDir, files.agent_interaction_tools);
  }

  let allOk = true;

  for (const [fileKey, filePatches] of Object.entries(filePatchesMap)) {
    const filePath = fileMap[fileKey];
    let content = readFile(filePath);
    let modified = false;

    for (const patch of filePatches) {
      const state = checkPatchState(patch, content);

      if (state === PatchState.APPLIED) {
        log(`${patch.name}: already applied`, 'SKIP');
        continue;
      } else if (state === PatchState.CONFLICT) {
        log(`${patch.name}: CONFLICT \u2014 cannot determine state`, 'FAIL');
        allOk = false;
        continue;
      }

      // state === NOT_APPLIED
      const result = applySinglePatch(patch, content, dryRun);
      if (result === null) {
        allOk = false;
        continue;
      }

      content = result;
      modified = true;
      if (!dryRun) {
        log(`${patch.name}: applied`, 'OK');
      } else {
        log(`${patch.name}: would apply`, 'SKIP');
      }
    }

    if (modified && !dryRun) {
      writeFile(filePath, content);
      log(`Saved ${path.basename(filePath)}`, 'OK');
    }
  }

  return allOk;
}

module.exports = { checkPatchState, applySinglePatch, applyFunctionReplace, applyPatches };
