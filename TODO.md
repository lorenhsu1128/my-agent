# TODO.md

> Claude Code 在每次 session 開始時讀取此檔案，在工作過程中更新任務狀態。
> 里程碑結構由人類維護。Claude Code 負責管理任務狀態的勾選。

## 當前里程碑：M1 — 透過 llama.cpp 支援本地模型

**目標**：free-code 能直接連接專案內跑的 llama.cpp server（`http://127.0.0.1:8080/v1`，model alias `qwen3.5-9b-neo`），支援串流和全部 39 個工具的 tool calling。**不再**經過 LiteLLM proxy（ADR-001 已推翻，見 CLAUDE.md）。

**架構硬約束**：`src/QueryEngine.ts` 與 `src/Tool.ts` 在 `.claude/settings.json` deny list — **不能改**。因此 provider 必須在內部把 OpenAI SSE 轉成 Anthropic 形狀的 stream event，下游無感。

**實作路徑**：**路徑 B（fetch adapter）** — 2026-04-15 PoC 驗證通過（commit `b2af143`）。仿 `src/services/api/codex-fetch-adapter.ts` 模式，寫 `llamacpp-fetch-adapter.ts`，塞給 `new Anthropic({ fetch })`，翻譯層集中一處，`claude.ts` / `QueryEngine.ts` 零修改。**不另建** `src/services/providers/` 抽象層（路徑 A 已放棄）。

### 階段一：摸底與可行性驗證
- [x] 閱讀並記錄 free-code 現有 API 架構的實測事實（`src/services/api/client.ts`、`src/services/api/claude.ts`、`src/utils/model/providers.ts`），把發現寫進 `skills/freecode-architecture/SKILL.md`
- [x] 閱讀 Hermes 的 `reference/hermes-agent/hermes_cli/auth.py` 與 `reference/hermes-agent/agent/auxiliary_client.py`，只取「ProviderConfig + 動態客戶端工廠」設計概念（不直接複製 Python）
- [x] PoC：路徑 B 可行性驗證 — 寫 `scripts/poc/llamacpp-fetch-poc.ts`，確認 Anthropic SDK 透過 fetch adapter 可成功與 llama-server 通訊（2026-04-15 commit `b2af143`）
- [x] 架構決策：確定走路徑 B（fetch adapter）— 棄新 provider 層
- [x] 驗證：`bun run typecheck` 在當前 main 上仍通過（建立實作前的綠燈基準）— exit 0，僅 `tsconfig.json` L10 `baseUrl` 一條 TS5101 deprecation warning，無實際錯誤。同步把 `typecheck` 加進 `package.json` scripts（原本缺）

### 階段二：`llamacpp-fetch-adapter.ts` 實作（non-streaming 先行）
- [ ] 建立 `src/services/api/llamacpp-fetch-adapter.ts`（仿 `codex-fetch-adapter.ts` 結構）：
  - `createLlamaCppFetch(config)` 回傳 fetch 介面
  - 攔截 `/v1/messages` 請求，不攔截其他（讓原本 fetch 照常走）
  - 請求翻譯：Anthropic MessagesCreate → OpenAI ChatCompletion（system / user / assistant 訊息、max_tokens、temperature）
  - 回應翻譯：OpenAI ChatCompletion → Anthropic BetaMessage JSON，包進 `new Response(...)` 回給 SDK
  - `reasoning_content` → `thinking` content block（ADR-006）
  - `finish_reason` → `stop_reason` 映射表：`stop→end_turn` / `length→max_tokens` / `tool_calls→tool_use`
- [ ] 修改 `src/services/api/client.ts`：
  - 在 Codex 分支（L308）之前新增 llamacpp 分支：`if (apiMode === 'chat_completions' && LLAMA_BASE_URL) ...`
  - 使用 `new Anthropic({ apiKey: 'llamacpp-placeholder', fetch: llamaCppFetch })`
- [ ] 修改 `src/utils/model/providers.ts`：
  - 新增 `CLAUDE_CODE_USE_LLAMACPP` 支援到 `getAPIProvider()`
  - 或改用 `APIProvider` 中的 `'openai'` 值、靠 `LLAMA_BASE_URL` 存在與否分流（待實作時決定）
- [ ] 新增環境變數 `LLAMA_BASE_URL`（預設 `http://127.0.0.1:8080/v1`）與 `LLAMA_MODEL`（預設 `qwen3.5-9b-neo`）到適當的設定模組
- [ ] 驗證：`./cli --model qwen3.5-9b-neo -p "hello"` 單次 non-streaming 成功（`LLAMA_BASE_URL=http://127.0.0.1:8080/v1 ANTHROPIC_API_KEY=dummy ./cli -p "hi"`）

### 階段三：串流（SSE）翻譯
- [ ] 在 `llamacpp-fetch-adapter.ts` 中實作 streaming 路徑：
  - 請求參數加 `stream: true` 時，不再呼叫 non-streaming 翻譯
  - 向 llama-server 發 streaming 請求，取得 OpenAI SSE ReadableStream
  - 寫 `translateOpenAIStreamToAnthropic(openaiStream, model)` 把 OpenAI SSE chunks 轉成 Anthropic SSE（`message_start` / `content_block_start` / `content_block_delta` / `content_block_stop` / `message_delta` / `message_stop`）
  - 回傳 `new Response(anthropicSSEStream, { headers: { 'content-type': 'text/event-stream' } })` 給 SDK
  - `reasoning_content` delta 映射到 `thinking_delta`（需確認 Anthropic SDK 是否認這個 delta type）
