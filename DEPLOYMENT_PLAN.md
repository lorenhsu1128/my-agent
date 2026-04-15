# M1 里程碑修訂：llama.cpp 取代 LiteLLM+Ollama

## Context

TODO.md 原本的 M1「透過 LiteLLM proxy 支援本地模型」假設走 LiteLLM + Ollama，但實際部署已經改成專案目錄內跑 llama.cpp server（`http://127.0.0.1:8080/v1`，OpenAI 相容，model alias `qwen3.5-9b-neo`）。原 M1 任務的工具鏈、驗證條件、完成標準全部需要對齊新現實。

本 plan **只修改 TODO.md 與 CLAUDE.md 的 ADR 章節**，不動任何程式碼。目的是把 M1 路線固化成正確方向後，下一個 /project-next 能直接按表操課。

## 核心現狀（Explore 結果摘要）

- `src/services/providers/`、`src/utils/providers/` **都不存在** — 完全從零建。
- `src/utils/model/providers.ts` 的 `APIProvider` 字串聯集已有 `'openai'` 值，但只用在環境變數切換，沒有動態 provider 物件。
- `src/services/api/client.ts` 既有 multi-provider（Bedrock/Vertex/Foundry）都走 `CLAUDE_CODE_USE_*` env switch，還是拿 Anthropic SDK 客戶端 — **不是 provider 抽象**。
- `src/QueryEngine.ts`（第 788–828 行）**硬依賴** Anthropic 的 `stream_event` schema（`event.message.usage`、`event.delta.stop_reason` 等），且此檔在 `.claude/settings.json` 的 deny list — **不能改**。
- `src/services/tools/StreamingToolExecutor.ts` 的 `addTool(block: ToolUseBlock, ...)` 直接吃 `@anthropic-ai/sdk` 的 `ToolUseBlock`，無抽象。
- 專案內**完全沒有** OpenAI SSE 解析器、function-calling ↔ tool_use 轉譯層。
- Qwen3.5-Neo 的回應把 CoT 放 `reasoning_content`、答案放 `content`（已記入 LESSONS.md）。

**架構結論**：因為 QueryEngine / Tool.ts 不能改，provider 必須產出「Anthropic 形狀的 stream event」才能注入既有主幹；轉譯發生在 provider **內部**，下游無感。

## 新 M1 任務結構（要寫入 TODO.md）

### 階段一：Provider 抽象層（零 runtime 行為變化）
- [ ] 閱讀並記錄 free-code 現有 API 架構的實測事實（`src/services/api/client.ts`、`src/services/api/claude.ts`、`src/utils/model/providers.ts`）— 把發現寫進 `skills/freecode-architecture/SKILL.md`。
- [ ] 閱讀 Hermes 的 `hermes_cli/auth.py` 和 `agent/auxiliary_client.py`，只取其「ProviderConfig + 動態客戶端工廠」的設計概念。
- [ ] 設計 `src/services/providers/types.ts`：以 Anthropic 的 stream event schema 為通用格式（非最小公分母），定義 `Provider` 介面含 `sendMessageStream`、`listModels`、`getCapabilities`。
- [ ] 實作 `src/services/providers/index.ts` 註冊表 + 工廠：依 `APIProvider` 值選 provider。
- [ ] 實作 `src/services/providers/anthropicAdapter.ts`：薄封裝既有 `client.ts`，**確保當前 Anthropic 使用者行為完全不變**。
- [ ] 驗證：`bun run typecheck` 通過；`./cli -p "hello"` 用 Anthropic 路徑仍正常。

### 階段二：llama.cpp（OpenAI 相容）Provider
- [ ] 實作 `src/services/providers/llamaCpp.ts`：
  - 對 `http://127.0.0.1:8080/v1/chat/completions` 發 streaming 請求
  - 解析 OpenAI SSE（`data: {...}\n\n`、`data: [DONE]`）
  - **在 provider 內** 把 OpenAI SSE chunks 轉成 Anthropic 形狀的 `stream_event`（`message_start` / `content_block_start` / `content_block_delta` / `message_delta` / `message_stop`）
  - Qwen3.5-Neo 的 `reasoning_content` 映射成 Anthropic 的 `thinking` content block
- [ ] 實作 `src/services/providers/toolCallTranslator.ts`：
  - 出站：Anthropic `tools: [{name, input_schema}]` → OpenAI `tools: [{type:'function', function:{name, parameters}}]`
  - 入站：OpenAI `tool_calls: [{id, function:{name, arguments}}]`（串流時會切多個 chunk，arguments 需累積）→ Anthropic `ToolUseBlock`
  - `tool_result` 對話歷史轉譯：Anthropic `tool_result` → OpenAI `role:'tool'` message
- [ ] Server 啟動方式的設定：新增 env `LLAMA_BASE_URL`（預設 `http://127.0.0.1:8080/v1`）與 `LLAMA_MODEL`（預設 `qwen3.5-9b-neo`）。
- [ ] 驗證：單元測試轉譯器兩個方向 round-trip；整合測試用 server 跑一次 `hello world` 串流。

