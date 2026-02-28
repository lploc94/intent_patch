#!/usr/bin/env python3
"""
Auto-Patcher cho Intent Multi-Provider Patch.

Tự động phát hiện files, resolve symbol names, apply patches, verify và install.
Hoạt động xuyên phiên bản Intent — không hardcode tên file minified.

Usage:
    python3 autopatch.py                        # Full pipeline
    python3 autopatch.py --extracted-dir ./ext   # Patch existing extracted dir
    python3 autopatch.py --dry-run               # Không sửa file
    python3 autopatch.py --discover-only         # Chỉ tìm files + resolve symbols
"""

import argparse
import glob
import json
import os
import re
import shutil
import subprocess
import sys
import textwrap
from dataclasses import dataclass, field
from enum import Enum
from typing import Optional


# ─── Constants ──────────────────────────────────────────────────────────────────

INTENT_APP = "/Applications/Intent by Augment.app"
INTENT_RESOURCES = os.path.join(INTENT_APP, "Contents", "Resources")
INTENT_ASAR = os.path.join(INTENT_RESOURCES, "app.asar")
INTENT_UNPACKED = os.path.join(INTENT_RESOURCES, "app.asar.unpacked")
INTENT_PLIST = os.path.join(INTENT_APP, "Contents", "Info.plist")

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
BACKUP_ASAR = os.path.join(SCRIPT_DIR, "app.asar.backup")
DEFAULT_EXTRACTED = os.path.join(SCRIPT_DIR, "extracted")

AGENT_FACTORY_REL = "dist/features/agent/services/agent-factory.js"
CHUNKS_DIR_REL = "dist/renderer/app/immutable/chunks"

# Marker for patched loadModels cache key
PATCH_MARKER = '"__all__"'


# ─── Data Classes ───────────────────────────────────────────────────────────────

class PatchState(Enum):
    NOT_APPLIED = "not_applied"
    APPLIED = "applied"
    CONFLICT = "conflict"


@dataclass
class SymbolMap:
    """Resolved symbol names for a target file."""
    # Provider config exports: semanticName → exportAlias
    provider_exports: dict = field(default_factory=dict)
    # Target file imports from provider config: exportAlias → importAlias
    provider_imports: dict = field(default_factory=dict)
    # Target file imports from model store: exportAlias → importAlias
    modelstore_imports: dict = field(default_factory=dict)
    # Target file imports from svelte runtime: exportAlias → importAlias
    svelte_imports: dict = field(default_factory=dict)
    # Resolved: semanticName → local alias in target file
    resolved: dict = field(default_factory=dict)


@dataclass
class DiscoveredFiles:
    """Discovered file paths (relative to extracted dir)."""
    agent_factory: str = AGENT_FACTORY_REL
    provider_config: Optional[str] = None
    model_store: Optional[str] = None
    model_picker: Optional[str] = None
    # Also track the filenames for import resolution
    provider_config_filename: Optional[str] = None
    model_store_filename: Optional[str] = None


@dataclass
class PatchDef:
    """Definition of a single patch."""
    name: str
    file_key: str  # 'agent_factory', 'model_store', 'model_picker'
    patch_type: str  # 'text_replace', 'function_replace', 'statement_replace'
    # For text_replace / statement_replace
    search: Optional[str] = None
    replace: Optional[str] = None
    search_regex: Optional[str] = None
    replace_template: Optional[str] = None
    # For function_replace
    function_anchor: Optional[str] = None
    new_body: Optional[str] = None
    # Verification
    verify_present: Optional[str] = None
    verify_absent: Optional[str] = None


# ─── Utility Functions ──────────────────────────────────────────────────────────

def log(msg, level="INFO"):
    prefix = {"INFO": "  ", "OK": "  ✓", "FAIL": "  ✗", "WARN": "  !", "SKIP": "  →"}
    print(f"{prefix.get(level, '  ')} {msg}")


def fatal(msg):
    print(f"\n  ✗ FATAL: {msg}", file=sys.stderr)
    sys.exit(1)


def run_cmd(cmd, check=True, capture=True, timeout=120, **kwargs):
    """Run a shell command."""
    result = subprocess.run(
        cmd, shell=isinstance(cmd, str), check=check,
        capture_output=capture, text=True, timeout=timeout, **kwargs
    )
    return result


def which(cmd):
    """Check if command exists in PATH."""
    return shutil.which(cmd) is not None


def read_file(path):
    """Read file content."""
    with open(path, "r", encoding="utf-8") as f:
        return f.read()


def write_file(path, content):
    """Write file content."""
    with open(path, "w", encoding="utf-8") as f:
        f.write(content)


def find_single_match(pattern, text, context_name=""):
    """Find exactly one match of regex pattern in text. Return match or None on failure."""
    matches = list(re.finditer(pattern, text))
    if len(matches) == 1:
        return matches[0]
    if len(matches) == 0:
        log(f"Pattern not found for {context_name}: {pattern[:80]}...", "FAIL")
        return None
    log(f"Multiple matches ({len(matches)}) for {context_name}: {pattern[:80]}...", "FAIL")
    return None


# ─── Phase 0: Preflight ────────────────────────────────────────────────────────

def preflight_checks(skip_install=False):
    """Verify tools, permissions, and paths."""
    print("\n=== Phase 0: Preflight Checks ===")
    ok = True

    # Node.js
    if which("node"):
        try:
            ver = run_cmd("node --version").stdout.strip()
            major = int(ver.lstrip("v").split(".")[0])
            if major < 18:
                log(f"Node.js {ver} too old, need ≥18", "FAIL")
                ok = False
            else:
                log(f"Node.js {ver}", "OK")
        except Exception:
            log("Cannot determine Node.js version", "FAIL")
            ok = False
    else:
        log("node not found in PATH", "FAIL")
        ok = False

    # npx asar
    try:
        run_cmd("npx asar --version", check=True)
        log("npx asar available", "OK")
    except Exception:
        log("npx asar not available (run: npm i -g @electron/asar)", "FAIL")
        ok = False

    if not skip_install:
        # codesign
        if which("codesign"):
            log("codesign available", "OK")
        else:
            log("codesign not found", "FAIL")
            ok = False

        # PlistBuddy
        if os.path.exists("/usr/libexec/PlistBuddy"):
            log("PlistBuddy available", "OK")
        else:
            log("PlistBuddy not found", "FAIL")
            ok = False

        # Intent app
        if os.path.isdir(INTENT_APP):
            log(f"Intent app found at {INTENT_APP}", "OK")
        else:
            log(f"Intent app not found at {INTENT_APP}", "FAIL")
            ok = False

        # app.asar
        if os.path.exists(INTENT_ASAR):
            log("app.asar exists", "OK")
        else:
            log("app.asar not found in Intent bundle", "FAIL")
            ok = False

    if not ok:
        fatal("Preflight checks failed. Fix the issues above and retry.")

    log("All preflight checks passed.", "OK")


# ─── Phase 1: File Discovery ───────────────────────────────────────────────────

def discover_files(extracted_dir):
    """Find the 4 target files using structural fingerprints."""
    print("\n=== Phase 1: File Discovery ===")

    files = DiscoveredFiles()
    chunks_dir = os.path.join(extracted_dir, CHUNKS_DIR_REL)

    if not os.path.isdir(chunks_dir):
        fatal(f"Chunks directory not found: {chunks_dir}")

    # 1.1 agent-factory.js — fixed path
    af_path = os.path.join(extracted_dir, AGENT_FACTORY_REL)
    if os.path.exists(af_path):
        log(f"agent-factory.js: {AGENT_FACTORY_REL}", "OK")
    else:
        fatal(f"agent-factory.js not found at {af_path}")

    # 1.2 Provider Config Chunk
    files.provider_config, files.provider_config_filename = _discover_provider_config(chunks_dir)

    # 1.3 ModelStore Chunk
    files.model_store, files.model_store_filename = _discover_model_store(chunks_dir, files.provider_config_filename)

    # 1.4 ModelPicker Chunk
    files.model_picker = _discover_model_picker(chunks_dir, files.model_store_filename)

    return files


