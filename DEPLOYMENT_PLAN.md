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
$env:CLAUDE_CONFIG_DIR = "$env:USERPROFILE\.free-code-profile"
```
未來可能改為 free-code 預設用 `~/.free-code/`，由使用者決定後實作。

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

### ADR-M2-07：SQLite 路徑 `~/.free-code/projects/{slug}/session-index.db`，用 `bun:sqlite`

走 `~/.free-code/` 而非 `~/.claude/`，與 free-code 既有 profile 隔離方向一致。

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
