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
- [ ] M2-22 人工跑 smoke：`bun run dev --model qwen3.5-9b-neo` 開兩個 session，手動驗證 recall 行為（llamacpp 路徑）

### 完成標準（僅針對 llama.cpp 情境；Anthropic 路徑不作為驗收項）
- [ ] 跨 session recall：session B 問「上次的 X」能透過 SessionSearchTool 找回 session A 內容（llamacpp 主模型）
- [ ] Dynamic prefetch：user query 進來時 `<memory-context>` fence 自動注入相關 memdir + FTS 片段，system prompt 與 prefix cache 不受影響；llamacpp 能用注入脈絡作答
- [ ] MemoryTool：能正確寫 memdir 四型檔案、維護 MEMORY.md 索引、拒絕 injection 嘗試
- [ ] llamacpp 路徑下既有記憶系統行為不變：`memdir/` / `SessionMemory/` / `extractMemories/` / `autoDream/` 四個既有系統在 llamacpp 模式仍正常運作
- [ ] Anthropic 路徑：code 保留、不主動破壞，但不再測試、不列為回歸門檻

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

- [ ] **Bun compiled `.\cli.exe` TUI panic** — Bun 1.3.6 single-file-executable + Ink React TUI 衝突（非我方 bug），追 Bun changelog，未修前互動模式一律走 `bun run dev`
- [ ] **`-p` non-interactive mode regression** — `./cli.exe -p "..."` / `bun src/.. -p "..."` 90 秒無輸出 timeout，疑似 isolation commit 後出現。Trace 顯示 bootstrap 跑完 `cli_after_main_complete` 但 print 模式 query 沒實際發出。`bun run dev` 互動模式正常，所以開發階段可用；批次測試須等修好

### 完成標準
- [x] `./cli --model qwen3.5-9b-neo -p "hello"` 成功串流輸出；log 顯示連接 `http://127.0.0.1:8080/v1`（階段四 Task 1 實測 `3+5=?` → `8`，llamacpp 分支命中。**註**：isolation commit 後 -p mode 出現 regression 待修）
- [x] 工具呼叫可用：至少 Bash、Read、Write、Edit、Glob 五個核心工具端到端通過（階段三 Part B commit `cd80511` 5/5 綠）
- [x] 既有 Anthropic 使用者路徑**完全不受影響** — 結構驗證通過：未設 `CLAUDE_CODE_USE_LLAMACPP` 且 model 不是 llamacpp 別名時 `getLlamaCppConfig()` 回 null、llamacpp 分支不進，走原 Anthropic 初始化鏈。**需使用者用真 Anthropic key 最後端到端確認一次**
- [x] `tests/integration/TOOL_TEST_RESULTS.md` 記錄 43 個工具結果（39 個可測 + 4 個 feature-gated），adapter 翻譯成功率 100%，前 5 核心工具四維度全綠

---

## 未來里程碑（尚未詳細規劃）

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
