# my-agent Prompt 清單

本文件詳細索引 my-agent 倉庫內所有 prompt 定義位置（排除 `vendor/`、`reference/`、`node_modules/`），每條附 1-2 句說明：什麼時候會用 + 主要內容大意。

> 產出時間：2026-05-09。檔案路徑為當時 snapshot；之後若有重構，請以 `git log` / 實際檔案為準。

---

## 1. 主系統 Prompt 組裝（每 turn 都會帶）

### 1.1 `src/constants/prompts.ts` 內主要 builder

| 位置 | 名稱 | 說明 |
|---|---|---|
| L512-656 | `getSystemPrompt()` | 主 system prompt 組裝器，按序組 intro/system/doing-tasks/actions/using-tools/tone-style/output-efficiency + 動態（session_guidance/user_profile/memory），支援 proactive 分支 |
| L183-212 | `getSimpleIntroSection()` | 身份宣告 + 網安聲明，啟用 output-style 時改用「Output Style」措辭 |
| L216-229 | `getSimpleSystemSection()` | 工具/tag/hooks 規則（已外部化至 `system.md`） |
| L233-291 | `getSimpleDoingTasksSection()` | 任務執行準則 + 程式碼風格（ANT 版另含假索賠/bug 回報） |
| L307-309 | `getActionsSection()` | 可逆/不可逆動作守則 |
| L314-368 | `getUsingYourToolsSection()` | 工具選擇指南，引導用 Read/Edit/Glob/Grep 取代 Bash |
| L370-374 | `getAgentToolSection()` | Agent 工具叫用指南（fork 啟用時改寫） |
| L406-454 | `getSessionSpecificGuidanceSection()` | 動態 session guidance（AskUserQuestion / fork / Skill / Verification）依 feature flag 條件組 |
| L472-486 | `getOutputEfficiencySection()` | 輸出簡潔原則 |
| L490-510 | `getSimpleToneAndStyleSection()` | 風格指南（無 emoji、file:line、GH issue 格式） |
| L685-731 | `computeEnvInfo()` | 完整環境資訊（已淘汰） |
| L733-795 | `computeSimpleEnvInfo()` | 簡化環境資訊（CWD/git/shell/OS/model ID）— 主版 |
| L847-849 | `getDefaultAgentPrompt()` | Sub-agent 預設 system prompt 入口 |
| L854-885 | `enhanceSystemPromptWithEnvDetails()` | Sub-agent prompt 補環境 + Skill discover |
| L893-919 | `getScratchpadInstructions()` | Scratchpad 目錄指引（含 `{scratchpadDir}` 插值） |
| L921-943 | `getFunctionResultClearingSection()` | FRC 微壓縮說明（feature flag） |
| L972-1039 | `getProactiveSection()` | 自主模式（Tick/Sleep/terminal focus） |

### 1.2 `src/utils/systemPrompt.ts`

- L41-123 `buildEffectiveSystemPrompt()` — 按優先序組裝：override > coordinator > agent > custom > default

### 1.3 外部化 Sections

定義在 `src/systemPromptFiles/sections.ts`，預設文字打包在 `src/systemPromptFiles/bundledDefaults.ts`（首次 seed + fallback），使用者可覆寫於 `~/.my-agent/system-prompt/*.md`。

| Section | 用途 |
|---|---|
| `intro.md` | 身份宣告 + 網安聲明 |
| `system.md` | 工具/tag/hook 規則 |
| `doing-tasks.md` | 任務執行準則 |
| `actions.md` | 可逆/不可逆動作守則 |
| `using-tools.md` | 工具選擇指南 |
| `tone-style.md` | 回應風格 |
| `output-efficiency.md` | 輸出簡潔 |
| `proactive.md` | 自主工作（feature 啟用） |
| `skills-guidance.md` | SkillManage 指導 |
| `numeric-length-anchors.md` | 輸出字數上限（ANT） |
| `token-budget.md` | Token 預算（feature） |
| `scratchpad.md` | Scratchpad 路徑 |
| `frc.md` | Function Result Clearing（feature） |
| `summarize-tool-results.md` | 工具結果摘要規則 |
| `default-agent.md` | Sub-agent 預設 |
| `cyber-risk.md` | 網安聲明 |
| `user-profile-frame.md` | `<user-profile>` 外框 |
| `errors/max-turns.md` 等 | QueryEngine 錯誤訊息 |
| `memory/types-*.md`、`memory/what-not-to-save.md` 等 8+ 個 | Memory 系統說明 |

---

## 2. Sub-LLM / Sub-agent Prompts

> **M-SP-FULL Phase 3（2026-05-10）**：5 條已外部化（標 ✅ 外部化）— 使用者可改 `~/.my-agent/system-prompt/subllm/<name>.md`。
> 其餘 prompt builder（agent-tool 動態組裝 / extractMemories 4 條 composition）外部化會 lose 條件邏輯，留 M-SP-SUBLLM-COMPOSITION milestone。

