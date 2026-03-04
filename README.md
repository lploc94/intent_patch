# Intent Multi-Provider Patch

Patch cho [Intent by Augment](https://augmentcode.com/) cho phép sử dụng nhiều ACP providers đồng thời. Thay vì chỉ hiện models của provider đang active, dropdown sẽ hiện models của **tất cả** providers đã cài đặt, và tự động chọn đúng provider khi tạo agent.

**Hỗ trợ**: Intent v0.2.11 (legacy) · v0.2.12–v0.2.18 (auto-patch)

## Vấn đề gốc

Intent chỉ cho phép chọn 1 ACP provider tại 1 thời điểm. Model dropdown chỉ hiện models của provider đang active. Không thể dùng Claude Code (opus) làm implementor và Codex CLI làm verifier cùng lúc.

## Giải pháp

Auto-patch 5 files trong app.asar bằng version-independent symbol resolution:

| File | Vai trò | Patches |
|------|---------|---------|
| `agent-factory.js` | Backend agent creation — parse provider từ model ID | 6A, 6B, 6C |
| `agent-interaction-tools.js` | Cross-provider delegation | 8A-8D |
| ModelStore chunk | Fetch/group models từ all providers | 1–5 |
| ModelPicker chunk | UI dropdown — unified model list | 7A, 7B |

## Cài đặt nhanh

### Yêu cầu

- macOS (Apple Silicon hoặc Intel)
- Intent by Augment đã cài tại `/Applications/Intent by Augment.app`
- Node.js >= 18
- Quyền sudo

### Tương thích

| Intent version | Phương thức |
|---------------|------------|
| v0.2.11 | `--legacy` (pre-built patches) |
| v0.2.12–v0.2.18 | Auto-patch (symbol resolution) |

### Cách 1: One-liner (recommended)

```bash
npx github:lploc94/intent_patch
```

Một lệnh duy nhất — tự cài dependencies, extract, patch, verify, repack, install, codesign. Không cần clone repo, không cần Python.

Flags:
```bash
npx github:lploc94/intent_patch -- --dry-run        # Xem preview
npx github:lploc94/intent_patch -- --discover-only   # Chỉ discover
npx github:lploc94/intent_patch -- --no-install      # Patch không install
npx github:lploc94/intent_patch -- --status          # Kiểm tra trạng thái
```

### Cách 2: Clone & chạy local

```bash
git clone <repo-url> ~/projects/intent_patch
cd ~/projects/intent_patch
npm install
node autopatch.js
```

### Cách 3: Legacy mode (chỉ Intent v0.2.11)

```bash
node autopatch.js --legacy
```

### Xác nhận sau cài đặt

1. Mở Intent by Augment
2. Click dropdown model — phải hiện models từ nhiều providers (Auggie, Claude Code, Codex...)
3. Chọn `claude-code:default` → tạo agent → agent phải dùng Claude Code provider
4. Chọn model Codex → tạo agent mới → agent phải dùng Codex provider
5. Cả 2 agents chạy song song, gửi message cho cả 2

## Cấu trúc project

```
intent_patch/
  package.json              # bin: "intent-patch" → autopatch.js
  autopatch.js              # #!/usr/bin/env node — entry point
  src/
    constants.js            # Paths, markers, fixed values
    utils.js                # Utility functions (runCmd, runCmdArgs, log, etc.)
    preflight.js            # Phase 0: preflight checks
    discovery.js            # Phase 1: file discovery
    symbols.js              # Phase 2: symbol resolution
    patches.js              # Phase 3: patch definitions (18 patches)
    engine.js               # Patch engine: apply + brace-depth matching
    verify.js               # Phase 4: verification
    install.js              # Phase 5: repack + install
    cli.js                  # CLI orchestration
  patches/                  # Pre-built v0.2.11 patches (legacy mode)
  docs/                     # Tài liệu kỹ thuật chi tiết
```

State directory (`~/.intent-patch/`):
```
  .patched-version          # Version tracking
  app.asar.backup           # Backup asar gốc
  extracted/                # Extracted app source
  app.asar                  # Repacked patched output
```

## Tài liệu

Thư mục `docs/` chứa hướng dẫn đầy đủ từ đầu đến cuối:

1. [Chuẩn bị môi trường](docs/01-chuẩn-bị.md)
2. [Phân tích kiến trúc](docs/02-phân-tích.md)
3. [Giải mã code minified](docs/03-giải-mã-minified.md)
4. [Thiết kế patch](docs/04-thiết-kế-patch.md)
5. [Thực thi patch](docs/05-thực-thi-patch.md)
6. [Đóng gói cài đặt](docs/06-đóng-gói-cài-đặt.md)

Xem thêm [PATCHES.md](PATCHES.md) để tra cứu nhanh từng patch và symbol map. Xem [CHANGELOG.md](CHANGELOG.md) để theo dõi các thay đổi qua từng phiên bản.

## Phát triển

```
1. Edit       Sửa file trong src/...
2. Test       node autopatch.js --extracted-dir ./extracted --dry-run
3. Verify     node autopatch.js --extracted-dir ./extracted --no-install
4. Commit     git add src/ && git commit
```

### Lưu ý quan trọng

- **Unpacked files**: Chunk files có `unpacked: true` trong asar header. Install cập nhật cả trong asar lẫn `app.asar.unpacked/`. Script xử lý tự động.
- **Minified code**: Symbol resolution hoàn toàn tự động — không cần map symbol thủ công.
- **Codesign**: Tự động sau install.
- **sudo**: Install phase cần sudo — script prompt password 1 lần, cache 5 phút.
- **Security**: External commands (sudo, asar, codesign) dùng `execFileSync` với argv arrays, không dùng shell interpolation.
