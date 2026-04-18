# M1 里程碑：llama.cpp 本地模型支援（路徑 B — fetch adapter）

## Context

原 M1「透過 LiteLLM proxy 支援本地模型」路線（ADR-001）已推翻，改成直接連接專案內跑的 llama.cpp server（`http://127.0.0.1:8080/v1`，OpenAI 相容，model alias `qwen3.5-9b-neo`）。經 2026-04-15 的 PoC 驗證（commit `b2af143`），確認採用 **路徑 B（fetch adapter）**：仿 `src/services/api/codex-fetch-adapter.ts` 模式，寫 `llamacpp-fetch-adapter.ts`，塞給 `new Anthropic({ fetch })`，翻譯層集中一處，`claude.ts` / `QueryEngine.ts` / `StreamingToolExecutor.ts` **零修改**。

## 為什麼路徑 B

| 路徑 | 做法 | 工作量 | 狀態 |
|------|------|--------|------|
| ~~A. 新 Provider 層~~ | 在 `src/services/providers/` 從零建 types / registry / Anthropic adapter / llama.cpp provider / tool translator | 大（~820 行） | **棄用** |
| **B. fetch adapter** | 寫 `src/services/api/llamacpp-fetch-adapter.ts`、`client.ts` 加一條分支、`providers.ts` 加 env 判斷 | 中（~440 行） | **採用** |

路徑 B 的技術可行性已由 `scripts/poc/llamacpp-fetch-poc.ts` 端到端證實：Anthropic SDK 對翻譯後的 Anthropic-shape 回應無額外 validation，`thinking` content block 原生支援，`usage` 欄位 SDK 只讀必要欄位。

## 核心事實（摸底結果）

- `src/services/api/codex-fetch-adapter.ts`（812 行）已是現成 Anthropic ↔ OpenAI 翻譯層範本，處理訊息格式、工具呼叫、串流事件翻譯，端點寫死在 ChatGPT Codex。
- `src/services/api/client.ts` L308–321 已有「Codex subscriber → `new Anthropic({ fetch: codexFetch })`」的現成分支可仿。
- `src/services/api/claude.ts` 的串流事件是**透明轉發**原始 `BetaRawMessageStreamEvent`（L2301–2302），所以 adapter 必須產出 Anthropic-shape SSE。
- `src/utils/model/providers.ts` 的 `APIProvider` 聯集已有 `'openai'` 值但無對應路徑；可新增 `'llamacpp'` 或沿用 `'openai'`。
- `src/QueryEngine.ts`、`src/Tool.ts` 在 `.claude/settings.json` deny list，**不能改**。路徑 B 本來就不改這兩個檔案。
- Qwen3.5-Neo 回應把 CoT 放 `reasoning_content`、答案放 `content`（LESSONS.md 記錄、PoC 已驗證映射成 `thinking` block 可行）。

詳細摸底見 `skills/freecode-architecture/SKILL.md` 與 `skills/provider-system/SKILL.md`。

## 新 M1 任務結構

### 階段一：摸底與可行性驗證
- [x] 閱讀並記錄 free-code 現有 API 架構的實測事實 — 寫入 `skills/freecode-architecture/SKILL.md`。【2026-04-15 commit `e5ea9f2`；關鍵發現：`codex-fetch-adapter.ts` 是現成範本】
- [x] 閱讀 Hermes `auth.py` + `auxiliary_client.py`，取 ProviderConfig / apiMode / env 優先鏈設計概念 — 寫入 `skills/provider-system/SKILL.md`。【2026-04-15 commit `fa03174`】
- [x] PoC：路徑 B 可行性驗證 — `scripts/poc/llamacpp-fetch-poc.ts` 端到端測試通過。【2026-04-15 commit `b2af143`】
- [x] 架構決策：確定走路徑 B，棄路徑 A。
- [x] 驗證：`bun run typecheck` 在當前 main 上仍通過（建立實作前的綠燈基準）— exit 0，僅 `tsconfig.json:10` `baseUrl` 一條 TS5101 deprecation warning，無實際 code 錯誤。同步把 `typecheck` 加進 `package.json`（原本缺）。

### 階段二：`llamacpp-fetch-adapter.ts` 實作（non-streaming 先行）
- [ ] 建立 `src/services/api/llamacpp-fetch-adapter.ts`（仿 `codex-fetch-adapter.ts` 結構）：
  - `createLlamaCppFetch(config)` 回傳 fetch 介面
  - 攔截 `/v1/messages`，其他請求透傳
  - 請求翻譯：Anthropic MessagesCreate → OpenAI ChatCompletion（system / user / assistant、max_tokens、temperature）
  - 回應翻譯：OpenAI ChatCompletion → Anthropic BetaMessage JSON，包進 `new Response(...)` 回給 SDK
  - `reasoning_content` → `thinking` content block（ADR-006）
  - `finish_reason` → `stop_reason` 映射（`stop→end_turn` / `length→max_tokens` / `tool_calls→tool_use`）
- [ ] 修改 `src/services/api/client.ts`：在 Codex 分支前加 llamacpp 分支，`new Anthropic({ apiKey:'llamacpp-placeholder', fetch: llamaCppFetch })`。
- [ ] 修改 `src/utils/model/providers.ts`：支援 `CLAUDE_CODE_USE_LLAMACPP` 或 `LLAMA_BASE_URL` 存在時的分流。
- [ ] 新增環境變數 `LLAMA_BASE_URL`（預設 `http://127.0.0.1:8080/v1`）與 `LLAMA_MODEL`（預設 `qwen3.5-9b-neo`）。
- [ ] 驗證：`LLAMA_BASE_URL=... ANTHROPIC_API_KEY=dummy ./cli -p "hi"` 單次 non-streaming 回答正確。

### 階段三：串流（SSE）翻譯
- [ ] 在 adapter 中實作 streaming 路徑：`stream: true` 時翻譯 OpenAI SSE → Anthropic SSE（`message_start` / `content_block_start` / `content_block_delta` / `content_block_stop` / `message_delta` / `message_stop`）。
- [ ] `reasoning_content` delta 映射到 `thinking_delta`（需驗證 SDK 是否認得這個 delta type；若不認，用 text_delta + 標記）。
- [ ] `finish_reason=length` 邊界：轉成 `message_delta.stop_reason='max_tokens'`。
- [ ] CLI 串流實測：`./cli --model qwen3.5-9b-neo -p "寫一個 fibonacci"`，文字逐字出現。

### 階段四：工具呼叫翻譯
- [ ] Adapter 加 tool 翻譯：
  - 出站：Anthropic `tools[{name, input_schema}]` → OpenAI `tools[{type:'function', function:{name, parameters}}]`
  - 入站 non-streaming：OpenAI `tool_calls` → Anthropic `ToolUseBlock`
  - 入站 streaming：`tool_calls.arguments` 切多 chunk → 累積後輸出 `content_block_delta.input_json_delta`
  - `tool_result` 對話歷史：Anthropic `tool_result` → OpenAI `role:'tool'` message
- [ ] 建立 `tests/integration/TOOL_TEST_RESULTS.md` 骨架（39 個工具一張表）。
- [ ] 前五個核心工具（Bash/Read/Write/Edit/Glob）端到端測試，記錄 (a)(b)(c)(d)。
- [ ] 其餘 34 個工具分批補完。
- [ ] 修復翻譯 bug（只動 adapter，不改 `Tool.ts`）。

