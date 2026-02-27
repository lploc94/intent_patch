# 06 — Đóng gói và cài đặt

## Bước 1: Repack app.asar

```bash
cd ~/projects/intent
npx asar pack extracted app.asar
```

File `app.asar` mới sẽ chứa tất cả patches. Kích thước ~512MB.

## Bước 2: Xử lý unpacked files

### Vấn đề

Electron asar có cơ chế "unpacked files": một số file được đánh dấu `"unpacked": true` trong header asar. Khi app chạy, Electron đọc những file này từ thư mục `app.asar.unpacked/` **bên cạnh** file `app.asar`, không phải từ bên trong.

Trong Intent v0.2.11, hai file minified của chúng ta là unpacked:
- `dist/renderer/app/immutable/chunks/BTPDcoPQ.js`
- `dist/renderer/app/immutable/chunks/CfKn743W.js`

### Hậu quả nếu bỏ qua

Nếu chỉ copy `app.asar` mà không update `.asar.unpacked/`:
- `agent-factory.js` → **có hiệu lực** (packed, nằm trong asar)
- `BTPDcoPQ.js` → **không hiệu lực** (Electron đọc bản gốc từ `.unpacked/`)
- `CfKn743W.js` → **không hiệu lực** (tương tự)

App sẽ hoạt động như chưa patch.

### Giải pháp

Copy file đã patch vào **cả hai nơi**:

```bash
APP="/Applications/Intent by Augment.app"
UNPACKED="$APP/Contents/Resources/app.asar.unpacked"

# Copy vào asar (đã làm ở bước repack)
sudo cp app.asar "$APP/Contents/Resources/app.asar"

# Copy vào unpacked directory
sudo cp extracted/dist/renderer/app/immutable/chunks/BTPDcoPQ.js \
  "$UNPACKED/dist/renderer/app/immutable/chunks/BTPDcoPQ.js"
sudo cp extracted/dist/renderer/app/immutable/chunks/CfKn743W.js \
  "$UNPACKED/dist/renderer/app/immutable/chunks/CfKn743W.js"
```

### Cách kiểm tra file nào là unpacked

```python
python3 -c "
import struct, json
with open('app.asar.backup', 'rb') as f:
    f.read(4)
    hs = struct.unpack('<I', f.read(4))[0]
    f.read(4)
    ds = struct.unpack('<I', f.read(4))[0]
    header = json.loads(f.read(ds))

# Duyệt recursive tìm tất cả unpacked files
def find_unpacked(node, path=''):
    if 'files' in node:
        for name, child in node['files'].items():
            find_unpacked(child, f'{path}/{name}')
    elif node.get('unpacked'):
        print(path)

find_unpacked(header)
"
```

## Bước 3: Xử lý Electron integrity check

### ElectronAsarIntegrity

Intent dùng Electron Asar Integrity — checksum trong `Info.plist` để verify `app.asar` chưa bị modified.

Kiểm tra:

```bash
/usr/libexec/PlistBuddy -c "Print :ElectronAsarIntegrity" \
  "/Applications/Intent by Augment.app/Contents/Info.plist" 2>/dev/null && echo "Có integrity check" || echo "Không có"
```

### Xóa integrity check

```bash
sudo /usr/libexec/PlistBuddy -c "Delete :ElectronAsarIntegrity" \
  "/Applications/Intent by Augment.app/Contents/Info.plist" 2>/dev/null || true
```

## Bước 4: Xóa extended attributes

macOS đánh dấu file tải về hoặc bị thay đổi bằng extended attributes (quarantine, etc.):

```bash
sudo xattr -cr "/Applications/Intent by Augment.app"
```

## Bước 5: Re-codesign

Sau khi thay đổi nội dung app, code signature bị invalid. Ad-hoc sign lại:

```bash
sudo codesign --force --deep --sign - "/Applications/Intent by Augment.app"
```

`--force`: ghi đè signature cũ
`--deep`: sign tất cả nested bundles
`--sign -`: ad-hoc signing (không cần Apple Developer ID)

## Script tự động

Tất cả bước trên được gộp trong `install.sh`:

```bash
bash install.sh
```

Hoặc `apply.sh` (copy patches → verify → repack → install):

```bash
bash apply.sh
```

## Khôi phục

Nếu cần quay về bản gốc:

```bash
APP="/Applications/Intent by Augment.app"

# Copy backup
sudo cp app.asar.backup "$APP/Contents/Resources/app.asar"

# Xóa xattr và sign lại
sudo xattr -cr "$APP"
sudo codesign --force --deep --sign - "$APP"
```

Lưu ý: unpacked files gốc vẫn còn nguyên trong `.asar.unpacked/` nếu bạn chưa chạy `install.sh`. Nếu đã chạy, cần extract lại từ backup:

```bash
# Extract BTPDcoPQ.js và CfKn743W.js gốc từ app.asar.unpacked (nếu còn backup)
# Hoặc reinstall Intent từ website
```

## Kiểm tra sau cài đặt

### 1. App khởi động được

```bash
open "/Applications/Intent by Augment.app"
```

Nếu app crash, kiểm tra Console.app hoặc:

```bash
"/Applications/Intent by Augment.app/Contents/MacOS/Intent by Augment" 2>&1 | head -50
```

### 2. Model dropdown hiện nhiều providers

Mở Intent → click dropdown model → phải thấy headers: Auggie, Claude Code, Codex, v.v.

### 3. Agent tạo đúng provider

- Chọn `claude-code:default` → tạo agent → kiểm tra trong DevTools:
  ```
  Menu → View → Toggle Developer Tools → Console
  ```
  Tìm log: `Derived provider from model ID { model: "claude-code:default", provider: "claude-code" }`

### 4. Multi-agent hoạt động

Tạo 2 agents với 2 providers khác nhau. Gửi message cho cả 2. Cả 2 phải phản hồi độc lập.

## Troubleshooting

### App không mở / crash ngay

- Kiểm tra syntax: `node --check extracted/dist/renderer/app/immutable/chunks/BTPDcoPQ.js`
- Chạy `python3 verify.py` xem patch nào sai
- Kiểm tra asar integrity đã xóa: `PlistBuddy` command ở trên
- Kiểm tra codesign: `codesign -vv "/Applications/Intent by Augment.app"`

### Dropdown vẫn chỉ hiện 1 provider

- Kiểm tra unpacked files đã được update:
  ```bash
  python3 -c "
  c = open('/Applications/Intent by Augment.app/Contents/Resources/app.asar.unpacked/dist/renderer/app/immutable/chunks/BTPDcoPQ.js').read()
  if '__all__' in c: print('BTPDcoPQ.js: ĐÃ PATCH')
  else: print('BTPDcoPQ.js: CHƯA PATCH - chạy lại install.sh')
  "
  ```

### Agent tạo với sai provider

- Kiểm tra log trong DevTools Console
- Tìm `Safety net: aligning provider` — nếu thấy, safety-net đang sửa lại
- Kiểm tra `agent-factory.js` đã patch đúng (dùng `verify.py`)
