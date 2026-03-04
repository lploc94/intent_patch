# Changelog

Tất cả thay đổi đáng chú ý của project được ghi nhận tại đây.

## [Unreleased]

### Hỗ trợ Intent v0.2.18

**Vấn đề**: Patch 6C ("safety-net align provider") fail trên Intent v0.2.18 do thay đổi formatting trong file `agent-factory.js`.

- **v0.2.12–v0.2.17** (hai dòng):
  ```js
  resolvedModel =
      provider !== defaultProviderId ? `${provider}:${baseModel}` : baseModel;
  ```
- **v0.2.18** (một dòng):
  ```js
  resolvedModel = provider !== defaultProviderId ? `${provider}:${baseModel}` : baseModel;
  ```

Patch 6C dùng `text_replace` (exact string match via `content.includes()`), nên chỉ khác 1 whitespace/newline cũng gây fail.

**Fix**: Chuyển Patch 6C từ `text_replace` sang `statement_replace` với `search_regex`, dùng `\s+` để match linh hoạt cả hai format.

#### Chi tiết thay đổi

- **`src/patches.js`**:
  - Patch 6C definition: `patch_type` → `statement_replace`, `search` → `search_regex`, `replace` → `replace_template`
  - `_build6cSearch()`: Tách search string thành 2 phần tại điểm `resolvedModel =` ↔ `provider !== defaultProviderId`, escape cả hai với `escapeRegExp()`, nối bằng `\s+`
  - `_build6cReplace()`: Không thay đổi — dùng làm `replace_template` (literal string insertion)

#### Tương thích

| Intent version | Trạng thái |
|---------------|------------|
| v0.2.11 | ✓ Legacy mode (`--legacy`) |
| v0.2.12–v0.2.17 | ✓ Auto-patch (backward compatible) |
| v0.2.18 | ✓ Auto-patch (fixed) |

## [1.0.0] — 2025-01-15

### Khởi tạo

- Pure Node.js auto-patcher — zero dependencies ngoài `@electron/asar`
- 18 patches trên 5 files: ModelStore (1–5), AgentFactory (6A–6C), ModelPicker (7A–7B), AgentInteractionTools (8A–8D)
- Version-independent symbol resolution cho minified code
- Legacy mode cho Intent v0.2.11
- Hỗ trợ Intent v0.2.12–v0.2.17
