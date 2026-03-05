'use strict';

const path = require('path');
const { readFile, escapeRegExp } = require('./utils');

function buildPatches(files, pcSymbols, msSymbols, mpSymbols, extractedDir) {
  const patches = [];

  // ModelStore Patches (1-5)
  const msR = msSymbols.resolved;
  const msPath = path.join(extractedDir, files.model_store);
  const msContent = readFile(msPath);

  const parseFn = msR.parseCompoundModelId || 'Ce';
  const acp = msR.ACP_PROVIDERS || 'Et';
  const aps = msR.activeProviderStore || 'H';
  const getDefaultPid = msR.getDefaultProviderId || 'Ue';
  const getProviderCfg = msR.getProviderConfigById || 'We';

  // Patch 1: loadModels - function_replace
  patches.push({
    name: 'Patch 1: loadModels fetches all providers',
    file_key: 'model_store',
    patch_type: 'function_replace',
    function_anchor: 'async loadModels()',
    new_body: _buildLoadModelsBody(acp, getDefaultPid, msContent, aps, parseFn),
    verify_present: 'loadedForProviderId==="__all__"',
    verify_absent: `loadedForProviderId===${_findCacheVar(msContent, aps)}||this.isLoadingModels`,
  });

  // Patch 2: reloadModelsForProvider - function_replace
  patches.push({
    name: 'Patch 2: reloadModelsForProvider simplified',
    file_key: 'model_store',
    patch_type: 'function_replace',
    function_anchor: 'async reloadModelsForProvider(',
    new_body: _buildReloadBody(),
    verify_present: 'Reloading models for all providers',
    verify_absent: 'Reloading models for provider change',
  });

  // Patch 3: selectModel - statement_replace
  patches.push({
    name: 'Patch 3: selectModel uses parsed providerId',
    file_key: 'model_store',
    patch_type: 'statement_replace',
    search_regex: `${escapeRegExp(aps)}\\.activeProviderId;this\\.providerModels\\.set\\(\\w+,\\w+\\)`,
    replace_template: `${parseFn}(e).providerId;this.providerModels.set(t,e)`,
    verify_present: `${parseFn}(e).providerId;this.providerModels.set(t,e)`,
    verify_absent: `${aps}.activeProviderId;this.providerModels.set(t,e)`,
  });

  // Patch 4: getGroupedModels - function_replace
  patches.push({
    name: 'Patch 4: getGroupedModels groups by provider',
    file_key: 'model_store',
    patch_type: 'function_replace',
    function_anchor: 'getGroupedModels()',
    new_body: _buildGetGroupedModelsBody(parseFn, acp),
    verify_present: 'getGroupedModels(){if(this.availableModels.length===0)return[];const e=new Map',
    verify_absent: `getGroupedModels(){const e=${aps}.activeProviderId`,
  });

  // Patch 5: scheduleAutoRetry - statement_replace
  patches.push({
    name: 'Patch 5: scheduleAutoRetry removes provider check',
    file_key: 'model_store',
    patch_type: 'statement_replace',
    search_regex: `${escapeRegExp(aps)}\\.activeProviderId===\\w+&&`,
    replace_template: '',
    verify_absent: `${aps}.activeProviderId===`,
  });

  // Agent Factory Patches (6A-6C)
  patches.push({
    name: 'Patch 6A: ACP_PROVIDERS import',
    file_key: 'agent_factory',
    patch_type: 'text_replace',
    search: 'import { getDefaultModelForProvider,',
    replace: 'import { ACP_PROVIDERS, getDefaultModelForProvider,',
    verify_present: 'import { ACP_PROVIDERS, getDefaultModelForProvider',
  });

  patches.push({
    name: 'Patch 6B: derive provider from model ID',
    file_key: 'agent_factory',
    patch_type: 'text_replace',
    search: (
      'let provider = config.provider;\n'
      + '            if (!provider && !isBackend) {'
    ),
    replace: (
      'let provider = config.provider;\n'
      + '            if (!provider && config.model) {\n'
      + '                const { providerId } = parseCompoundModelId(config.model);\n'
      + '                if (ACP_PROVIDERS[providerId]) {\n'
      + "                    provider = providerId;\n"
      + "                    logger.debug('Derived provider from model ID', { model: config.model, provider });\n"
      + '                }\n'
      + '            }\n'
      + '            if (!provider && !isBackend) {'
    ),
    verify_present: "if (!provider && config.model) {\n                const { providerId } = parseCompoundModelId(config.model);",
    verify_absent: "if (!provider && config.model && config.model.includes(':'))",
  });

  patches.push({
    name: 'Patch 6C: safety-net align provider',
    file_key: 'agent_factory',
    patch_type: 'statement_replace',
    search_regex: _build6cSearch(),
    replace_template: _build6cReplace(),
    verify_present: 'Safety net: aligning provider to match compound model',
    verify_absent: 'Safety net: cross-provider model mismatch in agent creation',
  });

  // ModelPicker Patches (7A-7B)
  const mpR = mpSymbols.resolved;
  const iao = mpR.isAgentProviderOverride || 'Ie';
  const computed = mpR.computed || 'H';
  const getFn = mpR.get || 't';
  const epid = mpR.effectiveProviderId || 'be';
  const mpAps = mpR.activeProviderStore || 'mt';

  patches.push({
    name: 'Patch 7A: isAgentProviderOverride always false',
    file_key: 'model_picker',
    patch_type: 'statement_replace',
    search_regex: (
      `${escapeRegExp(iao)}\\s*=\\s*${escapeRegExp(computed)}\\s*\\(\\s*\\(\\s*\\)\\s*=>\\s*`
      + `${escapeRegExp(getFn)}\\s*\\(\\s*${escapeRegExp(epid)}\\s*\\)\\s*!==\\s*`
      + `${escapeRegExp(mpAps)}\\.activeProviderId\\s*\\)`
    ),
    replace_template: `${iao}=${computed}(()=>!1)`,
    verify_present: `${iao}=${computed}(()=>!1)`,
    verify_absent: `${iao}=${computed}(()=>${getFn}(${epid})!==${mpAps}.activeProviderId)`,
  });

  const effectFn = mpR.effect || 'nt';
  const setFn = mpR.set || 'h';
  const apm = mpR.agentProviderModels || 'xe';
  const ilam = mpR.isLoadingAgentModels || 're';
  const ame = mpR.agentModelError || 'se';

  patches.push({
    name: 'Patch 7B: effect clears agentProviderModels',
    file_key: 'model_picker',
    patch_type: 'statement_replace',
    search_regex: (
      `${escapeRegExp(effectFn)}\\s*\\(\\s*\\(\\s*\\)\\s*=>\\s*\\{\\s*(?:const|let)\\s+\\w+\\s*=\\s*`
      + `${escapeRegExp(getFn)}\\s*\\(\\s*${escapeRegExp(epid)}\\s*\\)\\s*;[\\s\\S]*?getModelsForProvider`
      + `[\\s\\S]*?catch\\s*\\([^}]+\\}\\s*\\)\\s*\\}\\s*\\)\\s*;`
    ),
    replace_template: (
      `${effectFn}(()=>{${getFn}(${epid});`
      + `${setFn}(${apm},null),${setFn}(${ilam},!1),${setFn}(${ame},null)});`
    ),
    verify_present: `${effectFn}(()=>{${getFn}(${epid});${setFn}(${apm},null),${setFn}(${ilam},!1),${setFn}(${ame},null)});`,
    verify_absent: null,
  });

  // Main Index Patch (9A: disable auto-update)
  // Placed BEFORE agent_interaction_tools guard so it's always built when main_index exists
  if (files.main_index) {
    patches.push({
      name: 'Patch 9A: disable auto-updater initialization',
      file_key: 'main_index',
      patch_type: 'text_replace',
      search: (
        "        if (process.env.NODE_ENV !== 'development' && mainWindow) {\n"
        + "            initializeAutoUpdater(mainWindow);\n"
        + "        }"
      ),
      replace: (
        "        if (false /* intent-patch: auto-update disabled */) {\n"
        + "            initializeAutoUpdater(mainWindow);\n"
        + "        }"
      ),
      verify_present: 'intent-patch: auto-update disabled',
      verify_absent: "process.env.NODE_ENV !== 'development' && mainWindow) {\n            initializeAutoUpdater(mainWindow);",
    });
  }

  // Prompt Enhancer Patches (10A-10B: context-rich enhancer via augmentCLI)
  if (files.agent_missing_ipc) {
    patches.push({
      name: 'Patch 10A: import services for enhancer context',
      file_key: 'agent_missing_ipc',
      patch_type: 'text_replace',
      search: "import { getInputWithEnhancePrompt, extractEnhancedPrompt, } from '../../../lib/utils/prompt-enhancement.js';",
      search_alt: (
        "import { getInputWithEnhancePrompt, extractEnhancedPrompt } from '../../../lib/utils/prompt-enhancement.js';\n"
        + "import { workspaceService } from '../../workspace/main/workspace.service.js';\n"
        + "import { agentPersistence } from '../../agent/main/agent-persistence.js';\n"
        + "import _fs from 'node:fs';\n"
        + "import _path from 'node:path';\n"
        + "import _os from 'node:os';"
      ),
      replace: (
        "import { getInputWithEnhancePrompt, extractEnhancedPrompt } from '../../../lib/utils/prompt-enhancement.js';\n"
        + "import { workspaceService } from '../../workspace/main/workspace.service.js';\n"
        + "import { agentPersistence } from '../../agent/main/agent-persistence.js';\n"
        + "import _fs from 'node:fs';\n"
        + "import _path from 'node:path';\n"
        + "import _os from 'node:os';\n"
        + "import { spawn as _spawn } from 'node:child_process';"
      ),
      verify_present: "import { spawn as _spawn } from 'node:child_process'",
      verify_absent: "extractEnhancedPrompt, } from '../../../lib/utils/prompt-enhancement.js'",
    });

    patches.push({
      name: 'Patch 10B: context-rich enhancer via CLI',
      file_key: 'agent_missing_ipc',
      patch_type: 'text_replace',
      search: (
        "const enhancementPrompt = getInputWithEnhancePrompt(prompt);\n"
        + "            // Use auggie CLI to enhance the prompt\n"
        + "            // Use a 30 second timeout for prompt enhancement (simple request)\n"
        + "            // Skip MCP servers for faster response - prompt enhancement doesn't need tools\n"
        + "            // Model is passed from the renderer (from backgroundAgentSettingsStore.getModelForType('fast'))\n"
        + "            const response = await augmentCLI.streamChat(enhancementPrompt, {\n"
        + "                model: modelId || MODEL_DEFAULTS.BACKGROUND_REQUEST_MODEL,\n"
        + "                workspaceId,\n"
        + "                agentId: 'enhance-prompt',\n"
        + "                systemPrompt: 'You are a helpful assistant. Respond directly and concisely. Do not use any tools.',\n"
        + "                skipMcp: true, // Skip MCP server initialization for faster response\n"
        + "            }, () => { }, // No streaming chunks needed for this use case\n"
        + "            undefined, // No abort signal\n"
        + "            30000);\n"
        + "            // Extract the enhanced prompt from the response\n"
        + "            const enhancedPrompt = extractEnhancedPrompt(response.content);"
      ),
      search_alt: _buildPatch10BOldReplace(),
      replace: _buildPatch10BReplace(),
      verify_present: 'intent-patch: context-rich enhancer via CLI',
      verify_absent: 'Use auggie CLI to enhance the prompt',
    });
  }

  // Agent Interaction Tools Patches (8A-8D) — guarded by early return
  if (!files.agent_interaction_tools) return patches;

  patches.push({
    name: 'Patch 8A-import: ACP_PROVIDERS import in agent-interaction-tools',
    file_key: 'agent_interaction_tools',
    patch_type: 'text_replace',
    search: "import { parseCompoundModelId, createCompoundModelId, getDefaultProviderId, getDefaultModelForProvider, isModelValidForProvider, PROVIDER_MODEL_TIERS, } from '../../../../shared/config/provider-config.js';",
    replace: "import { parseCompoundModelId, createCompoundModelId, getDefaultProviderId, getDefaultModelForProvider, isModelValidForProvider, PROVIDER_MODEL_TIERS, ACP_PROVIDERS, } from '../../../../shared/config/provider-config.js';",
    verify_present: "ACP_PROVIDERS, } from '../../../../shared/config/provider-config.js'",
  });

  patches.push({
    name: 'Patch 8A: resolveModelForProvider respects cross-provider specialist',
    file_key: 'agent_interaction_tools',
    patch_type: 'text_replace',
    search: (
      "        if (specialistProvider !== parentProvider) {\n"
      + "            logger.warn('Cross-provider specialist model without tier mapping, inheriting parent model', { specialistModel, specialistProvider, parentProvider, parentModel });\n"
      + "            return parentModel;\n"
      + "        }"
    ),
    replace: (
      "        if (specialistProvider !== parentProvider) {\n"
      + "            if (ACP_PROVIDERS[specialistProvider]) {\n"
      + "                logger.info('Cross-provider specialist model with known provider, keeping specialist model', { specialistModel, specialistProvider, parentProvider });\n"
      + "                return specialistModel;\n"
      + "            }\n"
      + "            logger.warn('Cross-provider specialist model with unknown provider, inheriting parent model', { specialistModel, specialistProvider, parentProvider, parentModel });\n"
      + "            return parentModel;\n"
      + "        }"
    ),
    verify_present: 'Cross-provider specialist model with known provider, keeping specialist model',
    verify_absent: 'Cross-provider specialist model without tier mapping, inheriting parent model',
  });

  patches.push({
    name: 'Patch 8B: resolveSpecialistConfig keeps cross-provider model override',
    file_key: 'agent_interaction_tools',
    patch_type: 'text_replace',
    search: (
      "        if (!isModelValidForProvider(validatedModelOverride, parentProvider)) {\n"
      + "            logger.warn('Model override belongs to a different provider, discarding', {\n"
      + "                modelOverride: validatedModelOverride,\n"
      + "                parentProvider,\n"
      + "            });\n"
      + "            validatedModelOverride = undefined;\n"
      + "        }"
    ),
    replace: (
      "        if (!isModelValidForProvider(validatedModelOverride, parentProvider)) {\n"
      + "            const { providerId: overrideProvider } = parseCompoundModelId(validatedModelOverride);\n"
      + "            if (ACP_PROVIDERS[overrideProvider]) {\n"
      + "                logger.info('Model override uses different ACP provider, keeping \u2014 provider will be inferred from model', {\n"
      + "                    modelOverride: validatedModelOverride,\n"
      + "                    overrideProvider,\n"
      + "                    parentProvider,\n"
      + "                });\n"
      + "            }\n"
      + "            else {\n"
      + "                logger.warn('Model override uses unknown provider, discarding', {\n"
      + "                    modelOverride: validatedModelOverride,\n"
      + "                    parentProvider,\n"
      + "                });\n"
      + "                validatedModelOverride = undefined;\n"
      + "            }\n"
      + "        }"
    ),
    verify_present: 'Model override uses different ACP provider, keeping',
    verify_absent: 'Model override belongs to a different provider, discarding',
  });

  patches.push({
    name: 'Patch 8C-1: createAgent #1 infer provider from model',
    file_key: 'agent_interaction_tools',
    patch_type: 'text_replace',
    search: (
      "            // Extract parent provider so child agents inherit the correct provider\n"
      + "            const parentProvider = ctx.model ? parseCompoundModelId(ctx.model).providerId : undefined;\n"
      + "            const agent = await handler.createAgent(this.workspaceId, agentName, {\n"
      + "                workspacePath: this.workspacePath,\n"
      + "                model: config.model,\n"
      + "                provider: ctx.provider, // Inherit ACP provider from parent agent"
    ),
    replace: (
      "            // Extract parent provider so child agents inherit the correct provider\n"
      + "            const resolvedProvider = (() => {\n"
      + "                const m = config.model;\n"
      + "                if (m && m.includes(':')) {\n"
      + "                    const { providerId } = parseCompoundModelId(m);\n"
      + "                    if (ACP_PROVIDERS[providerId]) return providerId;\n"
      + "                }\n"
      + "                return ctx.provider;\n"
      + "            })();\n"
      + "            const agent = await handler.createAgent(this.workspaceId, agentName, {\n"
      + "                workspacePath: this.workspacePath,\n"
      + "                model: config.model,\n"
      + "                provider: resolvedProvider, // Infer provider from resolved model, fallback to parent"
    ),
    verify_present: "})();\n            const agent = await handler.createAgent(this.workspaceId, agentName, {\n                workspacePath: this.workspacePath,\n                model: config.model,\n                provider: resolvedProvider",
    verify_absent: "const parentProvider = ctx.model ? parseCompoundModelId(ctx.model).providerId : undefined;\n            const agent = await handler.createAgent(this.workspaceId, agentName, {\n                workspacePath: this.workspacePath,\n                model: config.model,\n                provider: ctx.provider",
  });

  patches.push({
    name: 'Patch 8C-2: createAgent #2 infer provider from model',
    file_key: 'agent_interaction_tools',
    patch_type: 'text_replace',
    search: (
      "            // Extract parent provider so child agents inherit the correct provider\n"
      + "            const parentProvider = ctx.model ? parseCompoundModelId(ctx.model).providerId : undefined;\n"
      + "            const agent = await handler.createAgent(this.workspaceId, agentName, // Use truncated task text as agent name\n"
      + "            {\n"
      + "                workspacePath: this.workspacePath,\n"
      + "                model: config.model,\n"
      + "                provider: ctx.provider, // Inherit ACP provider from parent agent"
    ),
    replace: (
      "            // Extract parent provider so child agents inherit the correct provider\n"
      + "            const resolvedProvider = (() => {\n"
      + "                const m = config.model;\n"
      + "                if (m && m.includes(':')) {\n"
      + "                    const { providerId } = parseCompoundModelId(m);\n"
      + "                    if (ACP_PROVIDERS[providerId]) return providerId;\n"
      + "                }\n"
      + "                return ctx.provider;\n"
      + "            })();\n"
      + "            const agent = await handler.createAgent(this.workspaceId, agentName, // Use truncated task text as agent name\n"
      + "            {\n"
      + "                workspacePath: this.workspacePath,\n"
      + "                model: config.model,\n"
      + "                provider: resolvedProvider, // Infer provider from resolved model, fallback to parent"
    ),
    verify_present: "})();\n            const agent = await handler.createAgent(this.workspaceId, agentName, // Use truncated task text as agent name\n            {\n                workspacePath: this.workspacePath,\n                model: config.model,\n                provider: resolvedProvider",
    verify_absent: "const parentProvider = ctx.model ? parseCompoundModelId(ctx.model).providerId : undefined;\n            const agent = await handler.createAgent(this.workspaceId, agentName, // Use truncated task text",
  });

  patches.push({
    name: 'Patch 8C-3: createAgent #3 infer provider from model',
    file_key: 'agent_interaction_tools',
    patch_type: 'text_replace',
    search: (
      "        // Extract provider from the model so child agents inherit the correct provider\n"
      + "        const inferredProvider = model ? parseCompoundModelId(model).providerId : undefined;\n"
      + "        const agent = await handler.createAgent(this.workspaceId, agentName, {\n"
      + "            workspacePath: this.workspacePath,\n"
      + "            model,\n"
      + "            provider: ctx.provider, // Inherit ACP provider from parent agent"
    ),
    replace: (
      "        // Extract provider from the model so child agents inherit the correct provider\n"
      + "        const resolvedProvider = (() => {\n"
      + "            if (model && model.includes(':')) {\n"
      + "                const { providerId } = parseCompoundModelId(model);\n"
      + "                if (ACP_PROVIDERS[providerId]) return providerId;\n"
      + "            }\n"
      + "            return ctx.provider;\n"
      + "        })();\n"
      + "        const agent = await handler.createAgent(this.workspaceId, agentName, {\n"
      + "            workspacePath: this.workspacePath,\n"
      + "            model,\n"
      + "            provider: resolvedProvider, // Infer provider from resolved model, fallback to parent"
    ),
    verify_present: "const resolvedProvider = (() => {\n            if (model && model.includes",
    verify_absent: "const inferredProvider = model ? parseCompoundModelId(model).providerId : undefined",
  });

  patches.push({
    name: 'Patch 8C-4: createAgent #4 (wake_or_create) infer provider from model',
    file_key: 'agent_interaction_tools',
    patch_type: 'text_replace',
    search: (
      "            // Extract parent provider so child agents inherit the correct provider\n"
      + "            const parentProvider = ctx.model ? parseCompoundModelId(ctx.model).providerId : undefined;\n"
      + "            const newAgent = await handler.createAgent(this.workspaceId, agentName, {\n"
      + "                workspacePath: this.workspacePath,\n"
      + "                model,\n"
      + "                provider: ctx.provider, // Inherit ACP provider from parent agent"
    ),
    replace: (
      "            // Extract parent provider so child agents inherit the correct provider\n"
      + "            const resolvedProvider = (() => {\n"
      + "                if (model && model.includes(':')) {\n"
      + "                    const { providerId } = parseCompoundModelId(model);\n"
      + "                    if (ACP_PROVIDERS[providerId]) return providerId;\n"
      + "                }\n"
      + "                return ctx.provider;\n"
      + "            })();\n"
      + "            const newAgent = await handler.createAgent(this.workspaceId, agentName, {\n"
      + "                workspacePath: this.workspacePath,\n"
      + "                model,\n"
      + "                provider: resolvedProvider, // Infer provider from resolved model, fallback to parent"
    ),
    verify_present: "const resolvedProvider = (() => {\n                if (model && model.includes(':')) {\n                    const { providerId } = parseCompoundModelId(model);\n                    if (ACP_PROVIDERS[providerId]) return providerId;\n                }\n                return ctx.provider;\n            })();\n            const newAgent",
    verify_absent: "const parentProvider = ctx.model ? parseCompoundModelId(ctx.model).providerId : undefined;\n            const newAgent",
  });

  patches.push({
    name: 'Patch 8D: wake_or_create_task_agent allows cross-provider model',
    file_key: 'agent_interaction_tools',
    patch_type: 'text_replace',
    search: (
      "            if (model && ctx.provider) {\n"
      + "                if (!isModelValidForProvider(model, ctx.provider)) {\n"
      + "                    logger.warn('wake_or_create_task_agent: model belongs to different provider, discarding', {\n"
      + "                        model,\n"
      + "                        parentProvider: ctx.provider,\n"
      + "                    });\n"
      + "                    model = undefined;\n"
      + "                }\n"
      + "            }"
    ),
    replace: (
      "            if (model && ctx.provider) {\n"
      + "                if (!isModelValidForProvider(model, ctx.provider)) {\n"
      + "                    const { providerId: modelProvider } = parseCompoundModelId(model);\n"
      + "                    if (ACP_PROVIDERS[modelProvider]) {\n"
      + "                        logger.info('wake_or_create_task_agent: model uses different ACP provider, keeping', {\n"
      + "                            model,\n"
      + "                            modelProvider,\n"
      + "                            parentProvider: ctx.provider,\n"
      + "                        });\n"
      + "                    }\n"
      + "                    else {\n"
      + "                        logger.warn('wake_or_create_task_agent: model uses unknown provider, discarding', {\n"
      + "                            model,\n"
      + "                            parentProvider: ctx.provider,\n"
      + "                        });\n"
      + "                        model = undefined;\n"
      + "                    }\n"
      + "                }\n"
      + "            }"
    ),
    verify_present: 'wake_or_create_task_agent: model uses different ACP provider, keeping',
    verify_absent: 'wake_or_create_task_agent: model belongs to different provider, discarding',
  });

  return patches;
}