def _discover_provider_config(chunks_dir):
    """Find provider config chunk by structural fingerprint."""
    candidates = []
    for js_file in glob.glob(os.path.join(chunks_dir, "*.js")):
        filename = os.path.basename(js_file)
        content = read_file(js_file)

        # Must have activeProviderId property
        has_active_provider = ".activeProviderId" in content
        # Must have parseCompoundModelId-like function (split on ":")
        has_parse = '.split(":")' in content or ".split(':')" in content
        # Must have isDefault flags
        has_is_default = "isDefault:!0" in content or "isDefault:!1" in content
        # Must have tier keys
        has_tiers = "fast:" in content and "balanced:" in content and "smart:" in content
        # Must have localStorage key
        has_ls_key = '"workspaces-active-provider"' in content

        if has_active_provider and has_parse and has_is_default and has_tiers and has_ls_key:
            candidates.append((filename, js_file))

    if len(candidates) == 0:
        fatal("Provider config chunk not found. No file matches structural fingerprint.")
    if len(candidates) > 1:
        names = [c[0] for c in candidates]
        fatal(f"Multiple provider config candidates: {names}. Expected exactly 1.")

    filename = candidates[0][0]
    rel_path = os.path.join(CHUNKS_DIR_REL, filename)
    log(f"Provider config: {filename}", "OK")
    return rel_path, filename


def _discover_model_store(chunks_dir, provider_config_filename):
    """Find ModelStore chunk."""
    if not provider_config_filename:
        fatal("provider_config_filename required for ModelStore discovery")

    candidates = []
    for js_file in glob.glob(os.path.join(chunks_dir, "*.js")):
        filename = os.path.basename(js_file)
        content = read_file(js_file)

        # Must contain these non-minified method names
        has_methods = all(m in content for m in [
            "loadModels", "selectModel", "getGroupedModels",
            "reloadModelsForProvider", "fetchModelsForProvider",
            "availableModels", "modelsLoaded"
        ])
        # Must have localStorage key
        has_ls_key = '"workspaces-selected-model"' in content
        # Must import from provider config
        has_import = f'from"./{provider_config_filename}"' in content

        if has_methods and has_ls_key and has_import:
            candidates.append((filename, js_file))

    if len(candidates) == 0:
        fatal("ModelStore chunk not found. No file matches structural fingerprint.")
    if len(candidates) > 1:
        names = [c[0] for c in candidates]
        fatal(f"Multiple ModelStore candidates: {names}. Expected exactly 1.")

    filename = candidates[0][0]
    rel_path = os.path.join(CHUNKS_DIR_REL, filename)
    log(f"ModelStore: {filename}", "OK")
    return rel_path, filename


def _discover_model_picker(chunks_dir, model_store_filename):
    """Find ModelPicker chunk."""
    if not model_store_filename:
        fatal("model_store_filename required for ModelPicker discovery")

    candidates = []
    for js_file in glob.glob(os.path.join(chunks_dir, "*.js")):
        filename = os.path.basename(js_file)
        content = read_file(js_file)

        # Must import from ModelStore
        has_ms_import = f'from"./{model_store_filename}"' in content
        # Must have model fallback localStorage key prefix
        has_fallback_key = '"workspaces-model-fallback:"' in content
        # Must have ModelPicker string
        has_picker = '"ModelPicker"' in content

        if has_ms_import and has_fallback_key and has_picker:
            candidates.append((filename, js_file))

    if len(candidates) == 0:
        fatal("ModelPicker chunk not found. No file matches structural fingerprint.")
    if len(candidates) > 1:
        names = [c[0] for c in candidates]
        fatal(f"Multiple ModelPicker candidates: {names}. Expected exactly 1.")

    filename = candidates[0][0]
    rel_path = os.path.join(CHUNKS_DIR_REL, filename)
    log(f"ModelPicker: {filename}", "OK")
    return rel_path


# ─── Phase 2: Symbol Resolution ────────────────────────────────────────────────

def resolve_symbols(extracted_dir, files):
    """Resolve minified symbol names across all files."""
    print("\n=== Phase 2: Symbol Resolution ===")

    # 2.1 Parse provider config exports
    pc_symbols = resolve_provider_config(extracted_dir, files)

    # 2.2 Resolve ModelStore imports
    ms_symbols = resolve_model_store(extracted_dir, files, pc_symbols)

    # 2.3 Resolve ModelPicker imports
    mp_symbols = resolve_model_picker(extracted_dir, files, pc_symbols, ms_symbols)

    return pc_symbols, ms_symbols, mp_symbols


def resolve_provider_config(extracted_dir, files):
    """Parse provider config exports and identify semantic names."""
    print("  --- Provider Config Exports ---")
    pc_path = os.path.join(extracted_dir, files.provider_config)
    content = read_file(pc_path)

    symbols = SymbolMap()

    # Parse export statement: export{localVar as alias, ...}
    export_match = re.search(r'export\{([^}]+)\}', content)
    if not export_match:
        fatal("Cannot parse export statement in provider config")

    exports_str = export_match.group(1)
    export_pairs = {}
    for pair in exports_str.split(","):
        pair = pair.strip()
        m = re.match(r'(\w+)\s+as\s+(\w+)', pair)
        if m:
            local_var, alias = m.group(1), m.group(2)
            export_pairs[alias] = local_var

    log(f"Parsed {len(export_pairs)} exports", "OK")

    # Identify semantic names by analyzing local variable definitions
    # ACP_PROVIDERS: object with isDefault flags
    for alias, local in export_pairs.items():
        # Find the variable definition and analyze its shape
        pass  # Will be done below

    # Strategy: identify by unique characteristics of each function/object
    semantic_map = {}

    # parseCompoundModelId: function with .split(":")
    # Look for: function LOCAL(r){...r.split(":")...} or const LOCAL=r=>{...}
    for alias, local in export_pairs.items():
        # Check if this local var is the parseCompoundModelId function
        # Pattern: function that takes one arg, splits on ":", returns {providerId, modelId}
        pat = re.compile(
            rf'function\s+{re.escape(local)}\s*\([^)]*\)\s*\{{[^}}]*\.split\(":', re.DOTALL
        )
        if pat.search(content):
            semantic_map["parseCompoundModelId"] = alias
            log(f"parseCompoundModelId → export '{alias}' (local '{local}')", "OK")
            break

    # ACP_PROVIDERS: object with provider entries having isDefault
    # Pattern: const LOCAL={auggie:{...isDefault:!0...}, ...}
    # Find object assigned to local var that contains isDefault
    for alias, local in export_pairs.items():
        # Look for: const LOCAL={...isDefault:!0...isDefault:!1...}
        # This is a large object literal
        pat = re.compile(
            rf'(?:const|let|var)\s+{re.escape(local)}\s*=\s*\{{[^;]*?isDefault:!0[^;]*?isDefault:!1',
            re.DOTALL
        )
        if pat.search(content):
            semantic_map["ACP_PROVIDERS"] = alias
            log(f"ACP_PROVIDERS → export '{alias}' (local '{local}')", "OK")
            break

    # activeProviderStore: instance of class with activeProviderId + setActiveProvider
    # Look for: const LOCAL=new CLASS  where CLASS has .activeProviderId
    for alias, local in export_pairs.items():
        # Pattern: const LOCAL=new CLASSNAME, and CLASSNAME has activeProviderId
        pat = re.compile(rf'(?:const|let|var)\s+{re.escape(local)}\s*=\s*new\s+(\w+)')
        m = pat.search(content)
        if m:
            class_name = m.group(1)
            # Check if class has activeProviderId and setActiveProvider
            class_pat = re.compile(
                rf'class\s+{re.escape(class_name)}\b[^{{]*\{{.*?activeProviderId.*?setActiveProvider',
                re.DOTALL
            )
            if class_pat.search(content):
                semantic_map["activeProviderStore"] = alias
                log(f"activeProviderStore → export '{alias}' (local '{local}')", "OK")
                break

    # getDefaultProviderId: function that calls getDefaultProviderConfig().id or returns default
    for alias, local in export_pairs.items():
        # Simple function that returns the default provider ID
        # Pattern: function LOCAL(){return FUNC().id} or similar
        pat = re.compile(
            rf'function\s+{re.escape(local)}\s*\(\)\s*\{{\s*return\s+\w+\(\)\.id\s*\}}',
        )
        if pat.search(content):
            semantic_map["getDefaultProviderId"] = alias
            log(f"getDefaultProviderId → export '{alias}' (local '{local}')", "OK")
            break

    # getProviderConfigById: function that takes 1 arg, looks up from ACP_PROVIDERS
    acp_local = export_pairs.get(semantic_map.get("ACP_PROVIDERS", ""), "")
    if acp_local:
        for alias, local in export_pairs.items():
            if alias in semantic_map.values():
                continue
            # Pattern: function LOCAL(r){...ACP_LOCAL[r]...}
            pat = re.compile(
                rf'function\s+{re.escape(local)}\s*\(\w+\)\s*\{{[^}}]*{re.escape(acp_local)}\[',
                re.DOTALL
            )
            if pat.search(content):
                semantic_map["getProviderConfigById"] = alias
                log(f"getProviderConfigById → export '{alias}' (local '{local}')", "OK")
                break

    # getDefaultModelForProvider: function taking 2 args, accesses PROVIDER_MODEL_TIERS
    for alias, local in export_pairs.items():
        if alias in semantic_map.values():
            continue
        # Pattern: function with 2 params that references tier object
        pat = re.compile(
            rf'function\s+{re.escape(local)}\s*\(\w+\s*,\s*\w+\)\s*\{{',
        )
        if pat.search(content):
            # Check it references balanced/fast/smart tiers
            func_start = pat.search(content).start()
            snippet = content[func_start:func_start + 500]
            if "auggie" in snippet or "balanced" in snippet:
                semantic_map["getDefaultModelForProvider"] = alias
                log(f"getDefaultModelForProvider → export '{alias}' (local '{local}')", "OK")
                break

    # isModelValidForProvider: function that calls parseCompoundModelId then compares
    parse_local = export_pairs.get(semantic_map.get("parseCompoundModelId", ""), "")
    if parse_local:
        for alias, local in export_pairs.items():
            if alias in semantic_map.values():
                continue
            pat = re.compile(
                rf'function\s+{re.escape(local)}\s*\(\w+\s*,\s*\w+\)\s*\{{[^}}]*{re.escape(parse_local)}\(',
                re.DOTALL
            )
            if pat.search(content):
                semantic_map["isModelValidForProvider"] = alias
                log(f"isModelValidForProvider → export '{alias}' (local '{local}')", "OK")
                break

    # PROVIDER_MODEL_TIERS: object with fast/balanced/smart entries per provider
    for alias, local in export_pairs.items():
        if alias in semantic_map.values():
            continue
        # Pattern: const LOCAL={auggie:{fast:"...",balanced:"...",smart:"..."}, ...}
        pat = re.compile(
            rf'(?:const|let|var)\s+{re.escape(local)}\s*=\s*\{{[^;]*?fast:\s*"[^"]*"[^;]*?balanced:\s*"[^"]*"[^;]*?smart:\s*"[^"]*"',
            re.DOTALL
        )
        if pat.search(content):
            semantic_map["PROVIDER_MODEL_TIERS"] = alias
            log(f"PROVIDER_MODEL_TIERS → export '{alias}' (local '{local}')", "OK")
            break

    symbols.provider_exports = semantic_map

    # Validate essential symbols resolved
    required = ["parseCompoundModelId", "ACP_PROVIDERS", "activeProviderStore",
                 "getDefaultProviderId", "getProviderConfigById"]
    missing = [s for s in required if s not in semantic_map]
    if missing:
        fatal(f"Failed to resolve provider config symbols: {missing}")

    return symbols


