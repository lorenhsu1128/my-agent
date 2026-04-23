# CLAUDE.md

## 專案概述

本專案是 my-agent，已移除遙測、移除安全護欄、解鎖所有實驗功能。我們正在擴充它，加入多 provider 支援、本地模型能力，以及從 Hermes Agent（Nous Research）移植的功能。

Hermes Agent 的原始碼作為唯讀參考資料放在 `reference/hermes-agent/`。它是 Python — 閱讀它以理解設計和邏輯，然後用 TypeScript 在 my-agent 的既有架構內重新實作。

## 黃金規則

1. **永遠先啟動 conda 環境。** 在執行任何指令之前 — 建構、測試、安裝或腳本執行 — 都要先執行 `conda activate aiagent`。這適用於每個 session 的每一條終端指令。如果開了新的 shell 或不確定環境是否啟用，在繼續之前再次執行 `conda activate aiagent`。

2. **保留 my-agent 的既有程式碼。** 不要刪除或重寫現有檔案。透過擴充來新增功能，而非替換。當你需要修改現有檔案時，做最小必要的更改，並確保在新 provider 未啟用時原始行為完全不變。

3. **Hermes 程式碼僅供參考。** 絕不直接複製 Python 程式碼。閱讀 `reference/hermes-agent/` 以理解功能的設計和運作方式，然後撰寫符合 my-agent 架構（React/Ink UI、Tool 基礎類別、services 模式等）的道地 TypeScript 程式碼。

4. **本地模型透過 fetch adapter 整合。** M1 已實作 `src/services/api/llamacpp-fetch-adapter.ts`，在 `src/services/api/` 內用 adapter 模式支援 llama.cpp，不另建 `src/services/providers/` 目錄。既有的 Anthropic 路徑完全不受影響。

5. **每次功能性修改後都要測試。** TypeScript 變更後執行 `bun run typecheck`。針對受影響的 provider/工具執行整合測試。如果測試還不存在，先寫測試。

6. **提交可運作的狀態。** 每個邏輯單元的工作在編譯通過並通過測試後就提交。使用約定式提交格式：`feat(providers): ...`、`fix(proxy): ...`、`test(tools): ...`、`docs: ...`。

7. **遇到架構決策時，停下來問我。** 不要自行做結構性決定。提出 2-3 個方案及其取捨，等我選擇。例如：新模組放在哪裡、如何處理協議差異、是否要加新的依賴。

8. **每次 session 開始時讀取 LESSONS.md。** 此檔案記錄了過去犯過的錯誤和踩過的坑。在開始任何工作之前先讀取它，避免重蹈覆轍。當你在開發中修復了一個 bug、回退了一個錯誤做法、或發現了一個非預期的行為時，立即在 LESSONS.md 的對應分類下附加一條記錄。

9. **適時建立新的 skill。** 當你完成一個複雜或重複性高的任務後，評估這個經驗是否值得記錄成 skill。判斷標準：
   - 這個任務涉及了不明顯的步驟或陷阱嗎？
   - 未來可能會再次需要做類似的事嗎？
   - 這個知識是否專屬於本專案、不容易從外部文件查到？

   如果判斷值得建立 skill：
   - 先告訴我你打算建立什麼 skill、為什麼認為有價值、大致內容摘要
   - 等我確認後，在 `.claude/skills/` 下建立新目錄和 SKILL.md
   - 遵循既有 skill 的格式（說明、工具集、具體內容）
   - 在 TODO.md 的 session 日誌中記錄新建了哪個 skill

   人類也可以隨時指示你建立 skill，此時直接執行不需評估。

10. **所有規劃與開發必須跨 Windows / macOS 相容。** 任何新功能、腳本、測試、設定流程，預設就要同時能在 Windows（bash via Git Bash / WSL 或 pwsh）和 macOS 下運作。遇到平台差異時：
    - 優先尋找跨平台寫法（Node/Bun API、forward-slash 路徑、`path.join`、`os.tmpdir()` 等）
    - 若不可避免要用平台特定指令或二進位（例如 `taskkill` vs `kill`、`.exe` vs 無副檔名、`serve.sh` vs `.ps1`），**必須提供兩套對應方案**，並在檔名或 code path 以 `-windows` / `-macos` 或 `process.platform` 分支清楚標示
    - 驗證時：PR / commit 前至少說明清楚該改動在另一個平台的預期行為；實際 E2E 由持有對應機器的人完成
    - 文件範例（指令、路徑、環境變數）盡量用 Unix shell 語法為預設，Windows 特殊情況另列

## 倉庫結構

