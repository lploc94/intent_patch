# 04 — Thiết kế patch

## Kiến trúc hiện tại (single-provider)

```
┌─────────────┐     ┌──────────────────┐     ┌──────────────┐
│ ModelPicker  │────→│   ModelStore     │────→│ Provider API │
│ (dropdown)   │     │                  │     │ (1 provider) │
│              │     │ loadModels()     │     └──────────────┘
│ Hiện models  │     │  → fetch 1 prov  │
│ của 1 prov   │     │  → set models    │
└──────┬───────┘     └────────┬─────────┘
       │                      │
       │ chọn model           │ activeProviderId
       ▼                      ▼
┌──────────────┐     ┌──────────────────┐
│ AgentFactory │────→│ ActiveProvider   │
│              │     │     Store        │
│ provider =   │     │                  │
│ activeProvider│    │ auggie (cố định) │
└──────────────┘     └──────────────────┘
```

## Kiến trúc mới (multi-provider)

```
┌─────────────┐     ┌──────────────────┐     ┌──────────────┐
│ ModelPicker  │────→│   ModelStore     │────→│ Provider APIs│
│ (dropdown)   │     │                  │     │ (TẤT CẢ)    │
│              │     │ loadModels()     │     │ ┌──────────┐ │
│ Hiện models  │     │  → fetch ALL     │     │ │ Auggie   │ │
│ TẤT CẢ prov │     │  → merge & group │     │ │ Claude   │ │
│ grouped by   │     │  → prefix IDs    │     │ │ Codex    │ │
│ provider     │     │                  │     │ │ Cortex   │ │
└──────┬───────┘     └──────────────────┘     │ │ OpenCode │ │
       │                                       │ └──────────┘ │
       │ chọn model (vd: codex:gpt-5.3)       └──────────────┘
       ▼
┌──────────────┐
│ AgentFactory │
│              │
│ model = codex:gpt-5.3-codex/high
│ → parse: provider = "codex"          ← TỰ ĐỘNG từ model ID
│ → tạo agent với provider "codex"
└──────────────┘
```

## Insight chính

> Backend đã hỗ trợ multi-provider. ProviderRegistry dùng Map (không phải singleton).
> Giới hạn chỉ ở **frontend**: ModelStore chỉ fetch 1 provider, ModelPicker chỉ hiện 1 list.
> Giải pháp: mở rộng frontend, giữ nguyên backend.

## Thiết kế 8 patches

### Nhóm 1: ModelStore (BTPDcoPQ.js) — 5 patches

**Mục tiêu**: Fetch models từ tất cả providers, group theo provider, lưu preference per-provider.

#### Patch 1: `loadModels()` — Fetch ALL providers

| Aspect | Gốc | Mới |
|--------|-----|-----|
| Fetch | 1 provider (activeProviderId) | Tất cả `Object.keys(ACP_PROVIDERS)` |
| Concurrency | Sequential | `Promise.allSettled` (song song) |
| Cache key | `loadedForProviderId = "auggie"` | `loadedForProviderId = "__all__"` |
| Model IDs | Không prefix | Prefix `{provider}:` cho non-default |

Tại sao `Promise.allSettled` thay vì `Promise.all`?
- Provider chưa cài sẽ fail khi fetch → `allSettled` cho phép tiếp tục
- Mỗi result hoặc fulfilled (có models) hoặc rejected (skip)

Tại sao prefix model IDs?
- Cần phân biệt model cùng tên từ provider khác nhau
- Format: `codex:gpt-5.3-codex/high`, `claude-code:claude-opus-4.6`
- Default provider không prefix (backwards compatible): `gpt-5.3-turbo`

#### Patch 2: `reloadModelsForProvider()` — Reset & reload all

| Aspect | Gốc | Mới |
|--------|-----|-----|
| Logic | Save/restore per-provider, reload 1 | Reset all, reload all |

Đơn giản hóa: không cần save/restore vì unified list luôn chứa tất cả.

#### Patch 3: `selectModel()` — Save per parsed provider

| Aspect | Gốc | Mới |
|--------|-----|-----|
| Provider key | `activeProviderStore.activeProviderId` | `parseCompoundModelId(model).providerId` |

Khi user chọn `codex:gpt-5.3`, lưu preference cho provider `codex` (không phải `auggie`).

#### Patch 4: `getGroupedModels()` — Group theo provider

| Aspect | Gốc | Mới |
|--------|-----|-----|
| Output | 1 group, 1 provider | Nhiều groups, mỗi group 1 provider |
| Logic | Lấy provider config → wrap all models | Parse mỗi model → group by providerId |

Dropdown sẽ hiện headers: "Auggie", "Claude Code", "Codex", v.v.

#### Patch 5: `scheduleAutoRetry()` — Bỏ provider stale check

| Aspect | Gốc | Mới |
|--------|-----|-----|
| Condition | `!modelsLoaded && activeProvider === original` | `!modelsLoaded` |

Gốc: chỉ retry nếu active provider không đổi. Mới: retry bất kể (vì load tất cả).

### Nhóm 2: AgentFactory (agent-factory.js) — 3 patches

**Mục tiêu**: Tự động chọn đúng provider dựa trên model ID.

#### Patch 6A: Import `ACP_PROVIDERS`

Thêm import để dùng trong validation.

#### Patch 6B: Parse provider từ model ID

| Aspect | Gốc | Mới |
|--------|-----|-----|
| Provider resolution | Luôn `activeProviderStore` | Parse từ model ID → fallback active |

```
Ưu tiên:
1. config.provider (nếu explicit)
2. parseCompoundModelId(config.model).providerId
3. activeProviderStore.activeProviderId (fallback)
```

#### Patch 6C: Safety-net align provider (không reset model)

| Aspect | Gốc | Mới |
|--------|-----|-----|
| Khi mismatch | Reset model → default của provider | Align provider theo model |

Gốc: nếu model `codex:X` nhưng provider `auggie` → đổi model sang default auggie (mất lựa chọn user).
Mới: đổi provider sang `codex` (giữ lựa chọn user). Re-validate sau khi align.

### Nhóm 3: ModelPicker (CfKn743W.js) — 2 patches

**Mục tiêu**: Dropdown luôn dùng unified list từ ModelStore.

#### Patch 7A: `isAgentProviderOverride` luôn false

| Aspect | Gốc | Mới |
|--------|-----|-----|
| Logic | `effectiveProvider !== activeProvider` | Luôn `false` |

Vô hiệu hóa per-agent provider override UI — không cần thiết khi đã unified.

#### Patch 7B: Vô hiệu effect fetch per-provider

| Aspect | Gốc | Mới |
|--------|-----|-----|
| Effect | Fetch models riêng cho agent's provider | Clear signals → fallback unified list |

Effect gốc: nếu agent provider ≠ active → fetch models riêng cho agent provider.
Effect mới: luôn clear `agentProviderModels` → `displayedModels` fallback về `modelStore.availableModels`.

## Rủi ro và biện pháp giảm thiểu

| Rủi ro | Xác suất | Biện pháp |
|--------|----------|-----------|
| Provider chưa cài fetch fail | Cao | `Promise.allSettled` + `.catch(() => [])` |
| Model ID trùng suffix giữa providers | Rất thấp | `endsWith` fallback chỉ cho auto-select, không ảnh hưởng explicit select |
| Update Intent phá patches | Chắc chắn khi update | Version lock, verify script |
| Asar integrity check | Chắc chắn | Remove ElectronAsarIntegrity, re-codesign |