| 位置 | 用途 | M-SP 狀態 |
|---|---|---|
| `src/utils/cronNlParser.ts:30-45` | **Cron NL Parser** — 自然語言排程 → 5-field cron JSON（避免 :00/:30 整點） | ✅ `subllm/cron-parser.md` |
| `src/services/api/claude.ts:3212` | **queryHaiku()** — Haiku 小模型查詢入口（cron/memory/tool 摘要共用，含 llama.cpp 直通） | n/a（管線非 prompt） |
| `src/services/api/claude.ts:3184` | **buildSystemPromptBlocks()** — system prompt 切 block 並注入 cache control | n/a |
| `src/memdir/findRelevantMemories.ts:69` | **buildSelectMemoriesSystemPrompt()** — 記憶選擇器（Sonnet），依檔名 + description 挑 ≤N 條相關記憶 | ✅ `subllm/memory-selector.md`（`{maxFiles}` 插值） |
| `src/services/extractMemories/prompts.ts:36` | **personaSection()** — Persona/USER.md 編輯規則（≤80 chars/行、global vs project） | ⏸ Tier D（M-SP-SUBLLM-COMPOSITION） |
| `src/services/extractMemories/prompts.ts:61` | **opener()** — Memory extractor 開場（並行讀寫、turn budget 策略） | ⏸ Tier D |
| `src/services/extractMemories/prompts.ts:82` | **buildExtractAutoOnlyPrompt()** — Auto-only 記憶抽取（4 type / frontmatter / MEMORY.md 索引） | ⏸ Tier D |
| `src/services/extractMemories/prompts.ts:134` | **buildExtractCombinedPrompt()** — Auto + team memory 抽取（私人 vs 團隊目錄） | ⏸ Tier D |
| `src/userModel/prompt.ts:20` | **formatUserProfileBlock()** — `<user-profile>` 區塊（>1500 chars 警告） | n/a（純包裝） |
| `src/userModel/prompt.ts:50` | **loadUserProfilePrompt()** — 載入 user profile snapshot | n/a（loader） |
| `src/memdir/memdir.ts:33-146` | **memdir loader** — MEMORY.md 載入 + 截斷（200 行/25K bytes）+ 目錄存在指南 | n/a |
| `src/tools/AgentTool/prompt.ts:14-112` | **Agent tool prompt** — sub-agent 可用工具列表 + 何時 fork + 如何寫 prompt | ⏸ Tier D（200 行 9+ feature flag） |
| `src/tools/AgentTool/built-in/verificationAgent.ts:10` | **VERIFICATION_SYSTEM_PROMPT** — 驗證特化 sub-agent（不改檔、不 git write、跑 build/test/lint、敵對探測） | ✅ `subllm/verification-agent.md`（`{BASH_TOOL_NAME}`, `{WEB_FETCH_TOOL_NAME}` 插值） |

---

## 3. Memory / Session / Docs / 本地模型 Prompts

| 位置 | 用途 |
|---|---|
| `src/services/SessionMemory/prompts.ts:11` | **DEFAULT_SESSION_MEMORY_TEMPLATE** — 8 區段樣板（Title/Current State/Files/Workflow/Errors/Learnings/Worklog） | ✅ 自有外部化：`~/.my-agent/session-memory/config/template.md` |
| `src/services/SessionMemory/prompts.ts:43` | **getDefaultUpdatePrompt()** — 會話記憶更新指令（保留 section header） | ✅ 自有外部化：`~/.my-agent/session-memory/config/prompt.md` |
| `src/services/MagicDocs/prompts.ts:8` | **getUpdatePromptTemplate()** — Magic Docs 自動更新（`{{docPath}}/{{docContents}}/{{docTitle}}/{{customInstructions}}` 模板） | ✅ 自有外部化：`~/.my-agent/magic-docs/prompt.md` |
| `src/services/toolUseSummary/toolUseSummaryGenerator.ts:15` | **TOOL_USE_SUMMARY_SYSTEM_PROMPT** — Haiku 生成 ≤30 字元 git-commit 風格工具摘要 | ✅ M-SP `subllm/tool-use-summary.md` |
| `src/llamacppConfig/bundledTemplate.ts:14` | **LLAMACPP_JSONC_TEMPLATE** — 本地 llama.cpp 設定 JSONC 預設（client + server 層全繁中註解） | n/a（config 模板） |
| `src/coordinator/coordinatorMode.ts:79` | **getCoordinatorUserContext()** — Coordinator 模式 worker 工具/MCP 清單 | ⏸ Tier C（7 成動態組裝） |

---

## 4. Tool Descriptions（41 個工具，`src/tools/<Name>/prompt.ts`）