```
my-agent/
├── CLAUDE.md              ← 你正在讀的這份文件
├── TODO.md                ← 任務追蹤 — 你負責讀寫此文件
├── LESSONS.md             ← 教訓記錄 — 你和人類都可以讀寫
├── src/
│   ├── vendor/            ← my-agent-ai SDK 內化原始碼（詳見 ADR-007）
│   │   └── my-agent-ai/
│   │       ├── sdk/               # 主 SDK TypeScript 原始碼（83 .ts 檔）
│   │       ├── bedrock-sdk/       # AWS Bedrock SDK TS 原始碼
│   │       ├── vertex-sdk/        # Google Vertex SDK TS 原始碼
│   │       ├── foundry-sdk/       # Azure Foundry SDK TS 原始碼
│   │       ├── mcpb/              # MCP Bundle 工具（可讀 JS + .d.ts）
│   │       └── sandbox-runtime/   # Sandbox 執行環境（可讀 JS + .d.ts + .map）
│   ├── skills/
│   │   └── bundled/       ← 17 個 bundled skills（M3 從 anthropics/skills 移植）
│   ├── services/
│   │   ├── api/           ← Anthropic 原生 API + llamacpp-fetch-adapter.ts（M1 新增）
│   │   ├── sessionIndex/  ← M2 新增 — FTS5 跨 session 搜尋索引
│   │   └── memoryPrefetch/ ← M2 新增 — query-driven 動態 prefetch
│   ├── tools/             ← 41+ 個 agent 工具（含 M2 新增的 SessionSearchTool、MemoryTool）
│   ├── commands/          ← 既有 — slash 指令
│   ├── ...                ← 所有其他既有目錄
│   └── utils/
│       └── model/         ← 模型設定、provider 偵測（含 llamacpp 分支）
├── reference/
│   └── hermes-agent/      ← 唯讀的 Hermes 原始碼（在 .gitignore 中）
├── tests/
│   └── integration/       ← 整合測試（memory smoke tests 等）
├── scripts/
│   └── llama/             ← llama.cpp server 部署腳本
└── .claude/               ← Claude Code 設定、指令、hooks、agents、skills
    ├── commands/          # 5 個 slash 指令（project-next 等）
    ├── agents/            # 2 個 subagent（reviewer、tester）
    ├── hooks/             # 3 個 hook 腳本
    ├── skills/            # 7 個專案開發技能檔案
    └── settings.json      # 權限與 hooks 設定
```

## 需要理解的關鍵檔案（my-agent）

在修改任何東西之前，先閱讀這些以理解 my-agent 的運作方式：

- `src/tools.ts` — 工具註冊表。所有 39 個工具在此註冊。使用 `feature()` 做 flag 控制。
- `src/Tool.ts` — 工具基礎介面（792 行）。所有工具都實作此介面。
- `src/QueryEngine.ts` — 核心 LLM 查詢引擎（1,295 行）。處理查詢分發、工具呼叫迴圈、用量追蹤。
- `src/vendor/my-agent-ai/sdk/` — 內化的 Anthropic SDK 原始碼（tsconfig paths 映射 `@anthropic-ai/sdk` → 此處）。
- `src/services/api/client.ts` — 當前 API 客戶端（Anthropic SDK 封裝）。
- `src/services/api/claude.ts` — 串流處理和用量累計。
- `src/services/tools/StreamingToolExecutor.ts` — 串流工具執行（530 行）。
- `src/services/tools/toolExecution.ts` — 工具生命週期管理（1,745 行）。
- `src/utils/model/` — 模型設定、provider 偵測、驗證。
- `src/bootstrap/state.ts` — 應用程式初始化狀態（1,758 行）。

## 需要參考的關鍵檔案（Hermes Agent）

實作 provider 功能時，研讀以下 Hermes 檔案：

- `reference/hermes-agent/agent/auxiliary_client.py` — 多 provider 客戶端抽象
- `reference/hermes-agent/hermes_cli/auth.py` — Provider 註冊表、ProviderConfig、憑證處理
- `reference/hermes-agent/agent/model_metadata.py` — 上下文長度偵測鏈
- `reference/hermes-agent/run_agent.py` — Hermes 如何路由到不同 provider

## 建構與測試指令

```bash
conda activate aiagent           # 每個 session 一定要先執行這個
bun install                      # 安裝依賴
bun run build                    # 正式建構
bun run build:dev                # 開發建構
bun run typecheck                # 僅型別檢查
bun test                         # 執行測試
./cli -p "hello"                 # 快速冒煙測試
./cli --model qwen3.5-9b-neo     # 使用本地模型測試（M1 已完成）
```

## 自訂 Slash 指令

使用這些指令取代打冗長的 prompt：

| 指令 | 功能 |
|------|------|
| `/project-next` | 找到 TODO.md 中下一個未完成的任務並開始執行。載入相關 skill、讀取 Hermes 程式碼（如需要）、執行、測試、提交。 |
| `/project-status` | 顯示專案進度（TODO 計數、最近 commit、typecheck 結果、服務健康狀態）。唯讀 — 不修改任何東西。 |
| `/project-test` | 執行完整測試套件（typecheck → 單元測試 → 整合測試 → 建構檢查）。報告結果但不自動修復。 |
| `/project-review-hermes` | 分析 Hermes Agent 的指定模組（provider、memory、tools、cron、gateway、skills、agent）。唯讀分析 — 提出設計方案等我決定。 |
| `/project-create-skill` | 手動建立新 skill。指定主題後，Claude Code 在 `.claude/skills/` 下建立目錄和 SKILL.md。 |

## Subagents（由 Claude Code 依情境調度）

`.claude/agents/` 下的 subagent 不是手動 slash command；Claude Code 會依任務內容自動啟動對應 subagent（或透過 Task tool 顯式指定 `subagent_type`）。使用者不需喚起。

| Subagent | 職責 |
|----------|------|
| `reviewer` | 程式碼審查專職。檢查架構合規性、程式碼品質、整合安全性、測試覆蓋。僅審查、不寫程式碼。當階段性成果完成需要 review 時由 Claude Code 調度。 |
| `tester` | QA 測試專職。驗證功能、找 bug、測試邊界情況，產出含重現步驟的測試報告。當需要獨立驗證時由 Claude Code 調度。 |

## Hooks（自動執行 — 不需手動介入）

這些透過 `.claude/settings.json` 自動運作：

| Hook | 觸發時機 | 動作 |
|------|---------|------|
| `pre-tool-use-conda.sh` | 任何 Bash/Terminal 指令執行前 | 驗證 `conda activate aiagent` 已啟用。未啟用則阻擋執行。 |
| `post-tool-use-typecheck.sh` | 任何 .ts/.tsx 檔案被編輯後 | 自動執行 `bun run typecheck`。報告通過/失敗。 |
| `notification-session-end.sh` | Session 結束時 | 將 session 摘要附加到 TODO.md。發送桌面通知。 |