### 階段五：設定與使用者體驗
- [ ] `src/utils/model/model.ts`：優先級解析認得 `qwen3.5-9b-neo` 別名，自動啟用 llama.cpp 分支。
- [ ] `/model` 指令：llama.cpp 模型與 Anthropic 模型並列。
- [ ] server 不可用降級：adapter 偵測 `fetch` 失敗（ECONNREFUSED）時回傳清楚錯誤（指示執行 `bash scripts/llama/serve.sh`），不 crash。
- [ ] 啟動橫幅顯示已連接 provider。

### 完成標準
- [ ] `./cli --model qwen3.5-9b-neo -p "hello"` 成功串流輸出；log 顯示連接 `http://127.0.0.1:8080/v1`。
- [ ] 工具呼叫可用：至少 Bash / Read / Write / Edit / Glob 五個核心工具端到端通過。
- [ ] 既有 Anthropic 使用者路徑**完全不受影響**（`ANTHROPIC_API_KEY` 存在、未設 `LLAMA_BASE_URL` 時行為位元級相同）。
- [ ] `tests/integration/TOOL_TEST_RESULTS.md` 記錄 39 個工具結果表格。

## CLAUDE.md ADR 狀態

- ~~ADR-001（LiteLLM）~~ 已推翻（2026-04-15），改為 llama.cpp 直連。
- ADR-002：provider 程式碼仍需放 `src/services/providers/` —— **路徑 B 改寫此 ADR 的解讀**：adapter 是 SDK 擴充而非 provider 抽象，放 `src/services/api/` 與既有 `codex-fetch-adapter.ts` 同目錄更自然。（本 plan 採後者；如需正式改 ADR-002 再另立 ADR-007。）
- ADR-003：新功能直接啟用，不用 feature flag。
- ADR-004：Hermes 只作參考。
- ADR-005：provider 內部做格式翻譯，保持主幹零修改。
- ADR-006：Qwen3.5-Neo 的 `reasoning_content` 映射為 Anthropic `thinking` block（PoC 已驗證）。

## 修改的檔案（路徑 B 完整範圍）

| 檔案 | 改動 | 階段 |
|------|------|------|
| `src/services/api/llamacpp-fetch-adapter.ts` | **新建**（~440 行，參照 codex-fetch-adapter.ts）| 2–4 |
| `src/services/api/client.ts` | L308 前加一條 llamacpp 分支 | 2 |
| `src/utils/model/providers.ts` | 加 env 判斷 / 分流 | 2 |
| `src/utils/model/model.ts` / `modelStrings.ts` | 加 `qwen3.5-9b-neo` 別名 | 5 |
| `src/bootstrap/state.ts` | 讀 `LLAMA_BASE_URL` / `LLAMA_MODEL` | 2 or 5 |
| `tests/integration/TOOL_TEST_RESULTS.md` | **新建**，39 工具表格 | 4 |
| `TODO.md`、`DEPLOYMENT_PLAN.md` | 隨任務完成勾選 | 持續 |

**不動**：`src/QueryEngine.ts`、`src/Tool.ts`、`src/services/api/claude.ts`、`src/services/tools/StreamingToolExecutor.ts`、所有 `src/tools/*`、`src/services/providers/`（路徑 B 根本不建此目錄）。

## 驗證計畫

- 階段二完成後：`LLAMA_BASE_URL=http://127.0.0.1:8080/v1 ANTHROPIC_API_KEY=dummy ./cli -p "hi"` 回文字
- 階段三完成後：`./cli --model qwen3.5-9b-neo -p "寫一個 fibonacci"` 逐字串流
- 階段四完成後：`tests/integration/TOOL_TEST_RESULTS.md` 前五個工具全綠
- 回歸測試：`ANTHROPIC_API_KEY=real-key ./cli -p "hi"` 與修訂前行為位元級相同

## 不在範圍內
- `src/services/providers/` 抽象層（路徑 A 已棄）。
- LiteLLM、Ollama（ADR-001 推翻後不再相關）。
- 核心檔案 QueryEngine.ts / Tool.ts 的修改（deny list）。
- M2–M6 的任何工作（只動 M1）。

---

# M1 階段二實作 plan（2026-04-15 批准；合併原階段二、三）

## Context

M1 階段一全部打勾（commits `e5ea9f2` → `66d2a1a`）。進入階段二寫第一個實質產品碼。

實測發現 `src/services/api/claude.ts:1824` 對主 query 永遠發 `stream: true`，TODO.md 原本「階段二只做 non-streaming、階段三才做 streaming」無法用 `./cli` 驗證。使用者決定**合併原階段二、三**為單一「實作完整串流的階段二」，把純文字串流做到位，`./cli -p "hi"` 端到端可用。工具仍不含（留給合併後的新階段三）。

## 架構決策

### D1 — Provider 偵測：新 env flag
`CLAUDE_CODE_USE_LLAMACPP=true` 啟用。與既有 `CLAUDE_CODE_USE_BEDROCK/VERTEX/FOUNDRY` 風格一致。`APIProvider` 聯集加 `'llamacpp'`。不沿用 `'openai'`（語意混淆 Codex），不靠單獨 `LLAMA_BASE_URL` 隱式啟用（未來 vLLM / sglang 衝突）。

### D2 — Helper 位置
`src/utils/model/providers.ts` 新增 `getLlamaCppConfig(): {baseUrl, model} | null`。不放 `auth.ts`（llamacpp 無 token）。

### D3 — 檔案結構
單一檔案 `src/services/api/llamacpp-fetch-adapter.ts`，預估 400–500 行（non-streaming ~100 + streaming 狀態機 ~250 + helpers ~100）。工具翻譯留 stub 不寫。

### D4 — 型別策略
仿 codex：inline interface，**不 import `@anthropic-ai/sdk` 型別**。邊界乾淨、可獨立單測。
> **註（2026-04-16）**：ADR-007 已將 SDK vendor 至 `src/vendor/my-agent-ai/sdk/`，import 路徑不變。未來若需要可直接 import SDK 型別，不再有 npm 依賴隔離顧慮。

### D5 — Non-streaming 也實作
Haiku 快查走 non-streaming。PoC 已驗證，~100 行可直接移植。

### D6 — `thinking` streaming fallback
Anthropic SDK 對串流 `thinking_delta` 容忍度未驗。主路徑先試；若下游異常，切備援：reasoning 併入 text、加 `<think>...</think>` 包裹，保留可視性但放棄語意分離。階段內決策，不延後。

## 實作步驟

### Step 1 — `src/utils/model/providers.ts` 擴充（43 → ~70 行）

```ts
export type APIProvider = 'firstParty' | 'bedrock' | 'vertex' | 'foundry' | 'openai' | 'llamacpp'

export function getAPIProvider(): APIProvider {
  if (isEnvTruthy(process.env.CLAUDE_CODE_USE_LLAMACPP)) return 'llamacpp'
  // ... 其餘鏈不變
}

export const DEFAULT_LLAMACPP_BASE_URL = 'http://127.0.0.1:8080/v1'
export const DEFAULT_LLAMACPP_MODEL = 'qwen3.5-9b-neo'

export function getLlamaCppConfig(): { baseUrl: string; model: string } | null {
  if (getAPIProvider() !== 'llamacpp') return null
  return {
    baseUrl: process.env.LLAMA_BASE_URL || DEFAULT_LLAMACPP_BASE_URL,
    model: process.env.LLAMA_MODEL || DEFAULT_LLAMACPP_MODEL,
  }
}
```

### Step 2 — `src/services/api/llamacpp-fetch-adapter.ts` 新建