### 4.1 檔案 / Shell

| 工具 | 說明 |
|---|---|
| **Read** | 讀本機檔案（圖片/PDF/Jupyter），絕對路徑 |
| **Write** | 寫檔案（建新或全重寫） |
| **Edit** | 精確字串替換（必先 Read） |
| **Glob** | glob pattern 找檔案 |
| **Grep** | ripgrep 強力搜尋（取代 bash grep） |
| **Bash** | shell 指令（檔案類優先用專門 tool） |
| **PowerShell** | PowerShell 5.1/7+，Windows 專用 |
| **NotebookEdit** | Jupyter cell 替換/增/刪 |
| **LSP** | 跳定義/找引用/hover |

### 4.2 Agent / Task / Team

| 工具 | 說明 |
|---|---|
| **Agent** | 啟動 sub-agent（subagent_type / fork / 背景） |
| **TaskCreate** | 建任務清單（≥3 步驟複雜任務） |
| **TaskUpdate** | 更新任務狀態 / desc / owner / deps |
| **TaskGet** | 按 ID 取任務 |
| **TaskList** | 列任務摘要 |
| **TaskStop** | 停背景任務 |
| **TodoWrite** | session 內 todo 清單追蹤 |
| **TeamCreate** | 建多 agent team + 對應任務目錄 |
| **TeamDelete** | 移除 team + 任務目錄 |

### 4.3 Plan / Worktree Mode

| 工具 | 說明 |
|---|---|
| **EnterPlanMode** | 進計畫模式（多方案/重大架構決策） |
| **ExitPlanMode** | 退出 + 請求批准（僅實作計畫） |
| **EnterWorktree** | 建並進入隔離 git worktree |
| **ExitWorktree** | 退出 worktree（保留/刪除分支） |

### 4.4 Web / Browser

| 工具 | 說明 |
|---|---|
| **WebFetch** | 抓 URL + AI 處理（15min cache） |
| **WebSearch** | 搜尋網路（含 source list） |
| **WebCrawl** | BFS 爬站（遵守 robots.txt） |
| **WebBrowser** | 真實 Chromium 互動 SPA/Gmail/Maps |

### 4.5 Memory / Session

| 工具 | 說明 |
|---|---|
| **Memory** | 跨對話持久記憶（add/replace/remove） |
| **SessionSearch** | 搜過去 session（非當前 session 內容） |

### 4.6 MCP

| 工具 | 說明 |
|---|---|
| **ListMcpResourcesTool** | 列 MCP server 資源 |
| **ReadMcpResource** | 讀 MCP 資源（server + URI） |
| **MCPTool** | MCP runtime 整合（提示在 runtime 覆寫） |

**外部 MCP server（已知客戶端）**：

| 來源 | server | 暴露 tool |
|---|---|---|
| virtual-assistant-desktop（桌寵；my-agent 唯一 mascot 客戶端） | `MascotMcpServer`（HTTP，per-request stateless，由桌寵自架；用 `cli mcp add --scope user --transport http` 註冊到 `~/.my-agent/mcp.json`） | `set_expression` / `play_animation` / `say` / `look_at_screen` |

整合詳情見 `docs/mascot-integration.md`。

### 4.7 通訊 / UI

| 工具 | 說明 |
|---|---|
| **AskUserQuestion** | 多選題收集偏好 / 澄清 |
| **SendUserMessage** (Brief) | 主用戶回覆通道（markdown + 附件） |
| **SendMessage** | 跨 agent / cross-session peer 傳訊 |

### 4.8 排程 / 自主

| 工具 | 說明 |
|---|---|
| **CronCreate** (ScheduleCronTool) | 排程未來執行（一次性 / cron） |
| **RemoteTrigger** | CCR API 管理遠端排程 agent |
| **Sleep** | 等待時間（可中斷、可並行） |

### 4.9 設定 / 工具自身

| 工具 | 說明 |
|---|---|
| **Skill** | 主對話內叫 skill |
| **SkillManage** | 建/改/刪 skill（5+ tool 後可保存） |
| **ToolSearch** | 取延遲 tool 的 schema |
| **Config** | my-agent 設定（theme/model/permissions） |

---

## 5. Bundled Skills（27 個，`src/skills/bundled/*.ts`）

### 5.1 文件

| Skill | 觸發 / 能力 |
|---|---|
| **docx** | Word 文件建立/編輯（提及 .docx 即觸發） |
| **xlsx** | 試算表（.xlsx/.csv/.tsv） |
| **pptx** | PowerPoint 建立/編輯/合併 |
| **pdf** | PDF 抽文/合併/分割/OCR |
| **internal-comms** | 3P 更新 / FAQ / 狀態報告範本 |

### 5.2 視覺 / 設計