## 權限設定（`.claude/settings.json`）

已預先核准的操作（不會彈出確認提示）：

- 任何檔案的讀取操作
- 在 `tests/`、`TODO.md`、`LESSONS.md` 的寫入/編輯
- Shell 指令：conda、bun、git、curl localhost、cat/ls/find/grep/head/tail/wc/echo/mkdir/cp/mv 等

已封鎖的操作（會被拒絕）：

- `rm -rf`、`sudo`、`chmod`
- 寫入 `src/QueryEngine.ts`、`src/Tool.ts`（核心檔案 — 先問我）
- 寫入 `reference/`（唯讀的 Hermes 原始碼）

## 當前開發狀態

### 已完成

- **M1** — 透過 llama.cpp 支援本地模型（2026-04-15 完成）：fetch adapter 模式、串流 + tool call 翻譯、39 個工具全部通過
- **M2** — Session Recall & Dynamic Memory（2026-04-16 完成）：FTS5 跨 session 搜尋、query-driven prefetch、MemoryTool 寫入（含 injection 掃描）
- **M3** — 移植 anthropics/skills 為 Bundled Skills（2026-04-16 完成）：17 個 skill 內化為 TypeScript bundled skills

### 進行中

（無 — 參見 TODO.md 底部的 M4–M7 草稿）

### 已做出的架構決策

