# TODO.md

> Claude Code 在每次 session 開始時讀取此檔案，在工作過程中更新任務狀態。
> 里程碑結構由人類維護。Claude Code 負責管理任務狀態的勾選。

## 當前里程碑：M1 — 透過 llama.cpp 支援本地模型

**目標**：free-code 能直接連接專案內跑的 llama.cpp server（`http://127.0.0.1:8080/v1`，model alias `qwen3.5-9b-neo`），支援串流和全部 39 個工具的 tool calling。**不再**經過 LiteLLM proxy（ADR-001 已推翻，見 CLAUDE.md）。

**架構硬約束**：`src/QueryEngine.ts` 與 `src/Tool.ts` 在 `.claude/settings.json` deny list — **不能改**。因此 provider 必須在內部把 OpenAI SSE 轉成 Anthropic 形狀的 stream event，下游無感。

### 階段一：Provider 抽象層（零 runtime 行為變化）
- [x] 閱讀並記錄 free-code 現有 API 架構的實測事實（`src/services/api/client.ts`、`src/services/api/claude.ts`、`src/utils/model/providers.ts`），把發現寫進 `skills/freecode-architecture/SKILL.md`
- [x] 閱讀 Hermes 的 `reference/hermes-agent/hermes_cli/auth.py` 與 `reference/hermes-agent/agent/auxiliary_client.py`，只取「ProviderConfig + 動態客戶端工廠」設計概念（不直接複製 Python）
- [ ] 設計 `src/services/providers/types.ts`：以 Anthropic 的 stream event schema 為通用格式，定義 `Provider` 介面含 `sendMessageStream`、`listModels`、`getCapabilities`
- [ ] 實作 `src/services/providers/index.ts`：註冊表 + 工廠，依 `APIProvider` 值選 provider
- [ ] 實作 `src/services/providers/anthropicAdapter.ts`：薄封裝既有 `src/services/api/client.ts`，確保當前 Anthropic 使用者行為位元級相同
- [ ] 驗證：`bun run typecheck` 通過；`./cli -p "hello"` 用 Anthropic 路徑正常

### 階段二：llama.cpp（OpenAI 相容）Provider
- [ ] 實作 `src/services/providers/llamaCpp.ts`：
  - 對 `http://127.0.0.1:8080/v1/chat/completions` 發 streaming 請求
  - 解析 OpenAI SSE（`data: {...}\n\n`、`data: [DONE]`）
  - **在 provider 內**把 OpenAI SSE chunks 轉成 Anthropic 形狀的 `stream_event`（`message_start` / `content_block_start` / `content_block_delta` / `message_delta` / `message_stop`）
  - Qwen3.5-Neo 的 `reasoning_content` 映射成 Anthropic 的 `thinking` content block
- [ ] 實作 `src/services/providers/toolCallTranslator.ts`：
  - 出站：Anthropic `tools: [{name, input_schema}]` → OpenAI `tools: [{type:'function', function:{name, parameters}}]`
  - 入站：OpenAI `tool_calls: [{id, function:{name, arguments}}]`（串流切多個 chunk，arguments 需累積）→ Anthropic `ToolUseBlock`
  - `tool_result` 對話歷史：Anthropic `tool_result` → OpenAI `role:'tool'` message
- [ ] 新增環境變數 `LLAMA_BASE_URL`（預設 `http://127.0.0.1:8080/v1`）與 `LLAMA_MODEL`（預設 `qwen3.5-9b-neo`）到設定層
- [ ] 驗證：單元測試轉譯器兩方向 round-trip；整合測試打活著的 server 跑一次 `hello world` 串流

### 階段三：串流完整性
- [ ] 驗證 `StreamingToolExecutor`（**不改動**）收到 llama.cpp provider 產出的 `content_block_start/delta/stop` 事件時運作正常
- [ ] 處理 Qwen3.5-Neo 的 `finish_reason=length` 邊界：provider 轉成 `message_delta.stop_reason='max_tokens'`
- [ ] CLI 串流顯示實測：`./cli --model qwen3.5-9b-neo -p "寫一個 fibonacci"`，確認文字逐字出現而非整塊

### 階段四：工具呼叫整合
- [ ] 建立 `tests/integration/TOOL_TEST_RESULTS.md` 骨架（39 個工具一張表）
- [ ] 針對前五個核心工具（Bash、Read、Write、Edit、Glob）用 Qwen3.5-Neo 跑端到端測試，記錄：(a) 模型選對工具 (b) 轉譯正確 (c) 工具執行成功 (d) 結果顯示正確
- [ ] 其餘 34 個工具依樣畫葫蘆補完（可分批）
- [ ] 修復測試中發現的轉譯器 bug（只動 `toolCallTranslator.ts`，不改 `Tool.ts`）

### 階段五：設定與使用者體驗
- [ ] `src/utils/model/model.ts`：優先級解析中新增 `qwen3.5-9b-neo` 別名 → 映射到 llama.cpp provider
- [ ] `/model` 指令：列出可用 provider + 模型名
- [ ] server 不可用時的降級：provider 工廠偵測 `fetch` 失敗時 log 清楚錯誤、不 crash
- [ ] 啟動橫幅顯示已連接的 provider（Anthropic / llama.cpp）

### 完成標準（取代原 M1 標準）
- [ ] `./cli --model qwen3.5-9b-neo -p "hello"` 成功串流輸出；log 顯示連接 `http://127.0.0.1:8080/v1`
- [ ] 工具呼叫可用：至少 Bash、Read、Write、Edit、Glob 五個核心工具端到端通過
- [ ] 既有 Anthropic 使用者路徑**完全不受影響**（`ANTHROPIC_API_KEY` 存在時 `./cli -p "hello"` 行為位元級相同）
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
