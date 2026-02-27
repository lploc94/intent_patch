# 02 — Phân tích kiến trúc

## Mục tiêu phân tích

Intent by Augment chỉ cho phép chọn **1 ACP provider** tại 1 thời điểm. Mục tiêu: tìm hiểu vì sao bị giới hạn và xác định những file nào cần thay đổi.

## Bước 1: Hiểu hệ thống Provider

### Provider Config

File `dist/shared/config/provider-config.js` định nghĩa tất cả ACP providers:

```js
export const ACP_PROVIDERS = {
    auggie:      { id: 'auggie',      displayName: 'Auggie',      ... },
    'claude-code': { id: 'claude-code', displayName: 'Claude Code', ... },
    codex:       { id: 'codex',       displayName: 'Codex',       ... },
    cortex:      { id: 'cortex',      displayName: 'Cortex',      ... },
    opencode:    { id: 'opencode',    displayName: 'OpenCode',    ... },
};
```

Mỗi provider có:
- `id`: identifier duy nhất
- `displayName`: tên hiển thị
- `models`: danh sách model tiers (fast/balanced/quality)
- `fetchModels()`: hàm gọi API lấy available models

### Compound Model ID

App dùng format `{providerId}:{modelId}` (ví dụ `codex:gpt-5.3-codex/high`). Hàm parse:

```js
// dist/shared/config/provider-config.js
export function parseCompoundModelId(compoundModelId) {
    if (compoundModelId.includes(':')) {
        const [providerId, ...modelParts] = compoundModelId.split(':');
        return { providerId, modelId: modelParts.join(':') };
    }
    return { providerId: getDefaultProviderId(), modelId: compoundModelId };
}
```

Model không có prefix (ví dụ `gpt-5.3-turbo`) sẽ được gán cho default provider.

## Bước 2: Tìm điểm giới hạn (single-provider)

### Active Provider Store

File `dist/lib/stores/active-provider.store.svelte.js`:

```js
// Store giữ 1 activeProviderId duy nhất
class ActiveProviderStore {
    activeProviderId = $state('auggie'); // Mặc định Auggie
    // ...
}
```

Đây là trung tâm — mọi component đều đọc `activeProviderId` từ đây.

### Cách tìm

Dùng `grep` hoặc Augment codebase-retrieval để tìm tất cả references:

```bash
# Tìm ai đọc activeProviderId
cd extracted
grep -r "activeProviderId" --include="*.js" -l

# Kết quả quan trọng:
# dist/renderer/app/immutable/chunks/BTPDcoPQ.js  ← ModelStore
# dist/renderer/app/immutable/chunks/CfKn743W.js  ← ModelPicker
# dist/features/agent/services/agent-factory.js    ← Agent creation
```

## Bước 3: Phân tích luồng chạy

### Luồng load models (gốc)

```
User mở app
  → ModelStore.loadModels()
    → Lấy activeProviderId từ store (ví dụ "auggie")
    → Kiểm tra: đã load cho provider này chưa?
    → Nếu chưa: gọi fetchModelsForProvider("auggie")
    → Set availableModels = [models chỉ của auggie]
    → Set loadedForProviderId = "auggie"
```

**Vấn đề**: Chỉ fetch models của 1 provider. Nếu user đổi provider, phải fetch lại.

### Luồng tạo agent (gốc)

```
User click "New Agent" + chọn model
  → AgentFactory.createAgent({ model: "gpt-5.3-turbo" })
    → provider = activeProviderStore.activeProviderId  ← Luôn dùng active
    → Tạo agent với provider + model
```

**Vấn đề**: Dù model thuộc Codex, agent vẫn được tạo với provider = active (có thể là Auggie).

### Luồng hiển thị dropdown (gốc)

```
ModelPicker component
  → effectiveProviderId = agent.provider hoặc activeProviderId
  → isAgentProviderOverride = (effectiveProvider !== activeProvider)
  → Nếu override: fetch models riêng cho provider đó
  → Nếu không: dùng modelStore.availableModels (chỉ 1 provider)
```

**Vấn đề**: Dropdown chỉ hiện models của 1 provider.

## Bước 4: Xác định files cần patch

Từ phân tích trên, 3 files cần thay đổi:

| # | File | Vấn đề | Giải pháp |
|---|------|--------|-----------|
| 1 | `BTPDcoPQ.js` (ModelStore) | Chỉ fetch 1 provider | Fetch tất cả providers |
| 2 | `agent-factory.js` | Luôn dùng active provider | Parse provider từ model ID |
| 3 | `CfKn743W.js` (ModelPicker) | Fetch riêng per-provider | Dùng unified list |

### Vì sao không cần sửa files khác?

- **active-provider.store.svelte.js**: Không cần sửa. Store này vẫn giữ default provider, nhưng không còn là source of truth duy nhất.
- **agent-backend-handler.service.js**: Backend đã hỗ trợ multi-provider (ProviderRegistry là Map, không phải singleton). Không cần sửa.
- **provider-config.js**: Chỉ đọc, không cần sửa.

## Bước 5: Phân biệt file minified vs non-minified

| File | Loại | Cách nhận biết |
|------|------|----------------|
| `agent-factory.js` | Non-minified | Có comment, tên biến đầy đủ, xuống dòng |
| `BTPDcoPQ.js` | Minified | 1 dòng dài, tên biến 1-2 ký tự |
| `CfKn743W.js` | Minified | 1 dòng dài, tên biến 1-2 ký tự |

File non-minified sửa trực tiếp. File minified cần phải giải mã symbol trước (xem doc tiếp theo).
