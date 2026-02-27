# Intent Multi-Provider Patch

Patch cho [Intent by Augment](https://augmentcode.com/) (v0.2.11) cho phép sử dụng nhiều ACP providers đồng thời. Thay vì chỉ hiện models của provider đang active, dropdown sẽ hiện models của **tất cả** providers đã cài đặt, và tự động chọn đúng provider khi tạo agent.

## Vấn đề gốc

Intent chỉ cho phép chọn 1 ACP provider tại 1 thời điểm. Model dropdown chỉ hiện models của provider đang active. Không thể dùng Claude Code (opus) làm implementor và Codex CLI làm verifier cùng lúc.

## Giải pháp

Patch 3 files trong app.asar:

| File | Vai trò | Loại |
|------|---------|------|
| `dist/features/agent/services/agent-factory.js` | Backend agent creation — parse provider từ model ID | Non-minified |
| `dist/renderer/app/immutable/chunks/BTPDcoPQ.js` | ModelStore — fetch/group models | Minified |
| `dist/renderer/app/immutable/chunks/CfKn743W.js` | ModelPicker — UI dropdown | Minified |

## Cài đặt nhanh

### Yêu cầu

- macOS (Apple Silicon hoặc Intel)
- Intent by Augment v0.2.11 đã cài tại `/Applications/Intent by Augment.app`
- Node.js >= 18 (cần cho `npx asar`)
- Python 3 (cho verify script)
- Quyền sudo

### Cách 1: Một lệnh (recommended)

```bash
git clone <repo-url> ~/projects/intent
cd ~/projects/intent

# Extract app gốc, apply patches, repack, install (cần sudo)
cp "/Applications/Intent by Augment.app/Contents/Resources/app.asar" app.asar.backup
npx asar extract app.asar.backup extracted
bash apply.sh
```

### Cách 2: Từng bước

```bash
git clone <repo-url> ~/projects/intent
cd ~/projects/intent

# 1. Backup và extract app gốc
cp "/Applications/Intent by Augment.app/Contents/Resources/app.asar" app.asar.backup
npx asar extract app.asar.backup extracted

# 2. Copy patched files vào extracted/
cp patches/dist/features/agent/services/agent-factory.js \
   extracted/dist/features/agent/services/agent-factory.js
cp patches/dist/renderer/app/immutable/chunks/BTPDcoPQ.js \
   extracted/dist/renderer/app/immutable/chunks/BTPDcoPQ.js
cp patches/dist/renderer/app/immutable/chunks/CfKn743W.js \
   extracted/dist/renderer/app/immutable/chunks/CfKn743W.js

# 3. Verify
python3 verify.py

# 4. Repack
npx asar pack extracted app.asar

# 5. Install (cần sudo)
bash install.sh
```

### Xác nhận sau cài đặt

1. Mở Intent by Augment
2. Click dropdown model — phải hiện models từ nhiều providers (Auggie, Claude Code, Codex...)
3. Chọn `claude-code:default` → tạo agent → agent phải dùng Claude Code provider
4. Chọn model Codex → tạo agent mới → agent phải dùng Codex provider
5. Cả 2 agents chạy song song, gửi message cho cả 2

## Cấu trúc project

```
intent/
  patches/              # 3 file đã patch (git-tracked, ~184KB)
    dist/
      features/agent/services/agent-factory.js
      renderer/app/immutable/chunks/BTPDcoPQ.js
      renderer/app/immutable/chunks/CfKn743W.js
  apply.sh              # Script tự động: copy patches → verify → repack → install
  install.sh            # Script cài đặt: copy asar + unpacked files vào app
  verify.py             # Kiểm tra 11 assertions trên 3 file
  README.md             # File này
  PATCHES.md            # Chi tiết từng patch, symbol map, logic
  .gitignore            # Exclude extracted/, *.asar, node_modules/
```

Files sinh ra khi chạy (không track trong git):

```
  extracted/            # App source đầy đủ (từ npx asar extract)
  app.asar              # Repacked asar (từ npx asar pack)
  app.asar.backup       # Backup app.asar gốc
```

## Tài liệu

Thư mục `docs/` chứa hướng dẫn đầy đủ từ đầu đến cuối:

1. [Chuẩn bị môi trường](docs/01-chuẩn-bị.md) — Cài đặt công cụ, extract app
2. [Phân tích kiến trúc](docs/02-phân-tích.md) — Tìm file cần patch, hiểu luồng chạy
3. [Giải mã code minified](docs/03-giải-mã-minified.md) — Kỹ thuật đọc hiểu code minified, symbol map
4. [Thiết kế patch](docs/04-thiết-kế-patch.md) — Kiến trúc mới, 8 patches, lý do thiết kế
5. [Thực thi patch](docs/05-thực-thi-patch.md) — Hướng dẫn chi tiết từng patch
6. [Đóng gói cài đặt](docs/06-đóng-gói-cài-đặt.md) — Repack, unpacked files, codesign, troubleshooting

Xem thêm [PATCHES.md](PATCHES.md) để tra cứu nhanh từng patch và symbol map.

## Phát triển

### Workflow chỉnh sửa patches

1. Extract app gốc nếu chưa có: `npx asar extract app.asar.backup extracted`
2. Sửa file trong `extracted/`
3. Chạy `python3 verify.py` (cập nhật verify.py nếu thêm check mới)
4. Test: `npx asar pack extracted app.asar && bash install.sh`
5. Xác nhận trên Intent
6. Copy file đã sửa vào `patches/`: `cp extracted/<path> patches/<path>`
7. Commit

### Lưu ý quan trọng

- **Unpacked files**: `BTPDcoPQ.js` và `CfKn743W.js` có `"unpacked": true` trong asar header. Electron đọc chúng từ `app.asar.unpacked/` thay vì từ trong `app.asar`. Phải copy patched files vào **cả hai nơi** (trong asar và unpacked dir). `install.sh` và `apply.sh` đã xử lý việc này.
- **Version lock**: Patches này dành cho Intent v0.2.11. Khi Intent update, tên file (hash chunks) sẽ thay đổi và cần re-map symbols.
- **Codex review**: Patches đã được review bởi Codex CLI với verdict APPROVE (3 rounds, 4 issues found, 3 fixed).
