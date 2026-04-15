# TODO.md

> Claude Code 在每次 session 開始時讀取此檔案，在工作過程中更新任務狀態。
> 里程碑結構由人類維護。Claude Code 負責管理任務狀態的勾選。

## 當前里程碑：M1 — 透過 LiteLLM Proxy 支援本地模型

**目標**：free-code 能透過 LiteLLM proxy 連接本地模型（Qwen 3.5 9B via Ollama），支援串流和全部 39 個工具的 tool calling。

### 階段一：Provider 抽象層
- [ ] 閱讀並理解 free-code 目前的 API 架構（`src/services/api/`、`src/utils/model/`、`src/QueryEngine.ts`）
- [ ] 閱讀 Hermes Agent 的 provider 系統（`reference/hermes-agent/hermes_cli/auth.py`、`reference/hermes-agent/agent/auxiliary_client.py`）
- [ ] 設計 provider 介面，寫入 `src/services/providers/types.ts`
  - 必須支援：sendMessage、sendMessageStream、listModels
  - 必須處理：Anthropic 格式（原生）和 OpenAI 格式（透過 LiteLLM）
- [ ] 實作 provider 註冊表，寫入 `src/services/providers/index.ts`
- [ ] 實作 Anthropic 轉接器，寫入 `src/services/providers/anthropicAdapter.ts`
  - 封裝既有的 `src/services/api/client.ts` 作為 provider
  - 確保對當前 Anthropic 使用者零行為改變
- [ ] 驗證：`bun run typecheck` 通過，既有測試通過

### 階段二：LiteLLM Provider
- [ ] 實作 LiteLLM provider，寫入 `src/services/providers/litellm.ts`
  - 向 LiteLLM proxy 端點發送 HTTP 請求
  - 串流 SSE 解析（OpenAI 格式）
  - 錯誤處理和逾時管理
- [ ] 實作工具呼叫轉譯器，寫入 `src/services/providers/toolCallTranslator.ts`
  - Anthropic tool_use → OpenAI function calling（出站）
  - OpenAI function calling → Anthropic tool_use（入站）
  - 處理串流區塊邊界
  - 處理單次回應中的多個工具呼叫
  - 處理 tool_result 對話歷史轉譯
- [ ] 新增模型選擇支援（--model 旗標或 /model 指令支援 LiteLLM 模型）
- [ ] 驗證：能透過 LiteLLM 向 Ollama 發送基本聊天訊息

### 階段三：串流整合
- [ ] 將 LiteLLM provider 整合進 StreamingToolExecutor
  - 將 OpenAI SSE 事件對應到 free-code 的內部串流格式
  - 確保 content_block_start/delta/stop 事件正確發出
  - 處理模型支援的 thinking blocks
- [ ] 使用 Qwen 3.5 9B 測試串流
- [ ] 驗證：串流文字回應在 CLI 中正確顯示

### 階段四：工具呼叫整合
- [ ] 透過 LiteLLM 使用 Qwen 3.5 9B 測試全部 39 個工具
- [ ] 記錄哪些工具可用、哪些失敗，附失敗原因
- [ ] 修復測試中發現的轉接器問題
- [ ] 建立工具呼叫的整合測試套件
- [ ] 撰寫測試結果報告

### 階段五：設定與使用者體驗
- [ ] 新增 LiteLLM proxy 設定（URL、模型名稱）到 free-code 設定中
- [ ] 更新 /model 指令以顯示 LiteLLM 代理的模型
- [ ] 確保 proxy 不可用時有優雅的降級處理
- [ ] 更新啟動橫幅以顯示已連接的 provider
- [ ] 最終冒煙測試：使用本地模型完成完整的程式開發任務

### 完成標準
- [ ] `./cli --model qwen3.5:9b` 啟動並透過 LiteLLM 連接到 Ollama
- [ ] 串流文字回應正常運作
- [ ] 工具呼叫可用（至少 BashTool 必須正常；記錄全部 39 個的結果）
- [ ] 既有的 Anthropic API 使用完全不受影響
- [ ] 全部 39 個工具已測試，結果記錄在 `tests/integration/TOOL_TEST_RESULTS.md`

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
