# 工具呼叫整合測試結果 — llama.cpp provider

> M1 階段三產出。用 `qwen3.5-9b-neo`（Jackrong_Qwen3.5-9B-Neo Q5_K_M）透過
> `scripts/llama/serve.sh` 啟動的本地 llama-server，走 `src/services/api/llamacpp-fetch-adapter.ts`
> 翻譯層，驗證 free-code 每個工具的呼叫能不能端到端跑起來。

## 測試方法

每個工具都用**最小提示詞**誘導模型呼叫（不是測模型 prompt 工程能力、也不是測工具本身的功能）。
每項記錄四個維度：

| 維度 | 代號 | 問題歸屬 |
|------|------|---------|
| 模型是否選對工具 | **(a) 選擇** | 模型品質（非我方 bug）|
| adapter 工具呼叫格式翻譯是否正確 | **(b) 翻譯** | 我方 bug（須修 `llamacpp-fetch-adapter.ts`）|
| 工具實際是否成功執行 | **(c) 執行** | free-code 既有問題（通常不須改）|
| 結果是否正確顯示給使用者 | **(d) 顯示** | 串流狀態機或 UI 問題 |

狀態符號：`✅` 通過 · `❌` 失敗 · `⚠️` 部分通過 · `⏸️` 尚未測試 · `🚫` feature-gated 本地未啟用

## 環境

- 測試日期：2026-04-15
- llama-server build：b8457-149b2493c（CUDA 13.1）
- 模型：`models/Jackrong_Qwen3.5-9B-Neo-Q5_K_M.gguf`
- 上下文：32768 tokens（serve.sh 預設）
- free-code 版本：commit `9d4198e` 之後
- 測試腳本：
  - Part A 翻譯正確性：`scripts/poc/llamacpp-core-tools-poc.ts`
  - Part B 端到端：`scripts/poc/llamacpp-core-tools-e2e.sh`

## 前五個核心工具（優先測試）

全部 5/5 通過（Part A 翻譯 + Part B 端到端）。

| # | 工具 | (a) 選擇 | (b) 翻譯 | (c) 執行 | (d) 顯示 | 備註 |
|---|------|---------|---------|---------|---------|------|
| 1 | `BashTool` | ✅ | ✅ | ✅ | ✅ | `{"command":"ls -la"}` 正確；`echo MARKER` 端到端回傳 |
| 2 | `FileReadTool` | ✅ | ✅ | ✅ | ✅ | `{"file_path":"..."}` 正確；讀到 `READOK_MARKER_5678` |
| 3 | `FileWriteTool` | ✅ | ✅ | ✅ | ✅ | `{"file_path","content"}` 正確；檔案被寫入 |
| 4 | `FileEditTool` | ✅ | ✅ | ✅ | ✅ | `{"file_path","old_string","new_string"}` 正確；替換成功 |
| 5 | `GlobTool` | ✅ | ✅ | ✅ | ✅ | `{"pattern":"*.md"}` 正確；列出兩個 .md 檔 |

**注意**：Part B 在 Windows Git Bash 上必須用 `cygpath -m` 把 `/tmp/...` 轉成 `C:/Users/.../Temp/...` 格式的路徑給 `./cli`，否則 Bun/Node 的 fs API 會 ENOENT（見腳本註解與 LESSONS.md）。

## 其餘工具（可分批）

### 檔案 / 搜尋類

| # | 工具 | (a) | (b) | (c) | (d) | 備註 |
|---|------|----|----|----|----|------|
| 6 | `GrepTool` | ⏸️ | ⏸️ | ⏸️ | ⏸️ | |
| 7 | `NotebookEditTool` | ⏸️ | ⏸️ | ⏸️ | ⏸️ | Jupyter notebook 編輯 |

### Shell / 環境類

| # | 工具 | (a) | (b) | (c) | (d) | 備註 |
|---|------|----|----|----|----|------|
| 8 | `PowerShellTool` | ⏸️ | ⏸️ | ⏸️ | ⏸️ | Windows 11 原生可用 |
| 9 | `REPLTool` | ⏸️ | ⏸️ | ⏸️ | ⏸️ | |

### Web 類

| # | 工具 | (a) | (b) | (c) | (d) | 備註 |
|---|------|----|----|----|----|------|
| 10 | `WebFetchTool` | ⏸️ | ⏸️ | ⏸️ | ⏸️ | |
| 11 | `WebSearchTool` | ⏸️ | ⏸️ | ⏸️ | ⏸️ | |

### Agent / 任務管理類

| # | 工具 | (a) | (b) | (c) | (d) | 備註 |
|---|------|----|----|----|----|------|
| 12 | `AgentTool` | ⏸️ | ⏸️ | ⏸️ | ⏸️ | 派生子 agent |
| 13 | `TaskCreateTool` | ⏸️ | ⏸️ | ⏸️ | ⏸️ | |
| 14 | `TaskGetTool` | ⏸️ | ⏸️ | ⏸️ | ⏸️ | |
| 15 | `TaskListTool` | ⏸️ | ⏸️ | ⏸️ | ⏸️ | |
| 16 | `TaskUpdateTool` | ⏸️ | ⏸️ | ⏸️ | ⏸️ | |
| 17 | `TaskStopTool` | ⏸️ | ⏸️ | ⏸️ | ⏸️ | |
| 18 | `TaskOutputTool` | ⏸️ | ⏸️ | ⏸️ | ⏸️ | |
| 19 | `TodoWriteTool` | ⏸️ | ⏸️ | ⏸️ | ⏸️ | |

