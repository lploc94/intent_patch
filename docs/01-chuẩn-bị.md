# 01 — Chuẩn bị môi trường

## Công cụ cần cài

| Công cụ | Mục đích | Cài đặt |
|---------|----------|---------|
| **Node.js** ≥ 18 | Chạy `npx asar` để extract/repack Electron app | `brew install node` |
| **Python 3** | Chạy verify script, phân tích code | Có sẵn trên macOS |
| **asar** (npm) | Đọc/ghi Electron app archive | Tự cài qua `npx --yes asar` |

Không cần cài `asar` global — `npx asar` sẽ tải về tạm khi chạy.

## Quyền macOS cần thiết

### App Management
Khi copy file vào `/Applications/`, macOS yêu cầu quyền **App Management**:

```
System Settings → Privacy & Security → App Management → Bật Terminal (hoặc iTerm)
```

### Sudo
Script cài đặt dùng `sudo` để ghi vào `/Applications/`. Bạn cần là admin.

## Extract app

### Bước 1: Tạo thư mục làm việc

```bash
mkdir -p ~/projects/intent_patch
cd ~/projects/intent_patch
```

### Bước 2: Backup file gốc

```bash
cp "/Applications/Intent by Augment.app/Contents/Resources/app.asar" app.asar.backup
```

> **Quan trọng**: Luôn giữ backup. Nếu patch hỏng, copy ngược lại để phục hồi:
> ```bash
> sudo cp app.asar.backup "/Applications/Intent by Augment.app/Contents/Resources/app.asar"
> ```

### Bước 3: Extract

```bash
npx asar extract app.asar.backup extracted
```

Kết quả: thư mục `extracted/` chứa toàn bộ source code của app (~595MB).

### Lưu ý về `unpacked` files

Electron asar có 2 loại file:
- **Packed**: nằm bên trong file `.asar`, đọc qua asar virtual filesystem
- **Unpacked**: nằm ở thư mục `.asar.unpacked/` bên cạnh file `.asar`

Kiểm tra file nào là unpacked:

```bash
npx asar list app.asar.backup | head -20  # Liệt kê tất cả files

# Hoặc đọc header để thấy flag unpacked:
python3 -c "
import struct, json
with open('app.asar.backup', 'rb') as f:
    f.read(4); hs = struct.unpack('<I', f.read(4))[0]
    f.read(4); ds = struct.unpack('<I', f.read(4))[0]
    header = json.loads(f.read(ds))

# Kiểm tra 1 file cụ thể
node = header['files']['dist']['files']['renderer']['files']['app']
node = node['files']['immutable']['files']['chunks']['files']['BTPDcoPQ.js']
print(json.dumps(node, indent=2))
"
```

Nếu thấy `"unpacked": true`, file đó nằm ở:
```
/Applications/Intent by Augment.app/Contents/Resources/app.asar.unpacked/<path>
```

Khi patch, phải update file ở **cả hai nơi** (trong extracted/ để repack, và trong `.unpacked/` trực tiếp).

## Cấu trúc thư mục sau extract

```
extracted/
├── dist/
│   ├── features/          # Backend features (agent, workspace, ...)
│   │   └── agent/
│   │       └── services/
│   │           ├── agent-factory.js          ← File cần patch (non-minified)
│   │           └── agent-backend-handler.service.js
│   ├── lib/
│   │   └── stores/
│   │       └── active-provider.store.svelte.js  ← Active provider store
│   ├── renderer/          # Frontend (Svelte, minified)
│   │   └── app/
│   │       └── immutable/
│   │           └── chunks/
│   │               ├── BTPDcoPQ.js           ← ModelStore (minified, unpacked)
│   │               ├── CfKn743W.js           ← ModelPicker (minified, unpacked)
│   │               └── ... (hàng trăm chunks khác)
│   └── shared/
│       └── config/
│           └── provider-config.js            ← ACP provider definitions
├── node_modules/          # Dependencies
└── package.json
```
