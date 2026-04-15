# free-code 架構導覽

## 說明
free-code 內部架構的完整地圖。當你需要了解東西在哪裡、它們如何連接、以及在哪裡加入新程式碼時，載入此技能。

## 工具集
file

## 執行環境與建構

- **執行環境**：Bun（不是 Node.js）。使用 `bun:bundle` 透過 `feature('FLAG_NAME')` 做編譯時 feature flag。
- **UI 框架**：React + Ink（終端 React 渲染器）。元件是 `.tsx` 檔案。
- **進入點**：`src/main.tsx` → Commander.js CLI → `src/screens/REPL.tsx`
- **建構**：`scripts/build.ts` 處理 feature flags → `bun build` → 單一 `./cli` 二進位檔

## 核心查詢迴圈

```
使用者輸入
  → src/screens/REPL.tsx（UI 層）
  → src/QueryEngine.ts（1,295 行）
    → 組裝 messages[]，包含系統提示、記憶、工具
    → 呼叫 src/services/api/claude.ts（串流）
    → 接收包含 content blocks 的回應
    → 如果 content 包含 tool_use：
      → src/services/tools/StreamingToolExecutor.ts
        → src/services/tools/toolExecution.ts
          → 在特定工具上呼叫 Tool.call()
          → hooks：toolHooks.ts（PreToolUse/PostToolUse）
        → 工具結果附加到 messages[]
        → 回到查詢迴圈
    → 如果 content 是文字：顯示給使用者
```

## 工具系統

- **基礎類別**：`src/Tool.ts`（792 行）— 定義 Tool 介面、ToolUseContext、權限型別
- **註冊表**：`src/tools.ts`（389 行）— 匯入所有工具，套用 feature flag 防護
- **每個工具**：`src/tools/{工具名稱}/` 目錄，包含：
  - `{工具名稱}.tsx` — 主要實作（繼承 Tool）
  - `UI.tsx` — 用於顯示工具結果的 React 元件
  - `prompt.ts` — 面向 LLM 的描述和指示
  - 其他支援檔案（安全性、驗證等）
- **工具執行管線**：`src/services/tools/`（4 個檔案，共 3,113 行）
  - `StreamingToolExecutor.ts` — 處理串流工具執行
  - `toolExecution.ts` — 工具生命週期（驗證 → 授權 → 執行 → 報告）
  - `toolHooks.ts` — PreToolUse/PostToolUse hook 系統
  - `toolOrchestration.ts` — 平行/序列分發

## API 客戶端（當前 — 僅限 Anthropic）

- `src/services/api/client.ts` — Anthropic SDK 封裝
- `src/services/api/claude.ts` — 串流處理、用量累計
- `src/services/api/errors.ts` — 錯誤分類（可重試 vs 致命）
- `src/services/api/withRetry.ts` — 重試邏輯
- 完全使用 Anthropic Messages API 格式
- 工具呼叫使用 Anthropic 的 `tool_use` / `tool_result` content block 格式

## 模型設定

- `src/utils/model/`（96KB，16 個檔案）— 模型設定、provider 偵測、驗證
- 模型 ID 是 Anthropic 格式：`claude-opus-4-6`、`claude-sonnet-4-6` 等
- Provider 偵測：檢查環境變數（`CLAUDE_CODE_USE_BEDROCK`、`CLAUDE_CODE_USE_OPENAI` 等）
- 既有的多 provider 支援（Bedrock/Vertex/Codex）透過不同的 API 轉接器路由，但最終都使用 Anthropic SDK 或相容格式

## 狀態管理

- `src/state/AppState.tsx` — React 狀態儲存
- `src/bootstrap/state.ts`（1,758 行）— 初始化、session 設定
- 設定：`src/utils/settings/`（163KB，19 個檔案）— 持久化設定
- 設定檔：`~/.claude/settings.json`、專案層級 `CLAUDE.md`

## 不要修改的關鍵目錄

這些是複雜且緊密耦合的系統。擴充它們，不要重寫：

- `src/bridge/`（479KB）— IDE 整合橋接
- `src/utils/swarm/`（277KB）— 多 agent swarm 系統
- `src/utils/permissions/`（321KB）— 權限模型
- `src/hooks/`（1.3MB）— 104 個 React hooks
- `src/components/`（9.5MB）— 完整 UI 元件庫
- `src/ink/`（1.1MB）— 自訂 Ink fork

## 新增 Provider 程式碼的位置

```
src/services/providers/       ← 新增目錄
├── types.ts                  # Provider 介面定義
├── index.ts                  # Provider 註冊表、工廠、選擇邏輯
├── anthropicAdapter.ts       # 將既有 api/ 封裝為 Provider
├── litellm.ts                # LiteLLM proxy provider
└── toolCallTranslator.ts     # Anthropic ↔ OpenAI 格式轉譯
```

與既有程式碼的整合點：
1. `src/QueryEngine.ts` — 需要呼叫 provider 而非直接呼叫 `src/services/api/claude.ts`
2. `src/utils/model/` — 需要辨認 LiteLLM 模型名稱
3. `src/bootstrap/state.ts` — 需要在啟動時根據設定初始化 provider
4. `src/commands/model/` — 需要列出 LiteLLM 模型