- ~~ADR-001：使用 LiteLLM 作為本地模型的 proxy（不是直接整合 Ollama）~~ **已推翻（2026-04-15）** — 改為直接跑 llama.cpp server（OpenAI 相容，`http://127.0.0.1:8080/v1`）。理由：部署已完成（見 `scripts/llama/`）、少一層中介、減少相依性。
- ~~ADR-002：新的 provider 程式碼放在 `src/services/providers/`，不修改 `src/services/api/`~~ **已被 ADR-005 取代** — M1 實際採用 fetch adapter 模式，程式碼放在 `src/services/api/llamacpp-fetch-adapter.ts`
- ADR-003：新功能不使用 feature flag — 所有功能直接啟用
- ADR-004：Hermes 原始碼作為唯讀參考，用 TypeScript 重新實作
- ADR-005（2026-04-15）：provider 內部做格式轉譯（OpenAI SSE → Anthropic `stream_event`），保持 `QueryEngine.ts` 與 `StreamingToolExecutor.ts` 零修改。理由：這兩個檔案在 `.claude/settings.json` 的 deny list；在 provider 邊界做轉譯讓下游主幹無感。
- ADR-006（2026-04-15）：Qwen3.5-Neo 的 `reasoning_content` 映射為 Anthropic `thinking` content block。理由：模型把 CoT 放 `reasoning_content`、答案放 `content`，對應到 Anthropic 的 thinking block 在語意上最貼近，也保留 UI 顯示 CoT 的能力。
- ADR-007（2026-04-16）：`@anthropic-ai` 全部 7 個 npm 套件內化為專案原始碼（`src/vendor/my-agent-ai/`）。4 個有 TS 原始碼的（sdk / bedrock / vertex / foundry）直接 vendor `.ts` 檔；2 個只有編譯後 JS 的（mcpb / sandbox-runtime）vendor 可讀 JS + `.d.ts`；1 個（claude-agent-sdk）專案零 import 直接刪除。透過 `tsconfig.json` paths 映射，所有 `@anthropic-ai/sdk` import 自動指向 vendor 目錄，既有 121 個 import 不需修改路徑。理由：完全掌控 SDK 程式碼，可自由修改以支援多 provider；不再受上游版本更新影響。
- ADR-010（2026-04-19）：M-LLAMA-CFG — 本地 LLM server 設定統一到 `~/.my-agent/llamacpp.json`（單一來源）。新增 `src/llamacppConfig/` 模組（schema / paths / loader / seed / index），Zod schema 驗證；TS 端 `providers.ts` / `context.ts` 讀 snapshot 取 `baseUrl` / `model` / `modelAliases` / `contextSize`（env var override 仍優先）；Shell 端新增 `scripts/llama/load-config.sh`（jq 從 JSON 抽 env），`serve.sh` `source` 它。首次啟動 `setup.ts` seed 出預設 config + `llamacpp.README.md`；缺 jq / 缺檔 / JSON 壞 graceful fallback 到 `DEFAULT_LLAMACPP_CONFIG`。理由：原本 15 處散落（3 個 const、5 個 env var、serve.sh hard-code、LLAMACPP_MODEL_ALIASES 等）難維護，改 port / ctx / 模型路徑要動多個地方；統一後 TS + shell 共用一份 source of truth，編輯生效規則清楚（TS 開新 session；shell 每次 exec 重讀）。
- ADR-009（2026-04-19）：M-LLAMACPP-CTX — llamacpp 上下文長度偵測改善。(1) `/slots` 查詢失敗時 `console.error` 一次性警告，提示 `LLAMACPP_CTX_SIZE=<tokens>` 手動覆蓋；(2) adapter error path 新增 context-overflow 關鍵字偵測（regex 對 `context|n_ctx|prompt|token` + `length|exceed|too long/large/many|out of`），命中則改寫為 `Prompt is too long (llama.cpp): ...` 讓 `isPromptTooLongMessage()` 識別、觸發 reactive compaction；(3) streaming 收到 `finish_reason=length` + `output_tokens=0` 時記 warn 供診斷（典型上下文已滿徵兆）。理由：使用者 128K 本地模型上下文溢出時會卡在「停止回應 + server 待機」，auto-compact 因 `/slots` 未查詢到而用 200K 預設、reactive compact 又因 error message regex 不符合而不觸發；三路修復讓 llamacpp 與 Anthropic path 的錯誤復原行為一致。
- ADR-008（2026-04-19）：M-SP — system prompt 29 個 section 外部化至 `~/.my-agent/system-prompt/` 下的 .md 檔。新增 `src/systemPromptFiles/` 模組（paths / sections / bundledDefaults / loader / snapshot / seed / index）。採 session 啟動凍結快照（沿用 M-UM pattern）、per-project > global > bundled 三層解析、完全取代（不合併）、首次啟動自動 seed global 層 + README.md。覆蓋範圍：prompts.ts 全部 15 個 section（靜態 + 動態） + cyber-risk + user-profile 外框 + memory 系統 8 個常數 + QueryEngine 4 條錯誤訊息。使用者指南見 `docs/customizing-system-prompt.md`。理由：讓措辭調整不必改 code → rebuild；per-project 可做專案專屬 prompt 客製化。
- ADR-011（2026-04-19）：Browser 能力走 puppeteer-core，不走 playwright-core。M5 首次用 playwright-core 時發現在 bun + Windows 下預設 `--remote-debugging-pipe` transport 無限 hang，即使改 `ignoreDefaultArgs` + `remote-debugging-port` + `connectOverCDP` 也 hang（raw `ws` 套件連 chromium 可以，但 playwright 自家 client 不行）。puppeteer-core 預設 WebSocket CDP 在同環境下秒連，沿用 `bunx playwright install chromium` 裝的 browser binary 不需第二次下載。本地 / Browserbase / Browser Use 三個 provider 共用 puppeteer-core。Vision 走 vendored `my-agent-ai/sdk`（Anthropic SDK），interface 設計保留換後端空間（未來可加 Gemini / 本地 VLM）。Firecrawl 不當作 browser provider（它是 scraping API 不是 CDP target），改為 `WebCrawlTool` 的 optional fetcher backend，透過 `WEBCRAWL_BACKEND=firecrawl` + `FIRECRAWL_API_KEY` 啟用。Provider 選擇不走 feature flag（ADR-003），以 runtime env 決定：`BROWSER_PROVIDER` 顯式 > API key 偵測 > fallback local。
- ADR-012（2026-04-20）：M-DAEMON — Daemon 模式架構（Path A in-process QueryEngine 整合）。`my-agent daemon start` 起常駐 Bun.serve WS server（loopback only `127.0.0.1`、OS 指派 port、bearer token auth、pid.json heartbeat）；QueryEngineRunner 包 `ask()` 成 SessionRunner，跑真實 LLM turn；InputQueue 狀態機（IDLE/RUNNING/INTERRUPTING）+ 混合 intent 策略（interactive 打斷 / background FIFO / slash 優先）；sessionBroker 廣播 turnStart/turnEnd/runnerEvent 給所有 attached client 同步；permissionRouter 把 canUseTool 路由到 source client（含 toolName/input/riskLevel/description/affectedPaths），broadcast permissionPending 給旁觀 client（Q2=b），timeout 5min auto-allow（Q3=c），fallbackHandler interface 預留給 M-DISCORD；cron scheduler 搬進 daemon 獨占跑（`isDaemonAliveSync()` 讓 REPL/headless 跳過避免雙跑）；REPL 側 thin-client（detectDaemon 2s poll + thinClientSocket WS + fallbackManager 狀態機 standalone↔attached↔reconnecting），daemon 起/掛時透明切換，狀態列 badge 顯示目前模式。Session JSONL 沿用既有 `recordTranscript()`→`Project` singleton 不重做；`.daemon.lock` 檔防同 cwd 重啟兩份 daemon。**Path A 完整 in-process** 不是 Path B 的 spawn `./cli --print` 子程序 — 理由：狀態共享、單一 process 方便 debug、未來 Discord/cron 可同 AppState 搬動任務；代價：daemon bootstrap 要複製 main.tsx 的 headless 分支（`bootstrapDaemonContext`，不 refactor print.ts）。使用者指南見 `docs/daemon-mode.md`。Discord 整合（M-DISCORD）是 daemon 的第一個 non-REPL consumer。
- ADR-013（2026-04-20）：M-DISCORD — 單 daemon 多 project Discord gateway。一個 daemon process 內活 N 個 `ProjectRuntime`（各自 AppState / broker / QueryEngineRunner / permissionRouter / cron scheduler / session JSONL），透過 `ProjectRegistry` 管理 lifecycle（lazy loadProject / hasAttachedRepl-aware idle unload / onLoad/onUnload listeners）。並行策略 **B-1**：daemon 全域 turn mutex + `wrapRunnerWithProjectCwd` 切 `process.cwd()` 與 `STATE.originalCwd` 序列化跨 project turn（個人使用場景極少並行，接受「後到者排隊」UX）；`src/utils/sessionStorage.ts` 的 Project singleton 改 `Map<cwd, Project>`。REPL thin-client WS handshake 帶 `?cwd=`；daemon 側 `getProjectByCwd` 命中 → attachRepl + 綁 projectId；沒命中 → 回 `attachRejected` frame，REPL fallback standalone（不自動重試，避免 loop）。Discord gateway 以 `DiscordConfig`（`~/.my-agent/discord.json`）為入口：訊息路由 = 白名單 + DM `#<id|alias>` 前綴 + `channelBindings[channelId]` → `projectPath` → `registry.loadProject`；discord.js v14 **DM 坑**（MESSAGE_CREATE payload 缺 `channel.type`，Partials.Channel 建不出 DMChannel）workaround 兩層：啟動 pre-fetch whitelist users DM + 'raw' event fallback。8 個 slash commands（/status /list /help /mode /clear /interrupt /allow /deny）；permission mode 雙向同步新增 `permissionModeChanged` WS frame（daemon → attached REPL）。Home channel（`homeChannelId`）鏡像 non-Discord source 的 turn 輸出 + daemon up/down 通知，Discord source 的 turn 不鏡（streamOutput 已 reply 原 DM）。**不含**：voice / Slack-Telegram / button UX / 多使用者 guild。使用者指南見 `docs/discord-mode.md`。

