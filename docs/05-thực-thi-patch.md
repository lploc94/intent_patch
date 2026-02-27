# 05 — Thực thi patch

Hướng dẫn áp dụng từng patch. Chạy theo thứ tự hoặc dùng `apply.sh` để áp tự động.

## Chuẩn bị

```bash
cd ~/projects/intent_patch
# Đảm bảo đã extract
ls extracted/dist/features/agent/services/agent-factory.js || echo "Cần extract trước!"
```

## Patch 1: `loadModels()` — Fetch ALL providers

**File**: `extracted/dist/renderer/app/immutable/chunks/BTPDcoPQ.js`

Tìm pattern gốc:

```
this.modelsLoaded&&this.loadedForProviderId===e||this.isLoadingModels
```

Thay bằng:

```
this.modelsLoaded&&this.loadedForProviderId==="__all__"||this.isLoadingModels
```

Và thay toàn bộ body `loadModels()` — phần fetch 1 provider → fetch tất cả bằng `Promise.allSettled`.

Chi tiết code trước/sau: xem [PATCHES.md](../PATCHES.md#patch-1-loadmodels---fetch-all-providers).

**Verify**:
```bash
grep 'loadedForProviderId==="__all__"' extracted/dist/renderer/app/immutable/chunks/BTPDcoPQ.js
grep 'Promise.allSettled' extracted/dist/renderer/app/immutable/chunks/BTPDcoPQ.js
```

## Patch 2: `reloadModelsForProvider()` — Reset & reload all

**File**: `extracted/dist/renderer/app/immutable/chunks/BTPDcoPQ.js`

Tìm pattern gốc:

```
Reloading models for provider change
```

Thay bằng:

```
Reloading models for all providers
```

Và đơn giản hóa body: reset `modelsLoaded`, `loadedForProviderId`, `availableModels`, `loadError` rồi gọi `this.loadModels()`.

**Verify**:
```bash
grep 'Reloading models for all providers' extracted/dist/renderer/app/immutable/chunks/BTPDcoPQ.js
```

## Patch 3: `selectModel()` — Save per parsed provider

**File**: `extracted/dist/renderer/app/immutable/chunks/BTPDcoPQ.js`

Tìm pattern gốc (trong `selectModel`):

```
H.activeProviderId;this.providerModels.set(t,e)
```

Thay bằng:

```
Ce(e).providerId;this.providerModels.set(t,e)
```

Ý nghĩa: thay `H.activeProviderId` (active provider) bằng `Ce(e).providerId` (parse provider từ model ID).

**Verify**:
```bash
grep 'Ce(e).providerId;this.providerModels.set' extracted/dist/renderer/app/immutable/chunks/BTPDcoPQ.js
```

## Patch 4: `getGroupedModels()` — Group theo provider

**File**: `extracted/dist/renderer/app/immutable/chunks/BTPDcoPQ.js`

Tìm pattern gốc:

```
getGroupedModels(){const e=H.activeProviderId
```

Thay toàn bộ function body. Code mới:

```js
getGroupedModels(){
  if(this.availableModels.length===0)return[];
  const e=new Map;
  for(const s of this.availableModels){
    const r=Ce(s.value).providerId;
    e.has(r)||e.set(r,[]);
    e.get(r).push(s)
  }
  const t=[];
  for(const[s,r]of e){
    const i=Et[s];
    t.push({
      providerId:i?i.id:s,
      providerDisplayName:i?i.displayName:s,
      models:r
    })
  }
  return t
}
```

> Lưu ý: trong file minified, code trên phải nằm trên 1 dòng (không xuống dòng).

**Verify**:
```bash
grep 'getGroupedModels(){if(this.availableModels.length===0)return\[\];const e=new Map' extracted/dist/renderer/app/immutable/chunks/BTPDcoPQ.js
```

## Patch 5: `scheduleAutoRetry` — Bỏ provider stale check

**File**: `extracted/dist/renderer/app/immutable/chunks/BTPDcoPQ.js`

Tìm pattern gốc:

```
!this.modelsLoaded&&H.activeProviderId===e&&
```

Thay bằng:

```
!this.modelsLoaded&&
```

**Verify**:
```bash
# Phải không còn pattern cũ
python3 -c "
c = open('extracted/dist/renderer/app/immutable/chunks/BTPDcoPQ.js').read()
assert 'H.activeProviderId===e&&' not in c, 'Pattern cũ vẫn còn!'
print('OK')
"
```

## Patch 6A: Import ACP_PROVIDERS

**File**: `extracted/dist/features/agent/services/agent-factory.js`

Tìm dòng import:

```js
import { getDefaultModelForProvider, getDefaultProviderId, isModelValidForProvider, parseCompoundModelId, PROVIDER_MODEL_TIERS, } from '../../../shared/config/provider-config.js';
```

Thêm `ACP_PROVIDERS` vào đầu:

```js
import { ACP_PROVIDERS, getDefaultModelForProvider, getDefaultProviderId, isModelValidForProvider, parseCompoundModelId, PROVIDER_MODEL_TIERS, } from '../../../shared/config/provider-config.js';
```

## Patch 6B: Parse provider từ model ID

**File**: `extracted/dist/features/agent/services/agent-factory.js`

Tìm block (khoảng dòng 274):

```js
let provider = config.provider;
if (!provider && !isBackend) {
```

Chèn giữa:

```js
let provider = config.provider;
if (!provider && config.model) {
    const { providerId } = parseCompoundModelId(config.model);
    if (ACP_PROVIDERS[providerId]) {
        provider = providerId;
        logger.debug('Derived provider from model ID', { model: config.model, provider });
    }
}
if (!provider && !isBackend) {
```

## Patch 6C: Safety-net align provider

**File**: `extracted/dist/features/agent/services/agent-factory.js`

Tìm block safety-net (khoảng dòng 314). Thay logic "reset model" bằng "align provider":

```js
if (resolvedModel && provider && resolvedModel.includes(':')) {
    if (!isModelValidForProvider(resolvedModel, provider)) {
        const { providerId: modelProvider } = parseCompoundModelId(resolvedModel);
        if (ACP_PROVIDERS[modelProvider]) {
            logger.info('Safety net: aligning provider to match compound model', {
                resolvedModel, modelProvider, previousProvider: provider,
            });
            provider = modelProvider;
            // Re-validate sau khi align
            if (!isModelValidForProvider(resolvedModel, provider) && provider in PROVIDER_MODEL_TIERS) {
                const baseModel = getDefaultModelForProvider(provider, 'balanced');
                const defaultProviderId = getDefaultProviderId();
                resolvedModel =
                    provider !== defaultProviderId ? `${provider}:${baseModel}` : baseModel;
                logger.debug('Re-resolved model after provider alignment', { resolvedModel });
            }
        } else {
            logger.warn('Safety net: unknown provider in model, falling back', {
                resolvedModel, modelProvider, expectedProvider: provider,
            });
            if (provider in PROVIDER_MODEL_TIERS) {
                const baseModel = getDefaultModelForProvider(provider, 'balanced');
                const defaultProviderId = getDefaultProviderId();
                resolvedModel =
                    provider !== defaultProviderId ? `${provider}:${baseModel}` : baseModel;
            }
        }
    }
}
```

## Patch 7A: `isAgentProviderOverride` luôn false

**File**: `extracted/dist/renderer/app/immutable/chunks/CfKn743W.js`

Tìm pattern gốc:

```
Ie=H(()=>t(be)!==mt.activeProviderId)
```

Thay bằng:

```
Ie=H(()=>!1)
```

## Patch 7B: Vô hiệu effect fetch per-provider

**File**: `extracted/dist/renderer/app/immutable/chunks/CfKn743W.js`

Tìm effect gốc — block bắt đầu bằng:

```
nt(()=>{const r=t(be);if(r===mt.activeProviderId){h(xe,null),h(re,!1),h(se,null);return}
```

Và kết thúc tại `})` tương ứng. Thay toàn bộ bằng:

```
nt(()=>{t(be);h(xe,null),h(re,!1),h(se,null)})
```

## Kiểm tra syntax sau tất cả patches

```bash
node --check extracted/dist/features/agent/services/agent-factory.js
node --check extracted/dist/renderer/app/immutable/chunks/BTPDcoPQ.js
node --check extracted/dist/renderer/app/immutable/chunks/CfKn743W.js
echo "Syntax OK nếu không có output lỗi"
```

## Chạy verify script

```bash
python3 verify.py
# Phải pass 11/11 assertions
```
