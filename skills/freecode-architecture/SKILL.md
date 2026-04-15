# free-code 架構導覽

## 說明

free-code（Claude Code fork）核心程式碼地圖，重點是 **API/provider 層**與**串流/工具呼叫主幹**。M1 實作 llama.cpp provider 時必讀。本文件的所有「事實」都註明行號，2026-04-15 在 commit `536e56a` 之後實測。

## 工具集

file, grep

---

## 執行環境與建構（快速摘要）

- 執行環境：**Bun**（不是 Node.js）；UI 是 **React + Ink**（`.tsx`）
- 進入點：`src/main.tsx` → Commander CLI → `src/screens/REPL.tsx`
- 建構：`scripts/build.ts`（處理 `feature('FLAG')` 編譯時 flag）→ `bun build` → 單一 `./cli` 二進位
- 測試：`bun run typecheck`、`bun test`

---

## API 層實測事實

### `src/services/api/client.ts`（422 行）— 客戶端工廠

只有一個對外函數 `getAnthropicClient()`（L96）。**內部依據環境變數分五條路**，回傳型別都是 `Anthropic`（SDK 類別）：

| 條件 | 分支 | 實際回傳 | 行號 |
|------|------|---------|------|
| `CLAUDE_CODE_USE_BEDROCK=true` | `AnthropicBedrock`（動態 import `@anthropic-ai/bedrock-sdk`）| 轉型為 `Anthropic` | L161–198 |
| `CLAUDE_CODE_USE_FOUNDRY=true` | `AnthropicFoundry`（Azure）| 轉型為 `Anthropic` | L199–228 |
| `CLAUDE_CODE_USE_VERTEX=true` | `AnthropicVertex`（GCP）| 轉型為 `Anthropic` | L229–306 |
| `isCodexSubscriber()` + Codex OAuth | `new Anthropic({ fetch: codexFetch, ... })`（**fetch adapter 把 SDK 呼叫轉譯到 ChatGPT Codex backend**）| 原生 Anthropic 類別 | L308–321 |
| fallback | `new Anthropic({ apiKey, authToken, ... })` | firstParty | L323–338 |

**關鍵發現：Codex 那條路用 fetch adapter 做 Anthropic ↔ OpenAI 翻譯**（見下節）。這是 llama.cpp provider 最短路徑的現成先例。

### `src/services/api/codex-fetch-adapter.ts`（812 行）— **Anthropic ↔ OpenAI 翻譯層現成實作**

`createCodexFetch(accessToken)`（L746）回傳一個 `fetch`-shaped function，塞進 `new Anthropic({ fetch: ... })` 就能把 SDK 的 Messages API 呼叫翻譯到 OpenAI Responses API。內部已處理：
- 訊息格式（user/assistant/system → instructions）
- 工具定義（Anthropic `input_schema` ↔ OpenAI `parameters`）
- 工具呼叫（`tool_use` ↔ `function_call`、`tool_result` ↔ `function_call_output`）
- **串流事件翻譯**

端點寫死在 L15 的註解：`https://chatgpt.com/backend-api/codex/responses`。llama.cpp provider 可以參照此模式，把 endpoint / auth 改成 `LLAMA_BASE_URL` + 無 auth。

### `src/services/api/claude.ts`（3,419 行）— 查詢引擎

主要對外函數：

| 函數 | 行號 | 用途 |
|------|------|------|
| `queryModelWithStreaming` | - | **主串流 API**，回傳 `AsyncGenerator<StreamEvent \| AssistantMessage \| SystemAPIErrorMessage>` |
| `queryModelWithoutStreaming` | - | 非串流版本（fallback） |
| `queryHaiku` | - | 內部工具快查（Haiku 小模型） |
| `queryWithModel` | - | 通用模型查詢 |
| `updateUsage` | L2924 | 從 `message_delta` 累計 token |
| `accumulateUsage` | L2993 | 跨輪累計 |
| `cleanupStream` | - | 釋放串流資源 |