---

## 若從官方 Claude Code 遷移設定

my-agent 使用獨立的 `~/.my-agent/` 設定目錄，與官方 Claude Code 的 `~/.claude/` 完全隔離。

### 推薦作法（選擇性複製）

```bash
# Session 歷史
cp -r ~/.claude/projects ~/.my-agent/

# Memory（如有）
cp -r ~/.claude/projects/<slug>/memory ~/.my-agent/projects/<slug>/

# 自訂 skills / commands / agents
cp -r ~/.claude/skills ~/.my-agent/       # 按需
cp -r ~/.claude/commands ~/.my-agent/     # 按需
cp -r ~/.claude/agents ~/.my-agent/       # 按需
```

### 直接指向舊目錄（不推薦）

```bash
export CLAUDE_CONFIG_DIR=~/.claude
```

### 注意事項

- **OAuth tokens 無法使用** — my-agent 用本地 llama.cpp 或第三方 API key（`ANTHROPIC_API_KEY` / `CLAUDE_CODE_USE_BEDROCK` 等）
- **Chrome / Voice 設定無效** — 這兩個功能在 M15 已移除
- **Session JSONL 可讀** — 但 SQLite FTS 索引會在首次 reconcile 時重建
- **Settings schema 可能 drift** — 不建議直接沿用整個 `config.json`；只複製需要的部分比較安全

---

## 開發日誌

> Claude Code：在這行下方附加你的 session 摘要。
> 格式：`### YYYY-MM-DD — Session 標題`
> 包含：你做了什麼、修改了哪些檔案、還剩什麼、遇到的問題。

---

### 2026-04-23 — M-CRON-W3：Cron 6 大功能擴充（Wave 3）

**範圍**：本地 cron 從「會 fire 的 timer」升級成「可觀測 / 可確認 / 可恢復」的排程子系統。補齊 6 項：自然語言排程、結果通知（TUI toast + StatusLine badge + Discord 基礎建設）、run history、失敗重試 + exponential backoff、conditional 觸發、catch-up 策略。規劃見 `docs/cron-wave3-plan.md`、使用指南 `docs/cron-wave3.md`。

**commit 序列**（10 個獨立可交付）：
1. `39fdad7` W3-1 — CronTask schema 擴 6 optional 欄位 + FailureMode / CronCondition / CronNotifyConfig types
2. `8ea9edd` W3-2 — history JSONL + CronHistoryTool + markCronFiredBatch hook
3. `fc38b01` W3-3 — condition gate（shell / lastRunOk / lastRunFailed / fileChanged）
4. `7c9da27` W3-4 — per-task `catchupMax`（enumerateMissedFires + selectCatchUpFires + daemon startup spread）
5. `9d39186` W3-5 — retry/backoff（cronFailureClassifier 5 mode + handleFire 訂 turnEnd + setTimeout exponential）
6. `16646bd` W3-6 — cronWiring emits CronFireEvent + projectRuntimeFactory broadcast WS
7. `83e985b` W3-7 — TUI toast（重用 notifications）+ StatusLine CronStatusBadge（5min TTL）
8. `3f91e49` W3-8a — cronCreateWizardRouter（first-wins / 5min timeout / no-clients reject）
9. `5150164` W3-8b — CronCreateWizard summary card + CronCreateTool 走 router.requestWizard
10. `f0864cb` W3-9 — 純 LLM NL parser（queryHaiku + JSON + parseCronExpression 驗證 + retry 1）

**關鍵決策**（與使用者對齊）：
- Q1 純 LLM NL 解析（不裝 chrono-node），失敗明確報錯不靜默 fallback
- Q2 ephemeral toast + StatusLine 持久 badge
- Q3 失敗條件不寫死，走統一 wizard 蒐集
- Q3+ LLM 呼叫 CronCreate 一律彈 wizard 預填
- Q4 per-task `catchupMax`（預設 1 與 Wave 2 相容）

**新模組**：`src/utils/cronNlParser.ts` / `cronHistory.ts` / `cronCondition.ts` / `cronFailureClassifier.ts`、`src/daemon/cronCreateWizardRouter.ts`、`src/components/CronCreateWizard.tsx` / `CronStatusBadge.tsx`、`src/tools/ScheduleCronTool/CronHistoryTool.ts`

**改造既有**：cronTasks.ts schema + markCronFiredBatch hook + catch-up helpers；cronWiring.ts condition gate + retry loop + event emit + catch-up 前置；projectRuntimeFactory wizard router register + broadcast；daemonCli wizard frame route；CronCreateTool 走 wizard router + NL fallback；useDaemonMode 3 callbacks；AppState lastCronFire；StatusLine 掛 badge；REPL.tsx 接 wizard + toast；fallbackManager sendCronCreateWizardResult。