// --- Helper functions ---

function _findCacheVar(content, aps) {
  const m = content.match(/loadedForProviderId===(\w+)/);
  return m ? m[1] : 'e';
}

function _buildLoadModelsBody(acp, getDefaultPid, msContent, aps, parseFnOverride) {
  // Resolve internal variables
  let loggerVar = 'I';
  const loggerMatch = msContent.match(/const\s+(\w+)\s*=\s*\w+\(\s*"ModelStore"\s*\)/);
  if (loggerMatch) loggerVar = loggerMatch[1];

  let ussVar = 'h';
  const ussMatch = msContent.match(/(\w+)\.setModelsLoading/);
  if (ussMatch) ussVar = ussMatch[1];

  let seVar = 'Se';
  const seMatch = msContent.match(/(\w+)\.UI_MODEL_PREFERENCE/);
  if (seMatch) seVar = seMatch[1];

  let ytVar = 'yt';
  const ytMatch = msContent.match(new RegExp(`(\\w+)\\(\\s*${escapeRegExp(seVar)}\\.UI_MODEL_PREFERENCE`));
  if (ytMatch) ytVar = ytMatch[1];

  let parseFn = parseFnOverride || 'Ce';
  const parseMatch = msContent.match(/(\w+)\(this\.selectedModel\)\.providerId/);
  if (parseMatch) {
    parseFn = parseMatch[1];
  } else {
    const pat2 = msContent.match(/\{[^}]*providerId:\w+,modelId:\w+\}\s*=\s*(\w+)\(/);
    if (pat2) parseFn = pat2[1];
  }

  return (
    `async loadModels(){if(this.modelsLoaded&&this.loadedForProviderId==="__all__"||this.isLoadingModels)`
    + `{${loggerVar}.debug("All provider models already loaded or loading, skipping");return}`
    + `this.isLoadingModels=!0,this.loadError=null,`
    + `${loggerVar}.debug("Loading models for ALL providers"),${ussVar}.setModelsLoading(!0);`
    + `try{const e=Object.keys(${acp}),`
    + `t=${getDefaultPid}(),`
    + `s=await Promise.allSettled(e.map(async n=>{const o=await this.fetchModelsForProvider(n);`
    + `return{providerId:n,models:o}}));`
    + `let r=[];for(const n of s)if(n.status==="fulfilled"&&n.value.models.length>0)`
    + `{const{providerId:o,models:c}=n.value,`
    + `l=c.map(E=>o!==t?{...E,value:\`\${o}:\${E.value}\`}:E);r=r.concat(l)}`
    + `if(r.length>0){this.availableModels=r,this.modelsLoaded=!0,`
    + `this.loadedForProviderId="__all__",this.loadError=null,this.retryAttempt=0,`
    + `${loggerVar}.info("Loaded models from all providers",{count:r.length}),`
    + `${ussVar}.setAvailableModels(this.availableModels);`
    + `const n=r.map(o=>o.value),`
    + `{providerId:c,modelId:l}=${parseFn}(this.selectedModel);`
    + `if(!(n.includes(this.selectedModel)||n.some(o=>o===l||o.endsWith(":"+l)))&&this.availableModels.length>0)`
    + `{const o=${ytVar}(${seVar}.UI_MODEL_PREFERENCE,n)??this.availableModels[0].value;`
    + `${loggerVar}.warn("Selected model not in merged list, using preferred default",`
    + `{selectedModel:this.selectedModel,fallbackModel:o}),this.selectModel(o)}}`
    + `else this.loadError="No models available from any provider.",`
    + `${loggerVar}.warn("No models from any provider"),this.scheduleAutoRetry(${aps}.activeProviderId)}`
    + `catch(e){const t=e instanceof Error?e.message:"Failed to load models";`
    + `this.loadError=t,${loggerVar}.error("Failed to load models:",e),`
    + `this.scheduleAutoRetry(${aps}.activeProviderId)}finally{this.isLoadingModels=!1,`
    + `${ussVar}.setModelsLoading(!1)}}`
  );
}

