# 工具呼叫整合測試結果 — llama.cpp provider

> M1 階段三產出。用 `qwen3.5-9b-neo`（Jackrong_Qwen3.5-9B-Neo Q5_K_M）透過
> `scripts/llama/serve.sh` 啟動的本地 llama-server，走 `src/services/api/llamacpp-fetch-adapter.ts`
> 翻譯層，驗證 free-code 每個工具的呼叫能不能端到端跑起來。

## 測試方法

每個工具都用**最小提示詞**誘導模型呼叫。每項記錄四個維度：

| 維度 | 代號 | 問題歸屬 |
|------|------|---------|
| 模型是否選對工具 | **(a) 選擇** | 模型品質（非我方 bug）|
| adapter 工具呼叫格式翻譯是否正確 | **(b) 翻譯** | 我方 bug（須修 `llamacpp-fetch-adapter.ts`）|
| 工具實際是否成功執行 | **(c) 執行** | free-code 既有問題（通常不須改）|
| 結果是否正確顯示給使用者 | **(d) 顯示** | 串流狀態機或 UI 問題 |

狀態符號：`✅` 通過 · `❌` 失敗 · `⚠️` 部分通過 · `⏸️` 尚未測試 · `🚫` feature-gated 本地未啟用 · `—` 不適用

## 環境

- 測試日期：2026-04-15
- llama-server build：b8457-149b2493c（CUDA 13.1）
- 模型：`models/Jackrong_Qwen3.5-9B-Neo-Q5_K_M.gguf`
- 上下文：32768 tokens（serve.sh 預設）
- free-code 版本：commit `a8694da` 之後
- 測試腳本：
  - Part A 翻譯（前 5）：`scripts/poc/llamacpp-core-tools-poc.ts`
  - Part A 翻譯（其餘 34）：`scripts/poc/llamacpp-rest-tools-poc.ts`
  - Part B E2E（前 5）：`scripts/poc/llamacpp-core-tools-e2e.sh`

---

## 前五個核心工具（Part A + Part B）

全部 5/5 通過，四維度均綠。

| # | 工具 | (a) 選擇 | (b) 翻譯 | (c) 執行 | (d) 顯示 | 備註 |
|---|------|---------|---------|---------|---------|------|
| 1 | `BashTool` | ✅ | ✅ | ✅ | ✅ | `echo MARKER` 端到端回傳 |
| 2 | `FileReadTool` | ✅ | ✅ | ✅ | ✅ | 讀到 `READOK_MARKER_5678` |
| 3 | `FileWriteTool` | ✅ | ✅ | ✅ | ✅ | 檔案被寫入 |
| 4 | `FileEditTool` | ✅ | ✅ | ✅ | ✅ | 替換成功 |
| 5 | `GlobTool` | ✅ | ✅ | ✅ | ✅ | 列出兩個 .md |

---

## 其餘 34 個工具（Part A 翻譯）

adapter 翻譯 34/34 綠（`TaskCreate` 首次 run 模型選了 end_turn，重試成功 —
模型選擇 variance，非 adapter bug）。Part B 沒跑（依賴外部資源、互動環境、
或 feature gate；標於備註）。

### 檔案 / 搜尋類

| # | 工具 | (a) | (b) | (c)/(d) | 實際 input 範例 |
|---|------|----|----|---------|-----------------|
| 6 | `Grep` | ✅ | ✅ | ⏸️ Part B | `{"pattern":"import","type":"ts"}` |
| 7 | `NotebookEdit` | ✅ | ✅ | ⏸️ 需 .ipynb fixture | `{"notebook_path":"/tmp/note.ipynb","cell_number":0,"new_source":"print(1)"}` |

### Shell / 環境類

| # | 工具 | (a) | (b) | (c)/(d) | 實際 input 範例 |
|---|------|----|----|---------|-----------------|
| 8 | `PowerShell` | ✅ | ✅ | ⏸️ Part B | `{"command":"Get-ChildItem"}` |
| 9 | `REPL` | ✅ | ✅ | ⏸️ 需 kernel | `{"code":"print(2+2)","language":"python"}` |

### Web 類

| # | 工具 | (a) | (b) | (c)/(d) | 實際 input 範例 |
|---|------|----|----|---------|-----------------|
| 10 | `WebFetch` | ✅ | ✅ | ⏸️ 需網路 | `{"url":"https://example.com"}` |
| 11 | `WebSearch` | ✅ | ✅ | ⏸️ 需 API key | `{"query":"llama.cpp latest release"}` |

### Agent / 任務管理類

| # | 工具 | (a) | (b) | (c)/(d) | 實際 input 範例 |
|---|------|----|----|---------|-----------------|
| 12 | `Agent` | ✅ | ✅ | ⏸️ 遞迴 sub-agent 複雜 | `{"description":"summarize README","prompt":"...","subagent_type":"..."}` |
| 13 | `TaskCreate` | ✅ | ✅ | ⏸️ 需 state chain | `{"description":"build feature X","prompt":"Implement X"}` |
| 14 | `TaskGet` | ✅ | ✅ | ⏸️ 需既有 task | `{"task_id":"task_abc123"}` |
| 15 | `TaskList` | ✅ | ✅ | ⏸️ | `{"status":"pending"}` |
| 16 | `TaskUpdate` | ✅ | ✅ | ⏸️ | `{"task_id":"task_xyz","status":"completed"}` |
| 17 | `TaskStop` | ✅ | ✅ | ⏸️ | `{"task_id":"task_xyz"}` |
| 18 | `TaskOutput` | ✅ | ✅ | ⏸️ | `{"task_id":"task_xyz","block":false,"timeout":30}` |
| 19 | `TodoWrite` | ✅ | ✅ | ⏸️ 需 session state | `{"todos":[{"content":"test adapter","status":"pending"}, ...]}` |

