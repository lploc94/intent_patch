# intent_patch

Multi-provider patch cho Intent by Augment **v0.2.11, v0.2.12**. Cho phép chọn model từ **tất cả** ACP providers đã cài trong cùng một dropdown, thay vì chỉ provider đang active.

## Commands

```bash
# Auto-patch (version-independent): discover → patch → verify → repack → install
bash apply.sh

# Auto-patch without installing
bash apply.sh --no-install

# Discover files + resolve symbols only
bash apply.sh --discover-only

# Legacy mode (v0.2.11 pre-built patches only)
bash apply.sh --legacy

# Extract app gốc
npx asar extract app.asar.backup extracted

# Verify patches (11 assertions across 3 files, v0.2.11)
python3 verify.py

# Repack thủ công
npx asar pack extracted app.asar

# Install thủ công (cần sudo)
bash install.sh
```

## Architecture

### 3 Patched Files

| File | Vai trò | Patches |
|------|---------|---------|
| `patches/dist/features/agent/services/agent-factory.js` | Backend agent creation — tự suy provider từ model ID, align provider khi mismatch | 6A, 6B, 6C |
| `patches/dist/renderer/app/immutable/chunks/BTPDcoPQ.js` | ModelStore — fetch models từ **all** providers bằng `Promise.allSettled`, group theo provider | 1–5 |
| `patches/dist/renderer/app/immutable/chunks/CfKn743W.js` | ModelPicker UI — disable per-provider override, luôn dùng unified model list | 7A, 7B |

### Compound Model ID

Format: `{providerId}:{modelId}` — ví dụ `codex:gpt-5.3-codex/high`, `claude-code:claude-opus-4.6`.
Model không có prefix sẽ dùng default provider (auggie).

### Provider Inference (AgentFactory)

Ưu tiên: `config.provider` (explicit) → parse từ compound model ID → `activeProviderId` (fallback).
Safety-net: khi cross-provider mismatch, **align provider theo model** thay vì reset model.

## Development Workflow

```
1. Extract    npx asar extract app.asar.backup extracted
2. Edit       Sửa file trong extracted/dist/...
3. Verify     python3 verify.py
4. Test       npx asar pack extracted app.asar && bash install.sh
5. Archive    cp extracted/.../file patches/.../file  (3 files)
6. Commit     git add patches/ && git commit
```

Auto-patch (version-independent):
```
1. Extract    npx asar extract app.asar.backup extracted
2. Patch      bash apply.sh              # hoặc --no-install
3. Verify     Tự động bởi autopatch.py
```

## Caveats

- **Unpacked files**: `BTPDcoPQ.js` và `CfKn743W.js` có flag `unpacked: true` trong asar header. Install phải cập nhật cả trong asar lẫn `app.asar.unpacked/`.
- **Version lock**: Patches chỉ đúng cho Intent v0.2.11. Chunk filenames (`BTPDcoPQ`, `CfKn743W`) sẽ thay đổi khi Vite rebuild ở version mới.
- **Minified code**: 2 frontend files đã minified — khi sửa cần map symbol thủ công (xem `docs/03-giải-mã-minified.md`).
- **Docs bằng tiếng Việt**: Toàn bộ `docs/` viết bằng tiếng Việt.
- **`extracted/` không track**: Folder ~595 MB, nằm trong `.gitignore`. Chỉ `patches/` (~184 KB) được commit.
- **Codesign**: Sau install cần codesign lại app trên macOS (`codesign --force --deep --sign -`).
