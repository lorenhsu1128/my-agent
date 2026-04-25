# M-TOKEN：為 llamacpp 恢復真實 cache token 計數

## Context

使用者回報 TUI 某些 token 計數「一直顯示 0」。追查後發現：

- TUI 顯示入口：`src/cost-tracker.ts:181-226` `formatModelUsage()` —— 輸出 `N input, N output, N cache read, N cache write (cost)`；被 `/cost`、session 摘要等呼叫。
- 聚合入口：`src/cost-tracker.ts:250-276` `addToTotalModelUsage()` → `src/bootstrap/state.ts` `STATE.modelUsage[model]`。
- 資料來源：`src/services/api/claude.ts:2911-2974` `updateUsage()` 從 API 回應抽 usage。

根因：`src/services/api/llamacpp-fetch-adapter.ts` 把所有 cache 欄位**硬編碼為 0**：
- 非 streaming：L348-349 `cache_creation_input_tokens: 0, cache_read_input_tokens: 0`
- Streaming message_start：L465 `usage: { input_tokens: 0, output_tokens: 0 }`（完全沒提 cache）
- Streaming message_delta：L641 `usage: { output_tokens: accUsage.output_tokens }`（沒帶 cache）

但 llama.cpp server 的 OpenAI-compatible `/v1/chat/completions` 在開啟 prompt caching（預設開）後，**實際會回傳 `prompt_tokens_details.cached_tokens`**（OpenAI 2024-10 規格後的標準欄位，llama.cpp 已跟進）。這個欄位直接等同於 Anthropic 的 `cache_read_input_tokens` 語意——從 KV-cache 命中的 prompt tokens 數。

本次變更把這個值接回來，TUI 的 cache read 就能在 llamacpp session 顯示真實數字，而非永遠 0。`cache_creation_input_tokens`（Anthropic 專屬的「寫入」cache tokens）llama.cpp 無對應概念，維持 0。

## 目標與非目標

**目標**
- llamacpp session 的 `/cost` 與 session 結束摘要 `cache read` 欄位顯示真實命中數。
- 不影響 Anthropic 原生 path。
- Provider 沒回 `prompt_tokens_details` 時（例如舊版 llama.cpp）維持 0，不 crash。

**非目標**
- 不嘗試偽造 `cache_creation_input_tokens`（llama.cpp 沒有此概念；若要計算「首次寫入 KV cache」，要追蹤 prompt_tokens - cached_tokens，但語意與 Anthropic 不同，先不做）。
- 不動 cost 計算（pricing 對 llamacpp 本地模型應為 0，不改）。
- 不改 TUI；改完 adapter 後下游 `updateUsage` / `addToTotalModelUsage` / `formatModelUsage` 自動吃到新數字。

## 改動清單

### 1. `src/services/api/llamacpp-fetch-adapter.ts`

**1a. 擴充 OpenAI 回應型別定義（L107-112 非 stream、L134-139 stream）**
加上 `prompt_tokens_details?: { cached_tokens?: number }`。

**1b. 非 streaming 路徑（`translateChatCompletionToAnthropic`，L340-351）**
把 L348-349 的 `cache_read_input_tokens: 0` 改為：
```ts
cache_read_input_tokens: openai.usage?.prompt_tokens_details?.cached_tokens ?? 0,
```
`cache_creation_input_tokens` 仍維持 0（llama.cpp 無概念）。

**1c. Streaming accUsage（L450）**
擴充：
```ts
const accUsage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 }
```

**1d. Streaming chunk.usage 處理（L593-598）**
追加一段：
```ts
if (typeof chunk.usage.prompt_tokens_details?.cached_tokens === 'number') {
  accUsage.cache_read_input_tokens = chunk.usage.prompt_tokens_details.cached_tokens
}
```

**1e. Streaming message_delta（L635-641）**
把 `usage: { output_tokens: accUsage.output_tokens }` 擴充：
```ts
usage: {
  output_tokens: accUsage.output_tokens,
  input_tokens: accUsage.input_tokens,
  cache_read_input_tokens: accUsage.cache_read_input_tokens,
  cache_creation_input_tokens: 0,
},
```
> 注：原本 message_delta 只送 `output_tokens` 是 Anthropic 規格所允許的 minimal 形式，但補上 input_tokens / cache_* 不會破壞既有 `updateUsage()` 邏輯（`claude.ts:2911-2974` 對每個欄位都有 `> 0 ? 新值 : 舊值` 的護欄）。

**1f. Streaming message_start（L453-468）也可選擇性補**
目前 `usage: { input_tokens: 0, output_tokens: 0 }` 是安全初值；保持不動，由 message_delta 提供最終值即可。

### 2. 驗證 TUI 讀取鏈不需改動

