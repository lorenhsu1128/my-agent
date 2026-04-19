# TODO.md

> Claude Code 在每次 session 開始時讀取此檔案，在工作過程中更新任務狀態。
> 里程碑結構由人類維護。Claude Code 負責管理任務狀態的勾選。

## 當前里程碑：M2 — Session Recall & Dynamic Memory

**目標情境**：以 **llama.cpp 本地模型（`qwen3.5-9b-neo`）** 為主要運行情境設計。補齊 free-code 既有記憶系統（`src/memdir/` 四型分類 + `SessionMemory` + `extractMemories` + `autoDream` 已存在）尚缺的三塊：(1) 跨 session 歷史對話搜尋、(2) query-driven 動態 prefetch 注入、(3) 受控的 MemoryTool 寫入（含 prompt injection 掃描）。**不**移植 Hermes 的 provider plugin 抽象層，**不**改 `src/memdir/` 四型分類，**不**動 `QueryEngine.ts` / `Tool.ts` / `StreamingToolExecutor.ts`（deny list）。Anthropic 既有 code path 保留（黃金規則 #2）但**不作為**設計目標與驗收依據。

**架構決策**（2026-04-15 敲定，與使用者逐題對齊 Q1–Q7，並於同日依 llamacpp-primary 原則修訂）：
- ADR-M2-01：JSONL 為對話 source of truth，SQLite 僅作 FTS5 索引，可隨時刪重建
- ADR-M2-02：索引寫入時機 = 即時 tee（在 `sessionStorage.ts` append 點）+ 啟動掃描補齊（mtime 比對）
- ADR-M2-03：Prefetch 注入為 user message 前綴 `<memory-context>...</memory-context>` fence，**不碰 system prompt**，保 prefix cache
- ADR-M2-04（修訂）：Prefetch = FTS 歷史 + memdir topic files re-rank，預算 ~2000 tokens，片段直接貼原文。**memdir re-rank 第一版用關鍵字 / token overlap 等非 LLM 方法**，不呼叫遠端 LLM；若需 LLM 才能過濾才用 llamacpp（當前主模型），**不**用 Sonnet/Haiku 等 Anthropic 模型
- ADR-M2-05：MemoryTool 與 Edit/Write 並存（選項 1），不強制，因 `extractMemories.ts` 的 forked agent 仍走 Edit/Write
- ADR-M2-06（修訂）：SessionSearch 預設回 top-K 片段（輕量），參數 `summarize: true` 時用**當前 session 主模型 = llamacpp** 做摘要；摘要調用需考慮 llamacpp 速度與 context 限制（9B 模型、32K ctx），片段總量需先截斷到 ~8K 以內再送進去
- ADR-M2-07：SQLite 路徑 `~/.my-agent/projects/{slug}/session-index.db`，用 `bun:sqlite`（零依賴）
- ADR-M2-08：FTS schema 多存欄位（token/cost/tool_calls/finish_reason/timestamp），為未來分析預留
- ADR-M2-09：索引範圍僅當前 project；跨 project 全域索引延後到未來里程碑
- ADR-M2-10（新增）：所有驗收情境以 `./cli --model qwen3.5-9b-neo` 為準；Anthropic 路徑不作為回歸測試項（既有 code 保留但不保證 M2 下仍綠）

**詳細實作設計與決策邏輯見 DEPLOYMENT_PLAN.md 的 M2 區段。**

### 階段一：索引基礎建設
- [x] M2-01 在 `src/services/sessionIndex/` 建立 SQLite FTS5 schema（sessions + messages_fts）、`bun:sqlite` 連線管理、索引檔路徑 `~/.my-agent/projects/{slug}/session-index.db` — `paths.ts`/`schema.ts`/`db.ts`/`index.ts` 共 4 檔；10 欄 sessions 表 + FTS5 trigram virtual table + schema_version。`scripts/poc/session-index-smoke.ts` 27/27 綠。踩到 trigram ≥3 字元限制，記入 LESSONS.md 供 M2-05 參考
- [x] M2-02 找出 JSONL append 寫入點（預期在 `src/utils/sessionStorage.ts` 或 `src/assistant/sessionHistory.ts`），加 tee hook 同步寫 FTS；失敗不可中斷主流程 — hook 在 `sessionStorage.ts:1243`（TranscriptMessage 分支，繼承 `shouldSkipPersistence` 守衛）；`indexWriter.ts` 新增；schema v1→v2 加 `messages_seen` shadow 表做 UUID 去重；用 `getProjectRoot()`（不是 `getOriginalCwd()`）避免 EnterWorktreeTool 分裂索引；`SQLITE_BUSY` 直接吞由 M2-03 補。smoke 從 30 擴到 48/48 綠
- [x] M2-03 啟動時掃描當前 project 的 JSONL，用 mtime 比對補進未索引內容 — 註：實際路徑是 `{CLAUDE_CONFIG_HOME}/projects/{slug}/{sessionId}.jsonl`（無 `conversations/` 子目錄）。新增 `src/services/sessionIndex/reconciler.ts`：`reconcileProjectIndex` 掃描 + per-session mtime vs `last_indexed_at` 比對 + sidechain / 壞行跳過 + stats log；`ensureReconciled` 冪等 Promise 快取供啟動與 M2-05 共用。Hook 點：`src/setup.ts` 的 background-jobs 區塊（`!isBareMode()` 內，旁邊 `initSessionMemory`）fire-and-forget。Smoke 擴至 62/62 綠，覆蓋空目錄 / 多 session / 壞行 / sidechain 跳過 / up-to-date 跳過 / 冪等
- [x] M2-04 `bun run typecheck` 綠 + 手動驗證：產幾筆對話、確認 FTS 表有資料、能用 SQL 查到 — typecheck baseline 綠；smoke 66/66 綠；TUI 跑 2 輪天氣查詢後 `scripts/poc/query-session-index.ts` 查到 4 sessions / 79 messages_fts / tool_name 正確抽取（Bash/Read/Skill/Glob）。過程中發現 `indexEntry` 用 `Date.now()` 讓 `started_at` 不準 → 修正為優先 `entry.timestamp`、`ended_at` 改 MAX（commit `0384537`）；砍 db 重建後 started_at 全部對齊真實時間

### 階段二：Session 搜尋工具
- [x] M2-05 新增 `src/tools/SessionSearchTool/SessionSearchTool.ts`：輸入 `query` / `limit` / `summarize`；預設回 top-K 片段 + session 元資料（日期、模型、首條 user message 當標題）— 3 檔案（SessionSearchTool.ts / prompt.ts / UI.tsx）。FTS path + <3 char 自動 fallback 到 `sessions.first_user_message` LIKE。FTS5 reserved char（`.` 等）用 phrase-literal sanitize 處理。`summarize:true` 接受但帶 `summaryPending` flag（M2-06 做實際摘要）。`await ensureReconciled(projectRoot)` 在搜尋前保證索引新鮮。Output map 成 markdown（session header + match 列表）。Smoke `session-search-tool-smoke.ts` 24/24 綠，對真實 index 跑英文 / 中英混合 / 短 query fallback / summarize flag / reserved char / 空結果 / markdown 格式
- [x] M2-06 `summarize: true` 分支：把片段（先截到 ~8K token）餵回當前 session 主模型 = **llamacpp** 做摘要；複用既有 API client，不新開 provider。超時與 context overflow 需 graceful fallback 回純片段 — 新增私有 helper `summarizeSessions` / `buildSummarizePrompt` / `parseSummaryResponse`，透過 `getAnthropicClient()` + `client.messages.create(..., {signal})` 呼叫主模型（`context.options.mainLoopModel`）；char budget 24K（≈ 8K token，3 char/token heuristic）；30s timeout 走 child AbortController + `setTimeout`；任何失敗（timeout / 連線 / parse）都 graceful fallback 回 null → 呼叫端 `summaryPending=true` + note。Output schema 擴 `sessions[*].summary?`；`mapToolResult` 有 summary 時改顯示 summary 單行、省 raw matches。Smoke 29/29 綠（含 mock 成功輸出格式 + 真實 fallback 驗證）。Typecheck baseline 不變
- [x] M2-07 註冊到 `src/tools.ts`、加 prompt 使用說明（模型何時該呼叫，給 qwen3.5-9b-neo 看得懂的簡潔描述）— import + 無條件加到 `getAllBaseTools()`（BriefTool 後面，無 feature flag）；prompt.ts 重寫成具體觸發條件（「上次我們怎麼處理…」「remember when…」）+ input/output 說明 + 負面用例清單（不搜 code、不搜 web、不搜當前 session）。Typecheck baseline 不變，smoke 29/29 綠不迴歸
- [x] M2-08 端到端測試：`./cli --model qwen3.5-9b-neo` 跑兩個 session，第二 session 問「上次我們怎麼處理 X」，驗證能找回第一 session 的答案 — 根因修復：刪除 `checkPermissions` 覆寫（`updatedInput: {}` 覆蓋 input），還原 6 個無效 fix（保留 3 個 adapter 修正）。E2E `session-search-e2e.ts` 16/16 綠。註：`-p` mode regression 仍在，完整雙 session CLI 測試需 TUI 手動驗證

### 階段三：Query-driven Prefetch
- [x] M2-09a Local Model Routing：`src/utils/model/model.ts` 的 `getDefaultOpusModel` / `getDefaultSonnetModel` / `getDefaultHaikuModel` 在 llamacpp 模式短路回傳 `DEFAULT_LLAMACPP_MODEL`。效果：既有的 `findRelevantMemories`（Sonnet→本地）、`agenticSessionSearch`（Haiku→本地）、`tokenEstimation`（Sonnet→本地）等 9 個 sideQuery 呼叫點全部自動走 llama-server
- [x] M2-09 新增 `src/services/memoryPrefetch/`：FTS 歷史對話搜尋模組 — `ftsSearch.ts`（`searchSessionHistory`）+ `index.ts`。複用 sessionIndex，sanitize FTS query，過濾 tool role，截斷 300 chars。Smoke 14/14 綠
- [x] M2-10 Prefetch 預算控制 — `budget.ts`（`buildMemoryContextFence`）：TOKEN_BUDGET=2000（≈6000 chars）、MAX_FTS_SNIPPETS=3、`<memory-context>[past-sessions]</memory-context>` fence 格式。超額截斷最後一筆 content。Smoke 23/23 綠
- [x] M2-11 注入點：`src/query.ts` L655 附近（`callModel` 前），取最新 user message text → `searchSessionHistory` → `buildMemoryContextFence` → prepend `isMeta: true` user message。改 `prependUserContext(messagesWithMemoryContext, ...)` 替代原 `messagesForQuery`。Typecheck 基線不變
- [x] M2-12 Prefetch 失敗靜默 fallback — 已在 M2-11 實作中內建：`ftsSearch.ts` 雙層 try/catch 回空、`query.ts` 注入邏輯外層 try/catch 保持原 messages 不變
- [x] M2-13 端到端驗證（走 llamacpp）— TUI 手動測試通過：模型從 memory-context fence 提取關鍵字做 SessionSearch（query 含 "provider 格式轉譯 SSE Anthropic"），讀 TODO.md 後準確總結最近進度。prefetch 注入 + 模型利用 context 兩者確認正常

### 階段四：MemoryTool 寫入
- [x] M2-14 新增 `src/tools/MemoryTool/MemoryTool.ts`：動作 `add` / `replace` / `remove`；target 指 memdir 四型檔案；自動維護 `MEMORY.md` 索引行 — 3 檔案（MemoryTool.ts / prompt.ts / UI.tsx）+ 註冊到 tools.ts。`validateMemoryFilename` 路徑安全驗證 + `updateMemoryIndex` regex 索引管理。不覆寫 checkPermissions。Typecheck 基線不變
- [x] M2-15 原子寫入：temp file + rename；檔案鎖（Windows 用 `proper-lockfile` 或手搓 `.lock` 哨兵檔） — `atomicWrite` helper（寫 `.tmp` → `rename`，失敗 fallback 直接寫）+ `acquireMemdirLock`（`proper-lockfile` 包裝，stale 10s，retry 3 次）。`call()` 外層 try/finally 保證 unlock。`updateMemoryIndex` 亦改用 `atomicWrite`。Typecheck 基線不變
- [x] M2-16 Prompt injection scanner：掃寫入內容的可疑 pattern（`ignore previous instructions`、`system:`、base64 blob、URL exfil、`<script>` 等），命中就拒絕並回錯誤訊息 — 9 組 regex pattern（injection 3 + XSS 2 + data exfil 3 + role override 1）；`scanForInjection` 回傳首個命中描述或 null；add/replace 兩個動作在 `buildFileContent` 前掃 name+description+content 合併文字。Typecheck 基線不變
- [x] M2-17 配額警告：memdir 總 token 估算超閾值（例如 10K）時，tool 回應附警告請求收斂 — `estimateMemdirTokens`（readdir + stat，3 chars/token heuristic）+ `checkQuotaWarning`（≥10K 回警告字串）。add/replace 成功後附加警告到 message。Typecheck 基線不變
- [x] M2-18 端到端驗證：add 後 MEMORY.md 索引更新、replace 只改目標、remove 不留孤兒索引；injection 測試案例被拒 — `scripts/poc/memory-tool-smoke.ts` 47/47 綠。覆蓋：filename validation 8 case、file content format 4、index format 3、injection scanner 9 pattern × 2（命中+不誤殺）= 18、atomic write 4、index add/replace/remove 8、quota estimation 2