### 階段三：串流完整性
- [ ] 驗證 StreamingToolExecutor 收到 llama.cpp provider 產出的 `content_block_start/delta/stop` 事件時運作正常（不改 StreamingToolExecutor 本身）。
- [ ] 處理 Qwen3.5-Neo 吃 token 吃到 `finish_reason=length` 的邊界情況：provider 應轉成 `message_delta.stop_reason='max_tokens'`。
- [ ] CLI 串流顯示實測：`./cli --model qwen3.5-9b-neo -p "寫一個 fibonacci"`，確認文字逐字出現而非整塊。

### 階段四：工具呼叫整合
- [ ] 建立 `tests/integration/TOOL_TEST_RESULTS.md` 骨架（39 個工具一張表）。
- [ ] 針對前五個核心工具（Bash、Read、Write、Edit、Glob）用 Qwen3.5-Neo 跑端到端測試，記錄：(a) 模型是否選對工具、(b) 轉譯是否正確、(c) 工具是否成功執行、(d) 結果是否顯示。
- [ ] 其餘 34 個工具依樣畫葫蘆補完（可分批）。
- [ ] 修復測試中發現的轉譯器 bug（不改 Tool.ts，只動 toolCallTranslator.ts）。

### 階段五：設定與使用者體驗
- [ ] `src/utils/model/model.ts`：在優先級解析中新增 `qwen3.5-9b-neo` 的別名映射到 llama.cpp provider。
- [ ] `/model` 指令：列出可用 provider + 模型名。
- [ ] server 不可用時的降級：provider 工廠偵測到 `fetch` 失敗時 log 清楚錯誤，不 crash。
- [ ] 啟動橫幅顯示已連接的 provider（Anthropic / llama.cpp）。

### 完成標準（取代原 M1 標準）
- [ ] `./cli --model qwen3.5-9b-neo -p "hello"` 成功串流輸出；log 顯示連接 `http://127.0.0.1:8080/v1`。
- [ ] 工具呼叫可用：至少 Bash、Read、Write、Edit、Glob 五個核心工具端到端通過。
- [ ] 既有 Anthropic 使用者路徑完全不受影響（`ANTHROPIC_API_KEY` 存在時 `./cli -p "hello"` 行為位元級相同）。
- [ ] `tests/integration/TOOL_TEST_RESULTS.md` 記錄 39 個工具的結果表格。

## CLAUDE.md ADR 變更

在「已做出的架構決策」章節：
- ADR-001 **推翻**：改為「直接跑 llama.cpp server（OpenAI 相容），不經 LiteLLM proxy」，理由：部署已完成、少一層中介、減少相依性。
- 新增 ADR-005：「provider 內部做格式轉譯（OpenAI SSE → Anthropic stream_event），保持 QueryEngine / StreamingToolExecutor 零修改」，理由：這兩個檔案在 .claude/settings.json deny list。
- 新增 ADR-006：「Qwen3.5-Neo 的 `reasoning_content` 映射為 Anthropic `thinking` content block」。

## 修改的檔案

| 檔案 | 改動 |
|------|------|
| `TODO.md` | 重寫 M1 整段（階段一～五 + 完成標準） |
| `CLAUDE.md` | ADR-001 標註推翻、新增 ADR-005 / ADR-006 |
| `DEPLOYMENT_PLAN.md`（專案根目錄） | 覆寫為本 plan 內容（新慣例：已確認的 plan 都存此） |

## 新慣例：確認後的 plan 存檔流程

本專案從 2026-04-15 起，所有經使用者確認（ExitPlanMode 通過）的 plan 都要複製
到專案根目錄的 `DEPLOYMENT_PLAN.md`，覆寫舊內容，與 `git` 共同提供歷史追蹤。

執行步驟（加到本 plan 的落地動作首位）：
1. `Read` 本 plan 檔（`C:\Users\LOREN\.claude\plans\composed-dancing-aho.md`）
2. `Write` 同內容到 `DEPLOYMENT_PLAN.md`（專案根目錄，覆寫）
3. 之後再做其他 plan 任務（改 TODO.md、改 CLAUDE.md）
4. commit 時把 `DEPLOYMENT_PLAN.md` 跟其他變更併入同一個 docs commit（或視情況獨立）

此慣例也要存進 memory，避免下次 plan 時忘記。

備註：既有的 `scripts/llama/DEPLOYMENT_PLAN.md` 是上一輪部署計畫的副本，保留不動 —
它的路徑已說明是那個部署的一部分。新慣例只適用根目錄 `DEPLOYMENT_PLAN.md`。

## 驗證（本 plan 本身）

此 plan 只改文件，無程式行為可測。驗證方式：
1. 讀 TODO.md 的新 M1 — 確認每一項任務動詞具體、結果可測、無「研究一下」類含糊描述。
2. 讀 CLAUDE.md 的 ADR 段 — 確認 ADR-001 明確標註「已推翻」並指向取代方案。
3. 跑 `/project-next` — 應讀到階段一第一項任務並正確啟動。

## 不在範圍內
- 任何實作（那是修訂後依 /project-next 跑的事）。
- 修改核心檔案 QueryEngine.ts / Tool.ts（被 deny list 擋，且架構設計刻意繞過）。
- M2–M6 的修訂（只動 M1）。
