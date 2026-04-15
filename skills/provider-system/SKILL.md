# Provider 系統設計

## 說明

`src/services/providers/` 中多 provider 抽象層的設計指南。M1 里程碑實作時載入此 skill。

本 skill 整合兩份摸底：
- `skills/freecode-architecture/SKILL.md` — free-code 現有 API 層的實測事實
- 下方「Hermes 借鑑」段 — 對 `reference/hermes-agent/hermes_cli/auth.py` 與 `agent/auxiliary_client.py` 的設計概念摘要

## 工具集

file

---

## 核心設計原則（ADR-002 + ADR-005）

1. **不改核心**：`QueryEngine.ts`、`Tool.ts`、`claude.ts` 都不動。
2. **Provider 產出 Anthropic 形狀 stream event**：轉譯邏輯藏在 provider 內部，下游主幹無感。
3. **現有 `getAnthropicClient()` 不拆掉**：新 provider 只是多一條分支。
4. **新 provider 程式碼只放 `src/services/providers/`**；`src/services/api/` 不擴充（例外：若決定走 fetch adapter 路徑，可能需要新增 `src/services/api/llamacpp-fetch-adapter.ts` 以對齊既有 `codex-fetch-adapter.ts` 的檔案歸屬）。

---

## 兩條實作路徑（M1 階段二開工前決策）

### 路徑 A：新建 Provider 層（原 plan）
```
QueryEngine → query.ts → provider.sendMessageStream()
                         ├── AnthropicProvider → 既有 claude.ts
                         └── LlamaCppProvider → 自寫 SSE 解析 + 轉譯
```
需要：`types.ts`、`index.ts`、`anthropicAdapter.ts`、`llamaCpp.ts`、`toolCallTranslator.ts`。
工作量：大。架構乾淨、未來擴充友善。

### 路徑 B：Fetch Adapter（仿 codex-fetch-adapter.ts）
```
QueryEngine → query.ts → claude.ts → new Anthropic({ fetch: llamaCppFetch })
                                             ↓
                                  llamaCppFetch 攔截並翻譯
```
需要：`llamacpp-fetch-adapter.ts`（參照 `codex-fetch-adapter.ts` 812 行模板）＋`client.ts` 加一條分支。
工作量：小。`claude.ts` 完全無感，翻譯層集中在一處。
風險：Anthropic SDK 對非原生 response shape 的容忍度需實測。

**M1 階段二開工前由人類決定**。

---

## Provider 介面草稿（路徑 A 用）

若走路徑 A，`src/services/providers/types.ts` 的雛形：

```typescript
// 事件形狀借用 Anthropic SDK（free-code 既有下游依賴的格式）
import type { BetaRawMessageStreamEvent, BetaMessage } from '@anthropic-ai/sdk/resources/beta'

export interface Provider {
  readonly id: string                         // 'anthropic' | 'llamacpp' | ...
  readonly capabilities: ProviderCapabilities

  sendMessageStream(params: MessageParams): AsyncIterable<StreamYield>
  listModels(): Promise<ModelInfo[]>
  validateConnection(): Promise<boolean>
}

export interface ProviderCapabilities {
  streaming: boolean
  tools: boolean
  vision: boolean
  thinking: boolean
  promptCaching: boolean
}

// 與 claude.ts 的 yield 一致（L2301–2302）
export type StreamYield =
  | { type: 'stream_event'; event: BetaRawMessageStreamEvent; ttftMs?: number }
  | AssistantMessage
  | SystemAPIErrorMessage
```

**關鍵**：`StreamEvent` **直接沿用** `BetaRawMessageStreamEvent`，不自己發明通用格式 — QueryEngine 就是吃這個 schema（已在 `skills/freecode-architecture` 驗證）。

---

## ProviderConfig 結構（借鑑 Hermes）

不論走路徑 A 還是 B，都需要把 provider 設定資料結構化。**借鑑 Hermes `auth.py` 的 `ProviderConfig` dataclass**：

```typescript
export interface ProviderConfig {
  id: string                                  // 'anthropic' | 'llamacpp'
  name: string                                // 'Anthropic' | 'llama.cpp local'
  authType: 'api_key' | 'oauth' | 'none'     // llamacpp 是 'none'
  inferenceBaseUrl: string                    // 'http://127.0.0.1:8080/v1'
  apiKeyEnvVars?: readonly string[]           // 依序檢查的 env var
  baseUrlEnvVar?: string                      // 覆蓋 base URL 的 env var，如 'LLAMA_BASE_URL'
  defaultModel?: string                       // 'qwen3.5-9b-neo'
  apiMode: 'anthropic_messages' | 'chat_completions'  // 驅動翻譯行為
  capabilities: ProviderCapabilities
  extra?: Record<string, unknown>             // 未來擴充
}
```