def resolve_model_store(extracted_dir, files, pc_symbols):
    """Resolve ModelStore imports from provider config."""
    print("  --- ModelStore Imports ---")
    ms_path = os.path.join(extracted_dir, files.model_store)
    content = read_file(ms_path)

    symbols = SymbolMap()
    symbols.provider_exports = pc_symbols.provider_exports

    # Parse import from provider config
    pc_filename = files.provider_config_filename or os.path.basename(files.provider_config)
    import_pat = re.compile(
        rf'import\s*\{{([^}}]+)\}}\s*from\s*"\./{re.escape(pc_filename)}"'
    )
    m = import_pat.search(content)
    if not m:
        fatal(f"Cannot find import from provider config in ModelStore")

    import_str = m.group(1)
    import_map = {}  # exportAlias → importAlias
    for pair in import_str.split(","):
        pair = pair.strip()
        m2 = re.match(r'(\w+)\s+as\s+(\w+)', pair)
        if m2:
            import_map[m2.group(1)] = m2.group(2)
        elif pair:
            import_map[pair] = pair

    symbols.provider_imports = import_map

    # Build resolved map: semanticName → local alias in ModelStore
    resolved = {}
    for semantic_name, export_alias in pc_symbols.provider_exports.items():
        if export_alias in import_map:
            resolved[semantic_name] = import_map[export_alias]
            log(f"{semantic_name} → '{import_map[export_alias]}' (via export '{export_alias}')", "OK")

    symbols.resolved = resolved

    # Validate essential symbols
    required = ["parseCompoundModelId", "ACP_PROVIDERS", "activeProviderStore"]
    missing = [s for s in required if s not in resolved]
    if missing:
        fatal(f"Failed to resolve ModelStore symbols: {missing}")

    # Cross-validate: check symbols are used in expected patterns
    parse_alias = resolved["parseCompoundModelId"]
    acp_alias = resolved["ACP_PROVIDERS"]
    aps_alias = resolved["activeProviderStore"]

    if content.count(f"{aps_alias}.activeProviderId") < 1 and PATCH_MARKER not in content:
        log(f"Warning: {aps_alias}.activeProviderId not found in ModelStore (may already be patched)", "WARN")

    if content.count(acp_alias) < 1 and PATCH_MARKER not in content:
        log(f"Warning: {acp_alias} not found in ModelStore", "WARN")

    return symbols