**踩坑 / 教訓**：
1. scheduler batched write race（commit 6105c6c 修過）— Wave 3 history append 必須 pigback 在 markCronFiredBatch 之後，不能另開 write path
2. condition gate 原 plan 想「skip 不 advance lastFiredAt」會 1s tick-loop 狂 eval；改為「skip 也 advance 但 suppress submit」
3. retry 跨 daemon restart 無法保留（setTimeout + in-memory Map 都沒了）— 文檔明說 attemptCount > 0 視同放棄
4. wizard「沒 attached REPL」必須立即 reject 不 hang（否則 LLM 卡 5min timeout）
5. cron-wiring.test.ts 的 fake broker 要補 `queue.on/off` stub（retry path subscribe runnerEvent/turnEnd）
6. bun + Windows mkdir EEXIST — history dir 沿用 writeCronTasks 的 EEXIST swallow

**測試**：Wave 3 新增 88 tests；cron + daemon cron 130/130 綠；typecheck baseline 不變；每個 commit `./cli -p` smoke 通過。

**未做（後續）**：Discord cronMirror（gateway subscribe + pickAllMirrorTargets + redact）；wizard inline edit；slash `/cron-history`；CronListTool render scheduleSpec.raw；完整 E2E 實機驗證（需 daemon + REPL + llama.cpp + Discord 全起）。

---

### 2026-04-20 — M-DISCORD-AUTOBIND：Per-project channel + REPL 雙向同步

**範圍**：把 M-DISCORD 的靜態 `channelBindings` 升級成 REPL 內 `/discord-bind` 一鍵建頻道；加入 Discord ↔ REPL 雙向 turn 可見 + 權限雙發。9 個 commit，每個自成邏輯單元。

**commit 序列**：
1. `0f3241d` step 1 — schema (+ guildId / archiveCategoryId) + channelNaming (pinyin-pro + fallback) + unit tests
2. `1eff19c` step 2 — channelFactory + daemon RPC (discord.bind / discord.unbind frames) + addChannelBinding / removeChannelBinding (in-place cache mutation)
3. `6ec3e52` step 3 — REPL `/discord-bind` / `/discord-unbind` + FallbackManager.discordBind / discordUnbind
4. `561a481` step 4 — bindingHealthCheck (guild / channel / cwd 三層 stale)
5. `602b9e8` step 5 — replMirror β (per-project binding 命中走專屬頻道 `[from REPL]`，沒綁走 home)
6. `f374c77` step 6 — discordTurnEvent WS frame (Discord → REPL 反向鏡像 `[via Discord DM from @user]` / `[via #channel]`)
7. `b2b3e13` step 7 — permission 雙發 (permissionRouter broadcast + fallback race；permissionResolved frame 清 peer)
8. `a400f1a` step 8 — bot presence `Managing N projects` + Discord turn daemon log metadata
9. (本 commit) step 9 — docs + dev log

**新模組**：
- `src/discord/channelNaming.ts` — sanitize / hash / compute
- `src/discord/channelFactory.ts` — discord.js 薄封裝
- `src/discord/bindingHealthCheck.ts` — verifyBindings
- `src/discord/replMirror.ts` — β target picker + header formatter
- `src/daemon/discordBindRpc.ts` — daemon WS frame handler
- `src/commands/discordBind.ts` / `discordUnbind.ts` — REPL slash commands

**改動既有**：
- `src/discordConfig/schema.ts` — 加 `guildId` / `archiveCategoryId` (optional)
- `src/discordConfig/loader.ts` — atomic binding write-back + in-place cache mutate（gateway 共用 reference 立即可見）
- `src/discord/gateway.ts` — verifyBindings 啟動 + β 鏡像 + broadcastDiscordTurn + per-turn fallback + presence
- `src/daemon/permissionRouter.ts` — 加 projectId；discord-sourced 分支走 broadcast + fallback race；emit permissionResolved
- `src/daemon/daemonCli.ts` — 串 bind RPC + broadcastDiscordTurn callback
- `src/repl/thinClient/fallbackManager.ts` — discordBind / discordUnbind methods
- `src/hooks/useDaemonMode.ts` — permissionResolved 清 pendingPermissions
- `src/screens/REPL.tsx` — onFrame render discordTurnEvent

**新依賴**：`pinyin-pro` 3.28.1

**關鍵決策**（與使用者對齊）：
- 觸發時機：REPL 內 `/discord-bind`（不自動偵測目錄建立）
- 反向 render：turn-level（不做 streaming token 同步）
- 鏡像策略 β：per-project / home 互斥
- Stale 處理：archive category + 清 binding
- 命名：`<dirname>-<hash6>`；中文 pinyin；非 CJK 非 ASCII → `proj-<hash>`
- 頻道 topic = cwd；/discord-unbind = `unbound-<name>` 保留歷史
- 權限雙發 first-wins；DM-sourced turn 不鏡 per-project channel（私訊保密）
- Session metadata：走 daemon log（非 JSONL，避開 Message schema 改造）

**踩坑 / 教訓**：
1. `git add -A` 無差別撈 untracked（包含百 MB binary 備份）→ 必須顯式列檔案；誤 commit 用 `git reset --soft HEAD~1` 回退
2. `getDiscordConfigSnapshot` 是 frozen snapshot；binding 更新必須 in-place mutate，否則 running gateway closure 看不到
3. discord.js v14 ChannelType 是 enum (`GuildText = 0`)，判定路徑用 `ch.type === ChannelType.GuildText`
4. pinyin-pro 對混合中英文逐字拆（`v2` → `v 2`）；測試預期要寬鬆

**測試**：42 新 test（naming 20 + schema 2 + bind-rpc 8 + health 3 + mirror 9）；discord 總 122、daemon 198，typecheck baseline 不變。

**未做**：實機 E2E 需要真的 daemon + bot；docs/discord-mode.md 新 section 記錄完整流程。