function _buildReloadBody() {
  return (
    'async reloadModelsForProvider(){'
    + 'console.log("[ModelStore] Reloading models for all providers");'
    + 'this.modelsLoaded=!1,this.loadedForProviderId=null,this.availableModels=[],'
    + 'this.loadError=null;await this.loadModels()}'
  );
}

function _buildGetGroupedModelsBody(parseFn, acp) {
  return (
    `getGroupedModels(){if(this.availableModels.length===0)return[];`
    + `const e=new Map;for(const s of this.availableModels){`
    + `const r=${parseFn}(s.value).providerId;e.has(r)||e.set(r,[]);e.get(r).push(s)}`
    + `const t=[];for(const[s,r]of e){`
    + `const i=${acp}[s];t.push({providerId:i?i.id:s,providerDisplayName:i?i.displayName:s,models:r})}`
    + `return t}`
  );
}

function _build6cSearch() {
  const before =
    "if (resolvedModel && provider && resolvedModel.includes(':')) {\n"
    + "                if (!isModelValidForProvider(resolvedModel, provider)) {\n"
    + "                    const { providerId: modelProvider } = parseCompoundModelId(resolvedModel);\n"
    + "                    logger.warn('Safety net: cross-provider model mismatch in agent creation', {\n"
    + "                        resolvedModel,\n"
    + "                        modelProvider,\n"
    + "                        expectedProvider: provider,\n"
    + "                    });\n"
    + "                    if (provider in PROVIDER_MODEL_TIERS) {\n"
    + "                        const baseModel = getDefaultModelForProvider(provider, 'balanced');\n"
    + "                        const defaultProviderId = getDefaultProviderId();\n"
    + "                        resolvedModel =";
  const after =
    "provider !== defaultProviderId ? `${provider}:${baseModel}` : baseModel;\n"
    + "                        logger.debug('Re-resolved model to provider default', { resolvedModel });\n"
    + "                    }\n"
    + "                    // If provider has no tier mappings (e.g., opencode), keep resolvedModel as-is.\n"
    + "                    // We cannot safely guess a model for dynamic-model providers.\n"
    + "                }\n"
    + "            }";
  return escapeRegExp(before) + '\\s+' + escapeRegExp(after);
}

