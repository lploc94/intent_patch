# Chi tiết Patches

## Tổng quan

8 patches trên 3 files, chia thành 3 nhóm chức năng:

1. **ModelStore** (BTPDcoPQ.js): Fetch models từ tất cả providers, group theo provider
2. **AgentFactory** (agent-factory.js): Parse provider từ model ID, safety-net alignment
3. **ModelPicker** (CfKn743W.js): Vô hiệu per-provider fetch, dùng unified list

## Symbol Map (Minified Files)

### BTPDcoPQ.js (ModelStore)

| Symbol | Ý nghĩa |
|--------|---------|
| `H` | activeProviderStore |
| `Et` | ACP_PROVIDERS (provider config map) |
| `Ce` | parseCompoundModelId |
| `Ue` | getDefaultProviderId |
| `We` | getProviderConfigById |
| `h` | unifiedStateStore |
| `I` | Logger instance |
| `Me` | localStorage key `"workspaces-selected-model"` |
| `Se` | UI constants (model preference key, etc.) |
| `yt` | getPreferredModel utility |

### CfKn743W.js (ModelPicker)

| Symbol | Ý nghĩa |
|--------|---------|
| `be` | effectiveProviderId (computed) |
| `Ie` | isAgentProviderOverride (computed) |
| `xe` | agentProviderModels (signal, Y=signal constructor) |
| `re` | isLoadingAgentModels (signal) |
| `se` | agentModelError (signal) |
| `we` | displayedModels (computed: xe ?? ce.availableModels) |
| `ce` | modelStore instance |
| `mt` | activeProviderStore |
| `nt` | effect (reactive side-effect) |
| `H` | computed (reactive derived value) |
| `h` | set signal value |
| `t` | get signal value |
| `Et` | getProviderConfigById |

## Patch 1: loadModels() — Fetch ALL providers

**File**: `BTPDcoPQ.js`
**Function**: `async loadModels()`

### Trước (gốc)

```js
async loadModels(){
  const e = H.activeProviderId;
  if (this.modelsLoaded && this.loadedForProviderId === e || this.isLoadingModels) {
    return;
  }
  // ... fetch chỉ 1 provider (e), prefix models với provider ID
  const t = await this.fetchModelsForProvider(e);
  // ... set availableModels, modelsLoaded, loadedForProviderId = e
}
```

### Sau (patched)

```js
async loadModels(){
  if (this.modelsLoaded && this.loadedForProviderId === "__all__" || this.isLoadingModels) {
    return;
  }
  // ... fetch TẤT CẢ providers bằng Promise.allSettled
  const e = Object.keys(Et);  // Tất cả provider IDs
  const s = await Promise.allSettled(e.map(async n => {
    const o = await this.fetchModelsForProvider(n);
    return { providerId: n, models: o };
  }));
  // Merge tất cả models, prefix với {providerId}: (trừ default provider)
  // Set loadedForProviderId = "__all__"
}
```

### Logic

- `Object.keys(Et)` lấy tất cả provider IDs từ ACP_PROVIDERS config
- `Promise.allSettled` fetch song song, provider không cài sẽ trả về empty (catch trong fetchModelsForProvider)
- Mỗi model được prefix với `{providerId}:` trừ default provider (giữ backwards-compatible)
- Cache key là `"__all__"` thay vì 1 provider ID cụ thể

## Patch 2: reloadModelsForProvider() — Reset & reload all

**File**: `BTPDcoPQ.js`
**Function**: `async reloadModelsForProvider()`

### Trước

```js
async reloadModelsForProvider(){
  const e = H.activeProviderId;
  // ... save/restore model per provider, clear workspace models
  this.modelsLoaded = false;
  this.loadedForProviderId = null;
  await this.loadModels();  // → chỉ load provider e
}
```

### Sau

```js
async reloadModelsForProvider(){
  // Đơn giản: reset và reload tất cả
  this.modelsLoaded = false;
  this.loadedForProviderId = null;
  this.availableModels = [];
  this.loadError = null;
  await this.loadModels();  // → load tất cả providers
}
```

### Logic

- Không cần save/restore model per provider nữa vì danh sách luôn chứa tất cả
- Bỏ workspace model cache clear (không cần thiết khi unified list)

## Patch 3: selectModel() — Lưu theo provider từ model ID

**File**: `BTPDcoPQ.js`
**Function**: `selectModel(e)`

### Trước

```js
selectModel(e){
  // ...
  const t = H.activeProviderId;          // Lấy từ active provider store
  this.providerModels.set(t, e);         // Lưu model cho active provider
}
```

### Sau

```js
selectModel(e){
  // ...
  const t = Ce(e).providerId;            // Parse provider từ model ID
  this.providerModels.set(t, e);         // Lưu model cho provider của model
}
```

### Logic

- Khi user chọn `codex:gpt-5.3-codex/high`, provider được parse từ model ID (`codex`)
- Trước đây nó lưu cho active provider (có thể là `auggie`), gây lệch

## Patch 4: getGroupedModels() — Group theo provider prefix

**File**: `BTPDcoPQ.js`
**Function**: `getGroupedModels()`

### Trước

```js
getGroupedModels(){
  const e = H.activeProviderId, t = Et[e];
  return !t || this.availableModels.length === 0
    ? []
    : [{ providerId: t.id, providerDisplayName: t.displayName,
         models: this.availableModels }];
}
```

### Sau

```js
getGroupedModels(){
  if (this.availableModels.length === 0) return [];
  const e = new Map;
  for (const s of this.availableModels) {
    const r = Ce(s.value).providerId;
    e.has(r) || e.set(r, []);
    e.get(r).push(s);
  }
  const t = [];
  for (const [s, r] of e) {
    const i = Et[s];
    t.push({
      providerId: i ? i.id : s,
      providerDisplayName: i ? i.displayName : s,
      models: r
    });
  }
  return t;
}
```