**呼叫鏈**：`QueryEngine.ts` → `query.ts` → `query/deps.ts` → `queryModelWithStreaming`。QueryEngine **不直接** `import` claude.ts 的 query 函數；只 import `updateUsage`/`accumulateUsage`。

**串流事件是透明轉發**（L2301–2302）：
```ts
yield {
  type: 'stream_event',
  event: part,  // 原始 BetaRawMessageStreamEvent，未加工
  ...(part.type === 'message_start' ? { ttftMs } : undefined)
}
```
下游（`QueryEngine`、`StreamingToolExecutor`）吃的是原始 Anthropic SDK event 型別。**所以 provider 層必須產出 Anthropic schema 的 stream event。**

**處理的 Anthropic stream event 類型（在 claude.ts 內切換）**：
- `message_start`（L1980）— 初始化 partial message + usage
- `content_block_start`（L1995）— text / tool_use / thinking block 開頭
- `content_block_delta`（L2053）— 文字或 tool_use input 增量
- `message_delta`（L2213）— 更新 usage + stop_reason
- `message_stop`（L2295）— 無操作，僅標記結束

**Provider 分支**（全部是 Bedrock vs firstParty 的行為調整，無 OpenAI 分支）：
- L397：1H prompt caching 開關（Bedrock 條件）
- L1058：Bedrock application-inference-profile
- L1178：tool search header（firstParty only）
- L1551：Bedrock 額外 betas
- L1814：firstParty base URL 檢查

### `src/services/api/withRetry.ts`（822 行）與 `errors.ts`（1,207 行）

withRetry 被 claude.ts 在 L1778（主串流）、L843（非串流 fallback）、L544 引用。處理 429 / 5xx / 網路錯誤 → 指數退避。串流中斷會觸發非串流 fallback（L2465）。

---

## `src/utils/model/providers.ts`（43 行）— provider 偵測

```ts
export type APIProvider = 'firstParty' | 'bedrock' | 'vertex' | 'foundry' | 'openai'

export function getAPIProvider(): APIProvider {
  // 依序檢查 CLAUDE_CODE_USE_BEDROCK / VERTEX / FOUNDRY / OPENAI
  // 都否 → 'firstParty'
}
```

**`'openai'` 值已存在但沒實際對應程式碼**。M1 可以直接沿用這個 enum 值給 llama.cpp。

`isFirstPartyAnthropicBaseUrl()`（L27）檢查 `ANTHROPIC_BASE_URL` 是否指向 `api.anthropic.com`（或內部 staging）— 用來決定是否注入 request id 等 first-party-only 的行為。

---

## QueryEngine 與 StreamingToolExecutor 的硬耦合

**不能改**（`.claude/settings.json` deny list）：
- `src/QueryEngine.ts`（1,295 行）— 在第 788–828 行直接處理 `stream_event`，讀 `event.message.usage`、`event.delta.stop_reason` 等 Anthropic 特定欄位
- `src/Tool.ts`（792 行）— Tool 基礎介面

**可改但要謹慎**：
- `src/services/tools/StreamingToolExecutor.ts`（530 行）— `addTool(block: ToolUseBlock, ...)` 直接吃 `@anthropic-ai/sdk` 的 `ToolUseBlock` 型別
- `src/services/tools/toolExecution.ts`（1,745 行）— 工具生命週期

**架構含意**：provider 層必須在邊界**產出 Anthropic 形狀的 stream event**，下游主幹無感。實作路徑有兩條：
1. **新建 provider 層**（原 plan 寫的）— 在 `src/services/providers/` 從零寫
2. **沿用 fetch adapter 模式**（codex-fetch-adapter.ts 的精神）— 寫 `llamacpp-fetch-adapter.ts`，塞給 `new Anthropic({ fetch: ... })`，免改 QueryEngine/claude.ts 任何邏輯

