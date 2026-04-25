# MY-AGENT.md

This file provides guidance to my-agent when working with code in this repository.

## 常用開發命令

```bash
# 環境準備（每個 session 必做）
conda activate aiagent

# 基礎命令
bun install                      # 安裝依賴
bun run build                    # 正式建構（./cli）
bun run build:dev                # 開發建構（./cli-dev）
bun run build:dev:full           # 全功能實驗性建構
bun run typecheck                # TypeScript 型別檢查

# 測試
bun test                         # 執行所有測試
bun test tests/unit/             # 執行單一測試套件
bun test tests/integration/      # 執行整合測試
bun test -t "memory"             # 執行包含 "memory" 的測試

# 開發模式（熱重載）
bun run dev                      # 直接跑 src/entrypoints/cli.tsx

# 快速測試
./cli -p "hello"                 # 一問式測試
./cli --model qwen3.5-9b-neo     # 使用本地模型測試
```

## 高階架構

### 核心設計

本專案是 Claude Code 的可建構 fork，重點是：

- **多 provider 支援**：Anthropic 直連、OpenAI Codex、AWS Bedrock、Google Vertex、Anthropic Foundry，以及本地 llama.cpp
- **Browser provider 多家**：Local（puppeteer-core + chromium）、Browserbase、Browser Use；Vision 走 vendored Anthropic SDK
- **Daemon + Discord 整合**：`my-agent daemon start` 常駐 WS server，REPL thin-client；單一 daemon 多 ProjectRuntime；Discord bot 接 DM / guild channel 跨專案對話
- **Hermes Agent 移植**：將 Hermes Agent（Python）的功能用 TypeScript 重新實作，原始碼放在 `reference/hermes-agent/` 作為參考
- **Vendor SDK 策略**：`@anthropic-ai` 全套 SDK 套件內化為專案原始碼（`src/vendor/my-agent-ai/`），透過 tsconfig paths 映射，完全掌控 SDK

### 關鍵模組

#### 1. Provider 整合層

- `src/services/api/`：API 客戶端與 adapter（含 `llamacpp-fetch-adapter.ts` 的串流與工具呼叫轉譯）
- `src/utils/model/`：模型設定、provider 偵測、驗證（Zod schema）
- `src/services/api/client.ts`：統一 API 客戶端介面

#### 2. 核心引擎

- `src/QueryEngine.ts`：核心 LLM 查詢引擎（分發、工具呼叫、用量追蹤）
- `src/Tool.ts`：工具基礎介面（所有工具實作此介面）
- `src/tools.ts`：工具註冊表（51 個工具，含 8 個 cron 工具、WebBrowser、SessionSearch、MemoryTool 等；ADR-003 採無 feature flag 全啟用）
- `src/services/tools/StreamingToolExecutor.ts`：串流工具執行

#### 3. 系統提示與記憶

- `src/systemPromptFiles/`：系統提示外部化（29 個 section 寫入 .md 檔）
- `src/services/sessionIndex/`：Session Recall 的 FTS5 跨 session 搜尋
- `src/services/memoryPrefetch/`：query-driven 動態 memory prefetch

#### 4. Daemon / Discord / Cron

- `src/daemon/`：常駐 WS server（loopback + bearer token）、ProjectRegistry（多 ProjectRuntime lazy load）、daemonTurnMutex（FIFO 跨 project 串行）、permissionRouter（REPL-first / Discord fallback）、cronWiring（per-runtime scheduler）
- `src/discord/`：discord.js v14 gateway、router（DM `#<id>` 前綴 + channelBindings）、replMirror（home / per-project channel）、slashCommands（/status /list /help /mode /clear /interrupt /allow /deny）、channelFactory（`/discord-bind` 一鍵建頻道）
- `src/repl/thinClient/`：fallbackManager（standalone ↔ attached ↔ reconnecting 狀態機）、cwd handshake、attachRejected fallback
- `src/utils/cronNlParser.ts` / `src/discord/cronMirror.ts` / `src/components/CronCreateWizard.tsx`：Cron Wave 3+4

#### 5. Hermes 移植相關

- `reference/hermes-agent/`：唯讀的 Hermes 原始碼（Python）
- 實作時閱讀：`auxiliary_client.py`（多 provider）、`auth.py`（ProviderConfig）、`run_agent.py`（路由邏輯）

### 架構決策（需理解）

- ADR-003：新功能不使用 feature flag — 直接啟用
- ADR-005：provider 內部做格式轉譯（OpenAI SSE → Anthropic `stream_event`），保持 `QueryEngine.ts` 與 `StreamingToolExecutor.ts` 零修改
- ADR-007：`@anthropic-ai` 套件內化，vendor `.ts` 檔，透過 paths 映射，既有 import 不需修改
- ADR-008：29 段 system prompt 外部化至 `~/.my-agent/system-prompt/*.md`，per-project > global > bundled 三層解析
- ADR-009 / ADR-010：llamacpp ctx 偵測復原 + 設定統一到 `~/.my-agent/llamacpp.json`
- ADR-011：Browser 走 puppeteer-core（不走 playwright-core，bun + Windows 不相容）
- ADR-012：Daemon 採 Path A in-process QueryEngine 整合（非 Path B subprocess）
- ADR-013：單 daemon 多 project Discord gateway（B-1 全域 turn mutex + chdir 序列化）
- ADR-014：M-MEMRECALL-LOCAL — llamacpp 模式 memory selector 走本地模型 + safety-net fallback

## 測試流程

### 測試分類

- `tests/integration/`：整合測試（memory smoke tests、llamacpp 工具測試、SessionRecall 測試）
- 每個測試套件有獨立的啟動腳本與預期結果