**關鍵 Hermes 借鑑點**：
1. **`apiMode` 作為中樞**：Hermes 用 `TRANSPORT_TO_API_MODE` dict 決定哪個 SDK／翻譯器，我們沿用同一思路。
2. **`apiKeyEnvVars` 用 tuple/readonly array**：支援多個 env var（例：先查 `LLAMA_API_KEY`、再查 `OPENAI_API_KEY` 當 fallback），使用者彈性高。
3. **`baseUrlEnvVar` 單欄位**：讓使用者覆蓋預設 URL 不需改 code。
4. **`extra` 欄位**：未來加新欄位不破壞舊 config。

**暫不借鑑**：Hermes 的 `HERMES_OVERLAYS`（109+ provider 清單）、`models.dev` 整合、credential pool、OAuth device flow。M1 只需 anthropic + llamacpp 兩個。

---

## 註冊表

```typescript
export const PROVIDER_REGISTRY: Record<string, ProviderConfig> = {
  anthropic: { id: 'anthropic', ..., apiMode: 'anthropic_messages' },
  llamacpp:  { id: 'llamacpp',  ..., apiMode: 'chat_completions',
               inferenceBaseUrl: 'http://127.0.0.1:8080/v1',
               baseUrlEnvVar: 'LLAMA_BASE_URL',
               defaultModel: 'qwen3.5-9b-neo' },
} as const

export function getProvider(id: string): Provider { ... }
export function resolveProviderFromModel(modelName: string): Provider { ... }
```

`resolveProviderFromModel` 的邏輯：看 model 名稱判斷（`qwen*` → llamacpp、`claude*` → anthropic），或檢查 `CLAUDE_CODE_USE_*` env 一致性。

---

## 整合切點

依 `skills/freecode-architecture/SKILL.md` 的硬約束：

| 檔案 | 動作 | 備註 |
|------|------|------|
| `src/services/api/client.ts` L306–321 | 新增 `if (apiMode === 'chat_completions')` 分支，塞 `llamaCppFetch` | 路徑 B 才動；路徑 A 不動 |
| `src/services/providers/*` | 全新建立 | 路徑 A 才需完整架構；路徑 B 只需一個薄薄的 `index.ts` |
| `src/utils/model/providers.ts` | 確認 `'openai'` 聯集值足夠，或改名為 `'llamacpp'`？ | 需小心不破壞現有 Bedrock/Vertex/Foundry/Codex 的 env flag 行為 |
| `src/utils/model/model.ts` | 加 `qwen3.5-9b-neo` 到 `modelStrings.ts` 並讓優先級解析認得 | 階段五工作 |
| `src/bootstrap/state.ts` | 啟動時讀 `LLAMA_BASE_URL`、`LLAMA_MODEL` env | 階段五工作 |

**不改**：`QueryEngine.ts`、`Tool.ts`、`claude.ts`、`StreamingToolExecutor.ts`、`src/tools/*`、`src/services/tools/*`。

---

## 設定方式（M1 決定）

三選一讓人類決策：

| 做法 | 範例 | 優點 | 缺點 |
|------|------|------|------|
| **A. 環境變數**（類似 Bedrock/Vertex）| `LLAMA_BASE_URL=http://127.0.0.1:8080/v1 ./cli` | 沿用既有慣例、零新 CLI 介面 | 環境變數常被遺忘 |
| **B. CLI flag** | `./cli --provider llamacpp --model qwen3.5-9b-neo` | 顯式、容易紀錄到腳本 | 新增 flag 要改 commander 設定 |
| **C. settings.json** | `{"provider":"llamacpp","llamacpp":{"baseUrl":...}}` | 永續、可分享 | 最重的做法，修改 settings 邏輯 |

**建議**（可改）：A + B 組合。環境變數作 default，CLI flag 臨時覆寫。settings.json 支援先不做（M1 範圍控制）。

---

## 錯誤情境（llama.cpp-specific）

1. **server 沒跑** → `ECONNREFUSED on http://127.0.0.1:8080/v1`，錯誤訊息明示「請執行 `bash scripts/llama/serve.sh`」
2. **模型名錯** → llama-server 回 404 `Model not found`，透傳
3. **Context 超限** → llama-server 回 `finish_reason: length`，provider 翻成 `stop_reason: 'max_tokens'`（ADR-005 要求的一致行為）
4. **tool call JSON parse 失敗** → log + 回傳錯誤訊息給 LLM 讓它重試
5. **串流中斷** → 沿用 `withRetry.ts` 既有機制（路徑 B 自動繼承；路徑 A 需自寫 fallback）

---

## 參考

- free-code API 層：`skills/freecode-architecture/SKILL.md`
- Hermes 原始碼：`reference/hermes-agent/hermes_cli/auth.py`（ProviderConfig dataclass 模板）、`agent/auxiliary_client.py`（`resolve_provider_client()` + adapter pattern）、`agent/anthropic_adapter.py`（OpenAI → Anthropic 翻譯）
- free-code 既有翻譯器範例：`src/services/api/codex-fetch-adapter.ts`（812 行）
- ADR：CLAUDE.md 的 ADR-001（推翻）、ADR-002、ADR-005、ADR-006
- TODO.md 當前 M1 階段一剩餘任務