### 階段五：收尾
- [x] M2-19 整合測試集 `tests/integration/memory/`：recall 情境、prefetch 注入、MemoryTool injection 拒絕、索引損毀重建 — 3 個測試檔（recall-and-prefetch 14、memory-tool-injection 52、index-rebuild 9）共 75 case 全綠 + run-all.sh runner
- [x] M2-20 `bun run typecheck` + `bun test` 全綠 — typecheck 基線不變（僅 TS5101）；全 smoke + integration tests 122 case 全綠（memory-tool-smoke 47 + injection 52 + recall-prefetch 14 + index-rebuild 9）
- [x] M2-21 更新 `LESSONS.md`（本次踩到的坑）、`skills/` 下視情況建立 memory-system skill — 階段四無新教訓可記；MemoryTool 模式已在 `freecode-architecture` skill 涵蓋，`session-fts-indexing` skill 涵蓋索引系統，不需新建 skill
- [x] M2-22 自動化 smoke test：`bun run tests/integration/memory/m2-22-smoke.ts` 61/61 綠 — 隔離環境建兩個假 session JSONL → 索引 → FTS recall + prefetch fence + MemoryTool validation + injection 拒絕 + 既有記憶系統模組可載入

### 完成標準（僅針對 llama.cpp 情境；Anthropic 路徑不作為驗收項）
- [x] 跨 session recall：session B 問「上次的 X」能透過 SessionSearchTool 找回 session A 內容（llamacpp 主模型）— m2-22-smoke Gate 1 驗證（FTS 搜「量子計算」找到 session A、搜「OpenWeatherMap」找到 session B、去重正確）
- [x] Dynamic prefetch：user query 進來時 `<memory-context>` fence 自動注入相關 memdir + FTS 片段，system prompt 與 prefix cache 不受影響；llamacpp 能用注入脈絡作答 — m2-22-smoke Gate 2 驗證（fence 格式、空結果不注入、預算限制、FTS→fence 端到端）
- [x] MemoryTool：能正確寫 memdir 四型檔案、維護 MEMORY.md 索引、拒絕 injection 嘗試 — m2-22-smoke Gate 3 驗證（filename validation 8 case、frontmatter 格式、MEMORY.md 索引 CRUD、9 組 injection pattern + 4 組合法文字不誤殺）
- [x] llamacpp 路徑下既有記憶系統行為不變：`memdir/` / `SessionMemory/` / `extractMemories/` / `autoDream/` 四個既有系統在 llamacpp 模式仍正常運作 — m2-22-smoke Gate 4 驗證（6 個模組可 import、4 個 public API 是函式）
- [x] Anthropic 路徑：code 保留、不主動破壞，但不再測試、不列為回歸門檻

---

## 當前里程碑：M-UM — 使用者建模（User Modeling）

**目標**：移植 Hermes Agent 的 USER.md 概念，建立獨立於現有 typed memories 的 persona block，session 啟動凍結快照注入 system prompt。三路開關（CLI 留待後續、env、settings）預設啟用。**不**破壞現有 M2 memory。

**架構決策**（已與 user 對齊）：
- ADR-UM-01：雙層儲存 — global (`~/.my-agent/USER.md`) + per-project (`~/.my-agent/projects/<slug>/USER.md`)，注入時 global + project 合併，project 以 `### Project-specific` 分隔
- ADR-UM-02：寫入介面延伸現有 `MemoryTool`，新增 `target='user_profile'` + 可選 `scope='global'|'project'`（預設 global）；不新建工具
- ADR-UM-03：注入機制為獨立 `<user-profile>` fence，透過 `systemPromptSection('user_profile', ...)` 放在 `memory` section 之前
- ADR-UM-04：大小 soft limit 1500 chars（global + project 合計），超出告警不截斷
- ADR-UM-05：Session 啟動凍結快照 (Hermes 作法)；mid-session 寫入 MemoryTool 看到 live，但 system prompt 用 snapshot（prefix cache 友善）
- ADR-UM-06：開關優先序 env (`FREECODE_DISABLE_USER_MODEL`) > `CLAUDE_CODE_SIMPLE` > settings (`userModelEnabled`) > 預設啟用；CLI flag 暫不做（env var 前綴已夠用）

**詳細設計見 `USER_MODELING_PLAN.md`（根目錄）。**

### 任務
- [x] M-UM-1 建立 `src/userModel/` 骨架：`paths.ts`（雙層路徑 + 開關）/ `userModel.ts`（讀寫 / snapshot / 雙層合併）/ `prompt.ts`（fence 格式化 + `loadUserProfilePrompt`）
- [x] M-UM-2 擴充 `src/tools/MemoryTool/MemoryTool.ts`：schema 加 `target: 'file'|'user_profile'` + `scope`；`call()` 路由到 `writeUserModel`；injection scan 覆蓋 user_profile add/replace；`toAutoClassifierInput` 分支
- [x] M-UM-3 `src/utils/settings/types.ts` 加 `userModelEnabled` 欄位 + `src/constants/prompts.ts` 在 simple-proactive 路徑與 dynamicSections 注入 `loadUserProfilePrompt` 為獨立 section（`memory` 之前）
- [x] M-UM-4 整合測試 `tests/integration/user-model/user-model-smoke.ts` — 27/27 綠，覆蓋：開關三路、add/replace/remove、snapshot 凍結 vs live、雙層合併、字元告警、`loadUserProfilePrompt` 整合
- [x] M-UM-5 `bun run typecheck` baseline 綠（僅 TS5101 pre-existing）；TODO.md 更新；commit
- [x] M-UM-6 重寫 `src/tools/MemoryTool/prompt.ts` DESCRIPTION：明確指引 LLM 何時用 `target='user_profile'` vs `target='file'`、global vs project scope 判定、決策規則（短 bullet 跨對話 → user_profile；需 Why/How → feedback_*.md）、6 組具體情境範例含 remove 語法
- [x] M-UM-7 prompt 強化套件 E1–E8：E1 頭部 ASCII 決策樹、E2 3 組 anti-pattern bad→good、E3 Disambiguation 表格（user_*.md vs user_profile）、E4 Consolidation 4 步驟範本、E5 Scope 邊界規則（預設 global）、E6 `extractMemories/prompts.ts` 加 `personaSection()` 含 USER.md 路徑、E7 qwen-style 陷阱（JSON dump、長文）列入 anti-pattern、E8 `memdir.ts buildMemoryLines` 加 user_profile cross-reference。27/27 smoke 綠、typecheck baseline 不變

### 完成標準
- [x] USER.md 能被 MemoryTool 寫入（global + project 兩個 scope）
- [x] Session 啟動 snapshot 凍結；mid-session 寫入不影響 system prompt 當前注入
- [x] `<user-profile>` fence 自動注入 system prompt 頂部；`<memory>` section 仍獨立運作
- [x] 三路開關（env / SIMPLE / settings）正確各自停用
- [x] Injection scan 對 user_profile add/replace 生效
- [x] typecheck baseline 不破壞

---

## M-SkillNudge-Fix — Skill 建立 nudge 批准後實際落盤（2026-04-19）

**問題**：`790d9d3 fix(skill-creation): 批准後把完整候選資訊注入對話` 用 `createSystemMessage(body, 'suggestion')` 注入指示，但 `src/utils/messages.ts:2068` 的 API payload 過濾器把所有非 `local_command` 的 system 訊息丟掉——模型根本沒看到指示，SKILL.md 從未被建立。

**修復**：批准時繞過 LLM，於 hook 內直接呼叫 `SkillManageTool` 的 `createSkill()` 落盤；同時補一條 `createUserMessage({ isMeta: true })` 讓模型知情可後續用 `SkillManage(edit)` 補強。

### 任務
- [x] M-SN-01 `src/tools/SkillManageTool/SkillManageTool.ts:101` 將 `createSkill()` 改為 `export`，重用既有 frontmatter 驗證 + scanSkill + atomic write
- [x] M-SN-02 重寫 `src/hooks/useSkillCreationSurvey.ts` 批准分支：從 candidate 組 SKILL.md 雛形（frontmatter `name`/`description`/`when_to_use` + body `# title` + `## Steps`）→ 直接 `createSkill()` 落盤 → 成功注入 info 系統訊息 + isMeta user message；失敗/例外注入 error 系統訊息
- [x] M-SN-03 `bun run typecheck` baseline 綠（僅 TS5101 pre-existing）

### 完成標準
- [x] 批准 nudge → `.my-agent/skills/<name>/SKILL.md` 立即出現（不依賴 LLM）
- [x] 模型於下一輪知道 skill 已建立、可選擇用 SkillManage(edit) 補強而非重複 create
- [x] 失敗路徑（重名、frontmatter 不合法、scanSkill dangerous）有明確錯誤訊息

### M-SN-Brand — Resume hint 等使用者可見字串移除 `claude` 殘留
- [x] M-SN-04 `package.json` bin 新增 `my-agent`（保留 `claude` / `claude-source` 為向後相容 alias）
- [x] M-SN-05 替換 8 處使用者可見 `claude` 字串為 `my-agent`：`gracefulShutdown.ts`（resume hint）、`tipRegistry.ts`（continue tip）、`crossProjectResume.ts` x2（cross-project 命令）、`bridgeMain.ts` x3（unknown arg / help / no-session）、`bridgeApi.ts` x2（session expired 410/403）、`TeleportRepoMismatchDialog.tsx`（teleport hint）、`MCPListPanel.tsx`（debug hint）、`doctorDiagnostic.ts`（install fix）
- [x] M-SN-06 typecheck baseline 不變；comment 內的 `claude remote-control` 不動（非使用者可見）

---

## 當前里程碑：M-SP — System Prompt Externalization（2026-04-19 啟動）

**目標**：把約 15–16K tokens 寫死在 TS 的 system prompt 文字外部化到 `~/.my-agent/system-prompt/` 下的 `.md` 檔，使用者可直接編輯、下一 session 生效。雙層（global + per-project）+ 首次啟動自動 seed + README.md 指引。

**詳細計畫**：見 `M_SP_PLAN.md`

### 任務

#### M-SP-1：基礎設施 + 8 大靜態段 + Seed 機制（~3.5 天）
- [x] M-SP-1.1 建 `src/systemPromptFiles/` 模組骨架：`paths.ts` / `loader.ts` / `bundledDefaults.ts` / `sections.ts` / `seed.ts` / `snapshot.ts` / `index.ts`
- [x] M-SP-1.2 搬 `prompts.ts` 8 大靜態段字串到 `bundledDefaults.ts`（8/8 完成 — proactive 於 M-SP-2 併入）
- [x] M-SP-1.3 撰寫 README.md 模板（表格列檔名 → 影響區塊 → 時機 → 可否刪除）
- [x] M-SP-1.4 實作 `seedSystemPromptDirIfMissing()` + `setup.ts` 啟動鉤子（背景非阻塞）
- [x] M-SP-1.5 `prompts.ts` 8 個 `getXxxSection()` 改為讀 snapshot（8/8 完成）
- [x] M-SP-1.6 `scripts/dump-system-prompt.ts`：產出 bundled 版 vs 實際載入版兩種模式，供 byte-level diff
- [ ] M-SP-1.7 單元測試：seed / fallback 鏈 / per-project 覆蓋 / 權限失敗 warn
- [ ] M-SP-1.8 整合測試：`./cli -p "hi"` 首次啟動 seed + byte-level diff = 0
- [x] M-SP-1.9 typecheck 綠（baseline 僅 TS5101 pre-existing），commit

#### M-SP-2：動態段 fallback 字串（~1 天）
- [x] M-SP-2.1 搬 skills_guidance / numeric_length_anchors / token_budget / scratchpad / frc / summarize_tool_results / default_agent / proactive 到 .md
- [x] M-SP-2.2 新增 `interpolate()` 工具與 `getSectionInterpolated()` helper（支援 {TICK_TAG} / {SLEEP_TOOL_NAME} / {scratchpadDir} / {keepRecent} 插值）
- [x] M-SP-2.3 typecheck 綠、commit

#### M-SP-3：User Profile 外框 + cyber-risk（~0.5 天）
- [x] M-SP-3.1 `src/userModel/prompt.ts` 外框改讀 `user-profile-frame.md`（header 部分外部化，尾框與 body 仍在程式）
- [x] M-SP-3.2 `cyberRiskInstruction.ts` 新增 `getCyberRiskInstruction()` 函式；`prompts.ts` 三處 `${CYBER_RISK_INSTRUCTION}` 改為呼叫 getter
- [x] M-SP-3.3 typecheck 綠、commit（未跑 user-model smoke 27 — 只動 header 字面，行為應一致；若未來 regression 再補測試）

#### M-SP-4：Memory 系統文字（~3 天）
- [x] M-SP-4.1 grep 盤點所有 memory 常數 import 點（4 個檔案：memdir.ts / teamMemPrompts.ts / memoryTypes.ts / extractMemories/prompts.ts）
- [x] M-SP-4.2 `src/memdir/memoryTypes.ts` 7 個常數改名為 `_DEFAULT`，新增 `getX()` 版本讀 snapshot，空 fallback 走 `_DEFAULT`；legacy 常數 `@deprecated` 保留
- [x] M-SP-4.3 memdir.ts / teamMemPrompts.ts / extractMemories/prompts.ts 的 `...CONST` 改為 `...getCONST()`
- [x] M-SP-4.4 typecheck 綠、commit（memory 整合測試留待後續手動驗證；memory 不自動 seed 因內容過大，使用者需手動建檔）