```
// 1. inline 型別（~50 行）：AnthropicContentBlock、AnthropicMessage、
//    OpenAIMessage、OpenAIRequestBody、OpenAIStreamChunk
// 2. 請求翻譯 Anthropic → OpenAI（~80 行）：
//    translateMessagesToOpenAI、translateRequestToOpenAI
// 3a. 回應翻譯 non-streaming（~100 行，從 PoC 移植）：
//    translateChatCompletionToAnthropic
// 3b. 回應翻譯 streaming（~250 行，核心）：
//    translateOpenAIStreamToAnthropicSSE (async generator yielding SSE lines)
// 4. 映射表：FINISH_TO_STOP = {stop:'end_turn', length:'max_tokens', tool_calls:'tool_use'}
// 5. helpers：formatSSE、mkMsgId
// 6. export createLlamaCppFetch(config): typeof globalThis.fetch
```

**串流狀態機變數**：
```
msgStarted: boolean
currentBlockIndex: number (-1 起)
currentBlockType: 'text' | 'thinking' | null
accumulatedUsage: { input_tokens, output_tokens }
finalFinishReason: string | null
```

**每個 OpenAI chunk 處理規則**：
1. 解析 `data: ...\n\n`；`data: [DONE]` 收尾
2. 第一 chunk：emit `message_start`
3. `delta.reasoning_content`：切到 thinking block（必要時先關上一個）；emit `thinking_delta`
4. `delta.content`：切到 text block；emit `text_delta`
5. `delta.tool_calls`：本階段忽略
6. `finish_reason`：記 `finalFinishReason`
7. `usage`：累積
8. 收尾：emit `content_block_stop` + `message_delta` + `message_stop`

**SSE 格式**：`event: <type>\ndata: <json>\n\n`

### Step 3 — `src/services/api/client.ts` 整合

在 L308（Codex 分支前）插入：

```ts
const llamaCppConfig = getLlamaCppConfig()
if (llamaCppConfig) {
  const llamaCppFetch = createLlamaCppFetch(llamaCppConfig)
  return new Anthropic({
    apiKey: 'llamacpp-placeholder',
    ...ARGS,
    fetch: llamaCppFetch as unknown as typeof globalThis.fetch,
    ...(isDebugToStdErr() && { logger: createStderrLogger() }),
  })
}
```

### Step 4 — env 文件
補進 `client.ts` 頂部 JSDoc（L40–79）後方說明 `CLAUDE_CODE_USE_LLAMACPP` / `LLAMA_BASE_URL` / `LLAMA_MODEL`。

### Step 5 — TODO.md 結構對齊
原階段二、三合併為新階段二；原階段四→新三；原階段五→新四；完成標準不動。

## 關鍵檔案參照

| 檔案 | 用途 | 關鍵行號 |
|------|------|---------|
| `src/services/api/codex-fetch-adapter.ts` | 結構範本 | L81–101 型別、L290–735 串流翻譯器、L279–281 formatSSE、L746–812 主 export |
| `src/services/api/client.ts` | 整合切入點 | L40–79 env JSDoc、L308–321 Codex 分支 |
| `src/services/api/claude.ts` | 下游消費者 | L1980–2295 明確處理的 Anthropic SSE 事件類型 |
| `src/utils/model/providers.ts` | provider 偵測 | 整檔 43 行 |
| `scripts/poc/llamacpp-fetch-poc.ts` | Non-streaming 翻譯 | 整檔 190 行，清理移植 |

## 驗證計畫

- **V1 typecheck**：每 Step 後 `bun run typecheck` 必須維持基線（exit 0，只有 tsconfig baseUrl 一條 warning）
- **V2 Non-streaming 回歸**：`bun run scripts/poc/llamacpp-fetch-poc.ts` 通過
- **V3 Streaming 煙測**：新寫 `scripts/poc/llamacpp-streaming-poc.ts`（~60 行），用 SDK `messages.stream()` 對 llama-server 發串流，驗證事件序列：`message_start → content_block_start(thinking) → thinking_delta × N → content_block_stop → content_block_start(text) → text_delta × N → content_block_stop → message_delta → message_stop`
- **V4 `./cli` 端到端**：`CLAUDE_CODE_USE_LLAMACPP=true LLAMA_BASE_URL=... ANTHROPIC_API_KEY=dummy ./cli -p "寫一個 fibonacci"` 逐字串流回應
- **V5 Anthropic 路徑回歸**：未設 `CLAUDE_CODE_USE_LLAMACPP` 時 `./cli -p "hi"` 與修訂前位元級相同
- **V6 `thinking_delta` fallback**：若 V3/V4 SDK 下游異常，切 D6 備援，記入 LESSONS.md

## commit 策略（4–5 個繁中 commit）

1. `feat(providers): 新增 llamacpp APIProvider 值與 getLlamaCppConfig()`（Step 1）
2. `feat(api): llamacpp-fetch-adapter non-streaming 翻譯（請求 + 回應）`（Step 2 前半）
3. `feat(api): llamacpp-fetch-adapter 串流翻譯（純文字 + thinking）`（Step 2 後半）
4. `feat(client): 整合 llama.cpp provider 分支，補 env 文件`（Step 3 + Step 4）
5. `docs(m1): 合併階段二、三，結構對齊純文字串流里程碑`（Step 5）

每 commit 後 V1 + 對應 V2–V4 必須通過。

## 修改檔案範圍

| 檔案 | 動作 | 行數 |
|------|------|------|
| `src/utils/model/providers.ts` | 擴充 | 43 → ~70 |
| `src/services/api/llamacpp-fetch-adapter.ts` | **新建** | 400–500 |
| `src/services/api/client.ts` | 一條分支 + JSDoc | +20 |
| `scripts/poc/llamacpp-streaming-poc.ts` | **新建** | ~60 |
| `TODO.md` / `DEPLOYMENT_PLAN.md` | 階段結構對齊 + 進度同步 | 持續 |