| 下游檔案 | 現況 |
|---------|------|
| `src/services/api/claude.ts:2911-2974` `updateUsage()` | 對 `cache_read_input_tokens > 0` 有 update 邏輯，新值會覆蓋 |
| `src/cost-tracker.ts:250-276` `addToTotalModelUsage` L268 | `modelUsage.cacheReadInputTokens += usage.cache_read_input_tokens ?? 0` 已正確累加 |
| `src/cost-tracker.ts:181-226` `formatModelUsage` L217 | `formatNumber(usage.cacheReadInputTokens)` 顯示 — 值變了會自動刷新 |
| `src/bootstrap/state.ts:709` `getTotalCacheReadInputTokens()` | `sumBy` 聚合 — 值變了會自動刷新 |

無需動這些檔案。

## 關鍵檔案

- `src/services/api/llamacpp-fetch-adapter.ts` — 唯一要修改的檔案（5 處小改）
- `src/services/api/claude.ts` — **只讀**，確認 `updateUsage()` 行為（已知 OK）
- `src/cost-tracker.ts` — **只讀**，確認下游聚合/顯示
- `src/bootstrap/state.ts` — **只讀**，確認 state getter

## 可重用的既有程式碼

| 既有 util | 位置 | 用途 |
|-----------|------|------|
| OpenAI `usage` 既有抽取（prompt_tokens / completion_tokens） | `llamacpp-fetch-adapter.ts:346-347, 593-598` | 同一條 code path 只要加 `cached_tokens` 平行處理 |
| `updateUsage()` 的 `> 0` 護欄 | `claude.ts:2911-2974` | 新值若為 0 不會覆蓋舊值，天然 forward-compatible |

## 驗證計畫

### 單元驗證（快）
1. `bun run typecheck` baseline 不變（僅 TS5101）。
2. 人工檢查新程式碼：`cache_read_input_tokens` 在非 stream / stream 兩條 path 都被正確讀出。

### 端對端 smoke（真模型）
1. 啟動 llama-server（專案 `.cache/llama-serve.log` 背景任務；記憶說「由 Claude Code 啟動」）。
2. 跑 `./cli -p "hello, what is 2+2"` 或互動模式問幾輪問題讓 prompt cache 命中。
3. 在 session 內呼叫 `/cost`（或結束後看摘要）：
   - **預期**：`cache read` 欄位顯示 > 0（第一輪可能仍 0，第二輪起應非 0）。
   - `cache write` 欄位仍為 0（llamacpp 無此概念，正確）。
4. 用 `curl` 直打 llama-server 驗證 response 結構：
   ```bash
   curl -s http://127.0.0.1:8080/v1/chat/completions \
     -H 'Content-Type: application/json' \
     -d '{"model":"qwen3.5-9b-neo","messages":[{"role":"user","content":"hi"}]}' \
     | jq '.usage'
   ```
   若看到 `prompt_tokens_details.cached_tokens`，adapter 改動就會生效。若看不到（舊版 llama.cpp），改動仍安全（`?? 0` fallback）。

### 回歸驗證
- Anthropic path（`src/services/api/client.ts` + `src/services/api/claude.ts` 原生 fetch）未被觸及，不會退步。
- 不動 TUI，既有 `/cost` 版面一致。

## 風險與緩解

| 風險 | 緩解 |
|------|------|
| llama.cpp 舊版不回 `prompt_tokens_details` | `?? 0` fallback，等同現況 |
| 使用者關閉 llama.cpp 的 prompt caching（`--no-prefix-caching`） | 值為 0 時 `updateUsage` 不覆蓋舊值；顯示結果仍對 |
| OpenAI SDK 型別與 llama.cpp 擴充欄位衝突 | 我們自己的 `OpenAIChatCompletion` / `OpenAIStreamChunk` 介面是 narrow 自訂，不走 openai SDK 型別；加欄位是 additive safe |
| message_delta 多補 `input_tokens` 導致 Anthropic SDK parser 報錯 | `updateUsage()` 接受這些欄位；Anthropic SDK 本身 `MessageDeltaEvent.usage` 型別允許全欄位（只是多數 provider 只送 output_tokens） |

## 明確不做的事

- 不改 TUI 格式 / label（用「—」取代 0 之類的 UI 調整）
- 不新增 `cache_creation_input_tokens` 偽值（語意不符 Anthropic 規格會誤導成本計算）
- 不動 Anthropic 原生 path
- 不動 `updateUsage` 與 `addToTotalModelUsage` 既有 `?? 0` / `> 0` 護欄
- 不動 cost/pricing table（本地模型 cost = 0 保持）
- 不寫新測試（改動點極小、回歸靠 typecheck + 真模型 smoke）