function _build6cReplace() {
  return (
    "if (resolvedModel && provider && resolvedModel.includes(':')) {\n"
    + "                if (!isModelValidForProvider(resolvedModel, provider)) {\n"
    + "                    const { providerId: modelProvider } = parseCompoundModelId(resolvedModel);\n"
    + "                    if (ACP_PROVIDERS[modelProvider]) {\n"
    + "                        logger.info('Safety net: aligning provider to match compound model', {\n"
    + "                            resolvedModel, modelProvider, previousProvider: provider,\n"
    + "                        });\n"
    + "                        provider = modelProvider;\n"
    + "                        // Re-validate after alignment; fallback to provider default if still invalid\n"
    + "                        if (!isModelValidForProvider(resolvedModel, provider) && provider in PROVIDER_MODEL_TIERS) {\n"
    + "                            const baseModel = getDefaultModelForProvider(provider, 'balanced');\n"
    + "                            const defaultProviderId = getDefaultProviderId();\n"
    + "                            resolvedModel =\n"
    + "                                provider !== defaultProviderId ? `${provider}:${baseModel}` : baseModel;\n"
    + "                            logger.debug('Re-resolved model after provider alignment', { resolvedModel });\n"
    + "                        }\n"
    + "                    } else {\n"
    + "                        logger.warn('Safety net: unknown provider in model, falling back', {\n"
    + "                            resolvedModel, modelProvider, expectedProvider: provider,\n"
    + "                        });\n"
    + "                        if (provider in PROVIDER_MODEL_TIERS) {\n"
    + "                            const baseModel = getDefaultModelForProvider(provider, 'balanced');\n"
    + "                            const defaultProviderId = getDefaultProviderId();\n"
    + "                            resolvedModel =\n"
    + "                                provider !== defaultProviderId ? `${provider}:${baseModel}` : baseModel;\n"
    + "                        }\n"
    + "                    }\n"
    + "                }\n"
    + "            }"
  );
}

