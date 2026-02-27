# 03 — Giải mã code minified

## Tại sao cần giải mã?

Svelte/Vite build tạo ra các file chunk minified (1 dòng, biến 1-2 ký tự). Ví dụ:

```js
// Gốc (trong source code)
const isOverride = computed(() => effectiveProviderId() !== activeProviderStore.activeProviderId)

// Minified (trong BTPDcoPQ.js)
Ie=H(()=>t(be)!==mt.activeProviderId)
```

Không thể sửa đúng nếu không biết `Ie`, `H`, `t`, `be`, `mt` là gì.

## Phương pháp giải mã

### 1. Tìm tên đầy đủ trong codebase

Minifier rút gọn tên biến cục bộ nhưng **giữ nguyên** string literals, property names, và tên export. Tận dụng điều này:

```bash
# Tìm tên method đầy đủ (không bị minify)
grep -o "activeProviderId\|loadModels\|selectModel\|getGroupedModels" BTPDcoPQ.js

# Tìm string literals
grep -o '"[^"]*"' BTPDcoPQ.js | sort -u | head -30
```

String `"Loading models for provider"`, `"Selecting model:"`, v.v. cho biết ngữ cảnh.

### 2. Tìm import map ở đầu file

File minified thường bắt đầu bằng import:

```js
import{A as H, B as We, ...} from "./B-7-Y0L_.js";
```

Điều này cho biết `H` trong file này = export `A` từ `B-7-Y0L_.js`. Tra ngược:

```bash
# Tìm export A trong B-7-Y0L_.js
grep "export.*function A\|export{.*A" extracted/dist/renderer/app/immutable/chunks/B-7-Y0L_.js
```

### 3. Dùng ngữ cảnh sử dụng

Khi không tìm được import source, dùng cách biến được sử dụng để suy ra:

```js
// Nếu thấy:
const t = Ce(e).providerId;
// Và biết parseCompoundModelId trả về {providerId, modelId}
// → Ce = parseCompoundModelId
```

```js
// Nếu thấy:
H.activeProviderId
// → H = activeProviderStore (vì chỉ object này có property activeProviderId)
```

### 4. So sánh với non-minified files

`agent-factory.js` (non-minified) import cùng modules:

```js
import { getDefaultModelForProvider, getDefaultProviderId,
         isModelValidForProvider, parseCompoundModelId,
         PROVIDER_MODEL_TIERS } from '../../../shared/config/provider-config.js';
```

Tìm xem minified file import gì từ cùng module:

```bash
grep "provider-config" BTPDcoPQ.js
```

### 5. Dùng .map files (nếu có)

Một số chunks có source map (`.js.map`). Đọc:

```bash
# Kiểm tra source map
ls extracted/dist/renderer/app/immutable/chunks/BTPDcoPQ.js.map

# Parse (nếu tồn tại)
python3 -c "
import json
m = json.load(open('extracted/dist/renderer/app/immutable/chunks/BTPDcoPQ.js.map'))
print('Sources:', m.get('sources', [])[:10])
print('Names:', m.get('names', [])[:20])
"
```

`names` array chứa tên gốc trước khi minify — rất hữu ích.

## Symbol Map hoàn chỉnh

### BTPDcoPQ.js (ModelStore)

| Symbol | Ý nghĩa | Cách xác nhận |
|--------|----------|---------------|
| `H` | activeProviderStore | `H.activeProviderId` — chỉ store này có property đó |
| `Et` | ACP_PROVIDERS | `Et[providerId]` trả về config object có `.id`, `.displayName` |
| `Ce` | parseCompoundModelId | `Ce(e).providerId` — trả về `{providerId, modelId}` |
| `Ue` | getDefaultProviderId | Gọi khi cần default provider, trả về string |
| `We` | getProviderConfigById | `We(e)` trả về provider config |
| `h` | unifiedStateStore | `h.setModelsLoading(true)`, `h.selectModel(e)` |
| `I` | Logger instance | `I.debug(...)`, `I.info(...)`, `I.warn(...)` |
| `Me` | localStorage key | `= "workspaces-selected-model"` (string literal) |
| `yt` | getPreferredModel | Utility lấy preferred model |
| `Ob` | Object.keys | Alias minified |

### CfKn743W.js (ModelPicker)

| Symbol | Ý nghĩa | Cách xác nhận |
|--------|----------|---------------|
| `be` | effectiveProviderId | computed, dùng `mt.activeProviderId` |
| `Ie` | isAgentProviderOverride | computed, so sánh `be` với `mt.activeProviderId` |
| `xe` | agentProviderModels | signal (Y = signal constructor), set bởi effect |
| `re` | isLoadingAgentModels | signal boolean |
| `se` | agentModelError | signal string/null |
| `we` | displayedModels | computed: `t(xe) ?? ce.availableModels` |
| `ce` | modelStore instance | import, có `.availableModels`, `.getModelsForProvider()` |
| `mt` | activeProviderStore | `.activeProviderId` |
| `nt` | effect | Svelte reactive effect function |
| `H` | computed | Svelte computed function |
| `h` | set | Set signal value: `h(xe, null)` |
| `t` | get | Get signal value: `t(be)` |
| `Et` | getProviderConfigById | Trả config theo provider ID |
| `Y` | signal | Signal constructor: `Y(null)` |

## Kỹ thuật sửa code minified

### Nguyên tắc vàng

1. **Sửa ít nhất có thể**: Mỗi ký tự thay đổi đều có rủi ro
2. **Giữ nguyên độ dài nếu được**: Tránh dịch offset gây lỗi source map
3. **Test syntax trước khi deploy**: `node --check <file>` kiểm tra cú pháp

### Ví dụ: Sửa 1 expression

Thay `Ie=H(()=>t(be)!==mt.activeProviderId)` thành `Ie=H(()=>!1)`:

```python
content = open('CfKn743W.js', 'r').read()
old = 'Ie=H(()=>t(be)!==mt.activeProviderId)'
new = 'Ie=H(()=>!1)'
assert old in content, 'Pattern không tìm thấy!'
content = content.replace(old, new, 1)  # Chỉ replace 1 lần
open('CfKn743W.js', 'w').write(content)
```

Dùng Python vì:
- `sed` gặp vấn đề với regex đặc biệt (dấu `(`, `)`, `!`)
- Python dùng string replace thuần, không cần escape
- `assert` đảm bảo pattern tồn tại trước khi thay

### Ví dụ: Thay thế toàn bộ function body

Khi cần thay hàm dài, tìm boundary bằng brace matching:

```python
import re

content = open('BTPDcoPQ.js', 'r').read()

# Tìm vị trí bắt đầu hàm
start_marker = 'getGroupedModels(){'
idx = content.index(start_marker)

# Tìm closing brace (đếm depth)
depth = 0
i = content.index('{', idx)
while i < len(content):
    if content[i] == '{': depth += 1
    elif content[i] == '}':
        depth -= 1
        if depth == 0:
            end = i + 1
            break
    i += 1

old_func = content[idx:end]
new_func = 'getGroupedModels(){...code mới...}'
content = content.replace(old_func, new_func, 1)
```

### Kiểm tra syntax sau khi sửa

```bash
node --check extracted/dist/renderer/app/immutable/chunks/BTPDcoPQ.js
# Nếu không in gì = OK
# Nếu có lỗi = sai cú pháp, cần sửa lại
```
