#!/usr/bin/env python3
"""Verify all 8 patches are applied correctly in extracted/ directory."""

import sys
import os

EXTRACTED = os.path.join(os.path.dirname(os.path.abspath(__file__)), "extracted")

CHECKS = [
    # (file_relative_path, description, must_contain, must_not_contain)
    (
        "dist/features/agent/services/agent-factory.js",
        "Patch 6A: ACP_PROVIDERS import",
        "import { ACP_PROVIDERS, getDefaultModelForProvider",
        None,
    ),
    (
        "dist/features/agent/services/agent-factory.js",
        "Patch 6B: derive provider from model ID (no colon guard)",
        "if (!provider && config.model) {\n                const { providerId } = parseCompoundModelId(config.model);",
        "if (!provider && config.model && config.model.includes(':'))",
    ),
    (
        "dist/features/agent/services/agent-factory.js",
        "Patch 6C: safety-net align provider",
        "Safety net: aligning provider to match compound model",
        "Safety net: cross-provider model mismatch in agent creation",
    ),
    (
        "dist/features/agent/services/agent-factory.js",
        "Patch 6C+: re-validate after alignment",
        "Re-resolved model after provider alignment",
        None,
    ),
    (
        "dist/renderer/app/immutable/chunks/BTPDcoPQ.js",
        "Patch 1: loadModels fetches all providers",
        'loadedForProviderId==="__all__"',
        'loadedForProviderId===e||this.isLoadingModels',
    ),
    (
        "dist/renderer/app/immutable/chunks/BTPDcoPQ.js",
        "Patch 1: Promise.allSettled",
        "Promise.allSettled",
        None,
    ),
    (
        "dist/renderer/app/immutable/chunks/BTPDcoPQ.js",
        "Patch 2: reloadModelsForProvider simplified",
        'Reloading models for all providers',
        'Reloading models for provider change',
    ),
    (
        "dist/renderer/app/immutable/chunks/BTPDcoPQ.js",
        "Patch 3: selectModel uses parsed providerId",
        "Ce(e).providerId;this.providerModels.set(t,e)",
        "H.activeProviderId;this.providerModels.set(t,e)",
    ),
    (
        "dist/renderer/app/immutable/chunks/BTPDcoPQ.js",
        "Patch 4: getGroupedModels groups by provider",
        "getGroupedModels(){if(this.availableModels.length===0)return[];const e=new Map",
        'getGroupedModels(){const e=H.activeProviderId',
    ),
    (
        "dist/renderer/app/immutable/chunks/CfKn743W.js",
        "Patch 7A: isAgentProviderOverride always false",
        "Ie=H(()=>!1)",
        "Ie=H(()=>t(be)!==mt.activeProviderId)",
    ),
    (
        "dist/renderer/app/immutable/chunks/CfKn743W.js",
        "Patch 7B: effect clears agentProviderModels",
        "nt(()=>{t(be);h(xe,null),h(re,!1),h(se,null)})",
        "ce.getModelsForProvider(r).then",
    ),
]


def main():
    passed = 0
    failed = 0
    errors = []

    for rel_path, desc, must_contain, must_not_contain in CHECKS:
        full_path = os.path.join(EXTRACTED, rel_path)
        if not os.path.exists(full_path):
            print(f"  MISSING  {desc}")
            print(f"           File not found: {rel_path}")
            failed += 1
            errors.append(desc)
            continue

        content = open(full_path, "r").read()
        ok = True

        if must_contain and must_contain not in content:
            print(f"  FAIL     {desc}")
            print(f"           Expected pattern not found")
            ok = False

        if must_not_contain and must_not_contain in content:
            print(f"  FAIL     {desc}")
            print(f"           Old pattern still present")
            ok = False

        if ok:
            print(f"  OK       {desc}")
            passed += 1
        else:
            failed += 1
            errors.append(desc)

    print()
    print(f"Results: {passed} passed, {failed} failed, {passed + failed} total")

    if failed > 0:
        print()
        print("Failed checks:")
        for e in errors:
            print(f"  - {e}")
        sys.exit(1)
    else:
        print("All patches verified.")


if __name__ == "__main__":
    main()