function _buildPatch10BReplace() {
  return (
    "// intent-patch: context-rich enhancer via CLI\n"
    + "            const _cfgPath = _path.join(_os.homedir(), '.intent-patch', 'enhancer.json');\n"
    + "            let _cfg = {};\n"
    + "            try { _cfg = JSON.parse(_fs.readFileSync(_cfgPath, 'utf8')); } catch {}\n"
    + "            // 1. Gather workspace context\n"
    + "            let _ctxParts = [];\n"
    + "            if (workspaceId) {\n"
    + "                try {\n"
    + "                    const _ws = await workspaceService.getWorkspace(workspaceId);\n"
    + "                    if (_ws?.ok && _ws.data) {\n"
    + "                        const _wsPath = _ws.data.worktreePath || _ws.data.repositoryPath || '';\n"
    + "                        const _scope = _ws.data.scope || '';\n"
    + "                        if (_wsPath) _ctxParts.push('Workspace: ' + _wsPath);\n"
    + "                        if (_scope) _ctxParts.push('Scope: ' + _scope);\n"
    + "                    }\n"
    + "                } catch {}\n"
    + "            }\n"
    + "            // 2. Gather conversation history\n"
    + "            if (workspaceId) {\n"
    + "                try {\n"
    + "                    const _agentIds = await agentPersistence.listAgents(workspaceId);\n"
    + "                    if (_agentIds.length > 0) {\n"
    + "                        const _maxLoad = 5;\n"
    + "                        const _loads = await Promise.all(\n"
    + "                            _agentIds.slice(0, _maxLoad).map(id =>\n"
    + "                                agentPersistence.loadAgent(id, workspaceId).catch(() => null)\n"
    + "                            )\n"
    + "                        );\n"
    + "                        const _agents = _loads\n"
    + "                            .filter(r => r?.success && r.data?.messages?.length > 0)\n"
    + "                            .map(r => r.data);\n"
    + "                        _agents.sort((a, b) => {\n"
    + "                            const ta = new Date(a.updatedAt || a.lastActivity || 0).getTime();\n"
    + "                            const tb = new Date(b.updatedAt || b.lastActivity || 0).getTime();\n"
    + "                            return tb - ta;\n"
    + "                        });\n"
    + "                        if (_agents[0]?.messages) {\n"
    + "                            const _maxMsgs = _cfg.maxConversationMessages ?? 20;\n"
    + "                            const _msgs = _agents[0].messages.slice(-_maxMsgs);\n"
    + "                            const _history = _msgs.map(m => {\n"
    + "                                const _role = m.role || 'unknown';\n"
    + "                                const _text = typeof m.content === 'string'\n"
    + "                                    ? m.content : JSON.stringify(m.content);\n"
    + "                                return _role + ': ' + _text.slice(0, 2000);\n"
    + "                            }).join('\\n');\n"
    + "                            if (_history) _ctxParts.push('Recent conversation:\\n' + _history);\n"
    + "                        }\n"
    + "                    }\n"
    + "                } catch {}\n"
    + "            }\n"
    + "            // 3. Build enhanced prompt with context\n"
    + "            const _basePrompt = getInputWithEnhancePrompt(prompt);\n"
    + "            const _MAX_CTX_CHARS = (_cfg.maxContextChars ?? 50000);\n"
    + "            let _ctxStr = _ctxParts.join('\\n\\n');\n"
    + "            if (_MAX_CTX_CHARS <= 0) _ctxStr = '';\n"
    + "            else if (_ctxStr.length > _MAX_CTX_CHARS) _ctxStr = _ctxStr.slice(0, _MAX_CTX_CHARS) + '\\n... (truncated)';\n"
    + "            const _fullPrompt = _ctxStr.length > 0\n"
    + "                ? 'Context for this enhancement:\\n' + _ctxStr + '\\n\\n---\\n\\n' + _basePrompt\n"
    + "                : _basePrompt;\n"
    + "            // 4. Call configured CLI or fallback to augmentCLI\n"
    + "            const _sysPrompt = _cfg.systemPrompt\n"
    + "                || 'You are a helpful assistant that enhances prompts. Do not use any tools.';\n"
    + "            const _TIMEOUT = _cfg.timeout ?? 60000;\n"
    + "            const _tool = _cfg.tool;\n"
    + "            let enhancedPrompt;\n"
    + "            if (_tool) {\n"
    + "                const _cliPrompt = 'System: ' + _sysPrompt + '\\n\\n' + _fullPrompt;\n"
    + "                const _bufMB = Math.max(1, Math.min(20, Number(_cfg.maxBuffer) || 5));\n"
    + "                const _MAX_BUF = _bufMB * 1024 * 1024;\n"
    + "                const _cliArgs = Array.isArray(_cfg.args) ? _cfg.args : ['--print'];\n"
    + "                try {\n"
    + "                    const _raw = await new Promise((resolve, reject) => {\n"
    + "                        let _done = false;\n"
    + "                        const _fin = (fn, v) => { if (!_done) { _done = true; fn(v); } };\n"
    + "                        const _proc = _spawn(_tool, _cliArgs, {\n"
    + "                            stdio: ['pipe', 'pipe', 'pipe'],\n"
    + "                        });\n"
    + "                        let _out = '', _outLen = 0;\n"
    + "                        _proc.stdout.on('data', d => {\n"
    + "                            _outLen += d.length;\n"
    + "                            if (_outLen <= _MAX_BUF) _out += d;\n"
    + "                            else { _proc.kill('SIGTERM'); _fin(reject, new Error('stdout exceeded limit')); }\n"
    + "                        });\n"
    + "                        _proc.stderr.on('data', () => {});\n"
    + "                        _proc.on('error', e => _fin(reject, e));\n"
    + "                        _proc.on('close', code => {\n"
    + "                            const r = _out.trim();\n"
    + "                            if (code === 0 && r.length >= 10) _fin(resolve, r);\n"
    + "                            else _fin(reject, new Error('exit=' + code + ' len=' + r.length));\n"
    + "                        });\n"
    + "                        const _t = setTimeout(() => {\n"
    + "                            _proc.kill('SIGTERM');\n"
    + "                            setTimeout(() => { try { _proc.kill('SIGKILL'); } catch {} }, 5000);\n"
    + "                            _fin(reject, new Error('timeout'));\n"
    + "                        }, _TIMEOUT);\n"
    + "                        _proc.on('close', () => clearTimeout(_t));\n"
    + "                        _proc.stdin.on('error', () => {});\n"
    + "                        _proc.stdin.write(_cliPrompt);\n"
    + "                        _proc.stdin.end();\n"
    + "                    });\n"
    + "                    enhancedPrompt = extractEnhancedPrompt(_raw);\n"
    + "                } catch (_spawnErr) {\n"
    + "                    const _isNotFound = _spawnErr.code === 'ENOENT';\n"
    + "                    logger.warn(_isNotFound\n"
    + "                        ? 'CLI tool not found, falling back to augmentCLI. Set tool:\"\" in enhancer.json to silence.'\n"
    + "                        : 'CLI enhancer failed, falling back to augmentCLI',\n"
    + "                        { error: _spawnErr.message, tool: _tool });\n"
    + "                    const response = await augmentCLI.streamChat(_fullPrompt, {\n"
    + "                        model: modelId || MODEL_DEFAULTS.BACKGROUND_REQUEST_MODEL,\n"
    + "                        workspaceId,\n"
    + "                        agentId: 'enhance-prompt',\n"
    + "                        systemPrompt: _sysPrompt,\n"
    + "                        skipMcp: true,\n"
    + "                    }, () => {}, undefined, _TIMEOUT);\n"
    + "                    enhancedPrompt = extractEnhancedPrompt(response.content);\n"
    + "                }\n"
    + "            } else {\n"
    + "                const response = await augmentCLI.streamChat(_fullPrompt, {\n"
    + "                    model: modelId || MODEL_DEFAULTS.BACKGROUND_REQUEST_MODEL,\n"
    + "                    workspaceId,\n"
    + "                    agentId: 'enhance-prompt',\n"
    + "                    systemPrompt: _sysPrompt,\n"
    + "                    skipMcp: true,\n"
    + "                }, () => {}, undefined, _TIMEOUT);\n"
    + "                enhancedPrompt = extractEnhancedPrompt(response.content);\n"
    + "            }"
  );
}