路徑 2 的工作量可能只有路徑 1 的 30–50%，但需評估 Anthropic SDK 對非 Anthropic response shape 的容忍度。**這是 M1 階段二開工前必須做的架構決策**。

---

## 工具系統（與 provider 無直接關係，供背景理解）

- `src/tools.ts`（389 行）— 工具註冊表，用 `feature('FLAG')` 做編譯時開關
- 每個工具：`src/tools/{name}/` 含 `{name}.tsx`、`UI.tsx`、`prompt.ts`、安全性檔
- `src/services/tools/` 四檔共 ~3,100 行：`StreamingToolExecutor`、`toolExecution`、`toolHooks`、`toolOrchestration`

工具 I/O 型別都直接沿用 `@anthropic-ai/sdk` 的 `ToolUseBlock` / `ToolResultBlockParam`。M1 的 toolCallTranslator 只需處理「出站（發送到 OpenAI endpoint 前翻譯）+ 入站（SSE chunks 拼回 Anthropic ToolUseBlock）」兩個方向。

---

## 模型選擇

- `--model` flag → `src/bootstrap/state.ts` 的 `getMainLoopModelOverride()`
- `/model` 指令：`src/commands/model/`
- 模型名全 hardcode 在 `src/utils/model/modelStrings.ts`（`opus46`、`sonnet46`、`haiku45` 等）
- 優先級（在 `src/utils/model/model.ts` 的 `getMainLoopModel()`）：
  1. `/model` session override
  2. `--model` flag
  3. `ANTHROPIC_MODEL` env
  4. settings
  5. default（預設 Sonnet 4.6）
- `ANTHROPIC_BASE_URL` 可覆蓋 API endpoint（但 firstParty 行為只認 `api.anthropic.com`）

---

## 新增 Provider 程式碼的放置

依 ADR-002：所有 provider 程式碼放 `src/services/providers/`，不改 `src/services/api/`。

```
src/services/providers/       ← 尚不存在，M1 階段一建立
├── types.ts
├── index.ts                  # 工廠 + 註冊表
├── anthropicAdapter.ts       # 薄包既有 api/claude.ts
├── llamaCpp.ts               # 新 provider（或 llamacpp-fetch-adapter.ts）
└── toolCallTranslator.ts     # （如果走 fetch adapter 路徑可能不需要，因為 codex 已經有）
```

整合點（**都是擴充，不要重寫**）：
1. `src/utils/model/providers.ts` — 新增 `'llamacpp'` 到 `APIProvider` 聯集（或沿用 `'openai'`）
2. `src/services/api/client.ts` — 在 L306 之後加新分支（llama.cpp 用 fetch adapter 路徑最乾淨）
3. `src/utils/model/model.ts` — 在 modelStrings 加 `qwen3.5-9b-neo` 別名
4. `src/bootstrap/state.ts` — 啟動時讀 `LLAMA_BASE_URL` / `LLAMA_MODEL` env

---

## 不要動的關鍵目錄（複雜、緊密耦合）

| 目錄 | 大小 | 為什麼別動 |
|------|------|-----------|
| `src/bridge/` | 479KB | IDE 整合橋接 |
| `src/utils/swarm/` | 277KB | 多 agent swarm |
| `src/utils/permissions/` | 321KB | 權限模型 |
| `src/hooks/` | 1.3MB | 104 個 React hooks |
| `src/components/` | 9.5MB | 完整 UI 元件庫 |
| `src/ink/` | 1.1MB | 自訂 Ink fork |

## 參考

- 源頭檔案：`src/services/api/{client,claude,codex-fetch-adapter,withRetry,errors}.ts`
- Provider 偵測：`src/utils/model/providers.ts`
- 硬耦合點：`src/QueryEngine.ts:788-828`
- 相關 skill：`skills/hermes-architecture/`（Hermes provider 設計參考）、`skills/provider-system/`、`skills/tool-call-adapter/`
- 專案根 `CLAUDE.md` 的 ADR 章節（特別是 ADR-001 推翻與 ADR-005 新制）
