# Native-TS Addons（純 TS 取代 native module）

> 對應目錄：`src/native-ts/`
> 動機：把原本依賴 NAPI / Rust binding 的功能用 pure TypeScript 改寫，bun + 跨平台不用編 native binary。

三個子模組，各取代一個 vendor native module，**API 完全對齊**讓 caller 不必改：

| 模組 | 對應 native | 主要功能 |
|---|---|---|
| `color-diff/` | `vendor/color-diff-src` (Rust + syntect + bat + similar) | 程式碼 diff 上色 + word-level diff |
| `file-index/` | `vendor/file-index-src` (Rust + nucleo) | fzf 風格模糊檔名搜尋 |
| `yoga-layout/` | `yoga-layout` (Meta C++ flexbox) | Ink UI 用 flexbox layout |

## 1. `color-diff/`

純 TS 重寫 `vendor/color-diff-src` 的 Rust 版（用 syntect + bat 上色 + similar 算 word diff）。本實作改用 `highlight.js`（已是 cli-highlight 依賴）+ `diff` npm 套件的 `diffArrays`。

### 與 native 的語義差異

| 項目 | Native (syntect) | TS (highlight.js) |
|---|---|---|
| 大部分 token 顏色 | ✓ | 從 syntect 量出對齊 |
| Plain identifier | 有 scope | 沒 scope，預設 fg |
| 操作符（`=` `:`） | 有 scope（白/粉色） | 沒 scope，預設 fg |
| 結構（行號、marker、word-diff） | ✓ | 完全相同 |
| `BAT_THEME` env 支援 | ✓ | Stub — 永遠回該 Claude theme 的預設 |

### Lazy load

`hljs()` 用 `require` 延後載入 — 完整 `highlight.js` 註冊 190+ 語法 grammar，require time ~50MB / 100-200ms（macOS）/ 數倍（Windows）。Top-level import 會讓 `test/preload.ts` 經 `StructuredDiff.tsx` → `colorDiff.ts` 撞到，使後續 test 進 GC pause（PR #24150 紀錄）。

### 入口

`src/native-ts/color-diff/index.ts` — `ColorDiff.render(...)`、`getSyntaxTheme(...)` 等，介面與 `vendor/color-diff-src/index.d.ts` 完全一致。

## 2. `file-index/`

純 TS 重寫 `vendor/file-index-src`（Rust NAPI 包 [nucleo](https://github.com/helix-editor/nucleo)）。

### API

```ts
new FileIndex()
  .loadFromFileList(fileList: string[]): void   // dedupe + index
  .search(query: string, limit: number): SearchResult[]

type SearchResult = { path: string, score: number }
```

### Score 語義

**越低越好**。`score = position_in_results / result_count`，最佳 match = 0.0。包含 `test` 的路徑加 1.05× penalty（封頂 1.0），讓非測試檔略佔優先。

### Scoring 常數（近似 fzf-v2 / nucleo bonuses）

```
SCORE_MATCH = 16
BONUS_BOUNDARY = 8        // 詞邊界（/、_、-、空白後）
BONUS_CAMEL = 6           // CamelCase 大寫處
BONUS_CONSECUTIVE = 4     // 連續 match
BONUS_FIRST_CHAR = 8      // 路徑/檔名第一字元
PENALTY_GAP_START = 3
PENALTY_GAP_EXTENSION = 1
```

### 效能設計

- `TOP_LEVEL_CACHE_LIMIT = 100` — 短 query 結果 cache
- `MAX_QUERY_LEN = 64` — 過長 query 截短
- **Time-based chunking**：`CHUNK_MS = 4` — 每塊只跑 4ms 就 yield event loop。慢機（舊 Windows）chunk 自然變小，event loop 不卡。

### 入口

`src/native-ts/file-index/index.ts` — `FileIndex` class 介面與 vendor native 對齊。

## 3. `yoga-layout/`

純 TS 重寫 Meta C++ [Yoga](https://github.com/facebook/yoga) flexbox engine。對齊 `yoga-layout/load` API surface（被 `src/ink/layout/yoga.ts` 用）。

### 涵蓋的 spec 子集（Ink 真的會用的）

- `flex-direction`（row/column + reverse）
- `flex-grow` / `flex-shrink` / `flex-basis`
- `align-items` / `align-self`（stretch、flex-start、center、flex-end）
- `justify-content`（六值全收）
- `margin` / `padding` / `border` / `gap`
- `width` / `height` / `min` / `max`（point、percent、auto）
- `position`：relative / absolute
- `display`：flex / none
- Measure functions（給 text node）

### 為 spec parity 也做了（Ink 不用）

- `margin: auto`（main + cross axis、覆蓋 justify/align）
- 子元素撞 min/max 時的 multi-pass flex clamping
- Indefinite size 下的 flex-grow/shrink 對 container min/max
- `flex-wrap: wrap` / `wrap-reverse`（multi-line flex）
- `align-content`（多行 cross-axis 定位）
- `display: contents`（孩子提到祖父、box 移除）
- Baseline alignment（`align-items: baseline`）

### 沒實作（Ink 不需）

- `aspect-ratio`
- `box-sizing: content-box`
- RTL direction（Ink 永遠傳 `Direction.LTR`）

### 為什麼自己重寫

Upstream `yoga-layout` 是 WASM + 編 binary，跨 bun + Windows + Linux + macOS 容易掉 cache、build 慢。Pure TS 版啟動快、無 binary、行為對 Ink 子集完全等效。完整 C++ `CalculateLayout.cpp` ~2500 行，TS 版只實作必要 single-pass。

### 入口

`src/native-ts/yoga-layout/index.ts` 主 API、`enums.ts` 常數列舉。

## 共同設計原則

1. **API 對齊 native，caller 零修改** — switch import path 即可。
2. **效能不能比 native 差太多** — chunking、lazy load、cache 都在每個模組重新做一次。
3. **語義差異要寫死在 doc 開頭** — 例如 color-diff 的 plain identifier 不上色、yoga 的 spec 子集，避免之後 debugging 時誤判 regression。

## 物件路徑

| 檔案 | 行數 | 對應 vendor |
|---|---|---|
| `src/native-ts/color-diff/index.ts` | ~ | `vendor/color-diff-src/` |
| `src/native-ts/file-index/index.ts` | ~ | `vendor/file-index-src/` |
| `src/native-ts/yoga-layout/index.ts` | ~ | `yoga-layout` npm |
| `src/native-ts/yoga-layout/enums.ts` | ~ | yoga enum constants |