### Plan / Session 控制類

| # | 工具 | (a) | (b) | (c) | (d) | 備註 |
|---|------|----|----|----|----|------|
| 20 | `EnterPlanModeTool` | ⏸️ | ⏸️ | ⏸️ | ⏸️ | |
| 21 | `ExitPlanModeTool` | ⏸️ | ⏸️ | ⏸️ | ⏸️ | |
| 22 | `EnterWorktreeTool` | ⏸️ | ⏸️ | ⏸️ | ⏸️ | |
| 23 | `ExitWorktreeTool` | ⏸️ | ⏸️ | ⏸️ | ⏸️ | |
| 24 | `VerifyPlanExecutionTool` | ⏸️ | ⏸️ | ⏸️ | ⏸️ | |

### 互動類

| # | 工具 | (a) | (b) | (c) | (d) | 備註 |
|---|------|----|----|----|----|------|
| 25 | `AskUserQuestionTool` | ⏸️ | ⏸️ | ⏸️ | ⏸️ | 互動；非互動 session 可能 skip |
| 26 | `SleepTool` | ⏸️ | ⏸️ | ⏸️ | ⏸️ | |

### LSP / 程式碼分析類

| # | 工具 | (a) | (b) | (c) | (d) | 備註 |
|---|------|----|----|----|----|------|
| 27 | `LSPTool` | ⏸️ | ⏸️ | ⏸️ | ⏸️ | |
| 28 | `BriefTool` | ⏸️ | ⏸️ | ⏸️ | ⏸️ | 程式碼摘要 |

### MCP 類

| # | 工具 | (a) | (b) | (c) | (d) | 備註 |
|---|------|----|----|----|----|------|
| 29 | `MCPTool` | ⏸️ | ⏸️ | ⏸️ | ⏸️ | |
| 30 | `ListMcpResourcesTool` | ⏸️ | ⏸️ | ⏸️ | ⏸️ | |
| 31 | `ReadMcpResourceTool` | ⏸️ | ⏸️ | ⏸️ | ⏸️ | |
| 32 | `McpAuthTool` | ⏸️ | ⏸️ | ⏸️ | ⏸️ | |

### 設定 / 技能類

| # | 工具 | (a) | (b) | (c) | (d) | 備註 |
|---|------|----|----|----|----|------|
| 33 | `ConfigTool` | ⏸️ | ⏸️ | ⏸️ | ⏸️ | |
| 34 | `SkillTool` | ⏸️ | ⏸️ | ⏸️ | ⏸️ | |
| 35 | `ToolSearchTool` | ⏸️ | ⏸️ | ⏸️ | ⏸️ | 搜尋 deferred tools |
| 36 | `SendMessageTool` | ⏸️ | ⏸️ | ⏸️ | ⏸️ | |
| 37 | `SyntheticOutputTool` | ⏸️ | ⏸️ | ⏸️ | ⏸️ | |
| 38 | `TungstenTool` | ⏸️ | ⏸️ | ⏸️ | ⏸️ | |
| 39 | `WorkflowTool` | 🚫 | 🚫 | 🚫 | 🚫 | feature `WORKFLOW_SCRIPTS` — 預設關 |

### Feature-gated（預設通常不啟用，列入以免漏算）

| # | 工具 | 狀態 | Feature flag |
|---|------|------|--------------|
| 40 | `ScheduleCronTool` | 🚫 | `AGENT_TRIGGERS` |
| 41 | `RemoteTriggerTool` | 🚫 | `AGENT_TRIGGERS_REMOTE` |
| 42 | `TeamCreateTool` | 🚫 | Team mode |
| 43 | `TeamDeleteTool` | 🚫 | Team mode |

## 測試腳本

測試以獨立 bun 腳本進行（不走 `./cli` 以避免互動環境影響結果），參照
`scripts/poc/llamacpp-tool-streaming-poc.ts` 模式，針對每個工具自行撰寫
誘導 prompt 與斷言。測試產出物（若有）寫到 `tests/integration/test-output*`
命名，完成後清理。

## 發現的翻譯 Bug（若有）

**前 5 核心工具階段無翻譯 bug**。唯一發現的是測試 fixture 問題（Git Bash `/tmp/` 路徑不被 Windows 下 Bun fs API 認），非 adapter 缺陷，已在測試腳本內用 `cygpath -m` 轉換解決。

## 翻譯正確性總結（進行中）

- 翻譯成功率：5/43（前 5 核心工具）
- 模型選擇成功率：5/43（前 5 核心工具）
- 工具執行成功率：5/43（前 5 核心工具）

其餘 34 個工具將分批補完（TODO 階段三第三項）。