**不含**：自動目錄偵測、頻道節流、離線 queue、多 guild、private channel、secret scanning on mirror。

---

### 2026-04-20 — M-DISCORD：Discord gateway（單 daemon 多 project）

**範圍**：把 M-DAEMON 的 in-process daemon 擴成能同時活 N 個 ProjectRuntime，接上 Discord bot — DM / guild channel 文字對話、slash commands、permission mode 雙向同步、home channel 鏡像 REPL/cron turn。

**commit 序列**：
- `6c04352` M-DISCORD-1.0/1.1：daemon turn mutex + ProjectRegistry 骨架
- `58eba69` 1.2：Project singleton → `Map<cwd, Project>` multi-map
- `1d43688` 1.4：daemonCli 改 ProjectRegistry wiring + runner 包 mutex + chdir
- `ca38f37` 2：REPL thin-client WS handshake 帶 cwd + attachRejected fallback
- `c301227` 3a：Discord config module + router + truncate（Hermes `truncate_message` port）
- (—) 3b：reactions + streamOutput + attachments（圖片進出）+ messageAdapter
- `c0ffbd4` 3c：discord.js Client 封裝 + Gateway orchestrator + daemon 整合
- `fa7b104` 支援 `botToken` 寫在 `discord.json`（env var 優先）
- `d3d8b3c` 4：8 個 slash commands + permission mode 雙向同步（新 `permissionModeChanged` WS frame）
- `7a6a837` fix：Partials 字串 → enum（v14 API 改變）
- `f7ea331` fix：DM pre-fetch whitelist + 'raw' event workaround（discord.js v14 DM bug — MESSAGE_CREATE payload 缺 channel.type 導致 DMChannel 建不出）
- `c713e99` 5：home channel REPL/cron turn mirror + daemon up/down 通知 + ProjectRegistry onLoad/onUnload listener
- `be4dbb3` fix：TDZ — ensureHomeMirror referenced before const declaration

**新模組**：
- `src/daemon/daemonTurnMutex.ts` — FIFO mutex + `wrapRunnerWithProjectCwd`（SessionRunner 包一層 chdir + STATE.originalCwd 切換）
- `src/daemon/projectRegistry.ts` — Map<projectId, ProjectRuntime> + lazy load + idle sweeper（hasAttachedRepl 跳過）+ onLoad/onUnload listener API
- `src/daemon/projectRuntimeFactory.ts` — createDefaultProjectRuntimeFactory 把 bootstrapDaemonContext + beginDaemonSession + sessionBroker + permissionRouter + cronWiring 串成 ProjectRuntime
- `src/discordConfig/` — 5 檔（schema/paths/loader/seed/index）沿用 llamacppConfig pattern
- `src/discord/` — 10 檔（types/router/truncate/reactions/streamOutput/attachments/messageAdapter/slashCommands/client/gateway）
- `scripts/poc/discord-connect-smoke.ts` + `discord-dm-debug.ts` — 實機連線 + DM 診斷

**改造既有模組**：
- `src/utils/sessionStorage.ts` — Project singleton → `Map<cwd, Project>`；cleanup handler 改 flush all
- `src/daemon/permissionRouter.ts` — 加 `onPending` / `onResolved` / `listPendingIds` API 供 Discord `/allow` `/deny` 追蹤
- `src/daemon/daemonCli.ts` — registry wiring 取代單 broker；Discord gateway 啟停串進 daemon lifecycle；`broadcastPermissionMode` callback 做 Discord → REPL 單向廣播
- `src/server/clientRegistry.ts` / `directConnectServer.ts` — ClientInfo 加 `cwd` / `projectId` 欄位
- `src/repl/thinClient/` 三檔 + `src/hooks/useDaemonMode.ts` + `src/screens/REPL.tsx` — cwd handshake、attachRejected fallback、`onPermissionModeChanged` handler apply 到本機 toolPermissionContext

**關鍵決策 Q&A**（與使用者對齊）：
- Q1 訊息路由 = DM `#<id>` 前綴 + Server channel binding 混合
- Q2 REPL attach = 只能 attach 已 load 的 runtime（沒 load 回 attachRejected）
- Q3 ProjectRuntime 生命週期 = 30min idle unload（hasAttachedRepl 時不計 idle）
- Q4 Cron = per-ProjectRuntime scheduler
- Q5 Permission ask 路由 = REPL-first（在場） / fallback Discord
- Q6 Library = discord.js v14
- Q8 Permission mode = Discord/REPL 雙向同步（permissionModeChanged frame）
- Q9 並行隔離 = B-1（daemon turn mutex + chdir，接受後到者排隊）
- Home channel 鏡像模式：REPL/cron 發起 turn 鏡到 home channel；Discord 發起 turn 不鏡（避免跟 reply 雙貼）

**踩坑 / 重要教訓**（已入 LESSONS.md 或 ADR-013）：
1. discord.js v14 **Partials** 從字串改 enum（`Partials.Channel` 而非 `'CHANNEL'`）— 字串 runtime 不被識別
2. discord.js v14 **DM MESSAGE_CREATE 缺 channel.type** → DMChannel 建不出 → event 不 emit；workaround = 啟動 pre-fetch whitelist users DM channel + 'raw' packet handler 作為 fallback
3. **MESSAGE CONTENT INTENT** 要在 Developer Portal 手動開啟（Privileged Gateway Intent），否則 bot 收不到訊息 content
4. **`const` TDZ**：JS const 沒 hoisting，閉包內引用必須在 declaration 之後；大型 gateway 檔案要注意順序
5. **daemon hot reload 不存在**：改 code 後 daemon 必須 stop+start 才吃新邏輯（bun run dev 也一樣）
6. **bun test OOM**：小 maxLength + counter reservation 造成 truncate 無限迴圈→ 加下限 guard；無限迴圈的 bun test process 不會自己退，要 taskkill
7. **slash commands 傳播**：guild-scope 註冊 instant；global（DM）最多 1 小時