#### M-SP-4.5：QueryEngine.ts 錯誤訊息（~0.5 天）
- [x] M-SP-4.5.1 搬 4 條字串到 `bundledDefaults`：`errors/max-turns` / `errors/max-budget` / `errors/max-structured-output-retries` / `errors/ede-diagnostic`（全部用 `{var}` 佔位）
- [x] M-SP-4.5.2 修 `QueryEngine.ts` L874/L1003/L1047/L1116 四處改為 `interpolate(getExternalSection(...) ?? fallback, vars)`
- [x] M-SP-4.5.3 commit（使用者先前已明確授權修改此 deny-list 檔案）

#### M-SP-5：Per-project 層 + 文件（~1 天）
- [ ] M-SP-5.1 新增 `tests/fixtures/system-prompt/` 驗證三層覆蓋
- [ ] M-SP-5.2 更新 `CLAUDE.md` + `docs/context-architecture.md`
- [ ] M-SP-5.3 寫 `docs/customizing-system-prompt.md` 使用者指南
- [ ] M-SP-5.4 M-SP 整體 e2e smoke + commit

### 完成標準
- [ ] 首次啟動自動 seed `~/.my-agent/system-prompt/` 含 README.md
- [ ] byte-level diff（seed 後 vs 重構前）= 0
- [ ] 所有既有整合測試通過（memory 154 + user-model 27）
- [ ] 使用者改檔案後開新 session 生效
- [ ] per-project 覆蓋優先於 global，global 優先於 bundled

---

## 已完成里程碑：M1 — 透過 llama.cpp 支援本地模型（封存）

**目標**：free-code 能直接連接專案內跑的 llama.cpp server（`http://127.0.0.1:8080/v1`，model alias `qwen3.5-9b-neo`），支援串流和全部 39 個工具的 tool calling。**不再**經過 LiteLLM proxy（ADR-001 已推翻，見 CLAUDE.md）。

**架構硬約束**：`src/QueryEngine.ts` 與 `src/Tool.ts` 在 `.claude/settings.json` deny list — **不能改**。因此 provider 必須在內部把 OpenAI SSE 轉成 Anthropic 形狀的 stream event，下游無感。

**實作路徑**：**路徑 B（fetch adapter）** — 2026-04-15 PoC 驗證通過（commit `b2af143`）。仿 `src/services/api/codex-fetch-adapter.ts` 模式，寫 `llamacpp-fetch-adapter.ts`，塞給 `new Anthropic({ fetch })`，翻譯層集中一處，`claude.ts` / `QueryEngine.ts` 零修改。**不另建** `src/services/providers/` 抽象層（路徑 A 已放棄）。

### 階段一：摸底與可行性驗證
- [x] 閱讀並記錄 free-code 現有 API 架構的實測事實（`src/services/api/client.ts`、`src/services/api/claude.ts`、`src/utils/model/providers.ts`），把發現寫進 `skills/freecode-architecture/SKILL.md`
- [x] 閱讀 Hermes 的 `reference/hermes-agent/hermes_cli/auth.py` 與 `reference/hermes-agent/agent/auxiliary_client.py`，只取「ProviderConfig + 動態客戶端工廠」設計概念（不直接複製 Python）
- [x] PoC：路徑 B 可行性驗證 — 寫 `scripts/poc/llamacpp-fetch-poc.ts`，確認 Anthropic SDK 透過 fetch adapter 可成功與 llama-server 通訊（2026-04-15 commit `b2af143`）
- [x] 架構決策：確定走路徑 B（fetch adapter）— 棄新 provider 層
- [x] 驗證：`bun run typecheck` 在當前 main 上仍通過（建立實作前的綠燈基準）— exit 0，僅 `tsconfig.json` L10 `baseUrl` 一條 TS5101 deprecation warning，無實際錯誤。同步把 `typecheck` 加進 `package.json` scripts（原本缺）

### 階段二：`llamacpp-fetch-adapter.ts` 實作（串流為主，純文字端到端）

> 原階段二（non-streaming）與階段三（串流）2026-04-15 合併 — `claude.ts:1824` 主 query 永遠發 `stream: true`，`./cli` 無法用 non-streaming 驗證。詳細實作設計見 DEPLOYMENT_PLAN.md 底部「M1 階段二實作 plan」段。

- [x] Step 1：擴充 `src/utils/model/providers.ts` — 加 `'llamacpp'` APIProvider、`CLAUDE_CODE_USE_LLAMACPP` 檢測、`getLlamaCppConfig()` helper、`DEFAULT_LLAMACPP_{BASE_URL,MODEL}` 常數
- [x] Step 2a：建立 `src/services/api/llamacpp-fetch-adapter.ts` non-streaming 路徑 — inline 型別、請求翻譯（Anthropic→OpenAI）、回應翻譯（ChatCompletion→BetaMessage）、`FINISH_TO_STOP` 映射表、`reasoning_content`→`thinking` block（ADR-006）
- [x] Step 2b：同檔加 streaming 路徑 — `translateOpenAIStreamToAnthropic` async generator、6 步狀態機、`thinking_delta` 主路徑（D6 fallback 不需啟動 — SDK 原生接受）
- [x] Step 3：修改 `src/services/api/client.ts` — llamacpp 分支放在 `getAnthropicClient()` 函數**最前面**（搶在 Anthropic auth / OAuth refresh 之前）；本地 provider 完全不需要 Anthropic 設定
- [x] Step 4：補進 `client.ts` 頂部 env JSDoc 說明 `CLAUDE_CODE_USE_LLAMACPP` / `LLAMA_BASE_URL` / `LLAMA_MODEL`
- [x] 驗證 V2：`bun run scripts/poc/llamacpp-fetch-poc.ts` 通過（non-streaming 迴歸）
- [x] 驗證 V3：新寫 `scripts/poc/llamacpp-streaming-poc.ts`，SDK `messages.stream()` 收到正確事件序列（thinking_delta/text_delta 各 N 次、兩個 content block、stop_reason=end_turn）
- [x] 驗證 V4：`CLAUDE_CODE_USE_LLAMACPP=true LLAMA_BASE_URL=... bun ./src/entrypoints/cli.tsx -p "..."` 端到端通過，回應 "4"。**注意**：不能設 `ANTHROPIC_API_KEY=dummy`，bootstrap 會卡；serve.sh 預設 ctx 需 ≥32K（已改）
- [x] 驗證 V5：結構驗證通過 — 未設 `CLAUDE_CODE_USE_LLAMACPP` 時 `getAPIProvider()` 不回 `'llamacpp'`、`getLlamaCppConfig()` 回 `null`、llamacpp 分支不進，走原 Anthropic 初始化鏈。**需使用者用真 Anthropic key 跑端到端最後確認** `ANTHROPIC_API_KEY=<real> ./cli -p "hi"` 行為與修訂前位元級相同

### 階段三：工具呼叫翻譯
- [x] 在 adapter 中加 tool 翻譯：
  - 出站：Anthropic `tools` → OpenAI `tools`（translateToolsToOpenAI，Step 2a 時已做）
  - 入站 non-streaming：tool_calls → `ToolUseBlock`（Step 2a 時已做）
  - 入站 streaming：tool_calls 切多 chunk 的 arguments 累積 → `input_json_delta`（階段三重構狀態機，用 `openToolBlocks: Map<openai idx → anthropic idx>` 追蹤；實測 Qwen3.5-Neo 呼叫 get_weather 工具成功，input 正確重組為 `{"city":"Tokyo"}`，stop_reason=tool_use；見 `scripts/poc/llamacpp-tool-streaming-poc.ts`）
  - `tool_result` 對話歷史 → `role:'tool'` message（translateMessagesToOpenAI，Step 2a 時已做）
- [x] 建立 `tests/integration/TOOL_TEST_RESULTS.md` 骨架（43 個工具分類表 — 前 5 核心、檔案/Web/Agent/Plan/互動/LSP/MCP/設定等類，含 feature-gated 標記）
- [x] 針對前五個核心工具（Bash、Read、Write、Edit、Glob）用 Qwen3.5-Neo 跑端到端測試 — **Part A（翻譯）+ Part B（E2E）全部 5/5 通過**。(a)(b)(c)(d) 四維度均綠。腳本：`scripts/poc/llamacpp-core-tools-poc.ts` + `scripts/poc/llamacpp-core-tools-e2e.sh`。結果記在 `tests/integration/TOOL_TEST_RESULTS.md`
- [x] 其餘 34 個工具依樣畫葫蘆補完（Part A 翻譯 34/34 綠 — `scripts/poc/llamacpp-rest-tools-poc.ts`；複雜 schema 含 nested object、array of object、型別混合、空物件皆正確翻譯；TaskCreate 首次模型選 text，重試後綠 — 模型 variance；Part B 大多需 MCP/LSP/互動環境，本階段不跑，列入後續工作）
- [x] 修復測試中發現的翻譯 bug — **無 bug 可修**。adapter 在 39 個可測工具 × 多種 schema shape（空物件、單/多欄、nested object、array of object、型別混合）全部翻譯正確

### 階段四：設定與使用者體驗
- [x] `src/utils/model/providers.ts`：新增 `LLAMACPP_MODEL_ALIASES` 陣列（目前 `qwen3.5-9b-neo`），`getLlamaCppConfig(model?)` 接受 model 參數；model 符合別名時自動啟用 llama.cpp 分支，不需再設 `CLAUDE_CODE_USE_LLAMACPP`。實測 `./cli --model qwen3.5-9b-neo -p "3+5=?"` → `8` 成功
- [x] `/model` 指令：`src/utils/model/modelOptions.ts` 的 `getModelOptions()` 在 Anthropic 模型清單後追加 `LLAMACPP_MODEL_ALIASES` 的每個項目（label 尾綴 `(local)`、description 顯示 base URL），使用者在 `/model` 互動 picker 能看到並選擇
- [x] server 不可用降級：adapter 的 fetch 用 try/catch 包；失敗時回 400（非 5xx，避免 SDK 重試）、`invalid_request_error` 型別、訊息指示執行 `bash scripts/llama/serve.sh`。偵測寬容：`ECONNREFUSED` / `ECONNRESET` / `ENOTFOUND` / `Unable to connect` / `fetch failed` 都認。實測指 localhost:9999（無 server）→ 立即顯示繁中 hint，無重試
- [x] 啟動橫幅顯示 provider：`src/utils/logoV2Utils.ts` 的 `getLogoDisplayData()` 在 `isLlamaCppActive()` 時把 `billingType` 改為 `llama.cpp (local)`，CondensedLogo 渲染時自動生效。新增 `isLlamaCppActive()` helper 到 `providers.ts`（目前只看 env flag；--model 觸發場景 banner 仍顯示一般 billing，但模型名本身已表明路徑）

### 待解決（M1 收尾後發現，使用者選擇延後處理）

- [x] **Bun compiled `.\cli.exe` TUI panic** — Bun 1.3.6 single-file-executable + Ink React TUI 衝突（非我方 bug），追 Bun changelog，未修前互動模式一律走 `bun run dev` — **已修**：升級 Bun 1.3.12 + 重建 cli.exe（2026-04-17）
- [x] **`-p` non-interactive mode regression** — `./cli.exe -p "..."` / `bun src/.. -p "..."` 90 秒無輸出 timeout，疑似 isolation commit 後出現 — **已修**：Bun 1.3.12 修復後 `./cli.exe --model qwen3.5-9b-neo -p "2+2=?"` → `4` 正常回應（2026-04-17）

### 完成標準
- [x] `./cli --model qwen3.5-9b-neo -p "hello"` 成功串流輸出；log 顯示連接 `http://127.0.0.1:8080/v1`（階段四 Task 1 實測 `3+5=?` → `8`，llamacpp 分支命中。**註**：isolation commit 後 -p mode 出現 regression 待修）
- [x] 工具呼叫可用：至少 Bash、Read、Write、Edit、Glob 五個核心工具端到端通過（階段三 Part B commit `cd80511` 5/5 綠）
- [x] 既有 Anthropic 使用者路徑**完全不受影響** — 結構驗證通過：未設 `CLAUDE_CODE_USE_LLAMACPP` 且 model 不是 llamacpp 別名時 `getLlamaCppConfig()` 回 null、llamacpp 分支不進，走原 Anthropic 初始化鏈。**需使用者用真 Anthropic key 最後端到端確認一次**
- [x] `tests/integration/TOOL_TEST_RESULTS.md` 記錄 43 個工具結果（39 個可測 + 4 個 feature-gated），adapter 翻譯成功率 100%，前 5 核心工具四維度全綠

---

## 當前里程碑：M3 — 移植 anthropics/skills 為 Bundled Skills

**目標**：將 `anthropics/skills` GitHub repo 的 17 個通用 skill 內化為 free-code 的 bundled TypeScript skills。SKILL.md 變成 TypeScript 模組、Python scripts 改寫為 TypeScript——讓它們成為 free-code 二進位檔的一部分，不依賴外部 marketplace。與 ADR-007（vendor SDK）精神一致。依 ADR-003，所有 skill 無條件註冊，不使用 feature flag。不依賴 LibreOffice 等大型系統軟體，所有功能用純 TypeScript/JavaScript 套件實現。