def resolve_model_picker(extracted_dir, files, pc_symbols, ms_symbols):
    """Resolve ModelPicker imports from provider config and ModelStore."""
    print("  --- ModelPicker Imports ---")
    mp_path = os.path.join(extracted_dir, files.model_picker)
    content = read_file(mp_path)

    symbols = SymbolMap()

    # Parse import from provider config
    pc_filename = files.provider_config_filename or os.path.basename(files.provider_config)
    import_pat = re.compile(
        rf'import\s*\{{([^}}]+)\}}\s*from\s*"\./{re.escape(pc_filename)}"'
    )
    m = import_pat.search(content)
    if not m:
        fatal(f"Cannot find import from provider config in ModelPicker")

    pc_import_str = m.group(1)
    pc_import_map = {}
    for pair in pc_import_str.split(","):
        pair = pair.strip()
        m2 = re.match(r'(\w+)\s+as\s+(\w+)', pair)
        if m2:
            pc_import_map[m2.group(1)] = m2.group(2)
        elif pair:
            pc_import_map[pair] = pair

    symbols.provider_imports = pc_import_map

    # Resolve provider config symbols in ModelPicker
    resolved = {}
    for semantic_name, export_alias in pc_symbols.provider_exports.items():
        if export_alias in pc_import_map:
            resolved[semantic_name] = pc_import_map[export_alias]

    # Parse import from ModelStore
    ms_filename = files.model_store_filename or os.path.basename(files.model_store)
    ms_import_pat = re.compile(
        rf'import\s*\{{([^}}]+)\}}\s*from\s*"\./{re.escape(ms_filename)}"'
    )
    m = ms_import_pat.search(content)
    if m:
        ms_import_str = m.group(1)
        ms_import_map = {}
        for pair in ms_import_str.split(","):
            pair = pair.strip()
            m2 = re.match(r'(\w+)\s+as\s+(\w+)', pair)
            if m2:
                ms_import_map[m2.group(1)] = m2.group(2)
            elif pair:
                ms_import_map[pair] = pair
        symbols.modelstore_imports = ms_import_map

    # Parse import from Svelte runtime (FWapvpP5.js equiv)
    # Find the import that brings in many Svelte primitives
    svelte_import_pat = re.compile(
        r'import\s*\{([^}]+)\}\s*from\s*"\./(\w+\.js)"'
    )
    for m in svelte_import_pat.finditer(content):
        import_str = m.group(1)
        if import_str.count(" as ") > 10:  # Svelte runtime has many imports
            svelte_map = {}
            for pair in import_str.split(","):
                pair = pair.strip()
                m2 = re.match(r'(\w+)\s+as\s+(\w+)', pair)
                if m2:
                    svelte_map[m2.group(1)] = m2.group(2)
                elif pair:
                    svelte_map[pair] = pair
            symbols.svelte_imports = svelte_map
            break

    # Resolve Svelte primitives by structural patterns in ModelPicker
    # We need: computed, effect, get, set, signal

    # activeProviderStore: find VAR.activeProviderId pattern
    aps_alias = resolved.get("activeProviderStore")
    if aps_alias:
        log(f"activeProviderStore → '{aps_alias}' in ModelPicker", "OK")
    else:
        log("activeProviderStore not imported in ModelPicker", "WARN")

    # getProviderConfigById
    gpcbi_alias = resolved.get("getProviderConfigById")
    if gpcbi_alias:
        log(f"getProviderConfigById → '{gpcbi_alias}' in ModelPicker", "OK")

    # Identify computed, effect, get, set from Svelte imports
    # Pattern for isAgentProviderOverride:
    #   VAR1 = VAR2(() => VAR3(VAR4) !== VAR5.activeProviderId)
    # where VAR2=computed, VAR3=get, VAR5=activeProviderStore
    if aps_alias:
        override_pat = re.compile(
            r'(\w+)\s*=\s*(\w+)\s*\(\s*\(\s*\)\s*=>\s*(\w+)\s*\(\s*(\w+)\s*\)\s*!==\s*'
            + re.escape(aps_alias) + r'\.activeProviderId\s*\)'
        )
        m = override_pat.search(content)
        if m:
            resolved["isAgentProviderOverride"] = m.group(1)
            resolved["computed"] = m.group(2)
            resolved["get"] = m.group(3)
            resolved["effectiveProviderId"] = m.group(4)
            log(f"isAgentProviderOverride → '{m.group(1)}' (override pattern found)", "OK")
            log(f"computed → '{m.group(2)}', get → '{m.group(3)}', effectiveProviderId → '{m.group(4)}'", "OK")
        else:
            # Might be already patched: VAR1 = VAR2(() => !1)
            patched_pat = re.compile(r'(\w+)\s*=\s*(\w+)\s*\(\s*\(\s*\)\s*=>\s*!1\s*\)')
            # Need more context to identify which one is isAgentProviderOverride
            # Look for the effect pattern nearby
            log("isAgentProviderOverride original pattern not found (may be patched)", "WARN")
            # Try to find from patched pattern + context
            _resolve_patched_model_picker(content, resolved, aps_alias)

    # Identify effect and set from the effect pattern:
    #   EFFECT(() => { GET(effectiveProviderId); SET(agentProviderModels, null); ... })
    # The effect contains getModelsForProvider (original) or just clear signals (patched)
    effect_alias = None
    set_alias = None
    epid = resolved.get("effectiveProviderId")
    get_alias = resolved.get("get")
    if epid and get_alias:
        # Original: EFFECT(()=>{const r=GET(EPID);...getModelsForProvider...})
        # Patched:  EFFECT(()=>{GET(EPID);SET(xe,null),...})
        effect_pat = re.compile(
            r'(\w+)\s*\(\s*\(\s*\)\s*=>\s*\{[^}]*?'
            + re.escape(get_alias) + r'\s*\(\s*' + re.escape(epid) + r'\s*\)'
        )
        for m in effect_pat.finditer(content):
            # Check this is the right effect (should be near model picker code)
            effect_alias = m.group(1)
            resolved["effect"] = effect_alias
            log(f"effect → '{effect_alias}'", "OK")
            break

    # Find set (signal setter) — used as SET(VAR, value)
    # Look in the effect body for SET(VAR, null) pattern
    if epid and get_alias:
        # Find the effect block and extract set alias from it
        # Pattern: EFFECT(()=>{...SET(someVar, null)...})
        set_pat = re.compile(
            r'(\w+)\s*\(\s*(\w+)\s*,\s*null\s*\)'
        )
        # Search near the effect for set calls
        if effect_alias:
            # Find effect block
            eff_search = f'{effect_alias}(()=>{{'
            eff_idx = content.find(eff_search)
            if eff_idx >= 0:
                # Extract ~500 chars of effect body
                eff_body = content[eff_idx:eff_idx + 500]
                set_matches = set_pat.findall(eff_body)
                if set_matches:
                    set_alias = set_matches[0][0]
                    resolved["set"] = set_alias
                    # Also identify agentProviderModels, isLoadingAgentModels, agentModelError
                    resolved["agentProviderModels"] = set_matches[0][1]
                    if len(set_matches) > 1:
                        resolved["isLoadingAgentModels"] = set_matches[1][1]
                    if len(set_matches) > 2:
                        resolved["agentModelError"] = set_matches[2][1]
                    log(f"set → '{set_alias}'", "OK")
                    log(f"agentProviderModels → '{set_matches[0][1]}'", "OK")

    # Find modelStore instance: accessed as VAR.availableModels
    ms_pat = re.compile(r'(\w+)\.availableModels')
    ms_matches = ms_pat.findall(content)
    if ms_matches:
        # Get most common match (should be the modelStore)
        from collections import Counter
        ms_counter = Counter(ms_matches)
        ms_alias = ms_counter.most_common(1)[0][0]
        if ms_alias != "this":  # Exclude class internal refs
            resolved["modelStore"] = ms_alias
            log(f"modelStore → '{ms_alias}'", "OK")

    symbols.resolved = resolved
    return symbols


def _resolve_patched_model_picker(content, resolved, aps_alias):
    """Try to resolve ModelPicker symbols when patches are already applied."""
    # If patches are applied, isAgentProviderOverride = COMPUTED(()=>!1)
    # We need to find it by context: it's near effectiveProviderId and before an effect

    # Find all COMPUTED(()=>!1) patterns
    false_computed_pat = re.compile(r'(\w+)\s*=\s*(\w+)\s*\(\s*\(\s*\)\s*=>\s*!1\s*\)')
    matches = list(false_computed_pat.finditer(content))

    # Look for ModelPicker-specific context: nearby activeProviderId, getModelsForProvider
    for m in matches:
        # Check context around this match (500 chars before and after)
        start = max(0, m.start() - 300)
        end = min(len(content), m.end() + 500)
        context = content[start:end]

        if aps_alias and f"{aps_alias}.activeProviderId" in context:
            resolved["isAgentProviderOverride"] = m.group(1)
            resolved["computed"] = m.group(2)
            log(f"isAgentProviderOverride → '{m.group(1)}' (patched pattern)", "OK")
            log(f"computed → '{m.group(2)}' (from patched pattern)", "OK")

            # Find get and effectiveProviderId from the effect nearby
            # Effect pattern: EFFECT(()=>{GET(EPID);SET(var,null)...})
            eff_pat = re.compile(r'(\w+)\s*\(\s*\(\s*\)\s*=>\s*\{\s*(\w+)\s*\(\s*(\w+)\s*\)')
            eff_m = eff_pat.search(context)
            if eff_m:
                resolved["effect"] = eff_m.group(1)
                resolved["get"] = eff_m.group(2)
                resolved["effectiveProviderId"] = eff_m.group(3)
                log(f"effect → '{eff_m.group(1)}', get → '{eff_m.group(2)}', effectiveProviderId → '{eff_m.group(3)}'", "OK")
            break


# ─── Phase 3: Patch Application ────────────────────────────────────────────────