### 測試策略

1. 修改 provider 相關程式碼 → 執行 `bun run typecheck`
2. 受影響的整合測試 → 針對性執行
3. 若測試未覆蓋 → 先寫測試（CLAUDE.md 第 5 條黃金規則）

## 常見錯誤處理

### 工具呼叫轉譯錯誤

- 錯誤："Failed to parse tool call" → 檢查 `llamacpp-fetch-adapter.ts` 的 `parseToolCall` 函式
- 解決：確保 provider SSE 格式正確映射到 Anthropic 格式

### Provider 配置錯誤

- 錯誤："All models must have a non-empty name" → 檢查 `src/utils/model/providers.ts` 中的 `ALL_MODEL_CONFIGS`
- 解決：確保每個 provider 都有完整的 `name` 和 `lookup` 配置

### 串流處理錯誤

- 錯誤："stream interrupted" → 檢查網路連接或 provider 端點
- 解決：對於 llamacpp，確保 `LLAMA_BASE_URL` 正確且 server 正在運行

## 關鍵檔案指引

### 每次修改前必讀

- `CLAUDE.md`：黃金規則、架構決策、現狀
- `LESSONS.md`：踩坑記錄、錯誤避免
- `FEATURES.md`：88 個 feature flags 的完整清單

### 修改工具時

- `src/tools.ts`：工具註冊表與 feature flag 控制
- `src/Tool.ts`：工具基礎介面與 `TOOL_DEFAULTS`

### 修改 provider 時

- `src/services/api/llamacpp-fetch-adapter.ts`：llamacpp 串流與轉譯邏輯
- `src/utils/model/providers.ts`：APIProvider enum 與 provider 映射

### 修改系統提示時

- `src/systemPromptFiles/`：外部化 prompt 的模組
- `docs/customizing-system-prompt.md`：使用者指南

## 現有文檔

- `README.md`：專案概述、安裝、使用
- `CLAUDE.md`：黃金規則、架構決策、現狀（含完整開發日誌：M-DAEMON / M-DISCORD / M-CRON-W3+W4 / M-MEMRECALL-LOCAL 等）
- `LESSONS.md`：教訓記錄（工具呼叫轉譯、Provider 整合、串流處理、建構設定等）
- `FEATURES.md`：Feature flag 歷史清單（fork 自原 Claude Code；my-agent 採 ADR-003 無 flag 全啟用，本檔僅供對照）
- `TODO.md`：任務追蹤（含 session 日誌與後續 milestone）
- `docs/daemon-mode.md` / `docs/discord-mode.md` / `docs/cron-wave3.md`：新功能使用者指南

## 自訂指令（CLI）

| 指令 | 功能 |
|------|------|
| `/project-next` | 找到 TODO.md 中下一個任務並執行 |
| `/project-status` | 顯示專案進度（TODO 計數、typecheck、服務健康） |
| `/project-test` | 執行完整測試套件 |
| `/project-review-hermes` | 分析 Hermes Agent 模組 |
| `/project-create-skill` | 手動建立新 skill |

## 環境變數

| 變數 | 用途 |
|------|------|
| `ANTHROPIC_API_KEY` | Anthropic API key |
| `ANTHROPIC_AUTH_TOKEN` | Anthropic OAuth token |
| `MY_AGENT_USE_OPENAI=1` | 切換到 OpenAI Codex |
| `MY_AGENT_USE_BEDROCK=1` | 切換到 AWS Bedrock |
| `MY_AGENT_USE_VERTEX=1` | 切換到 Google Vertex |
| `MY_AGENT_USE_FOUNDRY=1` | 切換到 Anthropic Foundry |
| `MY_AGENT_USE_LLAMACPP=1` | 切換到本地 llama.cpp（多數情況自動偵測，不需顯式設定） |
| `LLAMA_BASE_URL` | llama.cpp server 地址 |
| `LLAMA_MODEL` | 本地模型名稱 |
| `LLAMACPP_CTX_SIZE` | 手動覆寫 llama.cpp context size（`/slots` 偵測失敗時使用） |
| `BROWSER_PROVIDER` | WebBrowser backend（`local` / `browserbase` / `browser-use`） |
| `BROWSERBASE_API_KEY` / `BROWSER_USE_API_KEY` | Cloud browser provider 認證 |
| `WEBCRAWL_BACKEND=firecrawl` + `FIRECRAWL_API_KEY` | WebCrawl 切到 Firecrawl |

## 快速參考：Hermes 移植流程

1. 確定要移植的功能 → 讀 `reference/hermes-agent/` 相關檔案
2. 在 my-agent 既有架構內設計對應模組（React/Ink UI、Tool 基礎類別、services 模式）
3. 撰寫 TypeScript 實作（不直接複製 Python 代碼）
4. 寫整合測試
5. 提交（使用約定式提交格式）

## 快速參考：新增 Provider

1. 在 `src/utils/model/providers.ts` 新增 `APIProvider` 值
2. 在 `src/services/api/client.ts` 新增 provider 客戶端
3. 補全 `ALL_MODEL_CONFIGS` 的 lookup fallback（見 LESSONS.md 第 1 條）
4. 測試所有工具呼叫
5. 提交

## 提交規範

- 使用約定式提交格式：`feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`
- 提交訊息應簡潔（50 字以內）並說明 "why" 而非 "what"
- 大於 3 個檔案的修改應包含相關的 issue 編號

---

*本文件最後更新：2026-04-25（補 M-DAEMON / M-DISCORD / M-CRON-W3+W4 / M-MEMRECALL-LOCAL，修正 env var 命名 `CLAUDE_CODE_USE_*` → `MY_AGENT_USE_*`）*