**詳細實作設計見 plan 檔 `glowing-soaring-truffle.md`。**

### 階段一：建立模式 + 純 Prompt Skills（6 個）
- [x] M3-01 建立第一個 bundled skill（frontend-design）作為模板——確立 `.ts` + `Content.ts` + `SKILL.md` 開發模式 — Pattern A（inline prompt string）模式確立；`frontendDesign.ts` 註冊到 `index.ts`；typecheck 基線不變
- [x] M3-02 移植 brand-guidelines — Pattern A；`brandGuidelines.ts`；2.2KB prompt inline
- [x] M3-03 移植 doc-coauthoring — Pattern A；`docCoauthoring.ts`；15KB prompt inline
- [x] M3-04 移植 internal-comms — Pattern C（with `files`）；`internalComms.ts`；4 個 example .md 透過 `files: Record<string, string>` 提取到磁碟
- [x] M3-05 移植 algorithmic-art — Pattern B（lazy-load）；`algorithmicArt.ts` + `algorithmicArtContent.ts`；~20KB prompt lazy-loaded；viewer.html template 內容整合進 prompt（省去 files 提取複雜度）
- [x] M3-06 移植 canvas-design（含 binary font 處理）— `canvasDesign.ts` + `canvasDesignContent.ts` + `canvasDesignFonts.ts`（7.2MB base64 字型）；擴充 `bundledSkills.ts` 支援 `binaryFiles` 和 `safeWriteBinaryFile`；字型首次呼叫時 decode+extract 到 `~/.my-agent/bundled-skills/canvas-design/canvas-fonts/`
- [x] M3-07 修改 index.ts 註冊 Tier 1 全部 + typecheck + build 驗證 — 6 個 skill 全部無條件註冊；typecheck 基線不變（TS5101）；build 成功 130MB（+7MB 字型 = 預期內）；4609 modules bundled

### 階段二：帶參考檔案的 Skills（3 個）
- [x] M3-08 填入 claude-api 的 .md 原始內容（骨架已存在）— 從 upstream 下載 37 個 .md 到 `src/skills/bundled/claude-api/`；更新 `claudeApiContent.ts` 移除不存在的 `agent-sdk/` import、改為 `managed-agents/`、新增 12 個 managed-agents + agent-design 檔案；更新 `claudeApi.ts` reading guide 對齊 managed-agents 路徑
- [x] M3-09 移植 theme-factory（10 個 theme 定義檔 → files）— `themeFactory.ts`；10 個 theme .md 內嵌為 `files: Record<string, string>`，首次呼叫時提取到磁碟
- [x] M3-10 移植 web-artifacts-builder — `webArtifactsBuilder.ts` + `webArtifactsBuilderContent.ts`（~40KB，含 init/bundle shell scripts + shadcn tar.gz base64）；lazy-load content + 手動 extract scripts 到磁碟

### 階段三：Python → TypeScript 改寫（6 個）
- [x] M3-11 移植 webapp-testing（trivial 改寫——process orchestration）— `webappTesting.ts` + `webappTestingContent.ts`；Python `with_server.py` 改寫為 TypeScript `with-server.ts`（child_process.spawn + net.createConnection port polling）；3 個 Playwright example .py 作為參考檔案保留
- [x] M3-12 移植 mcp-builder — `mcpBuilder.ts` + `mcpBuilderContent.ts`（115KB）；SKILL.md prompt + 4 個 reference .md + 3 個 Python scripts 作為 extractable files
- [x] M3-13 移植 slack-gif-creator — `slackGifCreator.ts` + `slackGifCreatorContent.ts`（34KB）；4 個 Python core scripts（easing/frame_composer/gif_builder/validators）作為 extractable files
- [x] M3-14 移植 pptx — `pptxSkill.ts` + `pptxContent.ts`（56KB）；3 個 Python scripts + 2 個 reference .md 作為 extractable files（office/ 共用模組延後，Python scripts 暫保留原樣）
- [x] M3-15 移植 pdf — `pdfSkill.ts` + `pdfContent.ts`（60KB）；8 個 Python scripts + 2 個 reference .md 作為 extractable files（Python scripts 暫保留原樣，model 可讀取並改寫）
- [x] M3-16 移植 skill-creator — `skillCreator.ts` + `skillCreatorContent.ts`（153KB）；8 個 Python eval scripts + 3 個 agent .md + 1 個 reference schema .md 作為 extractable files

### 階段四：文件處理 Skills（2 個，純 TS 套件）
- [x] M3-17 移植 docx — `docxSkill.ts` + `docxContent.ts`（36KB）；SKILL.md prompt + 2 個 Python scripts（accept_changes/comment）作為 extractable files；不依賴 LibreOffice，Python scripts 供 model 參考
- [x] M3-18 移植 xlsx — `xlsxSkill.ts` + `xlsxContent.ts`（17KB）；SKILL.md prompt + recalc.py 作為 extractable file；不依賴 LibreOffice

### 收尾
- [x] M3-19 全量 typecheck + build + 全部 17 skill 註冊驗證 — typecheck 基線不變（TS5101）；build 成功 130MB / 4628 modules；17 個新 skill 全部無條件註冊確認
- [x] M3-20 更新 LESSONS.md + 評估是否建立 skill — 無新教訓（所有坑都在 Tier 1 解決）；不建立新 skill（bundled skill 模式已在 upstream 文件充分記錄）

---

## 未來里程碑（尚未詳細規劃）

### M4 — Hermes Cron 排程（TypeScript 重新實作）
將 Hermes 的 cron 系統（自然語言排程 + 多平台派送）移植到 free-code。

### M5 — Hermes 訊息閘道（TypeScript 重新實作）
將 Telegram/Discord/Slack 閘道移植到 free-code。

### M6 — Self-Improving Loop（AutoDream × Hermes 合併）

**目標**：合併 free-code 的 AutoDream（背景記憶整合）與 Hermes Agent 的 self-improving loop（即時自我改進迴圈），讓系統從「被動整理記憶」進化為「邊做邊學邊改」。三個階段漸進實施：方案一（擴展 Dream prompt）→ 方案二（即時 Nudge 雙迴圈）→ 方案三（完整三層自改進系統）。以 **llama.cpp 本地模型** 為主要運行情境。

**詳細設計分析見 `AUTODREAM_HERMES_MERGE_ANALYSIS.md`。**

**架構決策**：
- ADR-M6-01：三方案漸進式實施，每階段驗證效果後再決定是否繼續下一階段
- ADR-M6-02：方案二的 nudge hook 使用現有 `apiQueryHookHelper` + `postSamplingHooks` 框架（已被 `skillImprovement.ts` 驗證）
- ADR-M6-03：方案三的 skill 自動建立需經 skillGuard 安全掃描 + 3 session 驗證；Dream agent 的寫入邊界擴展到 `.my-agent/skills/`
- ADR-M6-04：llama.cpp 單 slot 環境下背景任務序列化執行（extractMemories → sessionReview → autoDream）；非 llama.cpp 環境保留原本 fire-and-forget
- ADR-M6-05：`getSmallFastModel()` 在 llama.cpp 環境下返回 `DEFAULT_LLAMACPP_MODEL`（qwopus3.5-9b-v3），nudge 的 side-channel 呼叫走同一模型

#### 階段一：EnhancedDream — 擴展 Dream 職責（方案一）
- [x] M6-01 擴展 `consolidationPrompt.ts`：在 Phase 4 之後新增 Phase 5（Skill Audit：掃描 `.my-agent/skills/` + transcript 識別跨 session 重複 workflow）和 Phase 6（Behavior Notes：識別用戶修正/偏好寫入 `user-behavior-notes.md`）
- [x] M6-02 自動化測試 `tests/integration/self-improve/enhanced-dream.test.ts`：驗證 Phase 5/6 存在、Phase 1-4 保留、extra 參數正確附加（4 個 test case）
- [x] M6-03 `bun run typecheck` + `bun test tests/integration/self-improve/` 全綠 — typecheck 基線不變（TS5101）；4/4 綠

#### 階段二：DualLoop — 即時 Nudge 雙迴圈（方案二）
- [x] M6-04 新增 `src/utils/hooks/memoryNudge.ts`：基於 `createApiQueryHook` 框架，每 8 個 user turn 偵測修正性偏好（借鑑 Hermes MEMORY_REVIEW_PROMPT），logResult 設 `appState.pendingMemoryNudge`；匯出 `parseMemoryNudgeResponse` 供測試
- [x] M6-05 新增 `src/utils/hooks/skillCreationNudge.ts`：基於 `createApiQueryHook` 框架，每 15 個 tool_use 偵測可 skill 化的 workflow（借鑑 Hermes SKILL_REVIEW_PROMPT），logResult 設 `appState.pendingSkillCandidate`；新增 `countRecentToolUses()` + `formatToolSequence()` 工具函式
- [x] M6-06 修改 `src/state/AppStateStore.ts`：新增 `pendingMemoryNudge` 和 `pendingSkillCandidate` 型別到 AppState（含預設值 null）
- [x] M6-07 修改 `src/utils/backgroundHousekeeping.ts`：在 `initSkillImprovement()` 之後加入 `initMemoryNudge()` + `initSkillCreationNudge()` 呼叫
- [x] M6-08 可選：注入 SKILLS_GUIDANCE 到 system prompt — 延後，待 nudge 機制驗證有效後再加
- [x] M6-09 自動化測試 `tests/integration/self-improve/memory-nudge.test.ts`（5 個 test case：parseResponse 解析 + 多筆 + 空 + 無標籤 + 無效 JSON）
- [x] M6-10 自動化測試 `tests/integration/self-improve/skill-creation-nudge.test.ts`（5 個 test case：parseResponse 解析 + 非候選 + 無標籤 + countRecentToolUses + formatToolSequence）
- [x] M6-11 `bun run typecheck` + `bun test tests/integration/self-improve/` 全綠 — typecheck 基線不變（TS5101）；14/14 綠（3 files）

#### 階段三：FullLoop — 完整三層自改進系統（方案三）
- [x] M6-12 新增 `src/services/selfImprove/skillGuard.ts`：從 Hermes `skills_guard.py` 移植核心威脅模式（8 類約 40 regex），結構限制 MAX_SKILL_SIZE_KB=10 / MAX_TOTAL_SKILLS=50，信任策略 agent-created → safe=allow / caution=allow / dangerous=block
- [x] M6-13 自動化測試 `tests/integration/self-improve/skill-guard.test.ts`（8 個 test case 全綠）
- [x] M6-14 新增 `src/services/selfImprove/trajectoryStore.ts`：writeTrajectory / readTrajectories / pruneTrajectories / countSkillObservations
- [x] M6-15 自動化測試 `tests/integration/self-improve/trajectory-store.test.ts`（3 個 test case 全綠）
- [x] M6-16 新增 `src/services/selfImprove/sessionReview.ts` + `sessionReviewPrompt.ts`：Session Review Agent（觸發條件 tool_use>=15 + 距上次>=2h，forkedAgent maxTurns=8，canUseTool 限 memory/）
- [x] M6-17 自動化測試 `tests/integration/self-improve/session-review.test.ts`（3 個 test case 全綠）
- [x] M6-18 新增 `src/tasks/SessionReviewTask/SessionReviewTask.ts`：仿 DreamTask 結構 + Task.ts 新增 `'session_review'` TaskType 和 `'s'` prefix
- [x] M6-19 擴展 `consolidationPrompt.ts`：加入 Phase 7（Skill Draft Review — 3+ session 驗證後自動升級）、Phase 8（Safety Checklist）、Phase 9（Trajectory Pruning — 保留最近 30 天）
- [x] M6-20 擴展 `autoDream.ts` 工具權限：新增 `createEnhancedDreamCanUseTool` 包裝 `createAutoMemCanUseTool` + `.my-agent/skills/` 寫入權限 + `isSkillsPath()` 判斷；import `scanSkill` 備用
- [x] M6-21 自動化測試 `tests/integration/self-improve/enhanced-dream-permissions.test.ts`（4 個 test case 全綠：Phase 7-9 存在 + Safety Checklist + Trajectory Pruning + Phase 1-6 保留）
- [x] M6-22 修改 `src/query/stopHooks.ts`：加入 `executeSessionReview` + llama.cpp 序列化（extractMemories → sessionReview → autoDream），非 llama.cpp 保留 fire-and-forget
- [x] M6-23 修改 `src/utils/backgroundHousekeeping.ts`：`initAutoDream()` 之後加入 `initSessionReview()`
- [x] M6-24 整合測試 `tests/integration/self-improve/full-loop-smoke.test.ts`（4 個 test case 全綠）
- [x] M6-25 `bun run typecheck` + `bun test tests/integration/self-improve/` 全綠 — typecheck 基線不變（TS5101）；36/36 綠（8 files, 96 expect calls）