| Skill | 觸發 / 能力 |
|---|---|
| **canvas-design** | 海報/藝術 .png/.pdf |
| **algorithmic-art** | p5.js 生成藝術 |
| **frontend-design** | 高品質 UI 元件/頁面 |
| **theme-factory** | 字體/配色主題庫 |
| **slack-gif-creator** | Slack 動畫 GIF |
| **brand-guidelines** | 品牌識別 |

### 5.3 開發

| Skill | 觸發 / 能力 |
|---|---|
| **web-artifacts-builder** | React+TS+Tailwind+shadcn 完整 web app |
| **webapp-testing** | Playwright 本地 web 測試 |
| **mcp-builder** | 建 MCP server (Python/TS) |
| **anthropic-sdk-reference** (claudeApi) | Claude API 多語 SDK 參考 |

### 5.4 工作流 / 自動化

| Skill | 觸發 / 能力 |
|---|---|
| **skill-creator** | 建/改/評估/最佳化 skill |
| **batch** | 多並行 worker 大規模程式碼變更 |
| **loop** | 排程遞迴提示（fixed / 自動節奏） |
| **schedule** | 雲端 cron 排程遠端 agent |
| **simplify** | 三 agent 並行 review（reuse/quality/security） |

### 5.5 設定 / 偵錯

| Skill | 觸發 / 能力 |
|---|---|
| **keybindings-help** | 自訂鍵盤快捷 |
| **update-config** | settings.json 配置 |
| **debug** | 啟偵錯日誌診斷 |
| **stuck** | 診斷凍結/慢 session |
| **doc-coauthoring** | 三階段文檔協作 |
| **verify** | 驗證程式碼變更達預期（內部） |
| **remember** | 記憶體複習（內部） |
| **skillify** | 從 session 抽流程成 skill |
| **lorem-ipsum** | 佔位符文本 |

---

## 6. Slash Commands（`src/commands/`）

### 6.1 帶動態 LLM prompt 的（13 個）

| 指令 | 說明 |
|---|---|
| `/commit` | LLM 看 git diff 寫 commit（遵 git safety） |
| `/commit-push-pr` | 完整 PR flow：diff 分析 → 分支 → push → PR（可 Slack 通知） |
| `/review` | LLM 審 PR（質量/風格/效能/測試/安全） |
| `/security-review` | 三階段深度安全審：repo context → comparative → vulnerability |
| `/init-verifiers` | 多階段建 verifier skill（Playwright/Tmux/HTTP） |
| `/init` | 5 階段設 MY-AGENT.md（探索 → 詢問 → 偵測 build/test → 生成） |
| `/insights` | 生 session 分析 HTML 報告（What's working / Quick wins） |
| `/statusline` | 觸 statusline-setup subagent 客製狀態列 |
| `/ultraplan` | 雲端遠端計畫模式（30min 多 agent 探索） |
| `/brief` | Brief-only 切換（只用 Brief tool） |
| `/daemon` | daemon lifecycle（on/off/attach/detach） |
| `/web` | Web UI 控制（待 LLM prompt 實裝） |
| `/cron` | 互動式 cron 管理（每排程任務帶自己的 prompt） |

### 6.2 純 UI / 狀態管理（無動態 prompt，~50 個）

`/agents` `/branch` `/config` `/clear` `/context` `/cost` `/diff` `/effort` `/export` `/files` `/help` `/hooks` `/ide` `/keybindings` `/memory` `/plan` `/permissions` `/theme` `/tools` `/version` `/status` `/stats` `/tag` `/tasks` `/memory-delete` `/resume` `/trash` `/session` `/session-delete` `/add-dir` `/btw` `/color` `/discord` `/doctor` `/heapdump` `/mcp` `/plugin` `/reload-plugins` `/rename` `/release-notes` `/vim` `/thinkback` `/thinkback-play` `/self-improve` 等。

### 6.3 Cron 任務 prompt

- `src/daemon/cronMutationRpc.ts` — 每 cron 任務結構 `{ cron, prompt, recurring, name?, scheduleSpec?, preRunScript? }`，觸發時 daemon subagent 用該 prompt。

---

## 統計總覽

| 類別 | 數量 |
|---|---|
| 主 system prompt builder | 17 個函數 |
| 外部化 sections | ~30 個 .md（含 errors/ memory/ 子目錄） |
| Sub-LLM prompts | ~13 條 |
| Memory/Session/Docs/Local prompts | 7 條 |
| Tool descriptions | **41 個** |
| Bundled skills | **27 個** |
| Slash commands（帶 LLM prompt） | 13 個 |
| Slash commands（純 UI） | ~50 個 |

**核心架構**：靜態主 prompt + 外部化 sections（使用者可改）+ 動態 sub-LLM/agent prompt + 工具/skill 描述（給 LLM 看的 menu）。支援 cache 分層、ANT 版本分支、feature flag 條件。
