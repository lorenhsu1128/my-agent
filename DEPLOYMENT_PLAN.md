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