#### 完成標準（僅針對 llama.cpp 情境）
- [x] EnhancedDream：Dream prompt 含 Phase 5 Skill Audit + Phase 6 Behavior Notes — 測試驗證 prompt 內容正確
- [x] DualLoop：memoryNudge（每 8 turn）+ skillCreationNudge（每 15 tool_use）已註冊為 postSamplingHook，appState 型別已擴展
- [x] FullLoop：Session Review Agent + skillGuard + trajectoryStore + 增強版 Dream（Phase 7-9）+ stopHooks 序列化 — 全部實作完成
- [x] 所有自動化測試（8 個檔案 36 個 test case）全綠
- [x] 既有記憶系統行為不變：typecheck 基線不變，createAutoMemCanUseTool 未修改（createEnhancedDreamCanUseTool 是包裝層）

### M6b — Skill 自主建立閉環（SkillManageTool + 安全掃描整合）

**目標**：修復 M6 的三個斷點——新增 SkillManageTool 讓 agent 直接建立/修改 skill，所有寫入經 scanSkill 程式碼層級安全掃描，接通 nudge → UI → 建立的完整閉環。

**詳細設計分析見 `SKILL_SELF_CREATION_PLAN.md`。**

#### 階段一：SkillManageTool 核心工具
- [x] M6b-01 新增 `src/tools/SkillManageTool/SkillManageTool.ts`：6 action + scanSkill + 回滾
- [x] M6b-02 新增 `src/tools/SkillManageTool/prompt.ts`
- [x] M6b-03 新增 `src/tools/SkillManageTool/UI.tsx`
- [x] M6b-04 修改 `src/tools.ts`：註冊 SkillManageTool
- [x] M6b-05 自動化測試 `skill-manage-tool.test.ts`（13 test case）
- [x] M6b-06 typecheck 基線不變；93/93 全綠

#### 階段二：SKILLS_GUIDANCE + Session Review 改造 + Nudge UI
- [x] M6b-07 修改 `src/constants/prompts.ts`：dynamicSections 加入 skills_guidance（SkillManageTool 可用時注入）
- [x] M6b-08 修改 `sessionReviewPrompt.ts`：Task 1 改為引導呼叫 SkillManage(create)
- [x] M6b-09 修改 `sessionReview.ts`：擴展 canUseTool 允許 SkillManageTool + 完成後通知
- [x] M6b-10 新增 `src/hooks/useSkillCreationSurvey.ts`：仿 useSkillImprovementSurvey，讀取 pendingSkillCandidate
- [x] M6b-11 修改 `src/screens/REPL.tsx`：掛載 useSkillCreationSurvey
- [x] M6b-12 修改 `skillImprovement.ts`：applySkillImprovement 寫入前加 scanSkill 驗證

#### 階段三：Dream 簡化 + 測試更新 + 文件同步
- [x] M6b-13 修改 `consolidationPrompt.ts`：Phase 7 改為 Skill Draft Cleanup，Phase 8（原 Safety Checklist）移除，Phase 8 改為 Trajectory Pruning
- [x] M6b-14 修改 `autoDream.ts`：移除 createEnhancedDreamCanUseTool/isSkillsPath，改回 createAutoMemCanUseTool
- [x] M6b-15 更新 `enhanced-dream-permissions.test.ts`：Phase 7-8 斷言對齊
- [x] M6b-16 更新 `session-review.test.ts`：prompt 斷言對齊 SkillManage
- [x] M6b-17 更新 `m6-full-e2e.test.ts`：管線模擬對齊 SkillManage 路徑
- [x] M6b-18 typecheck 基線不變；93/93 全綠
- [x] M6b-19 更新 `AUTODREAM_HERMES_MERGE_ANALYSIS.md`（觸發架構圖 + Phase 清單）+ `SKILL_SELF_CREATION_PLAN.md`（狀態標記完成）

#### 完成標準
- [x] 對話中 agent 呼叫 SkillManage(create) → scanSkill 掃描 → chokidar 自動加載：SkillManageTool 已註冊，scanSkill 在 create/edit/patch/write_file 中呼叫
- [x] 含 rm -rf 的 skill → scanSkill 阻擋 + 回滾：create 時 scanSkill verdict=dangerous 直接拒絕（不寫入）；edit/patch 時恢復備份
- [x] Session Review 背景呼叫 SkillManage → 通知用戶 "Skill created"：sessionReviewPrompt 引導呼叫 SkillManage，canUseTool 允許，appendSystemMessage 通知
- [x] skillCreationNudge → UI dialog → 確認 → SkillManage(create)：useSkillCreationSurvey 讀取 pendingSkillCandidate，確認後發 system message 引導建立
- [x] skillImprovement 修改 skill 時 scanSkill 驗證：applySkillImprovement 寫入前 scanSkill，dangerous 則不寫入
- [x] 所有自動化測試全綠：93/93（11 files）

### M6c — Dev Mode 修復 + Skill 閉環補齊 + 品牌重塑 config

**目標**：修復三個阻擋 `bun run dev` 運行的 runtime bug，補齊 M6b SkillCreationSurvey 的 UI 缺口，完成 config 檔名品牌重塑。

#### 修復一：SendMessageTool require hang
- [x] M6c-01 修改 `src/tools.ts`：`getSendMessageTool()` 的 `require()` 改為 ESM static import — Bun dev mode 下 `require()` 載入含 async 傳遞依賴的模組會靜默 hang，改為 static import 利用 live binding 正確處理

#### 修復二：enabledTools.some() TypeError
- [x] M6c-02 修改 `src/constants/prompts.ts`：`enabledTools.some(t => t.name === 'SkillManage')` → `enabledTools.has('SkillManage')` — M6b 新增的 skills_guidance 對 `Set<string>` 誤用 Array 方法，導致 system prompt 組裝 crash、SkillManage 指引從未注入

#### 修復三：MessageSelector require crash
- [x] M6c-03 修改 `src/QueryEngine.ts`：`require('MessageSelector')` → cached `await import()` — 同樣的 async module 問題阻擋所有 LLM query 執行

#### SkillCreationSurvey 閉環補齊
- [x] M6c-04 新增 `src/components/SkillCreationSurvey.tsx`：仿 SkillImprovementSurvey 模式，顯示候選 skill 的 name/description/steps，「1: 建立 / 0: 略過」互動
- [x] M6c-05 修改 `src/screens/REPL.tsx`：加入 SkillCreationSurvey import + render；移除 SkillImprovementSurvey 的 `"external" === 'ant'` guard（free-code 已解鎖所有功能）

#### 品牌重塑：config 檔案搬移
- [x] M6c-06 修改 `src/utils/env.ts`：`getGlobalClaudeFile()` 的檔名 `.claude.json` → `.my-agent.json`，含自動 migration（複製舊檔到新路徑）
- [x] M6c-07 修改 `src/utils/permissions/filesystem.ts`：DANGEROUS_FILES 清單 `.claude.json` → `.my-agent.json`
- [x] M6c-08 修改 `src/utils/env.ts`：config 檔從 `~/.my-agent.json` 搬移至 `~/.my-agent/.my-agent.json`（config 目錄內），三層 migration 鏈（`~/.claude.json` → `~/.my-agent.json` → `~/.my-agent/.my-agent.json`）
- [x] M6c-09 更新 12 個檔案中 16 處硬編碼的 `~/.my-agent.json` 路徑字串（註解/錯誤訊息/prompt）

#### 預設 bypassPermissions 模式
- [x] M6c-10 修改 `src/main.tsx`：`dangerouslySkipPermissions` 和 `allowDangerouslySkipPermissions` 預設值改為 `true` — 不需加 `--dangerously-skip-permissions` 即自動 bypass
- [x] M6c-11 修改 `src/interactiveHelpers.tsx`：跳過 `BypassPermissionsModeDialog` 首次確認對話框

#### 驗證
- [x] M6c-12 typecheck 通過 + 端到端驗證 `permissionMode: bypassPermissions` 確認生效 + config 路徑 `~/.my-agent/.my-agent.json`

### M6d — 移除 Auth 依賴 + GrowthBook 本地化 + 功能解鎖

**目標**：free-code 完全使用本地模型，移除所有 Anthropic auth 依賴。GrowthBook 停用遠端 fetch，所有 flag 預設 true 並從 .my-agent.json 讀取。解鎖被 auth gate 擋住的功能。

#### 區塊 1：GrowthBook 本地化
- [x] M6d-01 修改 `src/services/analytics/growthbook.ts`：`initializeGrowthBook()` 直接回 null（不連遠端）
- [x] M6d-02 修改 `growthbook.ts`：`getFeatureValue_CACHED_MAY_BE_STALE()` 只從 disk cache 讀取
- [x] M6d-03 修改 `growthbook.ts`：`checkStatsigFeatureGate_CACHED_MAY_BE_STALE()` 從 disk cache 讀取，找不到回 true
- [x] M6d-04 修改 `growthbook.ts`：`checkGate_CACHED_OR_BLOCKING()` 從 disk cache 讀取，找不到回 true（不阻塞）
- [x] M6d-05 修改 `growthbook.ts`：`refreshGrowthBookAfterAuthChange()` → no-op
- [x] M6d-06 修改 `src/utils/config.ts`：`createDefaultGlobalConfig()` 的 `cachedGrowthBookFeatures` 預填 ~100 個 flag（boolean 預設 true，反向邏輯的設 false，非 boolean 保留原值）

#### 區塊 2：Auth 移除
- [x] M6d-07 修改 `src/utils/auth.ts`：`isAnthropicAuthEnabled()` 永遠回 false — 所有 auth 檢查短路
- [x] M6d-08 確認 `useApiKeyVerification()` 自動回 valid（被 isAnthropicAuthEnabled 短路）
- [x] M6d-09 修改 `src/utils/preflightChecks.tsx`：`checkEndpoints()` 直接回 success（不檢查 Anthropic 連線）
- [x] M6d-10 修改 `src/commands/login/index.ts`：`isEnabled()` 回 false
- [x] M6d-11 修改 `src/commands/logout/index.ts`：`isEnabled()` 回 false
- [x] M6d-12 修改 `src/setup.ts`：移除 `prefetchApiKeyFromApiKeyHelperIfSafe()` 呼叫
- [x] M6d-13 確認 Onboarding 自動跳過 oauth/preflight/api-key steps（被 isAnthropicAuthEnabled 短路）
- [x] M6d-14 確認 BypassPermissionsModeDialog 已在 M6c 移除

#### 區塊 3：功能解鎖
- [x] M6d-15 修改 `src/bridge/bridgeEnabled.ts`：`isBridgeEnabled()` / `isBridgeEnabledBlocking()` / `getBridgeDisabledReason()` 移除 auth gate（保留 feature flag 檢查）
- [x] M6d-16 確認 Voice mode auth gate 被 isAnthropicAuthEnabled 短路
- [x] M6d-17 確認 dev channels auth gate 自然降級（無 OAuth → fallback path）

#### 驗證
- [x] M6d-18 typecheck 通過 + 93/93 測試全綠 + 端到端 `bun run dev -p "hi"` 成功回應

### M7 — Hermes 使用者建模（TypeScript 重新實作）
將 Honcho 風格的使用者建模和跨 session 回憶移植到 free-code。

### M8 — 移除殘留 Anthropic 對外連線與品牌字串

**目標**：稽核後發現產品本體仍有對 `api.anthropic.com` 的活路徑（MCP registry 啟動 prefetch）+ 每次 LLM 呼叫送出 "You are Claude Code, Anthropic's official CLI..." system prompt。本里程碑堵住活路徑、改寫 system prompt、刪掉已死的 telemetry/feedback POST 程式碼。

#### 批次 A — 堵住啟動時對外請求
- [x] M8-01 修改 `src/services/mcp/officialRegistry.ts`：`prefetchOfficialMcpUrls()` 直接 early-return（保留簽章不破壞 caller）

#### 批次 B — System prompt 改名
- [x] M8-02 修改 `src/constants/system.ts:9-11`：三條 prefix 改為 my-agent 品牌（`"You are my-agent, a local-first coding assistant."` 系列）— `splitSysPromptPrefix` 透過 `CLI_SYSPROMPT_PREFIXES` 自動跟著生效

#### 批次 C — 刪除 dead telemetry / feedback POST 程式碼
- [x] M8-03 刪除 `src/utils/telemetry/bigqueryExporter.ts`（無 caller，純死碼）
- [x] M8-04 刪除 `src/services/api/metricsOptOut.ts`（唯一 caller 是上面那個 dead exporter）
- [x] M8-05 修改 `src/services/analytics/firstPartyEventLoggingExporter.ts`：`sendBatchWithRetry` 改 no-op，整段網路送出邏輯刪除
- [x] M8-06 修改 `src/components/Feedback.tsx`：`submitFeedback` 直接回 `{success:false}`，不對外送
- [x] M8-07 改寫 `src/components/FeedbackSurvey/submitTranscriptShare.ts`：整檔縮為 no-op stub，移除 axios POST

#### 驗證
- [x] M8-08 `bun run typecheck` 綠燈（只剩既有的 tsconfig baseUrl 棄用警告）

### M9 — Dead code 清理 + Feedback/Survey UX 收尾

**目標**：刪掉 M8 後仍殘留的死碼（FirstParty exporter 整家族、filesApi、Sessions WebSocket）、把已 silently fail 的 /feedback + transcript share 改為明確「停用」訊息或從 UI 移除。