### Logic

- Trước: 1 group duy nhất cho active provider
- Sau: nhiều groups, mỗi group 1 provider, parse từ model compound ID
- Dropdown hiển thị headers theo tên provider

## Patch 5: scheduleAutoRetry — Bỏ provider stale check

**File**: `BTPDcoPQ.js`
**Inline trong**: `scheduleAutoRetry(e)`

### Trước

```js
!this.modelsLoaded && H.activeProviderId === e &&
```

### Sau

```js
!this.modelsLoaded &&
```

### Logic

- Trước: chỉ retry nếu active provider vẫn là `e` (provider lúc bắt đầu)
- Sau: retry bất kể provider nào active (vì load tất cả)

## Patch 6A: Import ACP_PROVIDERS

**File**: `agent-factory.js` (dòng 20)

```diff
-import { getDefaultModelForProvider, getDefaultProviderId, ...
+import { ACP_PROVIDERS, getDefaultModelForProvider, getDefaultProviderId, ...
```

## Patch 6B: Parse provider từ model ID trước fallback

**File**: `agent-factory.js` (dòng 274-281)

### Trước

```js
let provider = config.provider;
if (!provider && !isBackend) {
  provider = providerStore.activeProviderId;  // Luôn dùng active provider
}
```

### Sau

```js
let provider = config.provider;
// Thử parse provider từ model ID trước
if (!provider && config.model) {
  const { providerId } = parseCompoundModelId(config.model);
  if (ACP_PROVIDERS[providerId]) {
    provider = providerId;
  }
}
// Fallback về active provider nếu không parse được
if (!provider && !isBackend) {
  provider = providerStore.activeProviderId;
}
```

### Logic

- Khi user chọn `codex:gpt-5.3-codex/high`, provider = `codex` (từ model)
- Khi user chọn `gpt-5.3-turbo` (không prefix), provider = default provider (từ parseCompoundModelId)
- Chỉ fallback về activeProviderStore nếu model không có hoặc provider không hợp lệ

## Patch 6C: Safety-net align provider thay vì reset model

**File**: `agent-factory.js` (dòng 314-342)

### Trước

```js
if (!isModelValidForProvider(resolvedModel, provider)) {
  // Reset model về default của provider → MẤT model user đã chọn
  resolvedModel = getDefaultModelForProvider(provider, 'balanced');
}
```

### Sau

```js
if (!isModelValidForProvider(resolvedModel, provider)) {
  const { providerId: modelProvider } = parseCompoundModelId(resolvedModel);
  if (ACP_PROVIDERS[modelProvider]) {
    // Align provider theo model (giữ model user đã chọn)
    provider = modelProvider;
    // Re-validate; fallback nếu vẫn invalid
    if (!isModelValidForProvider(resolvedModel, provider) && provider in PROVIDER_MODEL_TIERS) {
      resolvedModel = getDefaultModelForProvider(provider, 'balanced');
    }
  } else {
    // Provider không biết → fallback model
    resolvedModel = getDefaultModelForProvider(provider, 'balanced');
  }
}
```

### Logic

- Trước: mismatch → reset model (mất lựa chọn của user)
- Sau: mismatch → đổi provider theo model (giữ lựa chọn của user)
- Chỉ reset model khi provider trong model ID không tồn tại

## Patch 7A: isAgentProviderOverride luôn false

**File**: `CfKn743W.js`

### Trước

```js
Ie = H(() => t(be) !== mt.activeProviderId)
```

### Sau

```js
Ie = H(() => !1)
```

### Logic

- `Ie` (isAgentProviderOverride) kiểm tra nếu agent đang dùng provider khác active
- Khi true, ModelPicker fetch models riêng cho provider đó thay vì dùng unified list
- Đặt luôn false → luôn dùng unified list từ ModelStore

## Patch 7B: Vô hiệu effect fetch per-provider

**File**: `CfKn743W.js`

### Trước

```js
nt(() => {
  const r = t(be);
  if (r === mt.activeProviderId) {
    h(xe, null); h(re, !1); h(se, null);
    return;
  }
  // Fetch models riêng cho provider khác
  h(re, !0); h(se, null);
  ce.getModelsForProvider(r).then(_ => {
    h(xe, _, !0); h(re, !1);
  }).catch(_ => {
    h(se, _.message || "Failed to load models", !0); h(re, !1);
  });
});
```

### Sau

```js
nt(() => {
  t(be);  // Giữ reactive subscription
  h(xe, null);   // agentProviderModels = null
  h(re, !1);     // loading = false
  h(se, null);   // error = null
});
```

### Logic

- Luôn clear `xe` (agentProviderModels) → `we` (displayedModels) fallback về `ce.availableModels` (unified list)
- Vẫn read `t(be)` để giữ Svelte reactive subscription (tránh warning)

## Known Limitations

1. **endsWith false-positive**: Trong loadModels (BTPDcoPQ.js), kiểm tra model tồn tại dùng `endsWith(modelId)` có thể match nhầm giữa providers nếu trùng suffix. Xác suất rất thấp và chỉ ảnh hưởng auto-select fallback.

2. **Version lock**: Tên file minified là content hashes. Khi Intent update, tên file sẽ khác và cần re-identify các chunks tương ứng.

3. **Provider chưa cài**: `Object.keys(Et)` fetch cả providers chưa cài. `fetchModelsForProvider` có `.catch(() => [])` nên providers không có sẽ trả về empty nhanh.