def build_patches(files, pc_symbols, ms_symbols, mp_symbols, extracted_dir):
    """Build patch definitions with resolved symbols."""
    patches = []

    # ── ModelStore Patches (1-5) ──
    ms_r = ms_symbols.resolved
    ms_path = os.path.join(extracted_dir, files.model_store)
    ms_content = read_file(ms_path)

    # Get resolved aliases
    parse_fn = ms_r.get("parseCompoundModelId", "Ce")
    acp = ms_r.get("ACP_PROVIDERS", "Et")
    aps = ms_r.get("activeProviderStore", "H")
    get_default_pid = ms_r.get("getDefaultProviderId", "Ue")
    get_provider_cfg = ms_r.get("getProviderConfigById", "We")

    # Patch 1: loadModels - function_replace
    # Find original loadModels function body using brace-depth matching
    patches.append(PatchDef(
        name="Patch 1: loadModels fetches all providers",
        file_key="model_store",
        patch_type="function_replace",
        function_anchor="async loadModels()",
        new_body=_build_load_models_body(acp, get_default_pid, ms_content, aps),
        verify_present='loadedForProviderId==="__all__"',
        verify_absent=f'loadedForProviderId==={_find_cache_var(ms_content, aps)}||this.isLoadingModels',
    ))

    # Patch 2: reloadModelsForProvider - function_replace
    patches.append(PatchDef(
        name="Patch 2: reloadModelsForProvider simplified",
        file_key="model_store",
        patch_type="function_replace",
        function_anchor="async reloadModelsForProvider(",
        new_body=_build_reload_body(),
        verify_present="Reloading models for all providers",
        verify_absent="Reloading models for provider change",
    ))

    # Patch 3: selectModel - statement_replace
    # Find the pattern: const VAR = APS.activeProviderId;this.providerModels.set(VAR,e)
    # Replace with:     const VAR = PARSE(e).providerId;this.providerModels.set(VAR,e)
    patches.append(PatchDef(
        name="Patch 3: selectModel uses parsed providerId",
        file_key="model_store",
        patch_type="statement_replace",
        search_regex=rf'{re.escape(aps)}\.activeProviderId;this\.providerModels\.set\(\w+,\w+\)',
        replace_template=f'{parse_fn}(e).providerId;this.providerModels.set(t,e)',
        verify_present=f"{parse_fn}(e).providerId;this.providerModels.set(t,e)",
        verify_absent=f"{aps}.activeProviderId;this.providerModels.set(t,e)",
    ))

    # Patch 4: getGroupedModels - function_replace
    patches.append(PatchDef(
        name="Patch 4: getGroupedModels groups by provider",
        file_key="model_store",
        patch_type="function_replace",
        function_anchor="getGroupedModels()",
        new_body=_build_get_grouped_models_body(parse_fn, acp),
        verify_present="getGroupedModels(){if(this.availableModels.length===0)return[];const e=new Map",
        verify_absent=f"getGroupedModels(){{const e={aps}.activeProviderId",
    ))

    # Patch 5: scheduleAutoRetry - statement_replace
    # Remove: APS.activeProviderId===e&&
    patches.append(PatchDef(
        name="Patch 5: scheduleAutoRetry removes provider check",
        file_key="model_store",
        patch_type="statement_replace",
        search_regex=rf'{re.escape(aps)}\.activeProviderId===\w+&&',
        replace_template="",
        verify_absent=f"{aps}.activeProviderId===",
    ))

    # ── Agent Factory Patches (6A-6C) ──

    # Patch 6A: Import ACP_PROVIDERS
    patches.append(PatchDef(
        name="Patch 6A: ACP_PROVIDERS import",
        file_key="agent_factory",
        patch_type="text_replace",
        search="import { getDefaultModelForProvider,",
        replace="import { ACP_PROVIDERS, getDefaultModelForProvider,",
        verify_present="import { ACP_PROVIDERS, getDefaultModelForProvider",
    ))

    # Patch 6B: Derive provider from model ID
    patches.append(PatchDef(
        name="Patch 6B: derive provider from model ID",
        file_key="agent_factory",
        patch_type="text_replace",
        search=textwrap.dedent("""\
            let provider = config.provider;
                        if (!provider && !isBackend) {"""),
        replace=textwrap.dedent("""\
            let provider = config.provider;
                        if (!provider && config.model) {
                            const { providerId } = parseCompoundModelId(config.model);
                            if (ACP_PROVIDERS[providerId]) {
                                provider = providerId;
                                logger.debug('Derived provider from model ID', { model: config.model, provider });
                            }
                        }
                        if (!provider && !isBackend) {"""),
        verify_present="if (!provider && config.model) {\n                const { providerId } = parseCompoundModelId(config.model);",
        verify_absent="if (!provider && config.model && config.model.includes(':'))",
    ))

    # Patch 6C: Safety-net align provider
    patches.append(PatchDef(
        name="Patch 6C: safety-net align provider",
        file_key="agent_factory",
        patch_type="text_replace",
        search=_build_6c_search(),
        replace=_build_6c_replace(),
        verify_present="Safety net: aligning provider to match compound model",
        verify_absent="Safety net: cross-provider model mismatch in agent creation",
    ))

    # ── ModelPicker Patches (7A-7B) ──
    mp_r = mp_symbols.resolved

    # Patch 7A: isAgentProviderOverride always false
    iao = mp_r.get("isAgentProviderOverride", "Ie")
    computed = mp_r.get("computed", "H")
    get_fn = mp_r.get("get", "t")
    epid = mp_r.get("effectiveProviderId", "be")
    mp_aps = mp_r.get("activeProviderStore", "mt")

    patches.append(PatchDef(
        name="Patch 7A: isAgentProviderOverride always false",
        file_key="model_picker",
        patch_type="statement_replace",
        search_regex=(
            rf'{re.escape(iao)}\s*=\s*{re.escape(computed)}\s*\(\s*\(\s*\)\s*=>\s*'
            rf'{re.escape(get_fn)}\s*\(\s*{re.escape(epid)}\s*\)\s*!==\s*'
            rf'{re.escape(mp_aps)}\.activeProviderId\s*\)'
        ),
        replace_template=f'{iao}={computed}(()=>!1)',
        verify_present=f"{iao}={computed}(()=>!1)",
        verify_absent=f"{iao}={computed}(()=>{get_fn}({epid})!=={mp_aps}.activeProviderId)",
    ))

    # Patch 7B: Effect clears agentProviderModels
    effect_fn = mp_r.get("effect", "nt")
    set_fn = mp_r.get("set", "h")
    apm = mp_r.get("agentProviderModels", "xe")
    ilam = mp_r.get("isLoadingAgentModels", "re")
    ame = mp_r.get("agentModelError", "se")

    patches.append(PatchDef(
        name="Patch 7B: effect clears agentProviderModels",
        file_key="model_picker",
        patch_type="statement_replace",
        # Search for the effect containing getModelsForProvider
        search_regex=(
            rf'{re.escape(effect_fn)}\s*\(\s*\(\s*\)\s*=>\s*\{{[^}}]*?getModelsForProvider[^}}]*?\}}\s*\)'
        ),
        replace_template=(
            f'{effect_fn}(()=>{{{get_fn}({epid});'
            f'{set_fn}({apm},null),{set_fn}({ilam},!1),{set_fn}({ame},null)}})'
        ),
        verify_present=f"{effect_fn}(()=>{{{get_fn}({epid});{set_fn}({apm},null),{set_fn}({ilam},!1),{set_fn}({ame},null)}})",
        verify_absent="getModelsForProvider(r).then",
    ))

    return patches


def _find_cache_var(content, aps):
    """Find the variable used in loadedForProviderId===VAR pattern."""
    m = re.search(r'loadedForProviderId===(\w+)', content)
    return m.group(1) if m else "e"