### Plan / Session 控制類

| # | 工具 | (a) | (b) | (c)/(d) | 實際 input 範例 |
|---|------|----|----|---------|-----------------|
| 20 | `EnterPlanMode` | ✅ | ✅ | — 互動類 | `{}` |
| 21 | `ExitPlanMode` | ✅ | ✅ | — 互動類 | `{}` |
| 22 | `EnterWorktree` | ✅ | ✅ | ⏸️ 需 git 狀態 | `{"worktree_path":"/tmp/worktree-branch","branch":"experiment"}` |
| 23 | `ExitWorktree` | ✅ | ✅ | — | `{}` |
| 24 | `VerifyPlanExecution` | ✅ | ✅ | — 需 plan context | `{}` |

### 互動類

| # | 工具 | (a) | (b) | (c)/(d) | 實際 input 範例 |
|---|------|----|----|---------|-----------------|
| 25 | `AskUserQuestion` | ✅ | ✅ | — 互動類；Part B 的 `-p` 模式自動跳過 | `{"questions":[{"header":"Choice","multiSelect":false, ...}]}` |
| 26 | `Sleep` | ✅ | ✅ | ⏸️ | `{"seconds":2}` |

### LSP / 程式碼分析類

| # | 工具 | (a) | (b) | (c)/(d) | 實際 input 範例 |
|---|------|----|----|---------|-----------------|
| 27 | `LSP` | ✅ | ✅ | ⏸️ 需 LSP server | `{"action":"definition","file_path":"/tmp/src/file.ts","symbol":"getAPIProvider"}` |
| 28 | `Brief` | ✅ | ✅ | ⏸️ 需大檔 | `{"file_path":"/tmp/bigfile.ts"}` |

### MCP 類

| # | 工具 | (a) | (b) | (c)/(d) | 實際 input 範例 |
|---|------|----|----|---------|-----------------|
| 29 | `MCP` | ✅ | ✅ | ⏸️ 需 MCP server | `{"server":"filesystem","method":"read","params":{"path":"/tmp/x.txt"}}` |
| 30 | `ListMcpResources` | ✅ | ✅ | ⏸️ 需 MCP server | `{"server":"filesystem"}` |
| 31 | `ReadMcpResource` | ✅ | ✅ | ⏸️ 需 MCP server | `{"server":"filesystem","uri":"file:///tmp/x.txt"}` |
| 32 | `McpAuth` | ✅ | ✅ | ⏸️ 需 MCP server | `{"server":"github"}` |

### 設定 / 技能類

| # | 工具 | (a) | (b) | (c)/(d) | 實際 input 範例 |
|---|------|----|----|---------|-----------------|
| 33 | `Config` | ✅ | ✅ | ⏸️ | `{"action":"get","key":"model"}` |
| 34 | `Skill` | ✅ | ✅ | ⏸️ 需 skill 存在 | `{"skill":"commit"}` |
| 35 | `ToolSearch` | ✅ | ✅ | ⏸️ 需 deferred tools | `{"query":"notebook","max_results":3}` |
| 36 | `SendMessage` | ✅ | ✅ | ⏸️ 需 messaging backend | `{"to":"alice","message":"hello"}` |
| 37 | `SyntheticOutput` | ✅ | ✅ | — 內部用 | `{"type":"summary","content":"done"}` |
| 38 | `Tungsten` | ✅ | ✅ | ⏸️ 需 Tungsten backend | `{"query":"what is 2+2"}` |
| 39 | `Workflow` | ✅ | ✅ | 🚫 feature `WORKFLOW_SCRIPTS` 關 | `{"name":"build","input":"release"}` |

### Feature-gated（預設未啟用，adapter 無關）

| # | 工具 | 狀態 | Feature flag |
|---|------|------|--------------|
| 40 | `ScheduleCronTool` | 🚫 | `AGENT_TRIGGERS` |
| 41 | `RemoteTriggerTool` | 🚫 | `AGENT_TRIGGERS_REMOTE` |
| 42 | `TeamCreateTool` | 🚫 | Team mode |
| 43 | `TeamDeleteTool` | 🚫 | Team mode |

---

## 發現的翻譯 Bug（若有）

**無**。adapter 在 39 個可測工具上全部 0 個翻譯 bug：
- 複雜 schema（nested object in `MCP.params`、array of object 在 `TodoWrite.todos` / `AskUserQuestion.questions`）處理正確
- 空物件 schema（`EnterPlanMode`、`ExitPlanMode` 等）處理正確
- 型別混合（`TaskOutput` 的 `string + boolean + number`）處理正確
- 布林 / 數字型別保留而非 stringify

測試期間發現的兩個**非 adapter 問題**已記 LESSONS.md：
1. Git Bash `/tmp/...` 虛擬路徑不被 Windows Bun fs API 認 → 測試腳本改用 `cygpath -m`
2. `ANTHROPIC_API_KEY=dummy` 會讓 CLI bootstrap 卡住 → 不要設

## 翻譯正確性總結

- 模型選擇成功率：38/39（97%） — TaskCreate 首次 run 選了 text，重試綠
- **adapter 翻譯成功率：39/39（100%）** — 在有測到的工具上零翻譯 bug
- 工具實際執行驗證：5/39（前 5 核心工具 Part B 全綠；其餘需外部依賴未跑）
- Feature-gated：4（未計入總數）

**結論**：llamacpp-fetch-adapter 在可觀察的所有 schema shape 上翻譯正確。剩餘 34 個的 Part B E2E 大多需外部依賴（MCP server、LSP server、網路、互動環境），本階段暫不補，列入後續工作。