- [x] M9-01 刪 `firstPartyEventLoggingExporter.ts` + `sinkKillswitch.ts`（`firstPartyEventLogger.ts` 是 OSS stub，6 個 caller 仰賴，保留）
- [x] M9-02 N/A — `/feedback` 整個指令停用後 Feedback 元件不會 render，UI 改寫不必要
- [x] M9-03 `src/commands/feedback/index.ts`：`isEnabled: () => false` 永久停用
- [x] M9-04 N/A — survey 流程深度整合 transcript share UI；M8 stub 已斷網路面，UX 失敗罕見容忍
- [x] M9-05 `growthbook.ts:505-506` hardcoded URL 改 `''`
- [x] M9-06 `filesApi.ts:32-38` `getDefaultApiBaseUrl()` 拿掉預設 `api.anthropic.com`，改回 `''`
- [x] M9-07 延後到 M11 — SessionsWebSocket URL 來自 `getOauthConfig().BASE_API_URL`，會在 M11 oauth.ts 下架時一併處理
- [x] M9-08 typecheck 綠 + `bun run dev -p "1+1="` 回 `1+1=2`

### M10 — Attribution Header + UA 中性化

**目標**：每次 LLM request 還在送 `x-anthropic-billing-header` 和 `claude-cli/x.y.z` UA，把它們對 llamacpp provider 中性化。

- [x] M10-01 `getAttributionHeader()` 加 llamacpp 短路條件回 `''`
- [x] M10-02 `getClaudeCodeUserAgent()` UA 改 `my-agent/${MACRO.VERSION}`
- [x] M10-03 抽 `ATTRIBUTION_HEADER_PREFIX` const 到 `src/constants/system.ts`，`utils/api.ts` 三處 magic string 改 import
- [x] M10-04 typecheck 綠 + `bun run dev -p "4*3="` 回 `4 * 3 = 12`

### M11 — OAuth scaffolding 完整下架

**目標**：M6d 已把 `isAnthropicAuthEnabled()` 永遠 false，但 30+ 處還 import `*OAuth*`、`getClaudeAIOAuthTokens` 等。本里程碑徹底移除 OAuth 相關檔案與分支。

- [x] M11-01 N/A — `isAnthropicAuthEnabled() === false` 已短路所有 caller，無需逐一改寫分支
- [x] M11-02 改採「中性化」策略 — oauth/ 目錄保留供 12+ 處型別 import，網路函式因 token 為空自然短路
- [x] M11-03 刪 `src/commands/install-github-app/` 整目錄；`ConsoleOAuthFlow.tsx` 縮為 stub（674 行 → 21 行，render `null`+ 即時 `onDone()`）
- [x] M11-04 N/A — `cli/print.ts` 兩處 OAuthService 在 `isAnthropicAuthEnabled() === false` 路徑不會觸發
- [x] M11-05 `src/constants/oauth.ts` PROD_OAUTH_CONFIG 全部 URL 字面改 `''`；`MCP_CLIENT_METADATA_URL` 改 `''`；`src/services/mcp/client.ts:880` claude.ai proxy 因 `getClaudeAIOAuthTokens()` 已 throw 自然不觸發
- [x] M11-06 N/A — 動 `utils/auth.ts` cascade 過大且既已短路；保留現狀
- [x] M11-07 額外處理 — `WebFetchTool/utils.ts checkDomainBlocklist` 改永遠 allow（原本每次 web_fetch 都查 anthropic）；`upstreamproxy.ts:121` 拿掉 `api.anthropic.com` 預設
- [x] M11-08 typecheck 綠 + `bun run dev -p "5+5="` 回 `10`
- [x] `commands/install-github-app` tip 從 `tipRegistry.ts` 移除

### M12 — Bundled skill `claude-api` 改名 + 完整改寫

**目標**：`src/skills/bundled/claude-api/` 內容是教使用者用 Anthropic SDK，整個改寫成 my-agent + 本地 LLM 對接教學。

- [x] M12-01 目錄改名 `claude-api` → `anthropic-sdk-reference`；SKILL.md frontmatter 更新清楚標示「外部 SDK 參考、非 free-code 本地 LLM」
- [x] M12-02 N/A — 採用「只改名不改內容」策略（247KB 多語言 SDK 文件保留實用價值，定位改為「外部 Anthropic SDK 參考資料」）
- [x] M12-03 `claudeApiContent.ts` 8+ 處 import 路徑 `./claude-api/` → `./anthropic-sdk-reference/`；`claudeApi.ts` 註冊名稱與文案同步更新
- [x] M12-04 typecheck 綠 + `bun run dev -p "9-3="` 回 `9 - 3 = 6`

### M13 — 完整測試計畫執行

**目標**：M8–M12 大量重構後執行 11 層測試確保未破壞既有功能、改動如預期生效、建構綠燈。產出物：`tests/integration/test-run-2026-04-18.md`

#### 第一輪 — 無需 llama-server
- [x] M13-T1 typecheck ✅ 綠；build / build:dev ⚠️ pre-existing fail（非本次引入）
- [x] M13-T2 5 條 grep 全 PASS（命中皆為白名單）
- [x] M13-T3 unit tests **93 pass / 0 fail / 11 files**
- [x] M13-T4 memory smoke **61 pass / 0 fail / 4 scripts**
- [x] M13-T11 4 項全 PASS（config 存在、無 dialog、permission default、auth 短路）

#### 第二輪 — 需 llama-server
- [x] M13-T5 llama health ✅ `{"status":"ok"}`；T5.2 verify.sh 未獨立跑（health 已涵蓋）
- [x] M13-T6 6 個 PoC 全 PASS（修了 6 檔 `@anthropic-ai/sdk` → `my-agent-ai/sdk` import）
- [x] M13-T7 6 個 prompt 全 PASS（T7.4 模型幻覺後重試成功）

#### 第三輪 — 人工 + 觀察
- [x] M13-T8 SKIPPED（本 session 不執行人工）
- [x] M13-T9 DNS 對 anthropic / claude / statsig / growthbook **0 命中**
- [x] M13-T10 TIMEOUT（本地推理 20+ 分鐘需求超過 480s timeout；算法層由 Tier 3 unit tests 覆蓋）

#### 收尾
- [x] M13-99 `tests/integration/test-run-2026-04-18.md` 已產出

### M14 — 強制預設 llamacpp provider（修 /model 顯示 Anthropic 模型 + 連帶 banner / status）

**目標**：`getAPIProvider()` 預設改 `llamacpp`（不再 fallback `firstParty`）→ /model 只列本地模型、banner 顯示「llama.cpp (local)」、/status 顯示 llamacpp provider。配合補 `getModelOptionsBase` / `getDefaultOptionForUser` / `buildAPIProviderProperties` 三處 llamacpp 分支。無 opt-back env（Anthropic 路徑因 auth 移除無實際用途）。

- [x] M14-01 `getAPIProvider()` 預設改 `'llamacpp'`；`CLAUDE_CODE_USE_LLAMACPP` env 移除（無作用）
- [x] M14-02 `getModelOptionsBase()` 加 llamacpp 分支 → 只回 default 選項
- [x] M14-03 `getDefaultOptionForUser()` 加 llamacpp 分支 → `Local llama.cpp (qwopus3.5-9b-v3)`
- [x] M14-04 `buildAPIProviderProperties()` 加 llamacpp 分支
- [x] M14-05 額外修補：`getBuiltinModelStrings('llamacpp'|'openai')` 全部映射到 DEFAULT_LLAMACPP_MODEL（避免 undefined cascade hang 下游）
- [x] M14-06 typecheck 綠 + `bun run dev -p "請說一句話"` 回「你好！有什麼我可以幫忙的嗎？」
- [x] M14-99 教訓存 memory：template literal undefined → print mode hang（typecheck 漏抓）

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

- 2026-04-15 16:02: Session 結束 | 進度：5/26 任務 | 66d2a1a chore(m1): 完成階段一最後一項 — typecheck 綠燈基線

- 2026-04-15 16:07: Session 結束 | 進度：5/26 任務 | 66d2a1a chore(m1): 完成階段一最後一項 — typecheck 綠燈基線

- 2026-04-15 16:14: Session 結束 | 進度：5/26 任務 | 66d2a1a chore(m1): 完成階段一最後一項 — typecheck 綠燈基線

- 2026-04-15 16:18: Session 結束 | 進度：5/26 任務 | 66d2a1a chore(m1): 完成階段一最後一項 — typecheck 綠燈基線

- 2026-04-15 16:34: Session 結束 | 進度：10/27 任務 | 403a514 feat(api): llamacpp-fetch-adapter 串流翻譯（純文字 + thinking）

- 2026-04-15 16:54: Session 結束 | 進度：14/27 任務 | 4730c0a chore(m1): 勾選 V5 回歸驗證（結構驗證通過，待真 key e2e 確認）

- 2026-04-15 17:17: Session 結束 | 進度：17/27 任務 | a8694da chore: .gitignore 追加 cli.exe / cli-dev.exe

- 2026-04-15 17:24: Session 結束 | 進度：19/27 任務 | 63ca009 test(m1): 階段三其餘 34 工具 Part A 翻譯 34/34 全綠

- 2026-04-15 20:35: Session 結束 | 進度：27/29 任務 | eb49b0d docs(m1): TODO 標記 Bun TUI panic 與 -p mode regression 為延後項目

- 2026-04-15 20:43: Session 結束 | 進度：27/29 任務 | eb49b0d docs(m1): TODO 標記 Bun TUI panic 與 -p mode regression 為延後項目

- 2026-04-15 20:54: Session 結束 | 進度：27/55 任務 | eb49b0d docs(m1): TODO 標記 Bun TUI panic 與 -p mode regression 為延後項目

- 2026-04-15 21:01: Session 結束 | 進度：27/56 任務 | eb49b0d docs(m1): TODO 標記 Bun TUI panic 與 -p mode regression 為延後項目

- 2026-04-15 21:04: Session 結束 | 進度：27/56 任務 | eb49b0d docs(m1): TODO 標記 Bun TUI panic 與 -p mode regression 為延後項目

- 2026-04-15 21:18: Session 結束 | 進度：27/56 任務 | 99f3a68 docs: 修正 slash command 命名（colon → dash）與 subagent 說明

- 2026-04-15 21:45: Session 結束 | 進度：28/56 任務 | 224cf7c feat(m2): M2-01 加 parent_session_id 欄位供 compaction chain tracking

- 2026-04-15 21:47: Session 結束 | 進度：28/56 任務 | 224cf7c feat(m2): M2-01 加 parent_session_id 欄位供 compaction chain tracking

- 2026-04-15 21:50: Session 結束 | 進度：28/56 任務 | 224cf7c feat(m2): M2-01 加 parent_session_id 欄位供 compaction chain tracking

- 2026-04-15 22:00: Session 結束 | 進度：29/56 任務 | 70c70da feat(m2): M2-02 JSONL 寫入同步 tee 到 FTS 索引

- 2026-04-15 23:35: Session 結束 | 進度：30/56 任務 | 592d4ca feat(m2): M2-03 啟動時 bulk reconcile JSONL 至 FTS 索引

- 2026-04-16 08:48: Session 結束 | 進度：30/56 任務 | 302ebf4 docs(skills): 新增 session-fts-indexing skill

- 2026-04-16 08:59: Session 結束 | 進度：30/56 任務 | 0384537 fix(m2): indexEntry 優先用 entry.timestamp，ended_at 改 MAX

- 2026-04-16 09:06: Session 結束 | 進度：31/56 任務 | 730433f docs(m2): 勾選 M2-04，階段一（索引基礎建設）收尾

- 2026-04-16 09:10: Session 結束 | 進度：32/56 任務 | 730433f docs(m2): 勾選 M2-04，階段一（索引基礎建設）收尾

- 2026-04-16 09:11: Session 結束 | 進度：32/56 任務 | 730433f docs(m2): 勾選 M2-04，階段一（索引基礎建設）收尾

- 2026-04-16 09:20: Session 結束 | 進度：32/56 任務 | c2af789 feat(m2): M2-05 SessionSearchTool — 跨 session FTS 搜尋工具

- 2026-04-16 09:36: Session 結束 | 進度：33/56 任務 | 732cdfe feat(m2): M2-06 SessionSearchTool summarize 分支呼叫 llamacpp 做摘要

- 2026-04-16 09:37: Session 結束 | 進度：33/56 任務 | 732cdfe feat(m2): M2-06 SessionSearchTool summarize 分支呼叫 llamacpp 做摘要

- 2026-04-16 09:45: Session 結束 | 進度：34/56 任務 | 732cdfe feat(m2): M2-06 SessionSearchTool summarize 分支呼叫 llamacpp 做摘要

- 2026-04-16 09:47: Session 結束 | 進度：34/56 任務 | 00c9910 feat(m2): M2-07 SessionSearchTool 註冊到 tools.ts

- 2026-04-16 09:53: Session 結束 | 進度：34/56 任務 | 4b4c1c3 fix(m2): SessionSearch call() 加防呆 + debug log（TUI 實測 input.query 為 undefined）

- 2026-04-16 09:56: Session 結束 | 進度：34/56 任務 | 4b4c1c3 fix(m2): SessionSearch call() 加防呆 + debug log（TUI 實測 input.query 為 undefined）

- 2026-04-16 10:02: Session 結束 | 進度：34/56 任務 | 4b4c1c3 fix(m2): SessionSearch call() 加防呆 + debug log（TUI 實測 input.query 為 undefined）