// Old Patch 10B replace text (v1: augmentCLI-only) — used as search_alt for upgrade path
function _buildPatch10BOldReplace() {
  return (
    "// intent-patch: context-rich enhancer via augmentCLI\n"
    + "            const _cfgPath = _path.join(_os.homedir(), '.intent-patch', 'enhancer.json');\n"
    + "            let _cfg = {};\n"
    + "            try { _cfg = JSON.parse(_fs.readFileSync(_cfgPath, 'utf8')); } catch {}\n"
    + "            // 1. Gather workspace context\n"
    + "            let _ctxParts = [];\n"
    + "            if (workspaceId) {\n"
    + "                try {\n"
    + "                    const _ws = await workspaceService.getWorkspace(workspaceId);\n"
    + "                    if (_ws?.ok && _ws.data) {\n"
    + "                        const _wsPath = _ws.data.worktreePath || _ws.data.repositoryPath || '';\n"
    + "                        const _scope = _ws.data.scope || '';\n"
    + "                        if (_wsPath) _ctxParts.push('Workspace: ' + _wsPath);\n"
    + "                        if (_scope) _ctxParts.push('Scope: ' + _scope);\n"
    + "                    }\n"
    + "                } catch {}\n"
    + "            }\n"
    + "            // 2. Gather conversation history\n"
    + "            if (workspaceId) {\n"
    + "                try {\n"
    + "                    const _agentIds = await agentPersistence.listAgents(workspaceId);\n"
    + "                    if (_agentIds.length > 0) {\n"
    + "                        const _maxLoad = 5;\n"
    + "                        const _loads = await Promise.all(\n"
    + "                            _agentIds.slice(0, _maxLoad).map(id =>\n"
    + "                                agentPersistence.loadAgent(id, workspaceId).catch(() => null)\n"
    + "                            )\n"
    + "                        );\n"
    + "                        const _agents = _loads\n"
    + "                            .filter(r => r?.success && r.data?.messages?.length > 0)\n"
    + "                            .map(r => r.data);\n"
    + "                        _agents.sort((a, b) => {\n"
    + "                            const ta = new Date(a.updatedAt || a.lastActivity || 0).getTime();\n"
    + "                            const tb = new Date(b.updatedAt || b.lastActivity || 0).getTime();\n"
    + "                            return tb - ta;\n"
    + "                        });\n"
    + "                        if (_agents[0]?.messages) {\n"
    + "                            const _maxMsgs = _cfg.maxConversationMessages ?? 20;\n"
    + "                            const _msgs = _agents[0].messages.slice(-_maxMsgs);\n"
    + "                            const _history = _msgs.map(m => {\n"
    + "                                const _role = m.role || 'unknown';\n"
    + "                                const _text = typeof m.content === 'string'\n"
    + "                                    ? m.content : JSON.stringify(m.content);\n"
    + "                                return _role + ': ' + _text.slice(0, 2000);\n"
    + "                            }).join('\\n');\n"
    + "                            if (_history) _ctxParts.push('Recent conversation:\\n' + _history);\n"
    + "                        }\n"
    + "                    }\n"
    + "                } catch {}\n"
    + "            }\n"
    + "            // 3. Build enhanced prompt with context\n"
    + "            const _basePrompt = getInputWithEnhancePrompt(prompt);\n"
    + "            const _MAX_CTX_CHARS = (_cfg.maxContextChars ?? 50000);\n"
    + "            let _ctxStr = _ctxParts.join('\\n\\n');\n"
    + "            if (_MAX_CTX_CHARS <= 0) _ctxStr = '';\n"
    + "            else if (_ctxStr.length > _MAX_CTX_CHARS) _ctxStr = _ctxStr.slice(0, _MAX_CTX_CHARS) + '\\n... (truncated)';\n"
    + "            const _fullPrompt = _ctxStr.length > 0\n"
    + "                ? 'Context for this enhancement:\\n' + _ctxStr + '\\n\\n---\\n\\n' + _basePrompt\n"
    + "                : _basePrompt;\n"
    + "            // 4. Call augmentCLI with rich context\n"
    + "            const _sysPrompt = _cfg.systemPrompt\n"
    + "                || 'You are a helpful assistant that enhances prompts. Use the provided context to make the prompt more specific and actionable. Do not use any tools.';\n"
    + "            const _timeout = _cfg.timeout ?? 60000;\n"
    + "            const response = await augmentCLI.streamChat(_fullPrompt, {\n"
    + "                model: modelId || MODEL_DEFAULTS.BACKGROUND_REQUEST_MODEL,\n"
    + "                workspaceId,\n"
    + "                agentId: 'enhance-prompt',\n"
    + "                systemPrompt: _sysPrompt,\n"
    + "                skipMcp: true,\n"
    + "            }, () => { }, undefined, _timeout);\n"
    + "            const enhancedPrompt = extractEnhancedPrompt(response.content);"
  );
}

module.exports = { buildPatches };