**不動**：QueryEngine.ts / Tool.ts（deny list）、claude.ts、codex-fetch-adapter.ts、services/tools/*、modelStrings.ts（階段四才碰）。

## 不在範圍內（留給合併後新階段三、四）

- 工具呼叫翻譯（含 tool_use↔function_call、streaming argument 累積、tool_result 歷史翻譯）
- ECONNREFUSED 降級訊息
- `/model` 指令、啟動橫幅
- `modelStrings.ts` 新增別名
- `finish_reason=length` 的 CLI 視覺優化
- 病態 reasoning/text 交錯
- 正式 `tests/` integration suite

---

# 手動測試指南（PowerShell；2026-04-15 批准）

M1 完成後的使用者操作手冊。在 PowerShell 執行，**互動模式一律 `bun run dev`**（compiled `.\cli.exe` 在 Windows 進 TUI 會 Bun panic — 已記入 LESSONS.md）。

## 前提（一次性）

```powershell
conda activate aiagent
bun install                          # 若 node_modules 空
bash scripts\llama\setup.sh          # 若 llama\ 或 models\ 空（一次 ~7.3GB）
```

## Step 1 — 啟動 llama-server

```powershell
bash scripts\llama\serve.sh
# 前景執行；Ctrl+C 停。Context 預設 32768。
```
另一個 PS 驗證：
```powershell
curl.exe -sf http://127.0.0.1:8080/v1/models | Select-Object -First 1
```
注意用 `curl.exe`（真 curl），不要 PS 別名的 `curl`（那是 `Invoke-WebRequest`）。

## Step 2 — CLI 啟動

### 互動模式（推薦：走源碼）

```powershell
Remove-Item Env:ANTHROPIC_API_KEY -ErrorAction SilentlyContinue
$env:CLAUDE_CODE_USE_LLAMACPP = "true"
bun run dev
# 或 bun src/entrypoints/cli.tsx
```

或用 --model 別名：
```powershell
Remove-Item Env:ANTHROPIC_API_KEY -ErrorAction SilentlyContinue
bun src/entrypoints/cli.tsx --model qwen3.5-9b-neo
```

互動進去後：
- Logo 下方應看到 `qwen3.5-9b-neo · llama.cpp (local)`（env flag 模式下會顯示）
- `/model` 打開 picker，最下有 `qwen3.5-9b-neo (local)`

### 非互動（`-p`，compiled `.\cli.exe` 可用）

```powershell
Remove-Item Env:ANTHROPIC_API_KEY -ErrorAction SilentlyContinue
.\cli.exe --dangerously-skip-permissions --model qwen3.5-9b-neo -p "你好"
```

## Debug

加 `$env:LLAMA_DEBUG = "1"` 在 stderr 印 adapter 診斷訊息。測完 `Remove-Item Env:LLAMA_DEBUG`。

## 快速驗證 PoC 腳本

| 用途 | 指令 | 預期 |
|------|------|------|
| Non-streaming 煙測 | `bun run scripts\poc\llamacpp-fetch-poc.ts` | `2+2=4` |
| Streaming 煙測 | `bun run scripts\poc\llamacpp-streaming-poc.ts` | thinking+text 雙 block |
| Tool call 煙測 | `bun run scripts\poc\llamacpp-tool-streaming-poc.ts` | tool_use 正確 |
| 前 5 工具翻譯 | `bun run scripts\poc\llamacpp-core-tools-poc.ts` | 5/5 ✓ |
| 34 工具翻譯 | `bun run scripts\poc\llamacpp-rest-tools-poc.ts` | 34/34 ✓ |
| 前 5 工具 E2E（要 Git Bash） | `bash scripts\poc\llamacpp-core-tools-e2e.sh` | 5/5 pass |

## 常見狀況

| 症狀 | 對策 |
|------|------|
| `.\cli.exe` 互動模式 Bun panic / 卡死 | 改用 `bun run dev`（compiled TUI 為 Bun bug） |
| CLI 卡 >30 秒無輸出 | `Remove-Item Env:ANTHROPIC_API_KEY`（dummy key 也會卡 bootstrap） |
| `API Error: 400 ... 未啟動於 ...` | `bash scripts\llama\serve.sh` 起 server |
| `exceeds the available context size` | `$env:LLAMA_CTX = "32768"` 重啟 server |
| `curl` 結果怪 | 用 `curl.exe` 不要 PS 別名 |
| 想切回 Anthropic 官方 | `Remove-Item Env:CLAUDE_CODE_USE_LLAMACPP`；不用 `--model qwen...`；設 `$env:ANTHROPIC_API_KEY = "<真 key>"` |

## Credential 共享待解

free-code 沿用官方 Claude Code 的 `~/.claude/` 路徑，bootstrap 會讀到真實 credentials。暫時隔離法：
```powershell
$env:CLAUDE_CONFIG_DIR = "$env:USERPROFILE\.my-agent-profile"
```
未來可能改為 free-code 預設用 `~/.my-agent/`，由使用者決定後實作。

---

# M2 里程碑：Session Recall & Dynamic Memory（llama.cpp 主場）

**建立日期**：2026-04-15
**狀態**：規劃完成，待執行
**前置條件**：M1 完成（llama.cpp provider 已可用，JSONL transcript 在 llamacpp 路徑下會產出）
**運行情境**：以 **llama.cpp 本地模型（`qwen3.5-9b-neo`）** 為主要設計目標。Anthropic 路徑保留既有 code（黃金規則 #2），但不列為設計考量與驗收門檻。

## Context

讀完 Hermes Agent `tools/memory_tool.py` + `hermes_state.py` + `agent/memory_manager.py` + `agent/context_compressor.py`，對照 free-code 既有 `src/memdir/` + `src/services/SessionMemory/` + `src/services/extractMemories/` + `src/services/compact/` + `src/services/autoDream/`，發現 free-code 已具備 Hermes 大部分功能：

| Hermes | free-code 對應 | 評估 |
|---|---|---|
| MEMORY.md + USER.md | `src/memdir/` 四型分類，各型獨立檔案 + MEMORY.md 索引 | free-code 較優，不倒退 |
| Session-start 凍結 snapshot | `systemPromptSection('memory', ...)` 快取 | 已有 |
| Session 抽取 | `SessionMemory/` + `extractMemories/` | 已有 |
| Context compaction | `services/compact/` pipeline | 已有 |
| 日誌蒸餾 | `services/autoDream/` | 已有 |
| JSONL transcripts | `.claude/projects/{slug}/conversations/*.jsonl` | 已有 |

**Hermes 有、free-code 沒有**只四件：(1) 跨 session 對話搜尋（FTS5 + session_search tool）、(2) query-driven pre-turn prefetch、(3) Provider plugin 抽象層、(4) 專用 MemoryTool。M2 做 (1)(2)(4)；(3) 棄（違反黃金規則 #2，且目前無外部後端需求）。

## 架構決策

### ADR-M2-01：JSONL source of truth，SQLite 只是索引

- 不動 `sessionStorage.ts` 既有寫入流程
- 索引損毀可砍重建
- Hermes 反過來（SQLite 為主）是因為它無先存 JSONL 機制，不是優越設計

### ADR-M2-02：即時 tee + 啟動掃描

- 即時：JSONL append 點 hook，失敗不中斷主流程，降級為 log warning
- 啟動：比對 SQLite 記錄 last_indexed_at 與 JSONL mtime 補漏

### ADR-M2-03：Prefetch 注入 user message 前綴 fence，不碰 system prompt

```
<memory-context>
## 相關歷史對話
[session_id:abc 2026-04-10] ...片段...
## 相關持久記憶
[user] ...topic file 內容...
</memory-context>

<使用者原始 message>
```

保 prefix cache；每輪多 ~2000 tokens 的 user turn 前綴，成本可接受。

### ADR-M2-04（修訂，llamacpp-primary）：memdir re-rank 不用 Anthropic LLM

**原規劃**：沿用 `findRelevantMemories.ts` 的 Sonnet 挑選邏輯
**修訂**：第一版用**非 LLM 方法** — 關鍵字 overlap（query tokens ∩ frontmatter `description` + topic file 首段 tokens），取 top-3。

**理由**：
- llamacpp-primary 原則：不預設 Anthropic 模型可用
- 非 LLM 方法零延遲、零成本，品質對 9B 本地模型情境已夠用
- 若實測品質不足，**才**升級為 llamacpp 呼叫（不回去用 Sonnet）

**預算**：總 ~2000 tokens（FTS 900 + memdir 900 + fence/標題 200），超額截斷。

### ADR-M2-05：MemoryTool 與 Edit/Write 並存

`extractMemories.ts` 的 forked agent 仍走 Edit/Write，不強制。MemoryTool 是主 agent 的受控路徑：
- 原子寫入（temp + rename）
- 檔案鎖（與 forked agent 協調）
- Prompt injection 掃描
- 自動維護 MEMORY.md 索引
- memdir 總量配額提醒

### ADR-M2-06（修訂，llamacpp-primary）：SessionSearch summarize 用 llamacpp

**預設**：回 top-K 片段 + 元資料
**`summarize: true`**：當前 session 主模型（= llamacpp）做摘要

**對 llamacpp 的特殊考量**：
- Qwen3.5-9B Q5_K_M + 32K ctx 下，摘要輸入**先截到 ~8K token** 再送（避免塞爆 context）
- llamacpp 推論慢（58 tok/s）；摘要呼叫需有 timeout，超時 fallback 回純片段模式
- 不加 Sonnet/Haiku 備援路徑（違反 llamacpp-primary）

### ADR-M2-07：SQLite 路徑 `~/.my-agent/projects/{slug}/session-index.db`，用 `bun:sqlite`

走 `~/.my-agent/` 而非 `~/.claude/`，與 free-code 既有 profile 隔離方向一致。

### ADR-M2-08：FTS schema 多存欄位

**sessions**：session_id / started_at / ended_at / model / message_count / first_user_message / total_input_tokens / total_output_tokens / estimated_cost
**messages_fts**（FTS5 virtual）：session_id / message_index / role / timestamp / tool_name / finish_reason / content（FTS）

未來想做 token/成本分析不用 migrate。

### ADR-M2-09：只索引當前 project

跨 project 全域索引延後。

### ADR-M2-10（新增，llamacpp-primary）：驗收情境僅限 llamacpp

- 所有完成標準以 `./cli --model qwen3.5-9b-neo` 為準
- Anthropic 路徑既有 code 保留（不主動破壞），但**不**列為回歸測試項
- 未來若要讓 M2 功能在 Anthropic 路徑也綠，單獨開新任務

## 風險與緩解

| 風險 | 緩解 |
|---|---|
| JSONL append 點不只一個，tee hook 漏 | M2-02 先 grep 盤點所有 append call site |
| SQLite 被其他 free-code 實例鎖 | WAL mode（Hermes 做法） |
| Prefetch 注入點得改 QueryEngine | 先 spike；若真必須碰 QueryEngine 停下來問使用者 |
| MemoryTool 鎖與 forked agent 的 Edit/Write 衝突 | advisory lock（`.lock` 哨兵檔），Edit/Write 不查 lock 但會被 MemoryTool 短暫阻擋 |
| injection scanner 誤殺 | 只拒絕不靜默改寫；寫 false positive test case |
| **llamacpp 摘要慢到主 agent 卡住** | `summarize: true` 加 30s timeout，超時回純片段 |
| **llamacpp context 32K 上限被 summarize 灌爆** | 片段總量先截到 ~8K token 再送 |
| **關鍵字 re-rank 品質對 9B 模型不夠** | 實測若不行，升級為 llamacpp 呼叫（不回去用 Anthropic） |

## 實作路徑概述

詳細任務見 TODO.md 的 M2 階段一～五（共 22 條 + 完成標準）。高階順序：

1. **基建**（M2-01～04）：SQLite schema + tee hook + 啟動掃描
2. **搜尋工具**（M2-05～08）：SessionSearchTool，llamacpp 摘要分支
3. **Prefetch**（M2-09～13）：memoryPrefetch service（關鍵字 re-rank）+ fence 注入
4. **寫入工具**（M2-14～18）：MemoryTool + injection 掃描
5. **收尾**（M2-19～22）：整合測試、llamacpp smoke

## 不在本里程碑範圍

- Memory provider plugin 抽象層（未來若要接 Mem0 / vector DB 再開里程碑）
- 跨 project 全域索引（未來）
- 壓縮鏈 `parent_session_id` tracking（free-code 已有 compact）
- Prompt-injection 靜默改寫 / 自動清洗（只拒絕）
- **Anthropic 路徑下的 M2 功能驗收**（ADR-M2-10：未來另開任務）
# M2-02 計畫 — 將 JSONL 寫入同步 tee 到 session FTS 索引

## 緣由

M2-01 已落地（commits `7e057f5` + `224cf7c`）：SQLite FTS5 索引檔在 `{CLAUDE_CONFIG_HOME}/projects/{slug}/session-index.db`，含：
- `sessions` 表（10 欄 + `parent_session_id`）
- `messages_fts` FTS5 虛擬表（`session_id`/`message_index`/`role`/`timestamp`/`tool_name`/`finish_reason` UNINDEXED + `content` 用 trigram 索引）
- 透過 `src/services/sessionIndex/db.ts` 的 `openSessionIndex(cwd)` 開啟

M2-02 目標：每次訊息被寫進 session JSONL 時，**同步 tee 一份進 SQLite 索引**。JSONL 仍是 source of truth；索引只是衍生快取，可隨時砍掉重建。

**不可妥協的約束**：
- JSONL 仍是 source of truth
- Tee 失敗**絕對不能**中斷主寫入流程
- 不動 `QueryEngine.ts` / `Tool.ts` / `StreamingToolExecutor.ts`（deny list）
- 必須撐得過 session 中途跑 `EnterWorktreeTool` 的情境，索引不能分裂

## 探勘結論

主要寫入漏斗：`SessionStorage.appendEntry()` 在 `src/utils/sessionStorage.ts:1128` → `enqueueWrite()`（line 606，fire-and-forget）→ 100ms debounce 的 `drainWriteQueue()`（line 645）→ `appendToFile()`（line 634）。

所有 `user` / `assistant` / `attachment` / `system` 訊息都在 line 1216 起的 TranscriptMessage 分支收斂。`isNewUuid` 去重已經在 line 1242 完成 — 我們就 hook 在那之後。

同步元資料路徑 `appendEntryToFile()`（line 2572）只處理 UI 狀態（標題 / 標籤 / 模式），**沒有訊息內容**，安全忽略。

已知繞過路徑（記錄下來，延後到 M2-03 的 bulk reconcile 處理）：
- `src/commands/branch/branch.ts:161` 用 `writeFile` 整份寫分叉 session 檔案
- `src/services/PromptSuggestion/speculation.ts:790` 直接寫 `speculation-accept`（非可搜尋內容，優先度低）

## Plan agent 的批評 — 全數吸收

以下六項（兩個 blocker、三個 high、一個 medium）全部融入下方設計：

| # | 問題 | 修法 |
|---|---|---|
| Blocker | `getOriginalCwd()` 在 `EnterWorktreeTool` 會被改 | 改用 `src/bootstrap/state.ts:511` 的 `getProjectRoot()`（明示為 session identity 穩定源） |
| Blocker | `shouldSkipPersistence()` 守衛 | 上游 `appendEntry:1129` 已經處理，我們 hook 在它後面自然繼承守衛，不用另加 |
| High | `SQLITE_BUSY` 可能卡主執行緒最多 1 秒 | 捕捉 `SQLITE_BUSY` → 直接吞掉 return；失去的幾筆讓 M2-03 bulk indexer 補回 |
| High | 不要自己重寫內容抽取 | 重用 `src/utils/messages.ts:2893–2913` 的 `getContentText` / `extractTextContent`，只在外層擴充 tool_use / tool_result / thinking |
| Medium | `branch.ts` 分叉 gap | 文件明載，交給 M2-03 |
| Medium | 跨 replay 的去重 | 新增 shadow 表 `messages_seen(session_id, uuid)` UNIQUE，用 `INSERT OR IGNORE` 把關 |

## 設計

### Schema 升級（`SCHEMA_VERSION` 由 1 升到 2）

FTS5 虛擬表不支援 UNIQUE constraint — 新增一張 shadow 去重表，所有寫入都先過它。

檔案：`src/services/sessionIndex/schema.ts`

```sql
CREATE TABLE IF NOT EXISTS messages_seen (
  session_id TEXT NOT NULL,
  uuid TEXT NOT NULL,
  PRIMARY KEY (session_id, uuid)
);
```

`SCHEMA_VERSION` 從 1 改 2。因為 M2-01 只在開發分支、尚未有實際使用者的索引檔存在，**直接就地加表升級**可接受；在 `db.ts:initializeSchema()` 加一段：若查到 `version=1` 就 `CREATE TABLE IF NOT EXISTS messages_seen`、更新版本為 2。

### 新檔：`src/services/sessionIndex/indexWriter.ts`

```ts
// 同步 bun:sqlite tee。所有錯誤都吞掉。
// 主執行緒效能：一般情境每次呼叫 sub-millisecond。
export function indexEntry(
  entry: TranscriptEntry,
  sessionId: string,
  projectRoot: string,  // 傳 getProjectRoot()，不是 getOriginalCwd()
): void {
  try {
    // 非訊息型別早退
    if (!isMessageBearingType(entry.type)) return
    const uuid = (entry as { uuid?: string }).uuid
    if (!uuid) return  // 防呆：訊息都有 uuid

    const db = openSessionIndex(projectRoot)

    // Shadow 表去重 — INSERT OR IGNORE 若已存在回 0 changes
    const seen = db
      .query('INSERT OR IGNORE INTO messages_seen (session_id, uuid) VALUES (?, ?)')
      .run(sessionId, uuid)
    if (seen.changes === 0) return  // 已索引過，跳過 FTS + sessions 更新

    const content = extractSearchableContent(entry)
    if (!content) return

    const now = Date.now()
    const role = entry.message?.role ?? entry.type
    const toolName = extractToolName(entry)
    const finishReason = (entry.message as { stop_reason?: string })?.stop_reason ?? null

    // 上插 sessions — started_at 只在第一次 INSERT 時設
    db.query(
      `INSERT INTO sessions (session_id, started_at, ended_at, first_user_message, message_count)
       VALUES (?, ?, ?, ?, 1)
       ON CONFLICT(session_id) DO UPDATE SET
         ended_at = excluded.ended_at,
         message_count = sessions.message_count + 1,
         first_user_message = COALESCE(sessions.first_user_message, excluded.first_user_message)`,
    ).run(
      sessionId,
      now,
      now,
      entry.type === 'user' ? content.slice(0, 200) : null,
    )

    // message_index 取當前 message_count（post-increment 後的值）
    const row = db
      .query<{ message_count: number }, [string]>(
        'SELECT message_count FROM sessions WHERE session_id = ?',
      )
      .get(sessionId)

    db.query(
      `INSERT INTO messages_fts (session_id, message_index, role, timestamp, tool_name, finish_reason, content)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      sessionId,
      row?.message_count ?? 0,
      role,
      now,
      toolName,
      finishReason,
      content,
    )
  } catch (err) {
    // SQLITE_BUSY 在多程序競爭時是預期的 — 直接丟（M2-03 bulk indexer 會補）
    // 其他錯誤每次 session 只 log 一次，避免洗版
    if (!isSqliteBusy(err)) logIndexError(err)
  }
}
```

### Hook 呼叫位置（`sessionStorage.ts`）

插在 line 1243–1245（TranscriptMessage 分支，`isNewUuid` 檢查之後）：

```ts
if (isAgentSidechain || isNewUuid) {
  if (!isAgentSidechain) {
    // Fire-and-forget tee 到 FTS 索引。
    // getProjectRoot() 能撐過 EnterWorktreeTool（state.ts:504-513 明示）。
    // indexEntry 內部全 try/catch — 絕對不會拋錯。
    indexEntry(entry, sessionId, getProjectRoot())
  }
  void this.enqueueWrite(targetFile, entry)
  // ... 原有 messageSet.add ...
}
```

Agent sidechain 訊息（`isAgentSidechain === true`）**跳過** — 它們寫到獨立的 `agent-{id}.jsonl`，會讓 session 計數複雜化。未來 M2-05 recall 若感覺不完整再加。

### 內容抽取 helper（`indexWriter.ts` 內）

在 `getContentText` 基礎上擴充 tool_use / tool_result / thinking：

```ts
// 擴充 src/utils/messages.ts 的 getContentText，多處理 tool_use / tool_result / thinking
function extractSearchableContent(entry: TranscriptEntry): string {
  const message = entry.message
  if (!message) return ''
  const content = message.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''

  const parts: string[] = []
  for (const block of content) {
    if (block.type === 'text') parts.push(block.text)
    else if (block.type === 'thinking') parts.push(block.thinking)
    else if (block.type === 'tool_use') {
      parts.push(`[tool:${block.name}] ${JSON.stringify(block.input)}`)
    } else if (block.type === 'tool_result') {
      const rc = block.content
      if (typeof rc === 'string') parts.push(rc)
      else if (Array.isArray(rc)) {
        for (const b of rc) {
          if (b.type === 'text') parts.push(b.text)
        }
      }
    }
  }
  return parts.join('\n').trim()
}

function extractToolName(entry: TranscriptEntry): string | null {
  const content = entry.message?.content
  if (!Array.isArray(content)) return null
  const toolUse = content.find(b => b.type === 'tool_use')
  return toolUse ? (toolUse as { name: string }).name : null
}
```

### 要動的關鍵檔案

- **修改**：`src/services/sessionIndex/schema.ts` — 新增 `messages_seen` 表、`SCHEMA_VERSION` 改 2
- **修改**：`src/services/sessionIndex/db.ts` — `initializeSchema` 加 v1→v2 migration case
- **新增**：`src/services/sessionIndex/indexWriter.ts` — `indexEntry` + 抽取 helper + `SQLITE_BUSY` 識別
- **修改**：`src/services/sessionIndex/index.ts` — 匯出 `indexEntry`
- **修改**：`src/utils/sessionStorage.ts:1243` — 在 TranscriptMessage 分支插 `indexEntry()` 一行
- **修改**：`scripts/poc/session-index-smoke.ts` — 擴充覆蓋新表 + `indexEntry` 流程

### 只讀的關鍵參考檔案（不改）

- `src/bootstrap/state.ts:511` — `getProjectRoot()` 來源
- `src/utils/messages.ts:2893–2913` — 內容抽取邏輯參考
- `src/utils/sessionStorage.ts:1128`, `:960`, `:976` — 理解上下文，不重構

## 驗收方式

1. `conda activate aiagent` 後 `bun run typecheck` — 必須與 baseline 一致（只有 `tsconfig.json:10` 的 `baseUrl` deprecation warning）
2. 擴充 `scripts/poc/session-index-smoke.ts`：
   - 驗證 v2 schema 建立成功
   - 直接用假的 user/assistant/attachment/system 訊息呼叫 `indexEntry`
   - 驗證 `messages_seen` / `sessions` / `messages_fts` 三表都有對應 row
   - 用同 UUID 呼叫 `indexEntry` 兩次 — 驗證 FTS 只有一筆（去重）
   - 用空內容訊息呼叫 — 驗證沒有任何 insert
   - 模擬 `SQLITE_BUSY` 例外 — 驗證被吞掉、流程不崩
3. 端到端：`bun run dev --model qwen3.5-9b-neo`，問一個問題，然後開 `session-index.db` 跑 `SELECT * FROM sessions; SELECT content FROM messages_fts;`，確認有對應內容
4. 驗證 slug 一致：`.my-agent/projects/{slug}/session-index.db` 的 `{slug}` 與 JSONL 目錄名相同
5. 迴歸：原本的 30 筆 smoke check 還是要綠

## 明確不在本任務範圍的 gap（已知、延後處理）

1. **分叉 session**（`branch.ts:161`）— 整份檔案 `writeFile` 繞過 `appendEntry`。M2-03 bulk indexer 於啟動時對齊
2. **Agent sidechains** — subagent 的 transcript 不索引。若 M2-05 recall 感覺不完整再加
3. **Tombstone 刪訊** — JSONL 刪行時 FTS 殘留。M2 可接受，實際踩到再處理
4. **Hard-kill 掉最後一筆** — WAL + `synchronous=NORMAL` 可能丟最後幾筆。bulk indexer 對齊



---

# M2-03 任務決策摘要（2026-04-15 追補 2026-04-16）

**任務**：啟動時 bulk reconcile JSONL 至 FTS 索引（原 TODO 措辭誤寫 `.claude/projects/.../conversations/*.jsonl`，實際是 `{CLAUDE_CONFIG_HOME}/projects/{slug}/{sessionId}.jsonl`，無 `conversations/` 子目錄）

**緣由**：M2-02 的 tee hook 只處理新訊息寫入，舊 JSONL（M2 之前產生的）/ 分叉 session / 遺漏的 tombstone / hard-kill 丟的最後幾筆都不會進 FTS。啟動時需做一次 reconcile 把歷史對齊。

**架構決策**（使用者當下拍板）：
- Q1 啟動掃描觸發：**選 C** — 啟動 fire-and-forget + M2-05 SessionSearchTool 呼叫前 await `ensureReconciled` 做冪等雙保險
- Q2 log 詳盡度：**選 (iii)** — 完整 stats（`掃 N 個 / 索引 M（K 新）/ 寫入 X / Y 錯 / 耗時 Zms`）

**實作**：
- 新檔 `src/services/sessionIndex/reconciler.ts`：`reconcileProjectIndex` + `ensureReconciled`（`Map<projectRoot, Promise>` 冪等快取）
- Hook 點：`src/setup.ts` background-jobs 區塊（`!isBareMode()` 內、旁邊 `initSessionMemory`）fire-and-forget
- 掃描只要直接層 `.jsonl`（不 recurse `subagents/`）
- `isSidechain=true` 跳過（與 M2-02 tee 行為一致）
- 壞 JSON 行計 errors 繼續，不中斷

**踩到的坑**：無新坑（schema / path / tee hook 全在 M2-01/02 處理過）

**Commit**：`592d4ca`

Smoke 從 48 擴至 62 綠（M2-02 48 + M2-03 14：空目錄 / 多 session / 壞行 / sidechain 跳過 / up-to-date 跳過 / 冪等）。

---

# M2-04 任務決策摘要（2026-04-15 + 2026-04-16 手動驗證；追補 2026-04-16）

**任務**：typecheck 綠 + 手動驗證 — 產幾筆對話、確認 FTS 有資料、SQL 可查

**緣由**：階段一（索引基礎建設）的 gate，確認 M2-01/02/03 真的會在實際 runtime 下落地。

**方法**：
- 自動：typecheck baseline（只有 baseUrl warning）+ smoke 66/66 綠
- 手動：TUI 跑 2 輪天氣查詢後執行 `scripts/poc/query-session-index.ts`（readonly 開 db，不與 TUI 搶鎖）查驗 sessions / messages_fts / tool_name 抽取

**實測結果**：
- 4 sessions / 79 messages_fts / 81 messages_seen（差 2 = sidechain + 空內容跳過）
- tool_name 正確：Bash 14 / Read 2 / Skill 1 / Glob 1
- FTS 搜 "weather" 5 筆（對）；FTS 搜 "天氣" 0 筆（預期，trigram ≥3 字元限制）

**過程中發現的 bug + 修法**：
- `indexEntry` 用 `Date.now()` 當 timestamp，導致 reconciler 重播歷史訊息時 `started_at` 被寫成「reconcile 執行時間」而非訊息真實時間（偏差 14 小時）
- 修：優先讀 `entry.timestamp`（ISO 字串 → `Date.parse`），失敗才 fallback `Date.now()`；`ended_at` 從 `excluded.ended_at` 改成 `MAX(現有, excluded)` 防順序顛倒
- 因 shadow dedup 阻擋原有壞資料更新，需 `rm session-index.db*` 後手動觸發 reconcile（`scripts/poc/rebuild-session-index.ts`）重建；重建後 4 個 session 的 `started_at` 全部對齊真實時間

**Commits**：
- `7e057f5` (M2-01), `224cf7c` (M2-01 補 parent_session_id), `70c70da` (M2-02), `592d4ca` (M2-03)
- `302ebf4` (skill), `0384537` (timestamp fix), `da9a505` (rebuild script), `730433f` (勾 M2-04)

**新 skill**：`skills/session-fts-indexing/SKILL.md` 299 行，覆蓋階段一所有踩坑與設計決策，M2-05/09 之前必讀。

---

# M2-05 任務決策摘要（2026-04-16 追補 2026-04-16）

**任務**：SessionSearchTool — 跨 session FTS 搜尋工具

**緣由**：M2 階段二起點。把 M2-01/02/03 建好的 SQLite FTS 包成 agent 可呼叫的 tool，讓 LLM 在使用者問「上次我們怎麼處理 X」時能回憶。

**架構決策**（自定，風險低）：
- 沿用 GlobTool 骨架（`buildTool` + `ToolDef<InputSchema, Output>`），最輕量 search tool pattern
- 3 檔案：`SessionSearchTool.ts` / `prompt.ts`（NAME + DESCRIPTION）/ `UI.tsx`（render*）
- Trigram ≥3 字元限制：query <3 char 自動 fallback 到 `sessions.first_user_message` LIKE（帶 `usedFallback=true` 告知 LLM）
- FTS5 MATCH reserved char（`.` `"` 等）sanitize：每個 token 包成 phrase literal `"..."`，AND join
- `summarize:true` M2-05 先接受參數但不實作（帶 `summaryPending=true` + note 給 LLM），**M2-06 補**
- `await ensureReconciled(projectRoot)` 在搜尋前做冪等雙保險（與啟動掃描共用同一 Promise）
- Output 用 markdown：`## [id8] title (date, model, N 則)` + `- [role tool=X] snippet`

**實作要點**：
- `getProjectRoot()` 確保與 tee / reconciler 共用同 slug
- snippet 截 400 char，換行改 `↵` 保單行
- `ensureReconciled` 失敗不致命，用舊 index 繼續搜
- 本階段**不**註冊到 `tools.ts`，LLM 看不到（M2-07 做）

**踩到的坑**：
- FTS5 MATCH 查 `"serve.sh"` 直接噴 `fts5: syntax error near "."` — 改成只查 `serve` 或用 phrase literal
- Windows bun:sqlite `EBUSY` rmSync — finally 裡先 `closeAllSessionIndexes()` 再清目錄

**Smoke**：`session-search-tool-smoke.ts` 24/24 綠（對真實 index 跑：英文 / 中英混合 / 短 query fallback / summarize flag / reserved char / 空結果 / markdown 格式）

**Commit**：`c2af789`

---

# M2-06 計畫 — SessionSearchTool `summarize: true` 呼叫 llamacpp 做片段摘要（2026-04-16）

## 緣由

M2-05 的 SessionSearchTool 已接受 `summarize: true`，但目前只設了 `summaryPending=true` flag 沒實際摘要。M2-06 把這個分支補上：把命中片段（先截到 ~8K token）餵回**當前 session 主模型（= llamacpp）** 做摘要，回覆一個精煉版本給 LLM 看。

**不可妥協的約束**：
- 摘要失敗（timeout / context overflow / server 不可用）必須 graceful fallback 回原片段，tool 不能拋錯
- 不新建 provider、不新起 LLM client — 複用 `getAnthropicClient()`
- 不動 `QueryEngine.ts` / `Tool.ts` / `StreamingToolExecutor.ts`（deny list）
- llamacpp 特殊考量：9B 模型 / 32K ctx / 58 tok/s 推理慢 → 30 秒 timeout、input 先截 8K tokens

## 探勘結論

**可複用的既有設施**：

| 需求 | 位置 | 用法 |
|---|---|---|
| 拿主模型名稱 | `ToolUseContext.options.mainLoopModel` (`src/Tool.ts:162`) | 從 `call()` 第二參數取 string |
| 拿 Anthropic client | `src/services/api/client.ts:getAnthropicClient()` | `await getAnthropicClient()`；llamacpp 分支內建 fetch adapter，透明翻譯 |
| Abort / timeout | `context.abortController: AbortController` (`src/Tool.ts:180`) | child controller + `setTimeout` |
| 呼叫 LLM | `client.messages.create({model, max_tokens, messages, signal})` | 直接用 SDK，不走 `runForkedAgent` |

**為何不用 `runForkedAgent`**：那是給「fork 一個繼承 prompt cache 的 mini agent」用（SessionMemory / extractMemories / autoDream 的背景任務）；本場景是一次性單輪 query，直接 `client.messages.create` 更簡單、可控。

**Token 估算簡化**：用 char-based heuristic — 8K tokens ≈ 24,000 chars（3 chars/token 覆蓋中英混合）。不走 `tokenCountWithEstimation`（那吃 `Message[]` 結構）。

## 設計

### 新增私有 helper：`summarizeSessions(...)`（同檔內，不新建檔）

```ts
async function summarizeSessions(
  sessions: Output['sessions'],
  query: string,
  model: string,
  parentAbort: AbortController,
): Promise<Map<string, string> | null>
```

流程：
1. 建 prompt（繁中，嚴格 `## [id8]` 格式指示），超 24,000 chars 就停
2. child AbortController + 30s setTimeout + parent abort 串接
3. `client.messages.create({model, max_tokens: 2000, messages, signal: child.signal})`
4. 解析 text content；regex `^## \[([a-f0-9]+)\]` 拆回 session_id
5. 失敗 / timeout / parse error → 回 null；呼叫端 fallback

### 修改 `call()` summarize 分支

把 M2-05 的 pending flag 改為實際呼叫 `summarizeSessions`：
- 全部 session 有 summary → 清除 pending flag
- 部分失敗 → `summaryPending=true` + note 描述哪幾個壞
- 全部失敗 / 回 null → `summaryPending=true` + note "摘要失敗，顯示原片段"

### Output schema 擴充

`sessionGroupSchema.summary?: z.string()`（optional）。

### `mapToolResultToToolResultBlockParam` 輸出更新

每個 session 有 summary 時：顯示 summary 單行、**不**列 raw matches。沒有 summary 時沿用 M2-05。

### 關鍵檔案

- **修改**：`src/tools/SessionSearchTool/SessionSearchTool.ts`
- **修改**：`scripts/poc/session-search-tool-smoke.ts`（加 summarize fallback 自動測試）
- **可選**：`LESSONS.md`（實測若踩到新坑）

## 驗收方式

1. `bun run typecheck` — baseline 不變
2. Smoke 自動：`summarize:true` **沒有** llamacpp server 時 graceful fallback、`summaryPending=true`、matches 仍在、note 含「摘要失敗」
3. Smoke 手動（需 llamacpp server 跑著）：實測 `sessions[*].summary` 有中文摘要內容
4. 端到端可選：`bun run dev --model qwen3.5-9b-neo` 問「上次我們討論什麼 weather 的事？」觀察 agent 走 SessionSearch + summarize

## 風險與緩解

| 風險 | 緩解 |
|---|---|
| llamacpp 推理慢，30s 不夠 | 起點 30s；常 timeout 再調 60s。摘要失敗 fallback 不致命 |
| 模型輸出格式不遵守 | regex 解析失敗時整段當單一 summary；退路 `summaryPending` |
| Context overflow（24K chars 仍太大） | 預留 margin；prompt 其他部分 ~1-2K token + 回應 2K，總 ~28K < 32K ctx。實測溢出再降 16K chars |
| Parent abort 傳遞到 child | `.addEventListener('abort', ...)`，finally 裡 removeEventListener 清理 |

## 不在本任務範圍

常數調整、結構化輸出 / tool_use、摘要快取、M2-07 的註冊

---

## M8 — 移除殘留 Anthropic 對外連線與品牌字串（2026-04-18）

**Context**：M6d 後雖宣告 Anthropic auth 移除，稽核發現產品本體仍有：
1. **活路徑**：`src/services/mcp/officialRegistry.ts` 在每次 `bun run dev` 啟動時 fire-and-forget GET `https://api.anthropic.com/mcp-registry/v0/servers`
2. **品牌字串**：`src/constants/system.ts` 三條 prefix 仍寫 "You are Claude Code, Anthropic's official CLI for Claude."，每次 LLM request 都送進 llama.cpp
3. **死碼但仍存在**：`bigqueryExporter.ts` / `metricsOptOut.ts` / `firstPartyEventLoggingExporter.ts` / `Feedback.tsx` / `submitTranscriptShare.ts` 內 hardcoded `api.anthropic.com` 端點，路徑被 `isAnthropicAuthEnabled()=false` 短路但程式碼還在

### 任務清單

#### 批次 A — 堵啟動時對外請求
- [x] M8-01 `src/services/mcp/officialRegistry.ts` `prefetchOfficialMcpUrls()` early-return

#### 批次 B — System prompt 改名
- [x] M8-02 `src/constants/system.ts:9-11` 三條 prefix → my-agent 品牌

#### 批次 C — 刪除 dead telemetry/feedback POST
- [x] M8-03 刪 `src/utils/telemetry/bigqueryExporter.ts`
- [x] M8-04 刪 `src/services/api/metricsOptOut.ts`
- [x] M8-05 `src/services/analytics/firstPartyEventLoggingExporter.ts` `sendBatchWithRetry` → no-op
- [x] M8-06 `src/components/Feedback.tsx` `submitFeedback` → no-op
- [x] M8-07 `src/components/FeedbackSurvey/submitTranscriptShare.ts` 整檔縮為 stub

#### 驗證
- [x] M8-08 `bun run typecheck` 綠燈（只剩既有 baseUrl 棄用警告）

### 範圍外（延後）

OAuth scaffolding 完整下架（`src/cli/handlers/auth.ts`、`src/components/ConsoleOAuthFlow.tsx`、`src/services/oauth/client.ts`、`src/constants/oauth.ts`、`src/commands/install-github-app/`）— 涉及多處 CLI handler import cascade，需要獨立里程碑處理。

### 驗收方式

1. `bun run typecheck` 綠
2. `bun run dev -p "hi"` 端到端能回應
3. 手動：啟動到回完話不對 `*.anthropic.com` 發出任何 request（看 log）
4. system prompt 開頭不再含 "Anthropic" 字樣

---

## M13 — 完整測試計畫執行（2026-04-18）

**Context**：M8–M12 大量重構（移除 Anthropic 對外連線、改寫 system prompt、刪 OAuth、改名 skill）後執行完整測試確保未破壞既有功能、改動如預期生效、建構綠燈。

**測試分層** —
1. Tier 1 — 靜態 + 建構（typecheck / build / build:dev）
2. Tier 2 — 品牌與網路洩漏稽核（grep）
3. Tier 3 — 既有單元測試（11 個 self-improve `.test.ts`）
4. Tier 4 — Memory 系統 PoC 煙測
5. Tier 5 — Llama-server 部署 smoke
6. Tier 6 — Llamacpp adapter PoC 6 個
7. Tier 7 — CLI print mode 6 個 prompt 端到端
8. Tier 8 — CLI 互動 mode 手動煙測（人工）
9. Tier 9 — 網路洩漏觀察（DNS / netstat）
10. Tier 10 — Skill loop E2E
11. Tier 11 — 配置與權限驗證

**判準**：
- 全綠 → ship-ready
- T1 / T2 / T3 / T9 任一紅 → 不可發
- T6 / T7 個別紅 → 可暫忍

**產出物**：`tests/integration/test-run-2026-04-18.md`