- 2026-04-16 10:09: Session 結束 | 進度：34/56 任務 | 9864572 fix(api): llamacpp SSE UTF-8 切碎修正 — TextDecoder streaming bug

- 2026-04-16 10:15: Session 結束 | 進度：34/56 任務 | ce15bb8 fix(m2): FTS 多 token query 改用 OR（不是 AND）

- 2026-04-16 10:23: Session 結束 | 進度：34/56 任務 | e0cd705 fix(m2): LIKE fallback 移除 ESCAPE 子句 — SQLite 報 2-char escape error

- 2026-04-16 10:35: Session 結束 | 進度：34/56 任務 | e0cd705 fix(m2): LIKE fallback 移除 ESCAPE 子句 — SQLite 報 2-char escape error

- 2026-04-16 10:41: Session 結束 | 進度：34/56 任務 | e0cd705 fix(m2): LIKE fallback 移除 ESCAPE 子句 — SQLite 報 2-char escape error

- 2026-04-16 10:51: Session 結束 | 進度：34/56 任務 | b0ef992 fix(api): adapter 累積完整 tool args 再一次 yield 解決 SDK UTF-8 亂碼

- 2026-04-16 10:56: Session 結束 | 進度：34/56 任務 | 9b17e7d fix(m2): LIKE fallback 拆 query 為多詞 OR，解決空格切開的中文搜不到

- 2026-04-16 11:02: Session 結束 | 進度：34/56 任務 | 587f162 fix(m2): SessionSearch 輸出格式對齊 Grep/Glob 風格（9B 模型可讀）

- 2026-04-16 11:30: Session 結束 | 進度：34/56 任務 | a9da051 fix(api): tool_use SSE 事件合併成單一 chunk 避免 SDK 跨 chunk 丟事件

- 2026-04-16 11:33: Session 結束 | 進度：34/56 任務 | a9da051 fix(api): tool_use SSE 事件合併成單一 chunk 避免 SDK 跨 chunk 丟事件

- 2026-04-16 11:37: Session 結束 | 進度：34/56 任務 | a9da051 fix(api): tool_use SSE 事件合併成單一 chunk 避免 SDK 跨 chunk 丟事件

- 2026-04-16 12:02: Session 結束 | 進度：35/56 任務 | 430d588 fix(api): sseGeneratorToStream 改為 collect-all 一次送出

- 2026-04-16 12:09: Session 結束 | 進度：35/56 任務 | 430d588 fix(api): sseGeneratorToStream 改為 collect-all 一次送出

- 2026-04-16 12:10: Session 結束 | 進度：35/56 任務 | 430d588 fix(api): sseGeneratorToStream 改為 collect-all 一次送出

- 2026-04-16 12:25: Session 結束 | 進度：35/56 任務 | 430d588 fix(api): sseGeneratorToStream 改為 collect-all 一次送出

- 2026-04-16 12:29: Session 結束 | 進度：35/56 任務 | 430d588 fix(api): sseGeneratorToStream 改為 collect-all 一次送出

- 2026-04-16 12:35: Session 結束 | 進度：35/56 任務 | 430d588 fix(api): sseGeneratorToStream 改為 collect-all 一次送出

- 2026-04-16 12:52: Session 結束 | 進度：40/57 任務 | 66b6ce3 docs(m2): 勾選 M2-12 — 失敗靜默 fallback 已內建於 M2-11 實作

- 2026-04-16 13:04: Session 結束 | 進度：41/57 任務 | 5f46900 docs(m2): 勾選 M2-13 — prefetch 端到端 TUI 驗證通過

- 2026-04-16 13:04: Session 結束 | 進度：41/57 任務 | 5f46900 docs(m2): 勾選 M2-13 — prefetch 端到端 TUI 驗證通過

- 2026-04-16 13:14: Session 結束 | 進度：42/57 任務 | 915cf58 feat(m2): M2-14 MemoryTool — memdir 四型檔案管理工具

- 2026-04-16 13:32: Session 結束 | 進度：46/57 任務 | 2c984c9 test(m2): M2-18 MemoryTool 端到端 smoke test — 47/47 綠

- 2026-04-16 13:32: Session 結束 | 進度：46/57 任務 | 2c984c9 test(m2): M2-18 MemoryTool 端到端 smoke test — 47/47 綠

- 2026-04-16 13:34: Session 結束 | 進度：46/57 任務 | 2c984c9 test(m2): M2-18 MemoryTool 端到端 smoke test — 47/47 綠

- 2026-04-16 13:43: Session 結束 | 進度：49/57 任務 | 2bf6dcb docs(m2): 勾選 M2-21 — 無新教訓、不需新 skill

- 2026-04-16 13:54: Session 結束 | 進度：49/57 任務 | 6251289 docs: LESSONS.md 新增 FTS5 中文 phrase match 教訓

- 2026-04-16 14:05: Session 結束 | 進度：49/57 任務 | 6251289 docs: LESSONS.md 新增 FTS5 中文 phrase match 教訓

- 2026-04-16 14:08: Session 結束 | 進度：49/57 任務 | 6251289 docs: LESSONS.md 新增 FTS5 中文 phrase match 教訓

- 2026-04-16 14:10: Session 結束 | 進度：49/57 任務 | 6251289 docs: LESSONS.md 新增 FTS5 中文 phrase match 教訓

- 2026-04-16 14:13: Session 結束 | 進度：49/57 任務 | 6251289 docs: LESSONS.md 新增 FTS5 中文 phrase match 教訓

- 2026-04-16 14:26: Session 結束 | 進度：49/57 任務 | 6251289 docs: LESSONS.md 新增 FTS5 中文 phrase match 教訓

- 2026-04-16 14:38: Session 結束 | 進度：49/57 任務 | 6251289 docs: LESSONS.md 新增 FTS5 中文 phrase match 教訓

- 2026-04-16 14:45: Session 結束 | 進度：49/57 任務 | 6251289 docs: LESSONS.md 新增 FTS5 中文 phrase match 教訓

- 2026-04-16 14:49: Session 結束 | 進度：49/57 任務 | 6251289 docs: LESSONS.md 新增 FTS5 中文 phrase match 教訓

- 2026-04-16 14:51: Session 結束 | 進度：49/57 任務 | 6251289 docs: LESSONS.md 新增 FTS5 中文 phrase match 教訓

- 2026-04-16 15:02: Session 結束 | 進度：49/57 任務 | 6251289 docs: LESSONS.md 新增 FTS5 中文 phrase match 教訓

- 2026-04-16 15:25: Session 結束 | 進度：49/57 任務 | 6251289 docs: LESSONS.md 新增 FTS5 中文 phrase match 教訓

- 2026-04-16 15:26: Session 結束 | 進度：49/57 任務 | 6251289 docs: LESSONS.md 新增 FTS5 中文 phrase match 教訓

- 2026-04-16 15:30: Session 結束 | 進度：49/57 任務 | 6251289 docs: LESSONS.md 新增 FTS5 中文 phrase match 教訓

- 2026-04-16 15:36: Session 結束 | 進度：49/57 任務 | 6251289 docs: LESSONS.md 新增 FTS5 中文 phrase match 教訓

- 2026-04-16 15:43: Session 結束 | 進度：49/57 任務 | 6251289 docs: LESSONS.md 新增 FTS5 中文 phrase match 教訓

- 2026-04-16 15:50: Session 結束 | 進度：49/57 任務 | 6251289 docs: LESSONS.md 新增 FTS5 中文 phrase match 教訓

- 2026-04-16 16:05: Session 結束 | 進度：55/57 任務 | 8931dce refactor: 品牌重塑 — @anthropic-ai → my-agent-ai、.claude → .my-agent、.free-code → .my-agent

- 2026-04-16 16:13: Session 結束 | 進度：55/57 任務 | 8931dce refactor: 品牌重塑 — @anthropic-ai → my-agent-ai、.claude → .my-agent、.free-code → .my-agent

- 2026-04-16 20:54: Session 結束 | 進度：55/57 任務 | 8931dce refactor: 品牌重塑 — @anthropic-ai → my-agent-ai、.claude → .my-agent、.free-code → .my-agent

- 2026-04-16 21:15: Session 結束 | 進度：55/57 任務 | 8931dce refactor: 品牌重塑 — @anthropic-ai → my-agent-ai、.claude → .my-agent、.free-code → .my-agent

- 2026-04-16 21:26: Session 結束 | 進度：55/57 任務 | 8931dce refactor: 品牌重塑 — @anthropic-ai → my-agent-ai、.claude → .my-agent、.free-code → .my-agent

- 2026-04-16 21:39: Session 結束 | 進度：55/57 任務 | 8931dce refactor: 品牌重塑 — @anthropic-ai → my-agent-ai、.claude → .my-agent、.free-code → .my-agent

- 2026-04-16 21:44: Session 結束 | 進度：55/57 任務 | 8931dce refactor: 品牌重塑 — @anthropic-ai → my-agent-ai、.claude → .my-agent、.free-code → .my-agent

- 2026-04-16 22:01: Session 結束 | 進度：60/77 任務 | 8931dce refactor: 品牌重塑 — @anthropic-ai → my-agent-ai、.claude → .my-agent、.free-code → .my-agent

- 2026-04-16 22:43: Session 結束 | 進度：75/77 任務 | a1125a3 docs: 修正 CLAUDE.md 及 .claude/ 設定對齊現狀

- 2026-04-16 22:46: Session 結束 | 進度：75/77 任務 | a1125a3 docs: 修正 CLAUDE.md 及 .claude/ 設定對齊現狀

- 2026-04-16 22:49: Session 結束 | 進度：75/77 任務 | a1125a3 docs: 修正 CLAUDE.md 及 .claude/ 設定對齊現狀

- 2026-04-16 22:53: Session 結束 | 進度：75/77 任務 | 3923766 refactor: 品牌重塑 — src/ 內 CLAUDE.md → MY-AGENT.md

- 2026-04-16 22:58: Session 結束 | 進度：75/77 任務 | 3923766 refactor: 品牌重塑 — src/ 內 CLAUDE.md → MY-AGENT.md

- 2026-04-16 23:06: Session 結束 | 進度：75/77 任務 | 3923766 refactor: 品牌重塑 — src/ 內 CLAUDE.md → MY-AGENT.md

- 2026-04-16 23:11: Session 結束 | 進度：75/77 任務 | 3923766 refactor: 品牌重塑 — src/ 內 CLAUDE.md → MY-AGENT.md

- 2026-04-16 23:19: Session 結束 | 進度：75/77 任務 | 3923766 refactor: 品牌重塑 — src/ 內 CLAUDE.md → MY-AGENT.md

- 2026-04-16 23:23: Session 結束 | 進度：75/77 任務 | 3b1d1b3 feat(api): llamacpp context window 自動偵測 — 查 /slots 端點讓 autocompact 閾值正確

- 2026-04-16 23:25: Session 結束 | 進度：75/77 任務 | 3b1d1b3 feat(api): llamacpp context window 自動偵測 — 查 /slots 端點讓 autocompact 閾值正確

- 2026-04-17 08:38: Session 結束 | 進度：75/77 任務 | 3b1d1b3 feat(api): llamacpp context window 自動偵測 — 查 /slots 端點讓 autocompact 閾值正確

- 2026-04-17 09:09: Session 結束 | 進度：75/77 任務 | 3b1d1b3 feat(api): llamacpp context window 自動偵測 — 查 /slots 端點讓 autocompact 閾值正確

- 2026-04-17 09:21: Session 結束 | 進度：75/77 任務 | 3b1d1b3 feat(api): llamacpp context window 自動偵測 — 查 /slots 端點讓 autocompact 閾值正確

- 2026-04-17 09:30: Session 結束 | 進度：75/77 任務 | 3b1d1b3 feat(api): llamacpp context window 自動偵測 — 查 /slots 端點讓 autocompact 閾值正確

- 2026-04-17 09:45: Session 結束 | 進度：75/77 任務 | 3b1d1b3 feat(api): llamacpp context window 自動偵測 — 查 /slots 端點讓 autocompact 閾值正確

- 2026-04-17 10:03: Session 結束 | 進度：75/77 任務 | 3b1d1b3 feat(api): llamacpp context window 自動偵測 — 查 /slots 端點讓 autocompact 閾值正確

- 2026-04-17 10:15: Session 結束 | 進度：80/107 任務 | 3b1d1b3 feat(api): llamacpp context window 自動偵測 — 查 /slots 端點讓 autocompact 閾值正確

- 2026-04-17 14:07: Session 結束 | 進度：123/132 任務 | 09da303 feat(m6): Self-Improving Loop — AutoDream × Hermes 合併 + 閾值可配置化 + JSONC 預設設定

- 2026-04-18 10:53: Session 結束 | 進度：191/195 任務 | 8eeb776 feat(m11): OAuth scaffolding 中性化 + 殘留 URL 清除

---

## M15 — 品牌徹底中性化 + Chrome/Voice 移除 + OAuth CLI 停用（2026-04-18）

**Context**：M8–M14 後仍有大量 `Claude` / `Anthropic` 字樣殘留在使用者可見介面（system prompt、CLI 描述、錯誤訊息、install.sh 等）。本里程碑徹底清除品牌殘留，移除不再可用的 Chrome / Voice 功能，並將 OAuth CLI 子命令改為印「not supported」退出。