def _build_load_models_body(acp, get_default_pid, ms_content, aps):
    """Build the new loadModels function body."""
    # Resolve all internal variables used in the body
    logger_var = "I"
    logger_match = re.search(r'const\s+(\w+)\s*=\s*\w+\(\s*"ModelStore"\s*\)', ms_content)
    if logger_match:
        logger_var = logger_match.group(1)

    # h = unified state store (has setModelsLoading, setAvailableModels)
    uss_var = "h"
    uss_match = re.search(r'(\w+)\.setModelsLoading', ms_content)
    if uss_match:
        uss_var = uss_match.group(1)

    # Se = UI constants (has UI_MODEL_PREFERENCE)
    se_var = "Se"
    se_match = re.search(r'(\w+)\.UI_MODEL_PREFERENCE', ms_content)
    if se_match:
        se_var = se_match.group(1)

    # yt = resolvePreferredModel function
    yt_var = "yt"
    yt_match = re.search(rf'(\w+)\(\s*{re.escape(se_var)}\.UI_MODEL_PREFERENCE', ms_content)
    if yt_match:
        yt_var = yt_match.group(1)

    # Ce = parseCompoundModelId (already in ms_r)
    parse_fn = "Ce"
    parse_match = re.search(r'(\w+)\(this\.selectedModel\)\.providerId', ms_content)
    if parse_match:
        parse_fn = parse_match.group(1)
    else:
        # Fallback: get from resolved imports
        for semantic, local in [("parseCompoundModelId", parse_fn)]:
            pat = re.search(rf'\{{[^}}]*providerId:\w+,modelId:\w+\}}\s*=\s*(\w+)\(', ms_content)
            if pat:
                parse_fn = pat.group(1)

    return (
        f'async loadModels(){{if(this.modelsLoaded&&this.loadedForProviderId==="__all__"||this.isLoadingModels)'
        f'{{' + logger_var + f'.debug("All provider models already loaded or loading, skipping");return}}'
        f'this.isLoadingModels=!0,this.loadError=null,'
        f'{logger_var}.debug("Loading models for ALL providers"),{uss_var}.setModelsLoading(!0);'
        f'try{{const e=Object.keys({acp}),'
        f't={get_default_pid}(),'
        f's=await Promise.allSettled(e.map(async n=>{{const o=await this.fetchModelsForProvider(n);'
        f'return{{providerId:n,models:o}}}}));'
        f'let r=[];for(const n of s)if(n.status==="fulfilled"&&n.value.models.length>0)'
        f'{{const{{providerId:o,models:c}}=n.value,'
        f'l=c.map(E=>o!==t?{{...E,value:`${{o}}:${{E.value}}`}}:E);r=r.concat(l)}}'
        f'if(r.length>0){{this.availableModels=r,this.modelsLoaded=!0,'
        f'this.loadedForProviderId="__all__",this.loadError=null,this.retryAttempt=0,'
        f'{logger_var}.info("Loaded models from all providers",{{count:r.length}}),'
        f'{uss_var}.setAvailableModels(this.availableModels);'
        f'const n=r.map(o=>o.value),'
        f'{{providerId:c,modelId:l}}={parse_fn}(this.selectedModel);'
        f'if(!(n.includes(this.selectedModel)||n.some(o=>o===l||o.endsWith(":"+l)))&&this.availableModels.length>0)'
        f'{{const o={yt_var}({se_var}.UI_MODEL_PREFERENCE,n)??this.availableModels[0].value;'
        f'{logger_var}.warn("Selected model not in merged list, using preferred default",'
        f'{{selectedModel:this.selectedModel,fallbackModel:o}}),this.selectModel(o)}}}}'
        f'else this.loadError="No models available from any provider.",'
        f'{logger_var}.warn("No models from any provider"),this.scheduleAutoRetry({aps}.activeProviderId)}}'
        f'catch(e){{const t=e instanceof Error?e.message:"Failed to load models";'
        f'this.loadError=t,{logger_var}.error("Failed to load models:",e),'
        f'this.scheduleAutoRetry({aps}.activeProviderId)}}finally{{this.isLoadingModels=!1,'
        f'{uss_var}.setModelsLoading(!1)}}}}'
    )


def _build_reload_body():
    """Build the new reloadModelsForProvider function body."""
    return (
        'async reloadModelsForProvider(){'
        'console.log("[ModelStore] Reloading models for all providers");'
        'this.modelsLoaded=!1,this.loadedForProviderId=null,this.availableModels=[],'
        'this.loadError=null;await this.loadModels()}'
    )


def _build_get_grouped_models_body(parse_fn, acp):
    """Build the new getGroupedModels function body."""
    return (
        f'getGroupedModels(){{if(this.availableModels.length===0)return[];'
        f'const e=new Map;for(const s of this.availableModels){{'
        f'const r={parse_fn}(s.value).providerId;e.has(r)||e.set(r,[]);e.get(r).push(s)}}'
        f'const t=[];for(const[s,r]of e){{'
        f'const i={acp}[s];t.push({{providerId:i?i.id:s,providerDisplayName:i?i.displayName:s,models:r}})}}'
        f'return t}}'
    )


def _build_6c_search():
    """Build search pattern for Patch 6C (original safety-net)."""
    # Must match exact indentation in agent-factory.js (12/16/20/24 spaces)
    return (
        "if (resolvedModel && provider && resolvedModel.includes(':')) {\n"
        "                if (!isModelValidForProvider(resolvedModel, provider)) {\n"
        "                    const { providerId: modelProvider } = parseCompoundModelId(resolvedModel);\n"
        "                    logger.warn('Safety net: cross-provider model mismatch in agent creation', {\n"
        "                        resolvedModel,\n"
        "                        modelProvider,\n"
        "                        expectedProvider: provider,\n"
        "                    });\n"
        "                    if (provider in PROVIDER_MODEL_TIERS) {\n"
        "                        const baseModel = getDefaultModelForProvider(provider, 'balanced');\n"
        "                        const defaultProviderId = getDefaultProviderId();\n"
        "                        resolvedModel =\n"
        "                            provider !== defaultProviderId ? `${provider}:${baseModel}` : baseModel;\n"
        "                        logger.debug('Re-resolved model to provider default', { resolvedModel });\n"
        "                    }\n"
        "                    // If provider has no tier mappings (e.g., opencode), keep resolvedModel as-is.\n"
        "                    // We cannot safely guess a model for dynamic-model providers.\n"
        "                }\n"
        "            }"
    )


def _build_6c_replace():
    """Build replacement for Patch 6C (new safety-net)."""
    return (
        "if (resolvedModel && provider && resolvedModel.includes(':')) {\n"
        "                if (!isModelValidForProvider(resolvedModel, provider)) {\n"
        "                    const { providerId: modelProvider } = parseCompoundModelId(resolvedModel);\n"
        "                    if (ACP_PROVIDERS[modelProvider]) {\n"
        "                        logger.info('Safety net: aligning provider to match compound model', {\n"
        "                            resolvedModel, modelProvider, previousProvider: provider,\n"
        "                        });\n"
        "                        provider = modelProvider;\n"
        "                        // Re-validate after alignment; fallback to provider default if still invalid\n"
        "                        if (!isModelValidForProvider(resolvedModel, provider) && provider in PROVIDER_MODEL_TIERS) {\n"
        "                            const baseModel = getDefaultModelForProvider(provider, 'balanced');\n"
        "                            const defaultProviderId = getDefaultProviderId();\n"
        "                            resolvedModel =\n"
        "                                provider !== defaultProviderId ? `${provider}:${baseModel}` : baseModel;\n"
        "                            logger.debug('Re-resolved model after provider alignment', { resolvedModel });\n"
        "                        }\n"
        "                    } else {\n"
        "                        logger.warn('Safety net: unknown provider in model, falling back', {\n"
        "                            resolvedModel, modelProvider, expectedProvider: provider,\n"
        "                        });\n"
        "                        if (provider in PROVIDER_MODEL_TIERS) {\n"
        "                            const baseModel = getDefaultModelForProvider(provider, 'balanced');\n"
        "                            const defaultProviderId = getDefaultProviderId();\n"
        "                            resolvedModel =\n"
        "                                provider !== defaultProviderId ? `${provider}:${baseModel}` : baseModel;\n"
        "                        }\n"
        "                    }\n"
        "                }\n"
        "            }"
    )


# ─── Patch Application Engine ──────────────────────────────────────────────────

def check_patch_state(patch, content):
    """Check if a patch is applied, not applied, or in conflict."""
    has_new = False
    has_old = False

    # Check if patch result is present (new/patched state)
    if patch.verify_present and patch.verify_present in content:
        has_new = True
    elif patch.verify_present is None and patch.new_body and patch.new_body in content:
        has_new = True

    # Check if original code is present (old/unpatched state)
    if patch.verify_absent and patch.verify_absent in content:
        has_old = True
    elif patch.search and patch.search in content:
        has_old = True
    elif patch.search_regex and re.search(patch.search_regex, content):
        has_old = True

    if has_new and not has_old:
        return PatchState.APPLIED
    if has_old and not has_new:
        return PatchState.NOT_APPLIED

    # Neither old nor new found: check if it's a "removal" patch
    # (replace_template is empty, meaning the patch just deletes code)
    if not has_old and not has_new:
        if patch.replace_template == "":
            # Deletion patch: if old code is gone, that's success
            return PatchState.APPLIED
        if patch.verify_present is None and patch.verify_absent is not None:
            # No positive check, only negative — if old is gone, assume applied
            return PatchState.APPLIED
        # For function_replace, check if anchor still exists
        if patch.function_anchor and patch.function_anchor in content:
            return PatchState.NOT_APPLIED
        return PatchState.CONFLICT
    # Both present is also conflict
    return PatchState.CONFLICT