**測試**：daemon 180 + discord 75（含 router / truncate / reactions / streamOutput / attachments / messageAdapter / slash-commands / permission-router-hooks / project-registry / project-registry-listeners / config-token / cwd-handshake）= 共 268 integration tests 全綠；typecheck baseline 不變。

**E2E 實機**（使用者驗證）：bot `MY-AGENT#3666` 連上私人 guild，DM `hi` → 👀 → ✅ + 回覆；`/mode acceptEdits` → REPL 同步顯示；home channel 收到 `🟢 daemon up` + REPL turn 鏡像。

**不含（延後）**：voice channel、button/embed interactive permission UX、Slack/Telegram、多使用者 guild。

---

### 2026-04-19 — M4–M7：Browser 能力整合（Hermes → my-agent TS port）

**範圍**：保留既有 WebFetch / WebSearch，加入 WebCrawl 與 WebBrowser 兩個工具，補齊 Hermes Agent 的 web 研究與互動式瀏覽能力。全為附加式，無既有檔案被重寫。

**M4（commit `c29f74c`）**：`WebCrawlTool` + 共用安全層

- 新增 `src/tools/WebCrawlTool/{WebCrawlTool,crawler,prompt}.ts`（BFS + robots.txt + cheerio 抽連結 + per-host rate limit + SSRF 重用 `ssrfGuard`）
- 新增 `src/utils/web/secretScan.ts`（重寫 Hermes `agent/redact.py`，30+ token 前綴 + bearer/env/JSON/私鑰/DB 連線字串）
- 新增 `src/utils/web/blocklist.ts`（重寫 Hermes `website_policy.py`，`~/.my-agent/website-blocklist.yaml`，30s cache，fnmatch 萬用字元，fail-open）
- 新增 cheerio 依賴；21 單元測試全綠；對 `https://github.com/lorenhsu1128` smoke 通過

**M5（commit `32fae13`）**：`WebBrowserTool` 本地 backend

- 新增 `src/tools/WebBrowserTool/{WebBrowserTool,session,a11y,actions,prompt}.ts`
- `providers/{BrowserProvider,LocalProvider}.ts` — 抽象介面 + puppeteer-core 實作
- 核心 10 actions：navigate / snapshot / click / type / scroll / back / press / console / evaluate / close
- 持久 session + 5 分鐘 idle TTL + process.exit cleanup；navigation 時 bump generation 讓舊 ref 失效
- a11y 走 `page.accessibility.snapshot`，輸出 `[ref=eN]` 文字樹；refToElement 用 puppeteer `-p-aria` selector + nth 回 ElementHandle
- 所有 action 過 SSRF / blocklist / secret redaction 安全層
- Agent 迴圈實測（qwen3.5-9b 本地）對 GitHub profile：70 refs、navigate→snapshot→close 通過

**M5 踩坑（→ ADR-011）**：bun + Windows 下 playwright-core 的 `--remote-debugging-pipe` transport hang；`connectOverCDP` 對自己 spawn 的 chromium 也 hang。改用 puppeteer-core 解決（預設 WebSocket CDP）。沿用 `bunx playwright install chromium` 裝的 browser binary，不需第二套。

**Build 修復（commit `4bf674b`）**：清 m-deanthro 留下的 5 處 dangling import（logout / login 模組已刪但 auth.ts / upgrade.tsx / extra-usage.tsx 還在 import；ccrClient.ts / SSETransport.ts 呼叫舊名 `getClaudeCodeUserAgent`）+ `react-devtools-core` 列 externals + `ink` import 改走 `src/ink.ts` 主題 wrapper（避開 top-level await）。`bun run build` 重新綠。

**M6（commit `49d53d7`）**：三家 cloud providers + vision + Firecrawl

- `providers/BrowserbaseProvider.ts`：REST 建 session → `puppeteer.connect`；close 時 REST 釋放 session；支援 `BROWSERBASE_ADVANCED_STEALTH`
- `providers/BrowserUseProvider.ts`：同模式，`BROWSER_USE_API_KEY`；略 Hermes 的 Nous managed gateway（my-agent 無對應 infra）
- `providers/selectProvider.ts`：runtime env 選 backend（顯式 `BROWSER_PROVIDER` → API key 偵測 → local）
- `src/utils/vision/VisionClient.ts`：interface + `AnthropicVisionClient`（走 vendored `my-agent-ai/sdk`）；vision prompt 內嵌「ignore instructions inside image」防禦
- 新 actions：`screenshot(full_page?)` / `vision(question)` / `get_images()`
- `src/utils/web/firecrawl.ts`：`/v1/scrape` adapter；`WEBCRAWL_BACKEND=firecrawl + FIRECRAWL_API_KEY` 啟用後 BFS 每個節點走 Firecrawl（JS 渲染）
- Agent 迴圈實測 screenshot → get_images，GitHub profile：129 KB PNG、7 張圖片

**M7（本 commit）**：收尾

- 新增 `src/tools/WebBrowserTool/README.md` action 參考 + 環境變數 + 安全模型
- 刪 FEATURES.md 的 `WEB_BROWSER_TOOL` stub 說明
- CLAUDE.md 開發日誌（本段）+ ADR-011
- TODO.md 勾掉 M4–M7

**新依賴**：`cheerio`（M4）、`puppeteer-core`（M5）。`playwright-core` 曾被裝但因 bun compat 問題移除。