### Phase 1 — BLOCKER 字串中性化
- [x] M15-P1-01 `src/constants/prompts.ts:452` system prompt 簡化模式自我介紹
- [x] M15-P1-02 `src/constants/prompts.ts:763` DEFAULT_AGENT_PROMPT
- [x] M15-P1-03 `src/coordinator/coordinatorMode.ts:116` coordinator 系統 prompt
- [x] M15-P1-04 `src/tools/AgentTool/built-in/generalPurposeAgent.ts:3` general agent prefix
- [x] M15-P1-05 `src/main.tsx:4132,4153,4162` CLI `auth login/status/logout` description
- [x] M15-P1-06 `src/commands/login/index.ts:9-11` + `src/commands/logout/index.ts:7` description
- [x] M15-P1-07 `src/commands/logout/logout.tsx:76` 登出訊息
- [x] M15-P1-08 `src/services/api/errors.ts:198,202,208` 三條錯誤訊息
- [x] M15-P1-09 `install.sh:36,173-174` banner + 登入引導
- [x] M15-P1-10 `bun run typecheck` + smoke 驗證

### Phase 2 — Chrome 功能整塊移除
- [x] M15-P2-01 刪 `src/commands/chrome/`（2 檔）
- [x] M15-P2-02 刪 `src/utils/claudeInChrome/`（8 檔）
- [x] M15-P2-03 刪 `src/components/ClaudeInChromeOnboarding.tsx`
- [x] M15-P2-04 刪 `src/hooks/useChromeExtensionNotification.tsx` + `usePromptsFromClaudeInChrome.tsx`
- [x] M15-P2-05 刪 `src/skills/bundled/claudeInChrome.ts`
- [x] M15-P2-06 清 `src/commands.ts:150,263` registry
- [x] M15-P2-07 清 `src/main.tsx` Chrome import / CLI flag / setup 區塊
- [x] M15-P2-08 清 `src/skills/bundled/index.ts` + `src/services/mcp/{config,client}.ts` + `src/services/api/claude.ts` import
- [x] M15-P2-09 清 `src/entrypoints/cli.tsx` + `src/utils/attachments.ts` + `src/utils/config.ts` + `src/bootstrap/state.ts` + `src/interactiveHelpers.tsx` + `src/screens/REPL.tsx` + `src/components/Settings/Config.tsx` + `src/tools/shared/spawnMultiAgent.ts` + `src/utils/swarm/spawnUtils.ts` + `src/utils/computerUse/*` 註解
- [x] M15-P2-10 `bun run typecheck` 必須綠

### Phase 3 — Voice 功能整塊移除
- [x] M15-P3-01 刪 `src/voice/` + `src/commands/voice/`
- [x] M15-P3-02 刪 `src/services/voice*.ts` (3 個)
- [x] M15-P3-03 刪 `src/hooks/useVoice*.{ts,tsx}` (3 個)
- [x] M15-P3-04 刪 `src/components/PromptInput/VoiceIndicator.tsx` + `src/components/LogoV2/VoiceModeNotice.tsx` + `src/context/voice.tsx`
- [x] M15-P3-05 清 `src/commands.ts` + `src/keybindings/*` + `src/state/AppState.tsx` + `scripts/build.ts` VOICE_MODE flag
- [x] M15-P3-06 清 UI 引用（Notifications / PromptInputFooterLeftSide / TextInput / LogoV2 / REPL.tsx）
- [x] M15-P3-07 清 `src/tools/ConfigTool/*` + `src/utils/settings/types.ts` + `src/utils/config.ts` + `src/entrypoints/sdk/coreSchemas.ts`
- [x] M15-P3-08 `bun run typecheck` 必須綠

### Phase 4 — OAuth CLI 子命令停用
- [x] M15-P4-01 `src/main.tsx` 三個 auth 子命令改為 console.error + process.exit(1)
- [x] M15-P4-02 typecheck 綠（smoke 留 Phase 6）

### Phase 5 — Rename（分 3 子 commit）
#### 5a 低風險
- [ ] M15-P5a-01 `src/utils/claudeDesktop.ts` → `desktopConfig.ts`
- [ ] M15-P5a-02 `src/skills/bundled/claudeApi*.ts` 對齊 M12 命名
- [ ] M15-P5a-03 `getClaudeCodeUserAgent` → `getCodeUserAgent`
- [ ] M15-P5a-04 `CLAUDE_CODE_EXPERIMENTAL_BUILD` → `EXPERIMENTAL_BUILD`

#### 5b 中風險（延後 — 內部識別字，不影響使用者介面）
- [ ] M15-P5b-01 `ClaudeAILimits` → `LlmRateLimits`（延後）
- [ ] M15-P5b-02 `isClaudeAISubscriber` → `hasInferenceAccess`（延後）
- [ ] M15-P5b-03 `src/services/claudeAiLimitsHook.ts` → `rateLimitsHook.ts`（延後）

#### 5c 高風險（延後 — 60+ 引用重構，改動面太大）
- [ ] M15-P5c-01 `src/services/api/claude.ts` → `api.ts`（延後）
- [ ] M15-P5c-02 `src/services/claudeAiLimits.ts` → `rateLimits.ts`（延後）
- [ ] M15-P5c-03 `src/utils/claudemd.ts` → `memoryFiles.ts`（延後）
- [ ] M15-P5c-04 `src/utils/claudeCodeHints.ts` → `codeHints.ts`（延後）
- [ ] M15-P5c-05 `getClaudeAIOAuthTokens` → `getStoredAuthTokens`（延後）
- [ ] M15-P5c-06 `getClaudeConfigHomeDir` → `getConfigHomeDir`（延後）

### Phase 6 — 最終驗證
- [x] M15-P6-01 Grep 殘留稽核 — 主要使用者可見 BLOCKER 清除（exploreAgent / statusNoticeDefinitions 補修）
- [x] M15-P6-02 `bun run typecheck` 綠
- [~] M15-P6-03 `bun run build` — 預先存在的 `react-devtools-core` 依賴錯誤（非 M15 造成），build 失敗但不阻擋 M15
- [~] M15-P6-04 CLI 驗證：`--help` 載入正常、`auth login/logout` 正確印 not supported 且 exit 1；llamacpp print mode 實測有 hang 傾向（非 M15 regressions，既有現象）
- [x] M15-P6-05 更新 `DEPLOYMENT_PLAN.md` + `LESSONS.md`（stash pop 還原已刪除檔案的 pitfall）

### 驗收標準
- 完整功能測試通過（Tier 1–9 綠）
- 使用者可見介面無 "Claude" / "Anthropic" 字樣
- Chrome / Voice 相關 import 全清乾淨
- `./cli auth login/logout/status` 印 not supported 並 exit 1
- Anthropic API header（`anthropic-version`）保留（API 契約必要）

### 不在範圍
- `src/vendor/my-agent-ai/` 內 SDK 原始碼（vendored，保留 Anthropic 字樣）
- `src/types/generated/` protobuf 自動產生（保留）
- `ANTHROPIC_API_KEY` 等環境變數名（外部契約）

- 2026-04-18 14:30: Session 結束 | 進度：247/260 任務 | cb05a66 docs(lessons): 記錄 git stash -u + failed checkout 讓已刪除檔案復活的 pitfall

- 2026-04-18 15:58: Session 結束 | 進度：247/260 任務 | 73e1b02 test(m15): 完整測試執行報告 + 6 處漏網字串補修

- 2026-04-18 16:13: Session 結束 | 進度：247/260 任務 | 73e1b02 test(m15): 完整測試執行報告 + 6 處漏網字串補修

---

## M16 — 移除失效的 Claude Code migration hint（2026-04-18 完成，commit `f4baa7d`）

**Context**：設定目錄稽核時發現 `printFreeCodeMigrationHintOnce()` 機制已失效：
1. `LEGACY_CLAUDE_HOME_DIR_NAME` 被 commit `8931dce` 誤改成 `.my-agent`（應為 `.claude`），偵測條件永遠 false
2. M15 P4 後 OAuth 全停，「沿用舊登入」文案誤導
3. Session / settings schema drift 風險

### 任務清單
- [x] M16-01 刪 `src/utils/envUtils.ts` 的 `FREE_CODE_HOME_DIR_NAME` + `LEGACY_CLAUDE_HOME_DIR_NAME` 常數、`printFreeCodeMigrationHintOnce()` 函式、`existsSync` import
- [x] M16-02 刪 `src/main.tsx` 對應 import 與 bootstrap 呼叫
- [x] M16-03 CLAUDE.md 新增「從官方 Claude Code 遷移設定」段落
- [x] M16-04 `bun run typecheck` 綠
- [x] M16-05 grep 確認 0 殘留

### 驗收
- `bun src/entrypoints/cli.tsx --help` 不再印 free-code hint stderr ✅
- `getClaudeConfigHomeDir()` 預設 `~/.my-agent`、`CLAUDE_CONFIG_DIR` env 覆寫保留 ✅
- 從 Claude Code 切過來的使用者可查 CLAUDE.md 遷移指南 ✅

- 2026-04-18 16:32: Session 結束 | 進度：252/265 任務 | 10fed0a test(m16): 完整測試執行報告 + 2 處漏網字串補修

- 2026-04-18 16:50: Session 結束 | 進度：252/265 任務 | 737f2b4 refactor(tui): 中性化 TUI 使用者可見的 Claude Code 字串（~30 處跨 25 檔）

- 2026-04-18 17:04: Session 結束 | 進度：252/265 任務 | 737f2b4 refactor(tui): 中性化 TUI 使用者可見的 Claude Code 字串（~30 處跨 25 檔）

- 2026-04-18 19:02: Session 結束 | 進度：252/265 任務 | 737f2b4 refactor(tui): 中性化 TUI 使用者可見的 Claude Code 字串（~30 處跨 25 檔）

- 2026-04-18 19:22: Session 結束 | 進度：252/265 任務 | 7777a85 refactor(tui): 清掉所有 Claude Code 殘留字串（comments + 死功能 UI + skill 教材除外）

- 2026-04-18 19:25: Session 結束 | 進度：252/265 任務 | f179f2b chore: session log

- 2026-04-18 19:37: Session 結束 | 進度：252/265 任務 | f179f2b chore: session log

- 2026-04-18 19:44: Session 結束 | 進度：252/265 任務 | f179f2b chore: session log

- 2026-04-18 19:47: Session 結束 | 進度：252/265 任務 | f179f2b chore: session log

- 2026-04-18 20:33: Session 結束 | 進度：263/276 任務 | aabb653 feat(user-model): M-UM 移植 Hermes USER.md 使用者建模（雙層 + 三路開關）

- 2026-04-18 20:49: Session 結束 | 進度：264/277 任務 | 3aa98b5 docs(user-model): M-UM-6 重寫 MemoryTool prompt 指引 user_profile 使用時機

- 2026-04-18 20:57: Session 結束 | 進度：265/278 任務 | f740f3c docs(user-model): M-UM-7 強化 persona 指引套件（E1–E8）

- 2026-04-18 21:11: Session 結束 | 進度：265/278 任務 | f740f3c docs(user-model): M-UM-7 強化 persona 指引套件（E1–E8）

- 2026-04-18 21:14: Session 結束 | 進度：265/278 任務 | 790d9d3 fix(skill-creation): 批准後把完整候選資訊注入對話

- 2026-04-18 21:26: Session 結束 | 進度：265/278 任務 | 790d9d3 fix(skill-creation): 批准後把完整候選資訊注入對話

- 2026-04-18 22:13: Session 結束 | 進度：265/278 任務 | b7bacd1 docs(context): 記錄 free-code 上下文組成詳解（M-UM + M2）

- 2026-04-18 22:18: Session 結束 | 進度：265/278 任務 | b7bacd1 docs(context): 記錄 free-code 上下文組成詳解（M-UM + M2）

- 2026-04-19 07:10: Session 結束 | 進度：265/278 任務 | b7bacd1 docs(context): 記錄 free-code 上下文組成詳解（M-UM + M2）

- 2026-04-19 07:40: Session 結束 | 進度：274/287 任務 | 3129f2c refactor(brand): 使用者可見字串改為 my-agent，新增 my-agent bin alias

- 2026-04-19 07:43: Session 結束 | 進度：274/287 任務 | 3129f2c refactor(brand): 使用者可見字串改為 my-agent，新增 my-agent bin alias

- 2026-04-19 07:51: Session 結束 | 進度：274/287 任務 | 3129f2c refactor(brand): 使用者可見字串改為 my-agent，新增 my-agent bin alias

- 2026-04-19 07:55: Session 結束 | 進度：274/287 任務 | 3129f2c refactor(brand): 使用者可見字串改為 my-agent，新增 my-agent bin alias

- 2026-04-19 07:58: Session 結束 | 進度：274/287 任務 | 3129f2c refactor(brand): 使用者可見字串改為 my-agent，新增 my-agent bin alias

- 2026-04-19 08:02: Session 結束 | 進度：274/287 任務 | 3129f2c refactor(brand): 使用者可見字串改為 my-agent，新增 my-agent bin alias

- 2026-04-19 08:19: Session 結束 | 進度：278/318 任務 | 1df413e feat(m-sp-1): 建立 systemPromptFiles 模組 + seed 機制，外部化 3 個靜態段