def apply_single_patch(patch, content, dry_run=False):
    """Apply a single patch to content. Returns modified content or None on failure."""
    if patch.patch_type == "text_replace":
        if patch.search not in content:
            log(f"Search pattern not found for {patch.name}", "FAIL")
            return None
        count = content.count(patch.search)
        if count > 1:
            log(f"Multiple matches ({count}) for {patch.name}", "FAIL")
            return None
        if dry_run:
            log(f"Would apply {patch.name}", "SKIP")
            return content
        return content.replace(patch.search, patch.replace, 1)

    elif patch.patch_type == "statement_replace":
        if patch.search_regex:
            m = re.search(patch.search_regex, content)
            if not m:
                log(f"Regex pattern not found for {patch.name}", "FAIL")
                return None
            matches = list(re.finditer(patch.search_regex, content))
            if len(matches) > 1:
                log(f"Multiple regex matches ({len(matches)}) for {patch.name}", "FAIL")
                return None
            if dry_run:
                log(f"Would apply {patch.name}", "SKIP")
                return content
            return content[:m.start()] + patch.replace_template + content[m.end():]
        else:
            if patch.search not in content:
                log(f"Search pattern not found for {patch.name}", "FAIL")
                return None
            if dry_run:
                log(f"Would apply {patch.name}", "SKIP")
                return content
            return content.replace(patch.search, patch.replace, 1)

    elif patch.patch_type == "function_replace":
        return _apply_function_replace(patch, content, dry_run)

    fatal(f"Unknown patch type: {patch.patch_type}")
    return None


def _apply_function_replace(patch, content, dry_run=False):
    """Replace a function body using brace-depth matching."""
    anchor = patch.function_anchor
    idx = content.find(anchor)
    if idx < 0:
        log(f"Function anchor not found for {patch.name}: {anchor}", "FAIL")
        return None

    # Check for multiple occurrences
    if content.count(anchor) > 1:
        log(f"Multiple function anchors for {patch.name}", "FAIL")
        return None

    # Find opening brace
    brace_start = content.find("{", idx + len(anchor))
    if brace_start < 0:
        log(f"Opening brace not found for {patch.name}", "FAIL")
        return None

    # Match braces to find end of function
    depth = 0
    i = brace_start
    while i < len(content):
        if content[i] == "{":
            depth += 1
        elif content[i] == "}":
            depth -= 1
            if depth == 0:
                break
        elif content[i] == '"' or content[i] == "'":
            # Skip string literals
            quote = content[i]
            i += 1
            while i < len(content) and content[i] != quote:
                if content[i] == "\\":
                    i += 1  # Skip escaped char
                i += 1
        elif content[i] == '`':
            # Skip template literals
            i += 1
            while i < len(content) and content[i] != '`':
                if content[i] == "\\":
                    i += 1
                elif content[i] == '$' and i + 1 < len(content) and content[i + 1] == '{':
                    # Skip ${...} in template — simplified, doesn't handle nested
                    i += 2
                    nested = 1
                    while i < len(content) and nested > 0:
                        if content[i] == '{':
                            nested += 1
                        elif content[i] == '}':
                            nested -= 1
                        i += 1
                    continue
                i += 1
        i += 1

    if depth != 0:
        log(f"Unbalanced braces for {patch.name}", "FAIL")
        return None

    func_end = i + 1  # Include closing brace

    # Find the start of the function (look back for 'async ' or method name)
    func_start = idx
    # Check if there's 'async ' before
    prefix_check = content[max(0, idx - 10):idx]
    if "async " in prefix_check:
        func_start = idx - (len(prefix_check) - prefix_check.find("async "))

    old_func = content[func_start:func_end]

    if dry_run:
        log(f"Would replace function ({len(old_func)} chars) for {patch.name}", "SKIP")
        return content

    return content[:func_start] + patch.new_body + content[func_end:]


def apply_patches(patches, extracted_dir, files, dry_run=False):
    """Apply all patches, respecting state machine."""
    print("\n=== Phase 3: Patch Application ===")

    # Group patches by file
    file_patches = {}
    for p in patches:
        file_patches.setdefault(p.file_key, []).append(p)

    # Map file_key to actual path
    file_map = {
        "agent_factory": os.path.join(extracted_dir, files.agent_factory),
        "model_store": os.path.join(extracted_dir, files.model_store),
        "model_picker": os.path.join(extracted_dir, files.model_picker),
    }

    all_ok = True

    for file_key, file_patches_list in file_patches.items():
        path = file_map[file_key]
        content = read_file(path)
        modified = False

        for patch in file_patches_list:
            state = check_patch_state(patch, content)

            if state == PatchState.APPLIED:
                log(f"{patch.name}: already applied", "SKIP")
                continue
            elif state == PatchState.CONFLICT:
                log(f"{patch.name}: CONFLICT — cannot determine state", "FAIL")
                all_ok = False
                continue

            # state == NOT_APPLIED
            result = apply_single_patch(patch, content, dry_run)
            if result is None:
                all_ok = False
                continue

            content = result
            modified = True
            if not dry_run:
                log(f"{patch.name}: applied", "OK")
            else:
                log(f"{patch.name}: would apply", "SKIP")

        if modified and not dry_run:
            write_file(path, content)
            log(f"Saved {os.path.basename(path)}", "OK")

    return all_ok


# ─── Phase 4: Verification ─────────────────────────────────────────────────────

def verify_patches(patches, extracted_dir, files):
    """Verify all patches are correctly applied."""
    print("\n=== Phase 4: Verification ===")

    file_map = {
        "agent_factory": os.path.join(extracted_dir, files.agent_factory),
        "model_store": os.path.join(extracted_dir, files.model_store),
        "model_picker": os.path.join(extracted_dir, files.model_picker),
    }

    passed = 0
    failed = 0
    errors = []

    for patch in patches:
        path = file_map[patch.file_key]
        content = read_file(path)
        ok = True

        # Positive check
        if patch.verify_present and patch.verify_present not in content:
            log(f"{patch.name}: expected pattern not found", "FAIL")
            ok = False

        # Negative check
        if patch.verify_absent and patch.verify_absent in content:
            log(f"{patch.name}: old pattern still present", "FAIL")
            ok = False

        if ok:
            log(f"{patch.name}: verified", "OK")
            passed += 1
        else:
            failed += 1
            errors.append(patch.name)

    # Syntax check with node --check
    print("  --- Syntax Checks ---")
    for file_key, path in file_map.items():
        try:
            run_cmd(f"node --check '{path}'", check=True)
            log(f"Syntax OK: {os.path.basename(path)}", "OK")
        except subprocess.CalledProcessError:
            log(f"Syntax error in {os.path.basename(path)}", "FAIL")
            failed += 1
            errors.append(f"Syntax: {os.path.basename(path)}")

    # Structural invariant checks
    print("  --- Structural Invariants ---")

    # ModelStore: loadModels must have Promise.allSettled and "__all__"
    ms_content = read_file(file_map["model_store"])
    if "Promise.allSettled" in ms_content and '"__all__"' in ms_content:
        log("ModelStore: loadModels uses Promise.allSettled + __all__", "OK")
        passed += 1
    else:
        log("ModelStore: loadModels missing Promise.allSettled or __all__", "FAIL")
        failed += 1
        errors.append("Structural: loadModels")

    # ModelStore: getGroupedModels must use Map
    if "new Map" in ms_content and "getGroupedModels" in ms_content:
        log("ModelStore: getGroupedModels uses Map", "OK")
        passed += 1
    else:
        log("ModelStore: getGroupedModels missing Map", "FAIL")
        failed += 1
        errors.append("Structural: getGroupedModels")

    # Agent factory: provider derivation before activeProviderStore fallback
    af_content = read_file(file_map["agent_factory"])
    derive_idx = af_content.find("Derived provider from model ID")
    active_idx = af_content.find("Using active provider from store")
    if derive_idx > 0 and active_idx > 0 and derive_idx < active_idx:
        log("AgentFactory: provider derivation before fallback", "OK")
        passed += 1
    else:
        log("AgentFactory: provider derivation order incorrect", "FAIL")
        failed += 1
        errors.append("Structural: provider derivation order")

    # AgentFactory: safety-net aligns provider
    if "aligning provider" in af_content:
        log("AgentFactory: safety-net aligns provider", "OK")
        passed += 1
    else:
        log("AgentFactory: safety-net missing align logic", "FAIL")
        failed += 1
        errors.append("Structural: safety-net align")

    print(f"\n  Results: {passed} passed, {failed} failed")

    if failed > 0:
        print("  Failed checks:")
        for e in errors:
            print(f"    - {e}")
        return False

    print("  All verifications passed.")
    return True


