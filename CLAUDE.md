# intent_patch

Multi-provider patch cho Intent by Augment. Cho phép chọn model từ **tất cả** ACP providers đã cài trong cùng một dropdown, thay vì chỉ provider đang active. **Pure Node.js** — zero dependencies ngoài `@electron/asar`.

## Commands

```bash
# Chạy từ xa (không cần clone):
npx github:lploc94/intent_patch

# Hoặc local:
node autopatch.js                       # Full pipeline: extract → patch → verify → repack → install
node autopatch.js --no-install          # Patch + verify, không install
node autopatch.js --discover-only       # Chỉ tìm files + resolve symbols
node autopatch.js --dry-run             # Xem preview, không sửa file
node autopatch.js --status              # Kiểm tra trạng thái patch
node autopatch.js --legacy              # Legacy mode: copy pre-built patches (v0.2.11 only)
node autopatch.js --extracted-dir ./ext # Dùng extracted dir có sẵn
```

## Architecture

### File Structure

```
intent_patch/
  package.json              # bin: "intent-patch" → autopatch.js
  autopatch.js              # #!/usr/bin/env node — entry point
  src/
    constants.js            # Paths, markers, fixed values
    utils.js                # log, fatal, runCmd, runCmdArgs, readFile, writeFile, escapeRegExp
    preflight.js            # Phase 0: verify Node ≥18, Intent app, asar
    discovery.js            # Phase 1: discover 5 target files via fingerprints
    symbols.js              # Phase 2: resolve minified symbols
    patches.js              # Phase 3: build 18 PatchDef objects
    engine.js               # Patch engine: checkPatchState, apply, brace-depth matching
    verify.js               # Phase 4: syntax checks + structural invariants
    install.js              # Phase 5: asar pack, backup, sudo install, codesign
    cli.js                  # CLI orchestration, arg parsing, version tracking
  patches/                  # Pre-built v0.2.11 patches (legacy mode)
  docs/                     # Tài liệu
```

### State Directory

`~/.intent-patch/` — persists across `npx` runs:
- `.patched-version` — version tracking
- `app.asar.backup` — backup asar gốc
- `extracted/` — extracted app source
- `app.asar` — repacked patched output

### 18 Patches (5 files)

| File | Patches | Vai trò |
|------|---------|---------|
| agent-factory.js | 6A, 6B, 6C | Backend: suy provider từ model ID, align provider |
| agent-interaction-tools.js | 8A-import, 8A, 8B, 8C-1..4, 8D | Cross-provider delegation |
| ModelStore chunk | 1–5 | Fetch models từ all providers, group by provider |
| ModelPicker chunk | 7A, 7B | Disable per-provider override |

### Compound Model ID

Format: `{providerId}:{modelId}` — ví dụ `codex:gpt-5.3-codex/high`.

### Provider Inference (AgentFactory)

Ưu tiên: `config.provider` (explicit) → parse từ compound model ID → `activeProviderId` (fallback).
Safety-net: khi cross-provider mismatch, **align provider theo model** thay vì reset model.

## Development Workflow

```
1. Edit       Sửa file trong src/...
2. Test       node autopatch.js --extracted-dir ./extracted --dry-run
3. Verify     node autopatch.js --extracted-dir ./extracted --no-install
4. Commit     git add src/ && git commit
```

## Caveats

- **Unpacked files**: Chunk files có `unpacked: true` trong asar header. Install cập nhật cả trong asar lẫn `app.asar.unpacked/`.
- **Minified code**: Frontend chunks đã minified — symbol resolution tự động qua `src/symbols.js`.
- **Docs bằng tiếng Việt**: Toàn bộ `docs/` viết bằng tiếng Việt.
- **`extracted/` không track**: Folder ~595 MB, nằm trong `.gitignore`. Chỉ `patches/` được commit.
- **Codesign**: Tự động sau install (`codesign --force --deep --sign -`).
- **sudo**: Install phase cần sudo — script prompt password 1 lần.
- **Security**: Tất cả sudo/external commands dùng `execFileSync` (argv arrays) thay vì shell strings để tránh injection. Xem `runCmdArgs` trong `src/utils.js`.