- [ ] 處理 `finish_reason=length` 邊界：轉成 `message_delta.stop_reason='max_tokens'`
- [ ] CLI 串流顯示實測：`./cli --model qwen3.5-9b-neo -p "寫一個 fibonacci"`，確認文字逐字出現而非整塊

### 階段四：工具呼叫翻譯
- [ ] 在 adapter 中加 tool 翻譯：
  - 出站：Anthropic `tools: [{name, input_schema}]` → OpenAI `tools: [{type:'function', function:{name, parameters}}]`
  - 入站 non-streaming：OpenAI `tool_calls: [{id, function:{name, arguments}}]` → Anthropic `ToolUseBlock`
  - 入站 streaming：`tool_calls` 的 `arguments` 會切多個 chunk，需累積後輸出 `content_block_delta.input_json_delta`
  - `tool_result` 對話歷史：Anthropic `tool_result` content block → OpenAI `role:'tool'` message
- [ ] 建立 `tests/integration/TOOL_TEST_RESULTS.md` 骨架（39 個工具一張表）
- [ ] 針對前五個核心工具（Bash、Read、Write、Edit、Glob）用 Qwen3.5-Neo 跑端到端測試，記錄：(a) 模型選對工具 (b) 翻譯正確 (c) 工具執行成功 (d) 結果顯示正確
- [ ] 其餘 34 個工具依樣畫葫蘆補完（可分批）
- [ ] 修復測試中發現的翻譯 bug（只動 `llamacpp-fetch-adapter.ts`，不改 `Tool.ts`）

### 階段五：設定與使用者體驗
- [ ] `src/utils/model/model.ts`：優先級解析認得 `qwen3.5-9b-neo` 別名，自動啟用 llama.cpp 分支
- [ ] `/model` 指令：列出 llama.cpp 模型與 Anthropic 模型並列
- [ ] server 不可用時的降級：adapter 偵測 `fetch` 失敗（ECONNREFUSED）時回傳清楚的錯誤訊息（指示執行 `bash scripts/llama/serve.sh`），不 crash
- [ ] 啟動橫幅顯示已連接的 provider（Anthropic / llama.cpp）

### 完成標準
- [ ] `./cli --model qwen3.5-9b-neo -p "hello"` 成功串流輸出；log 顯示連接 `http://127.0.0.1:8080/v1`
- [ ] 工具呼叫可用：至少 Bash、Read、Write、Edit、Glob 五個核心工具端到端通過
- [ ] 既有 Anthropic 使用者路徑**完全不受影響**（`ANTHROPIC_API_KEY` 存在、未設 `LLAMA_BASE_URL` 時 `./cli -p "hello"` 行為位元級相同）
- [ ] `tests/integration/TOOL_TEST_RESULTS.md` 記錄 39 個工具的結果表格

---

## 未來里程碑（尚未詳細規劃）

### M2 — Hermes 記憶系統（TypeScript 重新實作）
將 Hermes 的持久化記憶（SQLite + FTS5 + 記憶提醒）移植到 free-code。

### M3 — Hermes Cron 排程（TypeScript 重新實作）
將 Hermes 的 cron 系統（自然語言排程 + 多平台派送）移植到 free-code。

### M4 — Hermes 訊息閘道（TypeScript 重新實作）
將 Telegram/Discord/Slack 閘道移植到 free-code。

### M5 — Hermes 技能自動建立（TypeScript 重新實作）
將 Hermes 的自我改進技能循環移植到 free-code。

### M6 — Hermes 使用者建模（TypeScript 重新實作）
將 Honcho 風格的使用者建模和跨 session 回憶移植到 free-code。

---

## Session 日誌

> Claude Code：每次 session 結束後，在下方附加一行簡短記錄。
> 格式：`- YYYY-MM-DD: [完成的任務] | [遇到的問題] | [下一步]`

- 2026-04-15: 本地 llama.cpp b8457 + Qwen3.5-9B-Neo Q5_K_M 部署完成（scripts/llama/*），煙測 2+2=4 通過，58 tok/s prompt eval | 踩了 --log-colors 參數變更、Git Bash UTF-8 mangling、Neo reasoning_content/content 分離三個坑，都已記入 LESSONS.md | 下一步：M1 階段一，整合這個 server 作為 free-code 的本地 provider

---

- 2026-04-15 15:33: Session 結束 | 進度：1/25 任務 | e5ea9f2 docs(m1): 改寫 freecode-architecture skill，記錄 API 層實測事實

- 2026-04-15 15:40: Session 結束 | 進度：2/25 任務 | fa03174 docs(m1): 改寫 provider-system skill，納入 Hermes 借鑑與兩條實作路徑

- 2026-04-15 15:46: Session 結束 | 進度：2/25 任務 | b2af143 poc: 驗證路徑 B（fetch adapter）可行性

- 2026-04-15 15:54: Session 結束 | 進度：4/26 任務 | fbacb96 docs(m1): 對齊路徑 B — 以 fetch adapter 實作 llama.cpp 整合