# ─── Phase 5: Repack & Install ──────────────────────────────────────────────────

def repack_and_install(extracted_dir, files, skip_install=False):
    """Repack asar and install into Intent app."""
    print("\n=== Phase 5: Repack & Install ===")

    # 5.1 Repack
    asar_new = os.path.join(SCRIPT_DIR, "app.asar")
    log("Repacking asar...")
    try:
        run_cmd(f'npx --yes asar pack "{extracted_dir}" "{asar_new}"', timeout=300)
        log(f"Repacked to {asar_new}", "OK")
    except Exception as e:
        fatal(f"asar pack failed: {e}")

    if skip_install:
        log("Skip install (--no-install)", "SKIP")
        return

    # 5.2 Backup
    if os.path.exists(BACKUP_ASAR):
        # Verify backup is clean (not patched)
        try:
            # Quick check: extract and look for patch marker
            backup_content = run_cmd(
                f'npx --yes asar extract-file "{BACKUP_ASAR}" "{files.model_store}"',
                check=False
            )
            if PATCH_MARKER in (backup_content.stdout or ""):
                log("Warning: backup appears to already be patched", "WARN")
        except Exception:
            pass
        log("Backup already exists", "SKIP")
    else:
        log("Creating backup of app.asar...")
        try:
            shutil.copy2(INTENT_ASAR, BACKUP_ASAR)
            log(f"Backup saved to {BACKUP_ASAR}", "OK")
        except Exception as e:
            fatal(f"Cannot create backup: {e}")

    # 5.3 Install
    log("Killing Intent by Augment...")
    run_cmd('pkill -f "Intent by Augment"', check=False)
    import time
    time.sleep(2)

    log("Removing macOS protection flags...")
    run_cmd(f'sudo xattr -cr "{INTENT_APP}"', check=False)

    log("Installing patched app.asar...")
    try:
        run_cmd(f'sudo cp "{asar_new}" "{INTENT_ASAR}"')
        log("app.asar installed", "OK")
    except Exception as e:
        fatal(f"Failed to install app.asar: {e}")

    # Install unpacked files
    ms_file = os.path.basename(files.model_store)
    mp_file = os.path.basename(files.model_picker)
    unpacked_chunks = os.path.join(INTENT_UNPACKED, CHUNKS_DIR_REL)

    log("Installing unpacked files...")
    for filename in [ms_file, mp_file]:
        src = os.path.join(extracted_dir, CHUNKS_DIR_REL, filename)
        dst = os.path.join(unpacked_chunks, filename)
        if os.path.exists(dst):
            try:
                run_cmd(f'sudo cp "{src}" "{dst}"')
                log(f"Unpacked: {filename}", "OK")
            except Exception as e:
                log(f"Failed to install unpacked {filename}: {e}", "FAIL")
        else:
            log(f"Unpacked path not found: {dst}", "WARN")

    # Remove ElectronAsarIntegrity
    log("Removing ElectronAsarIntegrity...")
    run_cmd(
        f'sudo /usr/libexec/PlistBuddy -c "Delete :ElectronAsarIntegrity" "{INTENT_PLIST}"',
        check=False
    )

    # Re-sign
    log("Re-signing app...")
    try:
        run_cmd(f'sudo codesign --force --deep --sign - "{INTENT_APP}"')
        log("App re-signed", "OK")
    except Exception as e:
        log(f"Codesign failed: {e}", "FAIL")

    log("Installation complete! Open Intent by Augment to verify.", "OK")


# ─── Manifest ──────────────────────────────────────────────────────────────────

def write_patched_files_manifest(extracted_dir, files):
    """Write patched-files.json so install.sh knows which chunk files to copy."""
    manifest = {
        "model_store": os.path.basename(files.model_store),
        "model_picker": os.path.basename(files.model_picker),
        "chunks_dir": CHUNKS_DIR_REL,
    }
    manifest_path = os.path.join(extracted_dir, "patched-files.json")
    write_file(manifest_path, json.dumps(manifest, indent=2) + "\n")
    log(f"Wrote patched-files.json ({manifest['model_store']}, {manifest['model_picker']})", "OK")


# ─── Main ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="Auto-patcher for Intent Multi-Provider Patch"
    )
    parser.add_argument(
        "--extracted-dir",
        help="Path to pre-extracted app directory (skip extract step)"
    )
    parser.add_argument(
        "--dry-run", action="store_true",
        help="Show what would be done without modifying files"
    )
    parser.add_argument(
        "--discover-only", action="store_true",
        help="Only discover files and resolve symbols, don't patch"
    )
    parser.add_argument(
        "--no-install", action="store_true",
        help="Patch and verify but don't install into app bundle"
    )
    args = parser.parse_args()

    print("=" * 60)
    print("  Intent Multi-Provider Auto-Patcher")
    print("=" * 60)

    skip_install = args.no_install or args.dry_run or args.discover_only
    extracted_dir = args.extracted_dir or DEFAULT_EXTRACTED

    # Phase 0: Preflight
    preflight_checks(skip_install=skip_install)

    # Extract if needed
    if not args.extracted_dir and not os.path.isdir(extracted_dir):
        print("\n=== Extracting app.asar ===")
        source_asar = BACKUP_ASAR if os.path.exists(BACKUP_ASAR) else INTENT_ASAR
        if not os.path.exists(source_asar):
            fatal(f"No asar source found. Expected: {BACKUP_ASAR} or {INTENT_ASAR}")

        # asar extract requires .unpacked directory alongside the .asar file
        # If source is backup, create symlink to unpacked dir from Intent app
        unpacked_link = source_asar + ".unpacked"
        created_link = False
        if not os.path.exists(unpacked_link) and os.path.isdir(INTENT_UNPACKED):
            log(f"Creating symlink for unpacked files...")
            try:
                os.symlink(INTENT_UNPACKED, unpacked_link)
                created_link = True
            except OSError as e:
                log(f"Warning: cannot create unpacked symlink: {e}", "WARN")

        log(f"Extracting from {os.path.basename(source_asar)}...")
        try:
            run_cmd(f'npx --yes asar extract "{source_asar}" "{extracted_dir}"', timeout=300)
            log("Extraction complete", "OK")
        except Exception as e:
            fatal(f"asar extract failed: {e}")
        finally:
            # Clean up symlink if we created it
            if created_link and os.path.islink(unpacked_link):
                os.unlink(unpacked_link)

    if not os.path.isdir(extracted_dir):
        fatal(f"Extracted directory not found: {extracted_dir}")

    # Phase 1: File Discovery
    files = discover_files(extracted_dir)

    # Phase 2: Symbol Resolution
    pc_symbols, ms_symbols, mp_symbols = resolve_symbols(extracted_dir, files)

    if args.discover_only:
        print("\n=== Discovery Complete ===")
        print(f"  Provider Config: {files.provider_config}")
        print(f"  ModelStore:      {files.model_store}")
        print(f"  ModelPicker:     {files.model_picker}")
        print(f"  Agent Factory:   {files.agent_factory}")
        print("\n  Provider Config Exports:")
        for name, alias in pc_symbols.provider_exports.items():
            print(f"    {name} → '{alias}'")
        print("\n  ModelStore Resolved:")
        for name, alias in ms_symbols.resolved.items():
            print(f"    {name} → '{alias}'")
        print("\n  ModelPicker Resolved:")
        for name, alias in mp_symbols.resolved.items():
            print(f"    {name} → '{alias}'")
        return

    # Phase 3: Build and Apply Patches
    patches = build_patches(files, pc_symbols, ms_symbols, mp_symbols, extracted_dir)
    success = apply_patches(patches, extracted_dir, files, dry_run=args.dry_run)

    if not success:
        fatal("Some patches failed to apply. See errors above.")

    if args.dry_run:
        print("\n=== Dry Run Complete ===")
        print("  No files were modified.")
        return

    # Write manifest for install.sh
    write_patched_files_manifest(extracted_dir, files)

    # Phase 4: Verification
    if not verify_patches(patches, extracted_dir, files):
        fatal("Verification failed. Patches may be incomplete.")

    # Phase 5: Repack & Install
    if not args.no_install:
        repack_and_install(extracted_dir, files, skip_install=skip_install)
    else:
        log("Patches applied and verified. Use --no-install was set, skipping install.", "OK")


if __name__ == "__main__":
    main()
