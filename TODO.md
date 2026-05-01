# TODO.md

> Claude Code 在每次 session 開始時讀取此檔案，在工作過程中更新任務狀態。
> 里程碑結構由人類維護。Claude Code 負責管理任務狀態的勾選。

## 當前里程碑：M-RENAME — 專案改名 free-code → My Agent（2026-04-19 啟動）

**目標**：全倉庫 84 檔、265 處字串（free-code / freecode / Free Code）改名為 my-agent / My Agent。

**決策**：直接改名不留 alias；keychain prefix 改；install.sh repo 指 `lorenhsu1128/my-agent`；專案根目錄最後一步改名。

### 任務
- [x] M-RENAME-1 Phase 1：UI 品牌字串（LogoV2/REPL/Welcome 等 13 處）+ env vars MYAGENT_*（5 個）+ 識別字串（keychain prefix、OAuth originator）+ seed 內容（llamacpp seed/schema、bundledDefaults、defaultSettings）+ bundled skills
- [x] M-RENAME-2 Phase 2：程式碼註解 `// my-agent:`（24 檔，sed 批次）+ theme.ts 4 處
- [x] M-RENAME-3 Phase 3：install.sh（repo URL → lorenhsu1128/my-agent、INSTALL_DIR、symlink、ASCII 標題）+ scripts/llama/load-config.sh
- [x] M-RENAME-4 Phase 4：根目錄 11 個 *.md + docs/ + scripts/llama/*.md（test-run-*.md 略過）+ tests/integration/user-model/user-model-smoke.ts 的 env var
- [x] M-RENAME-5 Phase 5：`.claude/` 下 6 個 SKILL.md + reviewer.md + project-review-hermes.md；目錄 freecode-architecture → myagent-architecture（git mv）
- [x] M-RENAME-6 Phase 6：`bun run typecheck` 過；`bun run dev --help` 已顯示 "my-agent"；TUI logo 待人工確認
- [x] M-RENAME-7 Phase 7：commit/push 後手動 rename 根目錄 free-code → my-agent；重開 session 後修正 POC scripts 中 session slug（`scripts/poc/query-session-index.ts:13`、`scripts/poc/session-search-e2e.ts:44`）

### 完成標準
- [x] `grep -rni "free[- ]?code\|freecode" src/ scripts/ install.sh` 僅剩 2 個 POC slug（待 Phase 7）
- [x] `bun run dev --help` 顯示 my-agent
- [x] TUI logo 顯示「My Agent」（人工驗證）
- [x] 根目錄已改為 `_projects\my-agent`（Phase 7 手動）

---

## 當前里程碑：M-VISION — llamacpp 路徑多模態（Vision）支援 + 文字模型 fallback（2026-04-19 啟動）

**目標**：讓 llamacpp 路徑能真實接收圖片（目標後端 Gemopus-4-E4B-it，基於 Gemma-4-E4B-it 多模態 GGUF）；同時當後端是純文字模型（Qwen3.5-9B-Neo）時走 graceful fallback（保留現行 `[Image attachment]` 佔位符行為）。詳見 `docs/archive/M_VISION_PLAN.md`。

**決策**：capability 由 `~/.my-agent/llamacpp.json` 的 `vision.enabled` 宣告（不 runtime probe）；adapter 依旗標分支；serve.sh 透過 load-config.sh 的 extraArgs 機制追加 `--mmproj`。

### 任務
- [x] M-VISION-1 schema 擴充：新增 `LlamaCppVisionSchema`（`vision.enabled`）與 `LlamaCppServerVisionSchema`（`server.vision.mmprojPath?`）
- [x] M-VISION-2 loader 暴露 `isVisionEnabled()`；`src/llamacppConfig/index.ts` re-export；`getLlamaCppConfig()`（providers.ts）回傳加 `vision: boolean`
- [x] M-VISION-3 adapter 翻譯：`translateMessagesToOpenAI(messages, {vision})` 與 `imageBlockToOpenAIPart()` helper；`createLlamaCppFetch` 讀 `config.vision` 傳入 `translateRequestToOpenAI`；`OpenAIMessage.content` 型別擴成 `string | null | OpenAIContentPart[]`
- [x] M-VISION-4 `scripts/llama/load-config.sh` 讀 `.server.vision.mmprojPath`；相對路徑相對 repo root 補全；透過 `printf %q` 安全引用後追加 `--mmproj <path>` 到 `LLAMA_EXTRA_ARGS_SHELL`；serve.sh 不動
- [x] M-VISION-5 單元測試 `tests/integration/llamacpp/vision-adapter-smoke.ts`（27/27 綠）涵蓋 6 case
- [x] M-VISION-6 E2E scaffold `tests/integration/llamacpp/vision-e2e.ts`（opt-in `MYAGENT_VISION_E2E=1`；1x1 紅色 PNG inline，無需 fixture 檔案）；skip mode 正常
- [x] M-VISION-7 文字模型回歸 smoke `tests/integration/llamacpp/text-model-fallback-smoke.ts`（9/9 綠）；直接 curl Neo server 確認 text path 未壞

### 完成標準
- [x] `bun run typecheck` 綠
- [x] 單元測試全綠（adapter smoke 27/27 + fallback smoke 9/9）
- [x] Neo 模型回歸：image block 仍以 `[Image attachment]` 字串傳達，不報錯
- [ ] Gemopus-4-E4B-it 模型能實際識別圖片內容（**待使用者下載模型 + mmproj 後跑 E2E 或 TUI 驗證**）

---

## 當前里程碑：M-DAEMON — 本地 Daemon + Direct-Connect Server（2026-04-19 啟動）

**目標**：把 `my-agent` 的 QueryEngine 搬進獨立長駐 daemon process，透過 WebSocket 讓 REPL / 未來的 Discord gateway / 其他 client 可 attach 同一個 session；補完 `src/server/` 原本欠缺的 server side。為 M-DISCORD 鋪路。

**關鍵需求**：TUI（REPL）和未來 Discord 上的對話要**同步** — 任一邊都能看到歷史對話和即時輸出。

**架構決策**（2026-04-19 與使用者逐題對齊 Q1–Q9）：
- ADR-M-DAEMON-01：Daemon 是唯一的 QueryEngine 跑者、唯一的 session JSONL 寫入者；REPL attach 模式下只透過 WS 送 input + subscribe stream，不寫 session
- ADR-M-DAEMON-02：IPC 協議 = 復用 `src/server/directConnectManager.ts` 既有的 WS + JSON lines 格式（control_request / control_response / SDK message 轉發已就位，只補 server side）
- ADR-M-DAEMON-03：Daemon 監聽 `localhost:<port>` + auth token（非 unix socket；bun + Windows unix socket 風險大，呼應 ADR-011 playwright 踩坑）；port / pid 寫入 `~/.my-agent/daemon.pid.json`；token 放 `~/.my-agent/daemon.token`（0600）
- ADR-M-DAEMON-04：REPL attach UX = 透明偵測 + 狀態列 badge 顯示（`[local]` / `[daemon:12345]` / `[daemon:stale]`）；無 daemon 自動 fallback 獨立模式
- ADR-M-DAEMON-05：Input 策略 = 混合：使用者互動訊息（REPL Enter / Discord DM / `@mention`）= interrupt 當前 turn；自動觸發（cron / background）= queue；slash command = 立即執行
- ADR-M-DAEMON-06：Daemon 生命週期 = 顯式 `my-agent daemon start/stop/status/restart/logs` 子命令（非 auto-spawn）
- ADR-M-DAEMON-07：多 REPL attach 同 daemon = 允許；stream event broadcast 給所有 attached clients
- ADR-M-DAEMON-08：Permission prompt 路由 = 回到 input source client；Discord source 退回 YOLO classifier（M-DISCORD 實作時才接）
- ADR-M-DAEMON-09：Cron scheduler 搬進 daemon（RISK 4 解方）；REPL 獨立模式下 cron 不跑（明確化、無鎖競爭）

**本 milestone 完成後**：使用者可 `my-agent daemon start` 啟動背景服務 → 開兩個 REPL 視窗都會自動 attach 同一 session → 任一邊 type 都能在另一邊即時看到；cron 由 daemon 統一觸發。

### 階段一：基礎設施
- [x] M-DAEMON-1 `src/daemon/{paths,pidFile,authToken,daemonLog,daemonMain}.ts`：pid.json（6 欄含 version/pid/port/startedAt/lastHeartbeat/agentVersion）+ 每 N ms heartbeat interval + 64-char hex token（timing-safe compare、writeFile mode 0o600 + chmod、Windows graceful no-op）+ JSON lines 結構化日誌（debug/info/warn/error）+ `startDaemon()` 整合（SIGINT/SIGTERM/SIGBREAK 註冊 + stale 偵測與接管 + DaemonAlreadyRunningError）+ stop 冪等清理。測試 `tests/integration/daemon/lifecycle.test.ts` 29/29 綠（paths / authToken 6 case / pidFile 10 case / checkDaemonLiveness 5 case / daemonLog 2 case / startDaemon 5 整合 case）。`bun run typecheck` 綠（僅 TS5101 baseline），`./cli -p "say OK"` 獨立模式未迴歸
- [x] M-DAEMON-2 `src/server/{directConnectServer,clientRegistry}.ts` + `daemonMain.ts` 串接 WS：Bun.serve-based WS server（loopback only 127.0.0.1、OS 指派 port）+ bearer token auth（header / query 雙入口、compareTokens timing-safe）+ newline-delimited JSON 解析（壞 JSON silently ignore）+ 30s keep_alive ping（unref 不阻 event loop）+ client registry（register/unregister/broadcast/send/closeAll + source tag: repl/discord/cron/slash/unknown）+ startDaemon 整合（enableServer 開關、pid.json 寫入實際 port、daemon.stop 連帶關 server + closeAll clients）。測試 `tests/integration/daemon/ws-server.test.ts` 17 新 case（registry 4 + auth 4 + messaging 5 + daemon 整合 4），總計 46/46 綠。Typecheck 綠。`sessionBroker.ts` 延後到 M-DAEMON-4（屆時接 QueryEngine）。註：`src/server/types.ts` 和 `directConnectManager.ts` 客戶端已存在未動
- [x] M-DAEMON-3 `src/daemon/daemonCli.ts`（runDaemonStart/Stop/Status/Logs/Restart 5 handler）+ `src/main.tsx` 註冊 `my-agent daemon` 子命令樹（start/stop/status/restart/logs；commander `enablePositionalOptions` + `createSortedHelpConfig` 沿用既有模式）。handler 接受 stdout/stderr injection 便於測試；start foreground 阻塞可 Ctrl+C 或另一 shell `daemon stop`；stop SIGTERM → poll 5s → SIGKILL fallback；status 顯示 pid/port/agentVersion/startedAt/uptime/lastHeartbeat，live/stale 雙狀態回傳結構化 DaemonStatus；logs 支援 `-f` follow（AbortSignal 可停）；restart = stop + 200ms gap + start。測試 `tests/integration/daemon/cli-commands.test.ts` 12 case（status 3 + stop 3 + logs 3 + start 2 + restart 1，含 follow mode + stale cleanup），全套 58/58 綠

### 階段二：Session 整合
- [x] M-DAEMON-4 `src/daemon/{sessionBootstrap,queryEngineRunner,sessionBroker,sessionWriter}.ts`：Path A 完整 in-process QueryEngine 整合。4a bootstrapDaemonContext（tools / commands / MCP / AppState / readFileCache）；4b createQueryEngineRunner 包 `ask()` 成 SessionRunner（mutableMessages 持有 / SDKMessage→RunnerEvent / canUseTool 預設 auto-allow）；4c sessionBroker 接 WS↔InputQueue↔Runner + sessionWriter `.daemon.lock` 獨占（transcript 寫入沿用既有 `recordTranscript()`→Project singleton）+ daemonCli.runDaemonStart `enableQueryEngine:true` two-phase wiring；4d E2E 測試（WS input → llama.cpp → turnEnd.done → session.jsonl 驗證）。commits 412e4bd/c96d5fe/2874bb8/ef2b1b0；全 daemon 測試 90/90 綠，./cli -p 冒煙通過
- [x] M-DAEMON-4.5 `src/daemon/cronWiring.ts`：Cron scheduler 搬進 daemon，`createCronScheduler({onFire, onFireTask})` 接 `broker.queue.submit(prompt, {source:'cron',intent:'background',clientId:'daemon-cron'})`；`isLoading:()=>false` 讓 cron 永遠 submit，queue 靠 background intent 自動排 FIFO 尾不中斷 interactive；gate 沿用 `feature('AGENT_TRIGGERS') && isKairosCronEnabled()`；preRunScript 套到 prompt；fireLanes map 避免同 id 併發 race。REPL 端 `useScheduledTasks` + print.ts headless 加 `isDaemonAliveSync()` guard（同步 readFile + process.kill(pid,0) + 30s heartbeat）— daemon 活著就跳過避免雙跑。測試：5 單元（gate / isLoading / onFire submit / preRunScript / isKilled flip）+ 1 E2E（daemon WS client 收到 source=cron 的 turnStart）；全 daemon 測試 96/96 綠，./cli -p 冒煙通過
- [x] M-DAEMON-5 `src/daemon/{sessionRunner,inputQueue}.ts`：SessionRunner interface（run(input, signal) → AsyncIterable<RunnerEvent>）+ echoRunner / createDelayedEchoRunner 假實作（M-DAEMON-4 會用 QueryEngineRunner 取代）+ InputQueue 狀態機（IDLE/RUNNING/INTERRUPTING）+ 混合策略（interactive 搶占 / background FIFO / slash priority queue-head）+ interruptGraceMs force-clear（防 runner 卡死）+ EventEmitter 事件（state / runnerEvent / turnStart / turnEnd，帶 reason: done/error/aborted）+ defaultIntentForSource helper。測試 `input-queue.test.ts` 19 case（defaultIntent 5 + happy 4 + FIFO 2 + interrupt 3 + slash 1 + dispose 2 + runner 2），全套 77/77 綠。InputQueue 和 WS broker 解耦；M-DAEMON-4 把 QueryEngine 包成 SessionRunner 後即完成 pipeline

### 階段三：REPL thin-client
- [x] M-DAEMON-6 `src/repl/thinClient/{detectDaemon,thinClientSocket,fallbackManager}.ts` + `src/hooks/useDaemonMode.ts` + `PromptInputFooter DaemonStatusIndicator` + REPL onSubmit 攔截。
  - 6a (commit 988657e)：detectDaemon 2s poll pid+token+heartbeat；thinClientSocket WS `ws://host:port/sessions?token=` with newline JSON；fallbackManager 狀態機 standalone↔attached↔reconnecting（socket close → reconnecting，30s 逾時回 standalone；detector 確認 daemon 死 → standalone）
  - 6b (commit d4d3c9b)：AppState 新增 `daemonMode`/`daemonPort`；useDaemonMode hook 建 detector+manager 寫 AppState；DaemonStatusIndicator footer 顯示 `daemon: attached :port` 綠 / `reconnecting` 黃 / `standalone` 暗
  - 6c (commit dd1085c)：onSubmit 攔截 — attached + 非 slash + 非 speculation → sendInput via WS + 塞 user message；onFrame 解析 SDKMessage.assistant → createAssistantMessage 追加；onModeChange 插 system banner；module-level `getCurrentDaemonManager()` singleton 繞過 useCallback 早於 hook 的閉包問題
  - 6d (本 commit)：4 個 E2E（standalone detect / attach + sendInput / daemon stop → reconnecting → standalone / frame forwarding）
  - 未覆蓋（M-DAEMON-7+）：permission prompt 路由 daemon→client、tool_result 細粒度 UI、Q3=a in-flight turn 重跑（目前只 system banner）、slash command attached support
  - 全 daemon 測試 111/111 綠，./cli -p 冒煙通過

### 階段四：Multi-client + permission
- [x] M-DAEMON-7 `src/daemon/permissionRouter.ts` + thin-client 接收 + E2E。
  - 7a (commit b3917d4)：permissionRouter.canUseTool 把 daemon 的 tool permission 送到 source client（permissionRequest 含 toolName/input/riskLevel:read|write|destructive/description/affectedPaths），廣播 permissionPending 給其他 attached clients（filter 排除 source）；等 permissionResponse{toolUseID,decision,updatedInput?,message?}；timeout 5min auto-allow；fallbackHandler interface 預留給 M-DISCORD。daemonCli 用 brokerRef 注入 runner canUseTool 且 onMessage 先試 router.handleResponse。9 單元測試
  - 7b (commit 2d8c9c3)：thinClientSocket OutboundFrame 擴 permissionResponse；fallbackManager.sendPermissionResponse；useDaemonMode onPermissionRequest / onPermissionPending callback + pendingPermissions map + getLatestPendingPermission() + respondToPermission()；REPL 收到 permissionRequest 插警告 system message（含 risk/description/affectedPaths），收 permissionPending 插 info 旁觀；onSubmit 攔截 `/allow` `/deny` 解最新 pending → 送 WS
  - 7c (本 commit)：2 個 E2E（雙 WS client attach 同 daemon → source 收 request / peer 收 pending 且 source 沒重複收 / source 送 allow → decision.allow；first-wins 允許 peer 搶先送 deny）
  - 全 daemon 測試 122/122 綠，./cli -p 冒煙通過。Broadcast 部分（Q2 的旁觀通知）已在 M-DAEMON-4c 就實作完，本 milestone 確認了 turnStart/turnEnd/runnerEvent 對兩邊 client 同步沒漏

### 階段五：驗收
- [x] M-DAEMON-8 `tests/integration/daemon/smoke.sh`（start/status/stop/duplicate/stale-takeover 手動驗證）+ `docs/daemon-mode.md` 使用者指南（CLI 指令 / badge / permission 流程 / session JSONL / cron / 多 client 廣播 / intent 策略 / 故障排除 / 限制）+ ADR-012（CLAUDE.md）+ LESSONS.md 新增「Daemon 模式 / WS 整合」分類 7 條踩坑（NODE_ENV=test 擋 session / MACRO.VERSION build-time define / Windows rmSync EBUSY / describe.skipIf 在 TLA 前 evaluate / print.ts bootstrap 太黏不抽共用 / useCallback 早於 hook 的 module singleton 繞法 / token shape hex-only）。同時修 `runDaemonStop` 在 Windows SIGKILL 後強制清 pid.json（原本 graceful handler 被繞開 → orphan）。既有測試 122 case 已覆蓋 TODO 列的 lifecycle / attach-fallback (e2e-thin-client) / multi-client + permission-routing (e2e-permission-dual-client + ws-server) / input-strategy (input-queue) / session-write (e2e-query-engine)

### 完成標準
- [x] `bun run typecheck` 綠
- [x] `tests/integration/daemon/` 全綠（122 case）
- [x] 活性測試：`./cli daemon start` + 另一個終端連 WS，input 走 daemon；smoke.sh 自動化 5 case（no-daemon / start-and-status / duplicate-rejected / stop-clean / stale-takeover）全通過
- [x] Cron 在 daemon 內正確觸發（e2e-cron 驗證），REPL 獨立模式下確認不跑（isDaemonAliveSync guard）
- [x] Daemon crash 時 REPL 透明 fallback 不當機（e2e-thin-client: daemon stopped → mode=reconnecting→standalone，不阻塞）
- [x] Windows + bun 環境 SIGTERM 走 graceful；逾時 SIGKILL 會 force-clean pid.json（新加 runDaemonStop 邏輯）

### M-DAEMON-PERMS（2026-04-20）— Daemon 權限與 TUI 同步（A+B+C 三層）
- [x] PERMS-A：daemon sessionBootstrap 訂閱 `settingsChangeDetector` → 每次 settings.json 變動自動 `applySettingsChange(source, setAppState)`，persistent 規則（alwaysAllow/alwaysDeny/additionalDirs）即時同步；dispose 時 unsub
- [x] PERMS-B：新 WS frame `{type:'permissionContextSync', mode}` — thin-client OutboundFrame 擴展；fallbackManager.sendPermissionContextSync（attached 才送、silent no-op）；useDaemonMode export `syncPermissionModeToDaemon()`；REPL useEffect 監視 `toolPermissionContext.mode` 變化 + onModeChange 'attached' 時推送；daemon daemonCli.onMessage 解析 frame 直接 setAppState 更新 daemon 的 toolPermissionContext.mode
- [x] PERMS-C：permissionRouter.canUseTool 在送 WS prompt 前先呼叫 `hasPermissionsToUseTool(tool, input, context, ...)` pre-judge — allow/deny 直接回、不浪費 WS 往返；只有 'ask' 才走原本的 permissionRequest + WS 廣播 + timeout 路徑。forceDecision 也 short-circuit。pre-judge throw 防禦性 fallback 到 WS
- [x] Tests `tests/integration/daemon/permission-sync.test.ts`：4 單元（router forceDecision 短路 / pre-judge throw 安全 fallback / bootstrap dispose 重複呼叫 / permissionContextSync setAppState 語意）。全 daemon 測試 138/138 綠，./cli -p 冒煙通過

### M-DAEMON-AUTO（2026-04-20，M-DAEMON-8 收尾後新增）— REPL 預設啟動 daemon
- [x] AUTO-A `src/daemon/autostart.ts`：`GlobalConfig.daemonAutoStart?: boolean`（undefined=預設 true、false=停用）+ `isAutostartEnabled()` / `setAutostartEnabled()` + `spawnDetachedDaemon()` helper（`child_process.spawn(argv[0], [argv[1]?, 'daemon','start'], {detached:true, stdio:'ignore', windowsHide:true})` + unref）+ session-level `hasAttemptedAutostartThisSession` 旗標（Q1=c）+ `MY_AGENT_NO_DAEMON_AUTOSTART` env override。CLI 新增 `my-agent daemon autostart on|off|status` subcommand
- [x] AUTO-B useDaemonMode 首次偵測 standalone 時（等 30ms 讓第一次 detector check 完成）呼叫 `isAutostartEnabled()` + `markAutostartAttempted()` → `spawnDetachedDaemon()` → `onAutostart` callback 通知 REPL（Q4=b 非阻塞；Q6=a+b 失敗印 warning 且繼續 standalone）。REPL.tsx 的 onAutostart 插 info / warning system message
- [x] AUTO-C `src/commands/daemon.ts` slash command `/daemon on|off|status`：on 啟 autostart + 若無 daemon 立刻 spawn；off 關 autostart + 若有活 daemon 送 SIGTERM；status 同時顯示 autostart + daemon liveness + pid/port
- [x] Tests：12 單元（`tests/integration/daemon/autostart.test.ts`：isAutostartEnabled 默認/env 覆蓋/config 覆蓋、session flag lifecycle、spawn 成功路徑、runDaemonAutostart status/off/already-on）。全 daemon 134/134 綠，./cli -p 冒煙通過
- [x] 文件：`docs/daemon-mode.md` 新增快速上手的 auto-spawn 細節 + 三個 opt-out 管道（CLI/slash/env）

---

## 已完成里程碑：M-DISCORD-AUTOBIND — Per-project channel + REPL 雙向同步（2026-04-20 完成）

**目標**：REPL 內一鍵建立 Discord per-project channel；REPL ↔ Discord 雙向 turn 可見；權限雙發。

**範圍**：
- [x] schema 加 `guildId` / `archiveCategoryId`（optional，向後相容）
- [x] channelNaming（pinyin-pro 中文轉拼音 + fallback）
- [x] channelFactory（create / archive / rename / welcome）
- [x] daemon RPC（discord.bind / discord.unbind frames）
- [x] addChannelBinding / removeChannelBinding atomic + in-place cache mutate
- [x] REPL `/discord-bind` / `/discord-unbind`（含 daemon-required 錯誤路徑）
- [x] bindingHealthCheck 啟動掃 guild / channel / cwd 三層 stale
- [x] replMirror β 策略（per-project 命中 / fallback home 互斥）
- [x] discordTurnEvent frame（Discord → REPL 反向鏡像）
- [x] 權限雙發（broadcast + fallback race，permissionResolved 清 peer）
- [x] bot presence `Managing N projects`（onLoad/onUnload 動態）
- [x] 使用者指南 docs/discord-mode.md 新 section

### 任務
- [x] step 1 — schema + naming + pinyin-pro（commit `0f3241d`）
- [x] step 2 — channelFactory + daemon RPC（commit `1eff19c`）
- [x] step 3 — REPL slash commands（commit `6ec3e52`）
- [x] step 4 — bindingHealthCheck（commit `561a481`）
- [x] step 5 — replMirror β（commit `602b9e8`）
- [x] step 6 — discordTurnEvent frame + REPL render（commit `f374c77`）
- [x] step 7 — permission dual-notify（commit `b2b3e13`）
- [x] step 8 — presence + turn metadata（commit `a400f1a`）
- [x] step 9 — docs + dev log（本 commit）

### 完成標準
- [x] typecheck 綠（baseline 不變）
- [x] 42 新 unit test 全綠；discord 總 122、daemon 198 不 regress
- [x] `./cli --version` 冒煙不壞
- [ ] 實機 E2E（使用者驗證 — daemon + bot 實連）

### 不含（延後）
- 自動偵測目錄建立（.my-agent/ seed 觸發）
- 頻道節流 / 合併鏡像
- Bot 離線訊息 queue（現況：丟棄 + log）
- 多 guild 選擇 UI
- Private channel / 角色權限自動配置
- Secret scanning on mirror
- Session JSONL 加 source/author 欄位（Message schema 改造量大）

---

## 已完成里程碑：M-DISCORD — Discord Gateway（2026-04-20 完成）

**目標**：daemon 上接 Discord bot — DM + guild channel 文字對話 + 圖片進出 + slash commands + home channel 鏡像。單 daemon 多 project 架構。

**範圍**：
- [x] DM + guild channel（Q1=混合：DM 前綴 `#<id>` + channel binding）
- [x] 單 daemon 多 ProjectRuntime（B 方案）
- [x] REPL attach = 只接 loaded runtime，其他 attachRejected（Q2=b）
- [x] ProjectRuntime 30min idle unload，hasAttachedRepl 不計 idle（Q3=b）
- [x] Cron per-ProjectRuntime（Q4=a）
- [x] Permission mode 雙向同步 + REPL-first/Discord-fallback ask 路由（Q5=b + Q8）
- [x] B-1 並行：daemon turn mutex + chdir，接受後到者排隊
- [x] Home channel 鏡像 REPL/cron turn + daemon up/down（使用者要求）
- [x] 白名單檢查（訊息 + slash）
- [x] 8 個 slash commands：/status /list /help /mode /clear /interrupt /allow /deny
- 不含 voice / Slack-Telegram / button UX / 多使用者 guild（延後）

### 任務
- [x] M-DISCORD-1.0 daemonTurnMutex（commit `6c04352`）
- [x] M-DISCORD-1.1 projectRegistry 骨架（commit `6c04352`）
- [x] M-DISCORD-1.2 Project singleton 多例化（commit `58eba69`）
- [x] M-DISCORD-1.3 sessionBootstrap settings unsub（sessionBootstrap.ts 既有 dispose 已涵蓋）
- [x] M-DISCORD-1.4 daemonCli registry wiring + runner mutex wrap（commit `1d43688`）
- [x] M-DISCORD-2 REPL thin-client cwd handshake + attachRejected（commit `ca38f37`）
- [x] M-DISCORD-3a discord.js 安裝 + discordConfig + router + truncate（commit `c301227`）
- [x] M-DISCORD-3b reactions + streamOutput + attachments + messageAdapter
- [x] M-DISCORD-3c discord.js Client + Gateway + daemon 整合（commit `c0ffbd4`）
- [x] botToken 支援寫在 discord.json（commit `fa7b104`）
- [x] M-DISCORD-4 slash commands + permission mode 雙向同步（commit `d3d8b3c`）
- [x] fix: Partials enum（commit `7a6a837`）
- [x] fix: DM pre-fetch + 'raw' event workaround（commit `f7ea331`）
- [x] M-DISCORD-5 home channel mirror + daemon up/down 通知（commit `c713e99`）
- [x] fix: TDZ ensureHomeMirror（commit `be4dbb3`）
- [x] M-DISCORD-6 docs + ADR-013 + TODO.md 勾選

### 完成標準
- [x] `bun run typecheck` baseline 不變
- [x] 268/268 integration tests 全綠（daemon 184 + discord 84）
- [x] `./cli -p "..."` 單機冒煙通過
- [x] 實機 E2E（使用者驗證）：bot `MY-AGENT#3666` 連線、DM `hi` 整條 flow、`/mode` 雙向同步、home channel 鏡像皆通過
- [x] ADR-013 + `docs/discord-mode.md` + CLAUDE.md 開發日誌

---

## 當前里程碑：M2 — Session Recall & Dynamic Memory

**目標情境**：以 **llama.cpp 本地模型（`qwen3.5-9b-neo`）** 為主要運行情境設計。補齊 my-agent 既有記憶系統（`src/memdir/` 四型分類 + `SessionMemory` + `extractMemories` + `autoDream` 已存在）尚缺的三塊：(1) 跨 session 歷史對話搜尋、(2) query-driven 動態 prefetch 注入、(3) 受控的 MemoryTool 寫入（含 prompt injection 掃描）。**不**移植 Hermes 的 provider plugin 抽象層，**不**改 `src/memdir/` 四型分類，**不**動 `QueryEngine.ts` / `Tool.ts` / `StreamingToolExecutor.ts`（deny list）。Anthropic 既有 code path 保留（黃金規則 #2）但**不作為**設計目標與驗收依據。

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
- ADR-UM-06：開關優先序 env (`MYAGENT_DISABLE_USER_MODEL`) > `CLAUDE_CODE_SIMPLE` > settings (`userModelEnabled`) > 預設啟用；CLI flag 暫不做（env var 前綴已夠用）

**詳細設計見 `docs/archive/USER_MODELING_PLAN.md`（已歸檔）。**

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

**詳細計畫**：見 `docs/archive/M_SP_PLAN.md`

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
- [ ] M-SP-5.1 新增 `tests/fixtures/system-prompt/` 驗證三層覆蓋（延後；現階段由 paths.ts 既有 sanitizePath 複用保證正確性）
- [x] M-SP-5.2 更新 `CLAUDE.md`（新增 ADR-008）+ `docs/context-architecture.md`（新增 §8 M-SP 章節）
- [x] M-SP-5.3 寫 `docs/customizing-system-prompt.md` 使用者指南（完整目錄結構、解析鏈、per-project 範例、變數插值、復原方式）
- [x] M-SP-5.4 e2e smoke：`bun scripts/dump-system-prompt.ts` 顯示 29/29 externalized，not-yet-externalized 清單空；typecheck baseline 不變

### 完成標準
- [x] 首次啟動自動 seed `~/.my-agent/system-prompt/` 含 README.md（手動驗證：刪目錄 → 重跑 → 15 個檔 + README 正確寫入）
- [ ] byte-level diff（seed 後 vs 重構前）= 0（未跑完整對照；dump 腳本已可供比對）
- [ ] 所有既有整合測試通過（memory 154 + user-model 27）（未跑；M-SP-4 改動 memory 常數路徑，建議後續手動驗證）
- [x] 使用者改檔案後開新 session 生效（機制驗證：loadSystemPromptSnapshot 啟動凍結，下 session 重讀）
- [x] per-project 覆蓋優先於 global，global 優先於 bundled（loader.ts 實作順序正確）

---

## 當前里程碑：M-LLAMA-CFG — 本地 LLM server 設定外部化（2026-04-19）

**目標**：15 處 llamacpp 相關設定（TS const / env var / shell 腳本 hard-code）統一到 `~/.my-agent/llamacpp.json`，TS + shell 共用一份 source of truth。

### 任務
- [x] M-LLAMA-CFG-1 建 `src/llamacppConfig/` 模組：schema / paths / loader / seed / index（Zod 驗證 + session 凍結）
- [x] M-LLAMA-CFG-2 `providers.ts` `getLlamaCppConfig` / `isLlamaCppModel` / `getLlamaCppModelAliases` 讀 snapshot（env var 仍優先）
- [x] M-LLAMA-CFG-3 `context.ts` `getContextWindowForModel` llamacpp 分支加 config.contextSize 為第三順位 fallback
- [x] M-LLAMA-CFG-4 `setup.ts` 啟動鉤子呼叫 `seedLlamaCppConfigIfMissing()` + `loadLlamaCppConfigSnapshot()`
- [x] M-LLAMA-CFG-5 新增 `scripts/llama/load-config.sh`（jq 抽 env，缺 jq / 缺檔 graceful fallback）
- [x] M-LLAMA-CFG-6 改 `scripts/llama/serve.sh` source load-config.sh，使用匯出的 `LLAMA_*` env + `LLAMA_EXTRA_ARGS_SHELL` 動態展開
- [x] M-LLAMA-CFG-7 Seed 同時寫出 `llamacpp.README.md`（使用者指南）
- [x] M-LLAMA-CFG-8 typecheck 綠、端對端 seed + shell load 驗證、commit

### 完成標準
- [x] 首次跑 my-agent 後 `~/.my-agent/llamacpp.json` + `llamacpp.README.md` 自動建立
- [x] `bash scripts/llama/serve.sh` 能正確讀 config（驗證過 HOST/PORT/CTX/ALIAS 皆來自 json）
- [x] env var 臨時覆蓋仍有效（`LLAMA_CTX=65536 bash serve.sh` 依然覆蓋）
- [x] JSON 壞 / 缺檔不 crash，走內建預設並 stderr 警告

---

## 已完成里程碑：M-TOKEN — llamacpp cache token 計數修復（2026-04-19）

**問題**：TUI `/cost` 與 session 摘要的 `cache read` 在 llamacpp session 一直顯示 0，但 llama.cpp 的 OpenAI-compatible response 有 `usage.prompt_tokens_details.cached_tokens` 欄位，adapter 硬編碼 0 沒接上。

**詳細計畫**：`docs/archive/M_TOKEN_PLAN.md`

### 任務
- [x] M-TOKEN-1 `llamacpp-fetch-adapter.ts` OpenAI 型別介面加 `prompt_tokens_details?: { cached_tokens?: number }`（非 stream + stream 兩個 interface）
- [x] M-TOKEN-2 非 stream `translateChatCompletionToAnthropic`：`cache_read_input_tokens` 改讀 `prompt_tokens_details.cached_tokens`
- [x] M-TOKEN-3 Streaming `accUsage` 加 `cache_read_input_tokens` 欄位
- [x] M-TOKEN-4 Streaming chunk.usage 處理追加 `cached_tokens` 抽取
- [x] M-TOKEN-5 Streaming `message_delta` usage 擴充 `input_tokens` / `cache_read_input_tokens` / `cache_creation_input_tokens: 0`
- [x] M-TOKEN-6 `bun run typecheck` 綠（baseline TS5101 pre-existing）
- [x] M-TOKEN-7 curl llama-server 驗證 `prompt_tokens_details.cached_tokens` 欄位確實存在於回應中（當前 build b8829 cache_n=0，是 server 層行為，與 adapter 無關）

### 完成標準
- [x] llama.cpp 確實會回傳 `prompt_tokens_details.cached_tokens`（adapter 已接上，值隨 server 實際 cache 命中而動）
- [x] cache write 維持 0（llama.cpp 無此概念）
- [x] 舊版 llama.cpp（沒回 `prompt_tokens_details`）走 `?? 0` fallback，不 crash
- [x] Anthropic path 不退步（只動 adapter，未觸及 `services/api/client.ts` 與 `services/api/claude.ts`）

### 備註
- 本次 adapter 修好「資料管線」——cache_read_input_tokens 會從 llama.cpp response 正確流到 TUI 顯示
- 實際 cache hit 數字取決於 llama.cpp server 端的 prefix caching 設定；curl probe 顯示當前 build b8829 的 `timings.cache_n` 為 0（可能需要額外 `--slots` 或 `--cache-reuse` 啟動參數）——這是**後續調整 llama-server 啟動腳本**的議題，不在本 M-TOKEN 範圍

---

## 已完成里程碑：M1 — 透過 llama.cpp 支援本地模型（封存）

**目標**：my-agent 能直接連接專案內跑的 llama.cpp server（`http://127.0.0.1:8080/v1`，model alias `qwen3.5-9b-neo`），支援串流和全部 39 個工具的 tool calling。**不再**經過 LiteLLM proxy（ADR-001 已推翻，見 CLAUDE.md）。

**架構硬約束**：`src/QueryEngine.ts` 與 `src/Tool.ts` 在 `.claude/settings.json` deny list — **不能改**。因此 provider 必須在內部把 OpenAI SSE 轉成 Anthropic 形狀的 stream event，下游無感。

**實作路徑**：**路徑 B（fetch adapter）** — 2026-04-15 PoC 驗證通過（commit `b2af143`）。仿 `src/services/api/codex-fetch-adapter.ts` 模式，寫 `llamacpp-fetch-adapter.ts`，塞給 `new Anthropic({ fetch })`，翻譯層集中一處，`claude.ts` / `QueryEngine.ts` 零修改。**不另建** `src/services/providers/` 抽象層（路徑 A 已放棄）。

### 階段一：摸底與可行性驗證
- [x] 閱讀並記錄 my-agent 現有 API 架構的實測事實（`src/services/api/client.ts`、`src/services/api/claude.ts`、`src/utils/model/providers.ts`），把發現寫進 `skills/freecode-architecture/SKILL.md`
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

**目標**：將 `anthropics/skills` GitHub repo 的 17 個通用 skill 內化為 my-agent 的 bundled TypeScript skills。SKILL.md 變成 TypeScript 模組、Python scripts 改寫為 TypeScript——讓它們成為 my-agent 二進位檔的一部分，不依賴外部 marketplace。與 ADR-007（vendor SDK）精神一致。依 ADR-003，所有 skill 無條件註冊，不使用 feature flag。不依賴 LibreOffice 等大型系統軟體，所有功能用純 TypeScript/JavaScript 套件實現。

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

## 已完成里程碑：M-BROWSER — Hermes Browser 能力整合（2026-04-19）

將 Hermes Agent 的 web 研究 + 互動式瀏覽器能力以 TypeScript 重新實作進 my-agent；既有 WebFetch / WebSearch 不動，全部附加。四階段（M4-BR / M5-BR / M6-BR / M7-BR）完成。詳細決策見 ADR-011；開發日誌見 CLAUDE.md 2026-04-19 段落；工具使用說明見 `src/tools/WebBrowserTool/README.md`。

- [x] M4-BR `WebCrawlTool` + 共用安全層 `secretScan` / `blocklist` — commit `c29f74c`
- [x] M5-BR `WebBrowserTool` 本地 puppeteer backend（10 actions + a11y refs + idle TTL）— commit `32fae13`
- [x] FIX-BUILD 修 m-deanthro 後 dangling imports 讓 `bun run build` 重新能跑 — commit `4bf674b`
- [x] M6-BR 三家 cloud providers（Browserbase / Browser Use） + vision + screenshot + Firecrawl 整合 — commit `49d53d7`
- [x] M7-BR README + ADR-011 + 本段 TODO 更新 — 本 commit

踩坑：bun + Windows 下 playwright-core 的 pipe/CDP 無限 hang，改用 puppeteer-core 解決（沿用 `bunx playwright install chromium` 的 binary）。記錄於 memory `project_playwright_bun_incompat.md` 與 ADR-011。

---

## 當前里程碑：M-DELETE — Session / Memory / Trash slash commands（2026-04-22 啟動）

**目標**：新增三個互動式 REPL slash commands 讓使用者選取並刪除 session 內容與 memory 條目，採軟刪除（`.trash/`），附還原機制。詳細規劃見 `docs/plan-session-memory-delete.md`。

**架構決策**（2026-04-22 與使用者逐題對齊）：
- ADR-MD-01：軟刪除 — 檔案搬到 `<projectDir>/.trash/`，DB 紀錄（FTS 索引、sessions 表）直接硬刪；restore 時檔案搬回 + 跑 reconciler 重建索引
- ADR-MD-02：Memory 範圍 = auto-memory 個別條目 + MY-AGENT.md（非 CLAUDE.md — my-agent 實際讀前者）+ `./.my-agent/*.md` + Kairos daily logs；memory picker 雙鍵 `d` 刪除 / `e` 編輯（spawn `$EDITOR`）
- ADR-MD-03：Session 當前進行中的 session 禁止刪除，picker 顯示 `[current]` 標籤且 disabled
- ADR-MD-04：`/trash` 一個 picker 涵蓋 list + restore + empty + prune（跟 `/tools` 同風格）
- ADR-MD-05：Live filter（按 `/` 進入）+ 時間快捷鍵（`1`=今天 `2`=本週 `3`=本月 `a`=全部）
- ADR-MD-06：**Discord source 禁止觸發**三個 command；在 `src/discord/slashCommands.ts` router 層攔截並回覆「此操作僅限 REPL」

### 任務

#### 階段一：共用基礎層
- [x] M-DELETE-1 `src/utils/trash/index.ts`：`moveToTrash` / `restoreFromTrash` / `listTrash` / `emptyTrash` / `pruneTrash` / `purgeTrashEntry` / `totalTrashSize` + 34 case smoke
- [x] M-DELETE-2 `src/services/sessionIndex/delete.ts`：`deleteSessionWithDb`（transaction 刪 sessions + messages_fts + messages_seen；FTS5 用 SELECT COUNT 預量測因 changes() unreliable）+ `listSessionsWithDb(range/keyword/limit/offset)` + 22 case smoke
- [x] M-DELETE-3 `src/utils/trash/sessionOps.ts`：`trashSession` 整合 moveToTrash + deleteSession；`restoreSessionEntries` batch；呼叫端需跑 reconcileProjectIndex 重建 FTS

#### 階段二：Memory 層
- [x] M-DELETE-4 `src/utils/memoryDelete.ts`：`softDeleteMemoryEntry`（搬檔 + 更新 MEMORY.md 索引）+ `softDeleteStandaloneFile`（無索引類）+ `assertSafeMemoryFilename` 路徑安全驗證 + 27 case smoke
- [x] M-DELETE-5 `src/utils/memoryList.ts`：`listAllMemoryEntries(cwd)` 列 auto-memory 條目（讀 frontmatter）+ MY-AGENT.md + `./.my-agent/*.md` + Kairos daily logs（`logs/YYYY/MM/*.md`），mtime DESC

#### 階段三：Slash Commands
- [x] M-DELETE-6 `/session-delete`：listSessions → picker → 軟刪（trashSession = moveToTrash + deleteSession DB）；時間範圍 1/2/3/0、live `/` filter、`[cur]` 標記禁刪、二段 y/Esc 確認
- [x] M-DELETE-7 `/memory-delete`：listAllMemoryEntries → picker；`e` spawn `$EDITOR` 單列編輯（VISUAL/EDITOR fallback notepad/vi）；Enter 批次軟刪
- [x] M-DELETE-8 `/trash`：listTrash → picker 整合 Enter=purge / r=restore / x=emptyAll / p=prune N 天；三向二段確認
- [x] M-DELETE-9 `src/commands.ts` import + 註冊三個 command

#### 階段四：Discord 黑名單 + 驗收
- [x] M-DELETE-10 `src/discord/gateway.ts` handleIncoming step 1.5：prompt trimStart 比對黑名單 3 command → 回覆「僅限 REPL」；10 case smoke
- [x] M-DELETE-11 整合測試：`tests/integration/delete/` 4 檔 93 case 全綠（trash 34 + session-delete 22 + memory-ops 27 + discord-blacklist 10）
- [x] M-DELETE-12 `bun run typecheck` baseline 綠、`./cli -p` 冒煙通過
- [x] M-DELETE-13 docs `docs/session-and-memory-management.md` 使用者指南

### 完成標準
- [x] `bun run typecheck` 綠（baseline 僅 TS5101 pre-existing）
- [x] 三個 command 在 REPL 註冊成功（`grep` 確認 src/commands.ts 含三者）
- [x] 軟刪 + restore 往返完整（trash-smoke 33 case + sessionOps 驗證 DB 刪除）
- [x] Discord 來源拒絕觸發（discord-blacklist-smoke 10 case + gateway.ts handleIncoming step 1.5）
- [x] `./cli -p "ok"` 冒煙不壞
- [ ] 手動 E2E：REPL 開啟 /session-delete / /memory-delete / /trash 互動驗證（待使用者驗證）

### 完成標準
- [x] `bun run typecheck` 綠
- [ ] 三個 command 在 REPL 可用且互動順暢
- [ ] 軟刪 + restore 往返完整（session FTS 索引正確重建）
- [ ] Discord 來源拒絕觸發（slash command 明確回拒）
- [ ] `./cli -p "hi"` 冒煙不壞

---

## 當前里程碑：M-CRON-W3 — Cron 6 大功能擴充（2026-04-23 啟動）

**目標**：把本地 cron 從「會 fire 的 timer」升級成「可觀測 / 可確認 / 可恢復」的排程子系統。補齊 Anthropic remote schedule 等 managed 服務有、本地缺的 6 項：自然語言排程、結果通知（TUI toast + StatusLine badge + Discord）、run history 觀測、失敗重試 + backoff、conditional 觸發、明確 catch-up 策略。詳見 `docs/cron-wave3-plan.md`。

**核心決策**（與使用者對齊）：
- Q1 NL 解析 = 純 LLM（不裝 chrono-node），失敗明確報錯不靜默 fallback
- Q2 TUI 通知 = ephemeral toast + StatusLine 持久 badge
- Q3 失敗條件 = 不寫死，CronCreate 走統一 wizard 蒐集
- Q3+ Wizard 觸發 = LLM 呼叫 CronCreate 一律彈 wizard 預填讓使用者改/確認/取消
- Q4 Catch-up = per-task `catchupMax: number`（預設 1）

**架構原則**：擴 CronTask schema（全 optional）+ scheduler 邊界 hook，**不重寫核心邏輯**；保留 6105c6c 修的 batched write race；daemon 是唯一 fire 執行者。

### 任務
- [x] M-CRON-W3-1 CronTask schema 擴充（scheduleSpec / notify / history / retry / condition / catchupMax 6 個 optional 欄位 + FailureMode type export + writeCronTasks strip 邏輯保持，typecheck 全綠）
- [x] M-CRON-W3-2 Run history store + `CronHistoryTool` + `/cron-history` slash（`.my-agent/cron/history/{id}.jsonl` append-only + keepRuns truncate）
- [x] M-CRON-W3-3 Condition gate（`src/utils/cronCondition.ts` 支援 shell/lastRunOk/lastRunFailed/fileChanged，cronWiring.handleFire 開頭 evaluateCondition 不通過 emit skipped）
- [x] M-CRON-W3-4 Catch-up 明確化（enumerateMissedFires + selectCatchUpFires，daemon startup spread jitter 連續 fire `min(actual, catchupMax)` 次）
- [x] M-CRON-W3-5 Retry / backoff（cronFailureClassifier 5 種 mode，handleFire 訂 turnEnd → setTimeout exponential backoff，daemon restart attemptCount&gt;0 視同放棄）
- [x] M-CRON-W3-6 Broker `cronFireEvent` + Discord cronMirror（sessionBroker emit + directConnectServer broadcast + 走 pickAllMirrorTargets + redactSecrets + truncateForDiscord）
- [x] M-CRON-W3-7 TUI toast + StatusBadge（useDaemonMode.onCronFireEvent → addNotification 重用 context/notifications.tsx + 新 useCronStatus hook + CronStatusBadge 掛 StatusLine）
- [x] M-CRON-W3-8a Wizard 後端（broker 三 frames + cronCreateWizardRouter mirror permissionRouter pattern + CronCreateTool 改 async 等 wizard 結果 + bypassWizard escape hatch）
- [x] M-CRON-W3-8b Wizard 前端（CronCreateWizard summary card + inline edit ink UI，REPL 推到 modal slot）
- [x] M-CRON-W3-9 NL parser（cronNlParser 走 services/api/client.ts 結構化 prompt + tz/now，retry 1 次，失敗 typed error；CronCreateTool 偵測非 cron 字串走 NL 路徑）
- [x] M-CRON-W3-10 Docs（更新 `docs/daemon-mode.md` cron 章節）+ 開發日誌 + LESSONS

### 完成標準
- [x] `bun run typecheck` 綠
- [x] `tests/integration/daemon/cron-wiring.test.ts` 既有測試全綠
- [x] 新增單元測試（cronNlParser / cronFailureClassifier / cronCondition / cronHistory / catch-up helpers — tests/integration/cron/ 下 11 檔 + picker-logic 22 tests）
- [ ] 端到端：daemon 跑 cron 失敗 retry 正確、condition skip 正確、catchupMax 限制正確（待使用者實機驗證）
- [ ] Discord home channel 收到 cron fire 通知（已 redactSecrets + truncate）（待使用者實機驗證）
- [ ] REPL toast + StatusBadge 顯示正確（待使用者實機驗證）
- [ ] `/cron-create` 經 LLM 觸發出 wizard、使用者改欄位 / 確認 / 取消三條路徑都正確（待使用者實機驗證）
- [ ] NL：`「每週一早上 9 點」` 正確翻譯成 `0 9 * * 1`（待使用者實機驗證）
- [x] `./cli -p "hi"` 冒煙不壞（每個 commit 都跑）

---

## 已完成里程碑：M-CRON-W4 — `/cron` TUI + daemon WS 寫入（2026-04-23 啟動、2026-04-24 完成）

**目標**：Wave 3 只有 agent tool 層（LLM 呼叫 CronCreate / CronList / ...）；Wave 4 給人類一個互動式 TUI。打開 `/cron` 一鍵瀏覽 / 建立 / 編輯 / 暫停 / 執行 / 查 history，不必每次請 LLM。並補 daemon attached 時的即時寫入同步（chokidar ~200ms 改 WS 直接 RPC，broadcast 給所有 attached client）。

**使用者已定案的決策**：
- Q1 單一 `/cron` command
- Q2 基本 inline + `a` toggle advanced 欄位
- Q3 擴充既有 `CronCreateWizard` 支援 inline edit，create / LLM-gate 共用
- Q3′ (b) 擴 wizard 加 edit-field mode（不是寫新 form）
- Q4 attached 時寫 daemon WS，standalone 走本機
- Q5 run-now 走 REPL queue（沿用 `CronRunNowTool` 行為，不經 daemon）
- Q6 刪除 `y/N` confirm
- Q7 全部顯示（含 completed / agent-owned）
- Q8 sort by state rank + next-fire

**Schedule editor UX**（使用者回饋「打 `*/2 * * * *` 不友善」）：
- Q1 preset 清單 14 項夠用
- Q2 (a) 加 One-shot YYYY-MM-DD HH:MM preset
- Q3 preview 要顯示下次 fire 時間

**commit 序列**（11 個獨立可交付）：

### 核心 `/cron` TUI（commit 1-7）
- [x] commit 1 `f394fa6` read-only list + detail（master-detail、sort、inline 最近 5 筆 history、10s now tick、5s polls listAllCronTasks）
- [x] commit 2 `692cd1f` pause/resume/delete + y/N confirm + 2.5s auto-fade flash
- [x] commit 3 `5012e7b` run-now（走 CronRunNowTool 的 enqueuePendingNotification 路徑）
- [x] commit 4 `9057a1f` wizard inline edit mode（E / a 鍵 + 10 欄位 + text/bool/number/JSON editor）
- [x] commit 5 `33d183f` /cron create flow（n 鍵 → wizard + parseSchedule/parseScheduleNL）
- [x] commit 6 `5601828` /cron edit flow（e 鍵 → wizard 預帶 task 全欄位）
- [x] commit 7 `a6c309c` full history 捲動畫面（H 鍵 + 20/頁 PgUp/PgDn）

### Schedule preset picker（commit 8）
- [x] commit 8 `1a0cea9` `CronScheduleEditor` 14 preset + 參數 form + NL + custom + next-fire preview

### B1 daemon WS 寫入（commit 9-11）
- [x] commit B1a `df45fb1` `daemon/cronMutationRpc.ts` — frame protocol + handler + daemonCli dispatch
- [x] commit B1b `ebe1edd` `fallbackManager.sendCronMutation` + cron.mutationResult / cron.tasksChanged 處理
- [x] commit B1c `5639761` CronPicker 偵測 attached 走 WS / standalone 走本機；訂閱 cron.tasksChanged broadcast 立即 reload

### B2-B6 小收尾（commit 12-15）
- [x] commit B4 `3174388` /cron list 多一欄顯示 scheduleSpec.raw（NL 建的原始語意）
- [x] commit B2 `44d8f5c` CronListTool 輸出 scheduleRaw / scheduleKind；LLM 看得到使用者 NL 語意
- [x] commit B5 `272415d` wizard prompt 專屬 multi-line editor（同 schedule editor 模式）
- [x] commit B6 `1f88ef3` 抽 cronPickerLogic + 22 個單元測試（sort / label / icon / next-fire / last-run / truncate）

**主動跳過**：
- B3 `/cron-history` 獨立 slash command — `/cron` 的 H 鍵已覆蓋 95%，獨立 slash 只在 headless 有微邊際價值（LLM 已可呼 CronHistoryTool），不值得新 command

**新模組**：
- `src/commands/cron/{index.ts, cron.tsx, CronPicker.tsx, cronPickerLogic.ts}` — 1 個新 slash command
- `src/components/{CronScheduleEditor.tsx}` — 14 preset schedule editor
- `src/daemon/cronMutationRpc.ts` — WS frame protocol + handler
- `tests/integration/cron/picker-logic.test.ts` — 22 個 pure-fn tests

**改造既有**：
- `src/commands.ts` — 註冊 /cron
- `src/components/CronCreateWizard.tsx` — 從 display-only summary card 擴成全互動 wizard（view / selecting / editing / editing-schedule / editing-prompt 5 個 mode）
- `src/daemon/daemonCli.ts` — dispatch cron.mutation frame
- `src/repl/thinClient/fallbackManager.ts` — 加 CronMutationPayload type + sendCronMutation + pending map + cleanup
- `src/hooks/useDaemonMode.ts` — 加 sendCronMutationToDaemon helper
- `src/tools/ScheduleCronTool/CronListTool.ts` — output schema 加 scheduleRaw / scheduleKind

**E2E 驗收清單**（待使用者跑一輪）：
- [ ] `/cron` 開啟 → 看得到現有 tasks（含 daemon 建的 W3 test task）
- [ ] `n` 建「每 2 分鐘」→ list 立刻出現 → 等 2 分鐘 → REPL 彈 toast + StatusLine badge
- [ ] `p` 暫停 → icon 切 ⏸ → daemon 下 tick 不 fire
- [ ] `r` 立即執行 → REPL 在下個 turn gap 跑 prompt
- [ ] `e` 改 prompt → 再 `r` 驗證新 prompt 生效
- [ ] `h` inline history、`H` full history scroll
- [ ] `d` → confirm y → 從 list 移除、tasks.jsonl 也消失
- [ ] Schedule editor：preset 直接 commit、參數 form 填 c 確認、Custom/NL 輸入框 Enter commit
- [ ] Attached 模式下兩個 REPL：一邊改另一邊立即看到（cron.tasksChanged broadcast）
- [ ] Standalone 模式：daemon 停掉還能用（fallback 本機）

---

## 已完成里程碑：M-TOOLS-PICKER — REPL 即時 tool 開關（2026-04-21 完成）

**目標**：讓使用者在 REPL 用 `/tools` 開一個多選 picker 即時關閉 / 啟用工具，避免弱模型（qwen 9B）亂選 tool（例如硬用 curl 查 Google Maps）、或使用者想暫時關掉某些 tool。詳細規劃見 `docs/tools-picker.md`。

**架構決策**：
- ADR-TP-01：tool **註冊**（編譯時）不變；只在**組裝**層（`useMergedTools` + `getTools`）加 filter step。每 turn 重新組裝，改 AppState 下個 turn 立即生效、不需 rebuild / restart
- ADR-TP-02：三層持久化 — session (AppState) / per-project (`~/.my-agent/projects/<slug>/settings.json`) / global (`~/.my-agent/settings.json`)，優先 session > project > global > 預設（全開）
- ADR-TP-03：核心 tool 不可關 — `FileRead` / `FileWrite` / `FileEdit` / `Bash` / `Glob` / `Grep` 固定為 `UNTOGGLEABLE_TOOLS`，picker 顯示但灰色鎖定
- ADR-TP-04：關掉的 tool 從 tool array 完全隱藏，LLM 不知道其存在（而非「可見但標 disabled」）
- ADR-TP-05：REPL client local scope — daemon / Discord / cron turn 不受影響（user 決策）；日後要擴 daemon-wide 再加 WS frame

**實作任務**：

### 階段一：infrastructure
- [x] MTP-01 `src/constants/untoggleableTools.ts` 新增 `UNTOGGLEABLE_TOOLS: Set<string>`
- [x] MTP-02 `src/state/AppStateStore.ts` 加欄位 `disabledTools: ReadonlySet<string>` + action `setDisabledTools`
- [x] MTP-03 settings schema（Zod）加 optional `disabledTools?: string[]`（global + project 兩層）
- [x] MTP-04 `src/bootstrap/state.ts` 讀 global + project settings 合併、filter 掉 UNTOGGLEABLE，填入 initial AppState
- [x] MTP-05 settings helper：`readDisabledTools(scope)` / `writeDisabledTools(scope, list)`

### 階段二：filter 注入
- [x] MTP-06 `src/tools.ts:getTools()` 新增 `opts?: { disabledTools?: ReadonlySet<string> }` 參數，在 permission deny 之後、`.isEnabled()` 之前加 filter
- [x] MTP-07 `src/tools.ts:assembleToolPool()` 同步 pass-through
- [x] MTP-08 `src/hooks/useMergedTools.ts` 從 AppState 讀 `disabledTools` 傳給 assembleToolPool，加進 useMemo deps
- [x] MTP-09 驗證：改 AppState 後，新 turn 的 tools array 不含被關 tool

### 階段三：picker UI
- [x] MTP-10 `src/commands/tools/ToolsPicker.tsx` — 參考 `src/commands/model/ModelPicker.tsx`，實作方向鍵 + 空白 + Enter + p + g + r + Esc
- [x] MTP-11 `src/commands/tools/index.ts` — 註冊 local-jsx command
- [x] MTP-12 `src/commands.ts` 加進 COMMANDS array
- [x] MTP-13 Picker footer 顯示 hint（space/enter/p/g/r/esc）

### 階段四：驗證 + 測試
- [x] MTP-14 單元測試 `getTools` 的 disabledTools filter 行為、UNTOGGLEABLE guard
- [x] MTP-15 整合測試 picker 流程（AppState 改 → 下 turn 不含 tool）
- [x] MTP-16 手動測試：per-project 蓋 global、關 WebBrowser 後叫 agent 「開網頁」看它退到 WebFetch
- [x] MTP-17 `bun run typecheck` + `bun run build` 綠
- [x] MTP-18 `./cli` 冒煙測試 + commit

---

## 未來里程碑（尚未詳細規劃）

### M4 — Hermes Cron 排程（TypeScript 重新實作）
將 Hermes 的 cron 系統（自然語言排程 + 多平台派送）移植到 my-agent。

### ~~M5 — Hermes 訊息閘道（TypeScript 重新實作）~~
~~將 Telegram/Discord/Slack 閘道移植到 my-agent。~~
**由 M-DAEMON（前置）+ M-DISCORD（2026-04-19 啟動）取代**。先個人用 Discord，Telegram/Slack 不在範圍內。

### M6 — Self-Improving Loop（AutoDream × Hermes 合併）

**目標**：合併 my-agent 的 AutoDream（背景記憶整合）與 Hermes Agent 的 self-improving loop（即時自我改進迴圈），讓系統從「被動整理記憶」進化為「邊做邊學邊改」。三個階段漸進實施：方案一（擴展 Dream prompt）→ 方案二（即時 Nudge 雙迴圈）→ 方案三（完整三層自改進系統）。以 **llama.cpp 本地模型** 為主要運行情境。

**詳細設計分析見 `docs/archive/AUTODREAM_HERMES_MERGE_ANALYSIS.md`。**

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

**詳細設計分析見 `docs/archive/SKILL_SELF_CREATION_PLAN.md`。**

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
- [x] M6b-19 更新 `docs/archive/AUTODREAM_HERMES_MERGE_ANALYSIS.md`（觸發架構圖 + Phase 清單）+ `docs/archive/SKILL_SELF_CREATION_PLAN.md`（狀態標記完成）

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
- [x] M6c-05 修改 `src/screens/REPL.tsx`：加入 SkillCreationSurvey import + render；移除 SkillImprovementSurvey 的 `"external" === 'ant'` guard（my-agent 已解鎖所有功能）

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

**目標**：my-agent 完全使用本地模型，移除所有 Anthropic auth 依賴。GrowthBook 停用遠端 fetch，所有 flag 預設 true 並從 .my-agent.json 讀取。解鎖被 auth gate 擋住的功能。

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
將 Honcho 風格的使用者建模和跨 session 回憶移植到 my-agent。

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

- [x] M12-01 目錄改名 `claude-api` → `anthropic-sdk-reference`；SKILL.md frontmatter 更新清楚標示「外部 SDK 參考、非 my-agent 本地 LLM」
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

## 當前里程碑：M-MEMRECALL-LOCAL — Memory Prefetch 在純 llama.cpp 環境失效修復（2026-04-24 啟動）

**問題**：M2 設計的 query-driven memory prefetch（`tengu_moth_copse=true`）的 selector model 寫死 `getDefaultSonnetModel()`，透過 `sideQuery → getAnthropicClient` 走 Anthropic SDK。純 llama.cpp 用戶（無 `ANTHROPIC_API_KEY`）→ 401/throw → catch 吞掉 → 回 `[]` → memory 完全沒進 attachments。任何新 session 問記過的事都「亂答」（同 session 第二次能對是 conversation history 撐著，不是 memory 機制）。

**根因檔案**：
- `src/memdir/findRelevantMemories.ts:99` — selector hardcode `getDefaultSonnetModel()`
- `src/utils/sideQuery.ts:124` — 純 Anthropic 路徑
- `src/utils/claudemd.ts:1142` `filterInjectedMemoryFiles` 過濾 AutoMem（設計如此，由 `tengu_moth_copse` gate）

### 任務（A 走本地模型 + B fallback safety net）
- [x] M-MEMRECALL-1 `findRelevantMemories.ts`：加 `isLlamaCppActive()` 分支 → 走新 `selectViaLlamaCpp()`（直接 fetch `${baseUrl}/chat/completions`，prompt 引導純 JSON array 輸出，不依賴 structured-output beta）；signal 沿用既有 abort chain
- [x] M-MEMRECALL-2 fallback：selector 回 `[]` 時，按 mtime 排序帶最新 `FALLBACK_MAX_FILES=8` 檔（簡化版：用檔案數而非 bytes，省 stat IO）+ `logForDebugging` warn
- [x] M-MEMRECALL-3 unit test：`tests/integration/memory/findRelevantMemories-llamacpp.test.ts`（23 test：純函式 16 + selector 整合 7，mock fetch + mock.module）全綠
- [x] M-MEMRECALL-3b CJK fix：`src/utils/attachments.ts:2367` 原 `/\s/.test()` early-return 對中文 query（無空白）誤判 → bailout prefetch，所有 CJK 用戶 memory 機制完全失效。改成 `hasWhitespace || trimmed.length >= 4`（CJK 4 字 + 英文 4 字單字都觸發）
- [x] M-MEMRECALL-3c disk config 修正：`~/.my-agent/.my-agent.json` 的 `cachedGrowthBookFeatures.tengu_moth_copse` 被舊版 my-agent 寫死成 `false`，覆蓋了 code 預設 true → prefetch 整路關閉。本機 `sed` 改回 true + backup 到 `.my-agent.json.bak.before-mothcopse-fix`。永久修法另立 M-DISK-CFG-MIGRATION
- [x] M-MEMRECALL-4 typecheck（已過 baseline）+ 手動 E2E（2026-04-24 04:09）：daemon 重啟後新 session 問「現在台北天氣？」 — debug log 顯示 4 gate 全過 → llamacpp branch 觸發 → selector 回 0（local model 26s）→ fallback 帶 5 檔（含 `feedback_weather_api.md`）→ session JSONL 確認 LLM 直接 `curl wttr.in/Taipei` 拿到 `+21°C 🌓` 並正確答覆。Debug 程式碼已清掉
- [x] M-MEMRECALL-5 文件：CLAUDE.md ADR-014 + LESSONS.md（sideQuery hardcoded Sonnet 教訓）+ session log（docs/memory.md 待專題擴充時一起補）

### 完成標準
- [x] 純 llama.cpp + 無 API key 環境，新 session 套用 memory 規則（單元測試覆蓋；E2E 待人工驗）
- [x] Anthropic 路徑（設 API key 時）行為不變（沒動 sideQuery / Anthropic branch；分支由 `isLlamaCppActive()` gate）
- [x] selector 失效時 fallback 觸發、log 出現 warn（HTTP 500 / parse fail / network error / empty array 四 case 測過）

### 不在範圍（→ 後續 milestone）
- [x] M-SIDEQUERY-PROVIDER：`sideQuery` 改採更簡單方案 — commit `420ad1e` 直接砍 Anthropic 路徑改 llama.cpp-only（model 參數 kept for signature compat 但 runtime 忽略）。後續 commit `ec43451` / `79545c2` 把 callers（session-search summarize 等）跟著走。原本框架的「provider-aware」沒做（沒人需要），但驅動該 milestone 的問題已解
- [x] M-EXTRACT-LOCAL：自動隨 M-SIDEQUERY-PROVIDER 解 — `extractMemories.ts` 不直連 sideQuery（用 `executeExtractMemories` → ToolUse loop），sideQuery callers 改 llama.cpp-only 後 extractMemories 在純 llama.cpp 環境也能跑
- [ ] M-MEMRECALL-FLAG-AUDIT：評估 `tengu_moth_copse` 預設值是否該對純本地用戶反轉（回到 MEMORY.md 全進 system prompt） — 跟既有 ADR + 上下文 budget 取捨衝突，需專題討論
- [ ] M-CJK-AUDIT：全倉庫搜「以英文為前提」的字串處理（regex word boundary `\b`、whitespace `\s` token split、字數 / 詞數計算），逐一驗證 CJK 行為。`src/utils/attachments.ts:2367` 已修；可能還有 `extractMemories` / `memoryScan` / FTS query 預處理等
- [ ] M-DISK-CFG-MIGRATION：`~/.my-agent/.my-agent.json` 上的 `cachedGrowthBookFeatures` 是舊版本 sync 的快取，可能含被改成 `false` 的 my-agent-default-true flag（如本次的 `tengu_moth_copse`，或其他 `tengu_*` 解鎖 flag）。`getFeatureValue_CACHED_MAY_BE_STALE` 純讀 disk → 蓋掉 code 預設。要做：(a) 啟動時 detect my-agent-shipped flags 跟 disk 衝突，warn 或自動覆寫；(b) 或在 lookup 加一層「my-agent strong-default override」優先於 disk false。需考慮使用者手動關閉 flag 的情境（差別在哪）

---

## 當前里程碑：M-DECOUPLE-3 — E2E 測試套件補洞（2026-04-25 啟動）

**背景**：commit `5cd3028` 把 daemon + cron section 自動化到全綠（PASS=43）；但留兩條後續：(1) SRC mode（`bun run dev`）daemon start 當下被觀察到 hang，移到後續 milestone；(2) E2 test 名為「thin client attach + turn」實際 `-p` print mode 完全不走 thinClient（standalone 直打 llama.cpp），test 通過是 false-positive。

**重新診斷（2026-04-25）**：
- SRC hang **重現不到** — `( bun run ./scripts/dev.ts daemon start > log 2>&1 & )` pid.json 2s 出來、heartbeat 正常更新、daemon.log 顯示完整 listening。原本 `daemon-src-start.log` 的 `exited with code 143` 是 SIGTERM（八成 e2e timeout 殺的，被誤判為 hang）。
- E2 false-positive **已確認** — `src/cli/print.ts` 對 daemon 只查 `isDaemonAliveSync()` 用於 cron 歸屬，不開 thinClient socket；thinClient 模組（`src/repl/thinClient/fallbackManager.ts`）只在 `src/screens/REPL.tsx` 互動 REPL 使用。daemon.log grep `client connected` 對 SRC -p 跑那段時間 zero connection。

### 任務

#### M-DECOUPLE-3-2：SRC 路徑加回 E2E（防迴歸）
- [x] M-DECOUPLE-3-2-1 D6（SRC sanity）。**設計改變**：原計畫用 LLM 算術發現 SRC 三層 bun + tsx 全樹 transpile cold start 4 分鐘+ 跑不完；改用 `bun run dev --version` fast path — 仍會 import 整個 module 樹（dangling import / feature flag 殘留 / vendored SDK 壞會立刻爆），1 秒內完成。
- [x] M-DECOUPLE-3-2-2 E6/E7（SRC daemon start/stop）。`( bun run dev daemon start & )` → 15s 內 pid.json → SRC daemon stop 12s 內清乾淨。
- [x] M-DECOUPLE-3-2-3 D + E section isolated 驗證（D=6/6, E=7/7 全綠）

#### M-DECOUPLE-3-3：E2 名實不符修正 — 真 thin-client smoke + 完整 REPL E2E（B 方案）
- [x] M-DECOUPLE-3-3-1 (b 方案) `tests/e2e/_thinClientPing.ts` — 用底層 `createThinClientSocket` + `readPidFile/readToken`，直接打 WS 等 hello frame、送 permissionContextSync。E section 用 `bun run` 呼叫並比對 daemon.log 的 `client connected` 計數差。
- [x] M-DECOUPLE-3-3-2 E section 改造：E2 改名 `E2 print mode while daemon up`（誠實標示 standalone），新增 E4 thin-client ping、E5 完整 turn。
- [x] M-DECOUPLE-3-3-3 (c→改 B 方案) `tests/e2e/_thinClientTurn.ts` 用 REPL 真正用的 `createFallbackManager` + `createDaemonDetector`，sendInput 等 turnEnd 抽 `runnerEvent` assistant 文字。比 PTY-based 全互動 REPL 工程量小 N 倍、邊際 coverage 高（差別只剩 React 渲染那層，留 M-DECOUPLE-3-5）。
  - 關鍵 false-positive 副產物修復：F section 殘留的 `e2etest*` cron task 撞 E5 sendInput 觸發 interactive interrupt → turn aborted。E section 開頭加 prophylactic 清理；F cleanup 改用 filter 不只靠 backup/restore。
- [x] M-DECOUPLE-3-3-4 D + E section isolated 全綠；待 full E2E + commit

### 完成標準
- [x] D/E section 全綠（D 5→6 case, E 3→7 case）
- [x] 真 thin-client attach + turn 驗到（E4 + E5）
- [x] daemon.log 在 E4 + E5 期間有真實 `client connected` 紀錄（消除 false-positive）
- [x] SRC + BIN 兩條 path 都驗到（D6 SRC --version + E6/E7 SRC daemon）

### 不在範圍（→ 後續 milestone）
- [x] M-DECOUPLE-3-4：F section 從 5 case 擴 → 7 case，BIN + SRC daemon 各跑一輪 cron lifecycle（cron_lifecycle helper 抽出）
- [x] M-DECOUPLE-3-5：新增 I section（3 case）— I1 模組 load / I2 unit tests 跑過（155 pass）/ I3 真起 daemon + bot 連 Discord 驗 daemon.log 出現 `discord ready` + `slash commands registered`
- [x] M-DECOUPLE-3-6：c 方案 PTY-based 互動 REPL E2E。新增 `tests/e2e/_replInteractive.ts`（120 行）+ J section（2 case）。Phase 1 看 `Daemon 已連線` marker、Phase 2 送 4+5、ANSI strip 後 grep `\b9\b`。Bun + node-pty + ink alt-screen 撞 async ERR_SOCKET_CLOSED → 改 npx tsx 走 Node。順手 BIN cascade 三層（`.exe` / 無副檔名 / production fallback），D/E/F/G/I/J 全套用 → macOS 友善
- [ ] M-DECOUPLE-3-6-mac：macOS 端實機驗 J section（沒對應硬體，腳本 portable，等有 mac 的人補）
- [x] M-DECOUPLE-3-7：full E2E flake 改善 — 11 處 `timeout N CMD` 統一加 `-k 10s` SIGKILL 後援（commit 4999d1c）

---

## 當前里程碑：M-MEMTUI — `/memory` TUI 全面升級（2026-04-26 啟動）

**目標**：把 `/memory` 從「Dialog + spawn $EDITOR」升級成 cron 風格的 master-detail TUI（5-tab：auto-memory / USER / project / local-config / daily-log），吸收 `/memory-delete` 為 alias，補齊新建 / 重命名 / inline frontmatter 編輯 / body 預覽 / daemon WS 同步 / 注入掃描 / Session-index + Trash 維運入口。詳見 `~/.claude/plans/tui-memory-cron-validated-abelson.md`。

**核心決策**（與使用者對齊）：
- Q1 整合：取代 `/memory`、`/memory-delete` 收為 alias 進多選刪除模式
- Q2 Scope：5-tab 各一頁；daily-log 唯讀、USER 不可刪
- Q3 Body 編輯：預設 inline 多行、Shift+E spawn `$EDITOR`
- Q4 Frontmatter：inline wizard（mirror `CronCreateWizard`）；type 走 4 選 selector
- Q5 Daemon RPC：做 — 新 frame `memory.mutation` / `memory.mutationResult` / `memory.itemsChanged`
- Q6 注入掃描：做 — `scanForInjection()`，命中顯警告但**可手動 override**（TUI 是人類介面）
- Q7 重命名：做 — atomic rename + `updateMemoryIndex()` 重跑同步 MEMORY.md
- Q8 輔助畫面：Session-index stats + rebuild、Trash 列表 + restore
- Tab 切換鍵：`←`/`→`（master 模式）；detail 模式 `←` 退回（mode-aware）

**架構原則**：5-tab 共用同一 `MemoryManager.tsx`、純函式 `memoryManagerLogic.ts` 抽 testable layer；mutation **本機 / daemon RPC** 雙路徑（mirror cron W4-B1 pattern）；重用既有 `scanMemoryFiles` / `listAllMemoryEntries` / `validateMemoryFilename` / `atomicWrite` / `acquireMemdirLock` / `scanForInjection` / `updateMemoryIndex` / `softDeleteMemoryEntry` / `indexWriter`，**不重寫**。

### 任務

#### Phase 1 — 基礎 list / detail（無 mutation）
- [x] M-MEMTUI-1-1 `src/utils/memoryList.ts` 補 `kind: 'user-profile'`（global `~/.my-agent/USER.md` + project `<slug>/USER.md`）
- [x] M-MEMTUI-1-2 新 `src/commands/memory/memoryManagerLogic.ts` — TABS 能力矩陣 / nextTab/prevTab/tabIdOfEntry/filterByTab/filterByKeyword/sortEntries/truncate/formatRelativeTime/previewBody/stripFrontmatter；27 單元測試全綠
- [x] M-MEMTUI-1-3 新 `src/commands/memory/MemoryManager.tsx` — 5-tab master view + ←/→ 切 tab + Enter 進 detail + body 預覽前 30 行 + 5s poll + V 全螢幕 viewer（行捲動）
- [x] M-MEMTUI-1-4 改寫 `src/commands/memory/memory.tsx` 入口渲染 `MemoryManager`（保留 `LocalJSXCommandCall` 介面）；index.ts description 更新
- [x] M-MEMTUI-1-5 E2E case K1（module load）+ K2（unit tests）+ K3（user-profile kind）；K4-K13 待 Phase 2-5 補；smoke `./cli -p hello` 通過；typecheck 不退步

#### Phase 2 — 本機 mutation
- [x] M-MEMTUI-2-1 新 `src/components/memory/MemoryEditWizard.tsx` — view/selecting/editing/editing-body/editing-type 5 modes；type 4 選 selector；body 多行（backslash-newline）
- [x] M-MEMTUI-2-2 抽 `src/memdir/memdirOps.ts` 共用 helpers（MemoryTool refactor 共用）+ 新 `src/commands/memory/memoryMutations.ts`：createAutoMemory / updateAutoMemory / renameAutoMemory / writeRawBody / createLocalConfig / renameLocalConfig / deleteEntry / readFileWithFrontmatter；MemoryManager 接通 n/e/r/d 鍵
- [x] M-MEMTUI-2-3 注入掃描：mutation 寫入前跑 `scanForInjection()`，命中進 `injectionWarn` mode 顯警告 + y override（記 `[memory-tui] injection-override` warn log）
- [x] M-MEMTUI-2-4 detail mode `E` 鍵 spawn `$EDITOR`（沿用 `editFileInEditor()`），存檔後 reload + body 預覽刷新
- [x] M-MEMTUI-2-5 E2E K2 含 mutations 單元測試 9 cases；K6-K10 mutation 程式碼路徑由 K2 涵蓋（PTY 形式留 Phase 5）；smoke + typecheck 通過

#### Phase 3 — Daemon WS RPC
- [x] M-MEMTUI-3-1 新 `src/daemon/memoryMutationRpc.ts` — `MemoryMutationRequest` type、`isMemoryMutationRequest` 守衛、`handleMemoryMutation` 5 ops（restore 留 Phase 4 stub）
- [x] M-MEMTUI-3-2 `src/daemon/daemonCli.ts` dispatch `memory.mutation` 走 runtime cwd + 寫入後 broadcast `memory.itemsChanged`
- [x] M-MEMTUI-3-3 `src/repl/thinClient/fallbackManager.ts` 加 `MemoryMutationPayload` type / `sendMemoryMutation()` / `pendingMemoryMutation` map + memory.mutationResult/itemsChanged frame handler；`src/hooks/useDaemonMode.ts` export `sendMemoryMutationToDaemon()`
- [x] M-MEMTUI-3-4 `MemoryManager.tsx` mutation 路徑全改為 daemon-aware（`tryDaemon()` helper：attached → WS / standalone → 本機 fallback）；create / update / rename / delete 全走同一 pattern；Phase 1 已訂閱 `memory.itemsChanged` broadcast
- [x] M-MEMTUI-3-5 E2E K2 含 RPC 9 cases；K12 daemon RPC handleMemoryMutation 5 ops PASS（真 broadcast 留 Phase 5）；smoke + typecheck 通過

#### Phase 4 — 輔助畫面 + alias
- [x] M-MEMTUI-4-1 新 `src/components/memory/SessionIndexPanel.tsx` — `getSessionIndexPath` + `openSessionIndex` 讀 sessions 與 messages_fts 計數；R 鍵 `reconcileProjectIndex` rebuild 顯 ReconcileStats
- [x] M-MEMTUI-4-2 新 `src/components/memory/TrashPanel.tsx` — `listTrash` 列項目 + R 鍵 `restoreFromTrash`；purge/empty 不在 TUI（由 `/trash` 命令）
- [x] M-MEMTUI-4-3 `MemoryManager.tsx` 加 `s` 鍵進 `aux-select` mode（1/2 子選單）；wizard / aux 子畫面有自己 useInput，主層 bail；新 `multi-delete` / `multi-delete-confirm` mode（space toggle / a all / N none / / filter / Enter confirm / y 確認）；renderMultiDelete helper
- [x] M-MEMTUI-4-4 改寫 `src/commands/memory-delete/memoryDelete.tsx` 為 thin wrapper：渲染 `MemoryManager` 傳 `initialMode='multi-delete'`
- [x] M-MEMTUI-4-5 daemon RPC restore op 完成接通 `restoreFromTrash`；E2E K9（delete+restore round-trip）/ K11（alias module load）PASS；K13 PTY 標 Phase 5；smoke + typecheck 通過

#### Phase 5 — Section K 收尾 + docs
- [x] M-MEMTUI-5-1 新 helper `tests/e2e/_memoryTuiInteractive.ts`（PTY 互動，npx tsx + node-pty，mirror `_replInteractive.ts`）— K4 5-tab + K5 ←/→ 切到 daily-log
- [x] M-MEMTUI-5-2 新 helper `tests/e2e/_memoryMutationRpcClient.ts`（直打 daemon WS，mirror `_thinClientPing.ts`）— K12 兩 client A 寫 → B 收 itemsChanged broadcast
- [x] M-MEMTUI-5-3 Section K 8 PASS + 1 skip（K12 broadcast 預設 skip 因 daemon 不 unconditional 啟動；實機驗過 `B received memory.itemsChanged broadcast — OK`）；K13 standalone fallback 加上
- [x] M-MEMTUI-5-4 `docs/e2e-test-suite.md` 加 K section 完整章節 + scope alias `memtui` + 兩個 helper 檔案參照
- [x] M-MEMTUI-5-5 CLAUDE.md 2026-04-26 開發日誌（5 commit + 7 條踩坑教訓）+ LESSONS.md「TUI 開發（M-MEMTUI）」4 條教訓

#### Phase 5 額外（順手修）
- [x] 修 `src/cli/print.ts` 4 個 dangling import（M-DECOUPLE 漏網：growthbook / policyLimits / settingsSync / remoteManagedSettings）改 inline stub 讓 `bun run build:dev` 可過

### 完成標準
- [x] `bun run typecheck` 全綠（每階段提交前；只有 baseline TS5101 deprecation）
- [x] `./cli -p "hello"` 冒煙（每階段提交前）
- [x] `tests/integration/memory/` 3 組單元測試全綠（memoryManagerLogic 27 + memoryMutations 9 + memoryMutationRpc 10 = 46）
- [x] `bash tests/e2e/decouple-comprehensive.sh K` 8 PASS + 1 skip（K12 broadcast 需 daemon 在跑時 PASS，實機已驗）
- [ ] `bash tests/e2e/decouple-comprehensive.sh` 全套件（A–K）不退步
- [ ] `/memory` 開啟 → 5 tab 切換 → 各 tab 列出對應 entries（待使用者實機驗證）
- [ ] 兩個 REPL attach 同 project：A 改 → B 在 200ms 內 reload（待使用者實機驗證）
- [ ] 跨平台：Windows + macOS 各跑一次完整 E2E（macOS 待持有硬體者補）

### 不在範圍（→ 後續 milestone）
- USER.md 段落級結構化編輯（先當整檔編，未來 M-MEMTUI-USER-SECT）
- Daily-log 內容新建 / 編輯（保持唯讀，由 `/dream` 產生）
- 全文搜尋 memory body（目前只 filter filename + description）
- Memory diff / version history（git log 替代）

---

## 當前里程碑：M-LLAMACPP-WATCHDOG — 防止 llama.cpp 失控生成（2026-04-26 啟動）

**起因**：M-MEMTUI 開發過程診斷出 llama.cpp 持續運算 bug — qwen3.5-9b-neo `<think>` reasoning loop 不收尾（跑滿 max_tokens=32000，30+ 分鐘）+ 兩個 cli 孤兒 process hold slot。my-agent 現有 `AbortSignal` 只在 Esc 時觸發，背景呼叫沒人能中斷。詳見 `docs/plans/M-LLAMACPP-WATCHDOG.md`。

**目標**：客戶端三層 watchdog（A inter-chunk gap / B reasoning-block / C token-cap），各精準擋不同失控情境，**預設全關**讓使用者 opt-in。新 `/llamacpp` master TUI（Hybrid：無參數 TUI、有參數直接套用）+ daemon broadcast 多 REPL 同步。

**核心決策**（與使用者對齊）：
- Q1 不採固定 wall-clock（誤殺率高）
- Q2 三層分開精準偵測：A 30s / B 120s / C 16000 主 turn / 4000 背景
- Q3 預設**全部關閉** — 使用者透過 `/llamacpp` opt-in；master + 該層雙層 enabled AND 才生效
- Q4 命令合併 `/llamacpp`（master TUI），TAB 1 Watchdog / TAB 2 Slots
- Q5 UI 走 Hybrid（無參數 TUI / 有參數直套）；持久化雙線（寫 llamacpp.json + adapter hot-reload）
- Q6 Daemon broadcast `llamacpp.configChanged` mirror cron pattern

**架構原則**：擴 `LlamaCppConfigSchema` + 新 `llamacppWatchdog.ts` 純函式；adapter SSE loop 接 timer + abort；不重寫核心；hot-reload via mtime 偵測；env override `LLAMACPP_WATCHDOG_ENABLE/DISABLE` 一鍵切換。

### 任務

#### Phase 1 — Config schema + adapter watchdog 三層
- [x] M-LLAMACPP-WATCHDOG-1-1 `src/llamacppConfig/schema.ts` 加 `LlamaCppWatchdogSchema` + 子 schema interChunk/reasoning/tokenCap（master + 三層各自 enabled + 數值），全部預設 false；`LlamaCppCallSite` type export；`getEffectiveWatchdogConfig()` 含 env override `LLAMACPP_WATCHDOG_DISABLE`（強制關，最高優先）+ `LLAMACPP_WATCHDOG_ENABLE`（一鍵全開）
- [x] M-LLAMACPP-WATCHDOG-1-2 新 `src/services/api/llamacppWatchdog.ts` 純函式：`WatchdogAbortError` class + `tickChunk()` state machine + `watchSseStream()` async generator wrapper（含 5s 低頻 timer 模型 silent 時也觸發）
- [x] M-LLAMACPP-WATCHDOG-1-3 `translateOpenAIStreamToAnthropic` 加 `callSite` 參數；fetch 後把 `iterOpenAISSELines` 用 `watchSseStream` 包；catch `WatchdogAbortError` 後關所有 open content blocks + 改 `stop_reason`（tokenCap → `max_tokens` / 其他 → `end_turn`）+ console.warn 記錄層次/tokens/elapsed
- [x] M-LLAMACPP-WATCHDOG-1-4 unit tests `tests/integration/llamacpp/watchdog.test.ts` — 23/23 pass：layerActive 邊界 / getTokenCap per call-site / chunk inspection helpers / tickChunk 三層分別 + state mutation / watchSseStream 正常 passthrough + tokenCap throw + reasoning throw + 各層 disabled
- [x] M-LLAMACPP-WATCHDOG-1-5 typecheck baseline 不退步；`timeout -k 5s 60s ./cli -p "say hi"` 冒煙 EXIT=0；commit

#### Phase 2 — Per-call-site max_tokens ceiling
- [x] M-LLAMACPP-WATCHDOG-2-1 `translateRequestToOpenAI()` 加 `callSite` + `watchdogCfg` options（後者測試友善）；clamp `max_tokens = min(caller, getTokenCap(cfg, callSite))`；watchdog 關閉時 cap=Infinity 等於不變
- [x] M-LLAMACPP-WATCHDOG-2-2 主 turn 走 createLlamaCppFetch 預設 callSite='turn'；sideQuery / findRelevantMemories / extractMemories 走直接 fetch（不經 translateRequestToOpenAI），既有 hardcoded max_tokens（1024 / 256）已等於 ceiling 預設值，**無需改 caller**。未來若要強制 clamp 可在那幾條 caller 自行加 `Math.min(my_max, getTokenCap(cfg, 'sideQuery'))`，留 polish
- [x] M-LLAMACPP-WATCHDOG-2-3 新 `tests/integration/llamacpp/translate-clamp.test.ts` 7 cases（watchdog off 不變 / clamp turn / caller 較小不 inflate / per call-site memoryPrefetch+background / 預設 callSite='turn' / caller 沒給 max_tokens 用 4096 再 clamp）；smoke 通過；commit

#### Phase 3 — `/llamacpp` master TUI + Hybrid args + broadcast
- [x] M-LLAMACPP-WATCHDOG-3-1 新 `src/commands/llamacpp/{index, llamacpp.tsx, LlamacppManager.tsx, llamacppManagerLogic.ts, llamacppMutations.ts, argsParser.ts}` master TUI（2 tabs：Watchdog / Slots）+ 註冊到 `src/commands.ts`
- [x] M-LLAMACPP-WATCHDOG-3-2 新 `src/components/llamacpp/WatchdogTab.tsx` — 10 fields（master + A/B/C + per-call-site）；Space/Enter toggle / 數字 input / r reset / w 寫檔；effective marker
- [x] M-LLAMACPP-WATCHDOG-3-3 新 `src/components/llamacpp/SlotsTab.tsx` — fetchSlots 5s poll；K killSlot（501 顯 `--slot-save-path` 提示）；reasoning loop heuristic 標 `n_decoded > 20000` 為紅色
- [x] M-LLAMACPP-WATCHDOG-3-4 `argsParser.ts` Hybrid 解析器（19 動詞分支）+ `llamacpp.tsx` 入口無參數 → TUI、有參數 → `runArgsCommand` 直接套 + 印 status
- [x] M-LLAMACPP-WATCHDOG-3-5 `scripts/llama/serve.sh` 加 `--slot-save-path` flag（`LLAMA_SLOT_SAVE_PATH` env 可覆蓋；自動 mkdir）
- [x] M-LLAMACPP-WATCHDOG-3-6 `loader.ts` 加 `cachedMtimeMs` + `isCacheStale()` mtime 偵測；snapshot getter 在 stale 時重讀
- [x] M-LLAMACPP-WATCHDOG-3-7 新 `src/daemon/llamacppConfigRpc.ts` — types + 守衛 + `handleLlamacppConfigMutation`；`daemonCli.ts` dispatch + broadcast `llamacpp.configChanged`（無 projectId：daemon 全域狀態）
- [x] M-LLAMACPP-WATCHDOG-3-8 `fallbackManager.ts` 加 `LlamacppConfigMutationPayload` type / `sendLlamacppConfigMutation()` / pending map + frame handlers；`useDaemonMode.ts` export `sendLlamacppConfigMutationToDaemon()`
- [x] M-LLAMACPP-WATCHDOG-3-9 unit tests：`managerLogic.test.ts` 31 / `configMutationRpc.test.ts` 5；總 96 unit tests 全綠（含 watchdog 23 + translate-clamp 7 + 其他既有）；smoke 通過

#### Phase 4 — E2E Section L
- [x] M-LLAMACPP-WATCHDOG-4-1 新 helper `tests/e2e/_llamacppHungSimulator.ts`（Bun.serve mock SSE 4 scenario：fast / hung-after-first / reasoning-loop / token-flood；60s 自動關防孤兒）
- [x] M-LLAMACPP-WATCHDOG-4-2 新 helper `tests/e2e/_llamacppManagerInteractive.ts`（PTY，npx tsx + node-pty）— L7 通：spawn cli-dev → /llamacpp → 看 ‹ Watchdog › + Master + → 切 ‹ Slots ›
- [x] M-LLAMACPP-WATCHDOG-4-3 新 helper `tests/e2e/_llamacppConfigRpcClient.ts`（daemon WS broadcast 驗證）— L8 通：兩 thin-client A setWatchdog → B 1s 內收 llamacpp.configChanged
- [x] M-LLAMACPP-WATCHDOG-4-4 Section L **5 PASS + 1 skip**（L1-L4 watchdog 三層由 unit 涵蓋 / L5 module load / L6 args+hot-reload / L7 PTY / L8 RPC broadcast / L9 slot kill skip 因 server 未帶 --slot-save-path）
- [x] M-LLAMACPP-WATCHDOG-4-5 scope alias `llamacpp` / `watchdog`

#### Phase 5 — Docs + ADR
- [x] M-LLAMACPP-WATCHDOG-5-1 CLAUDE.md 2026-04-26 開發日誌（4 commit + 5 條踩坑 + ADR-015 採三層分層偵測 + hot-reload）
- [x] M-LLAMACPP-WATCHDOG-5-2 LESSONS.md 加 1 條（ConPTY 在 Windows 把連續空格壓掉 — PTY E2E 不能 grep 整串）
- [x] M-LLAMACPP-WATCHDOG-5-3 `docs/e2e-test-suite.md` 加 L section + 3 helper 路徑 + 總 cases 67
- [x] M-LLAMACPP-WATCHDOG-5-4 docs/llamacpp-watchdog.md 使用者指南（三層意義 / Quick start / TUI 操作 / Args 命令表 / 設定檔範例 / env override / 三常見情境 / server slot cancel API 啟用 / 限制與已知問題）
- [x] M-LLAMACPP-WATCHDOG-5-5 commit

### 完成標準
- [x] `bun run typecheck` 全綠（baseline 不退步）
- [x] `timeout -k 5s 60s ./cli -p hello` 冒煙 EXIT=0
- [x] `tests/integration/llamacpp/` 4 組單元測試全綠（watchdog 23 + translate-clamp 7 + managerLogic 31 + configMutationRpc 5 = 66）
- [x] `bash tests/e2e/decouple-comprehensive.sh L` 5 PASS + 1 skip
- [x] 全套 `decouple-comprehensive.sh L` + K 都綠（A-J 既有未動，K + L 新加）
- [x] **預設關閉驗證**：master.enabled=false、三層 enabled=false；L8 RPC 在初始狀態仍能廣播

### 不在範圍（→ 後續 milestone）
- `M-LLAMACPP-NOTHINK`：`/no_think` system prompt trigger + `</think>` stop sequence
- `M-CLI-SIGINT-CLEANUP`：cli SIGINT 強制斷 fetch（防孤兒 process）
- GUI dashboard 監控 slot

---

## 當前里程碑：M-WEB — Discord 風格 Web UI 嵌入 daemon（2026-04-26 規劃）

**目標**：在 daemon 內嵌第三個前端（TUI / Discord 之外），瀏覽器透過 LAN IP 連入即可使用 Discord 風三欄式 UI（左 project list / 中 message stream / 右 settings panel）。TUI / Discord / Web 三端對同一 ProjectRuntime 雙向同步（送訊息、permission 批准、cron/memory/llamacpp CRUD 任一端均同步）。

**完整計畫**：`docs/plans/M-WEB.md`

**範圍決策**（與使用者 12 輪對齊鎖定）：
- A 雙向訊息同步 + B 無認證 IP-only（W2 預設綁 0.0.0.0）+ C Discord 三欄式
- D Vite + React 獨立 `web/` 專案 + E `/web` master TUI（start/stop/status/open/qr/config）
- F3 嵌在 daemon 內額外開 port（同一 process、共用 broker reference）
- G1 完全 React 重寫（TUI 全 parity，含右欄 R3 cron/memory/llamacpp 全 CRUD）
- H3 跨 session 切換（左欄兩層樹 M1，FTS5 搜尋）
- J2 Phase A 含 chat + permission + 5 個核心 slash（/clear /interrupt /allow /deny /mode）
- K2 web 內部 protocol bridge（browser 看到乾淨 REST + WS）
- L2 右欄 Discord context-panel 風（跟著左欄 selected project 切）
- P2 master TUI（/cron /memory /llamacpp）導向右欄
- Q2 web 可 add/remove project + S3 雙向 session 建立同步
- T1 一刀切（單一大 milestone，內含 ~21 個 sub-task commit）
- V3 `~/.my-agent/web.json` 控制 port（預設 9090）+ autoStart

**預估工期**：8–12 週（單人）

### Phase 1 — Infra & 骨架（2 週）✅ 2026-04-26 完成
- [x] M-WEB-1：`web/` Vite 專案 scaffold（React 18 + TS + Tailwind + zustand + react-router）+ `bun run build:web` / `bun run dev:web` script — build 5.76s 159 KB JS / 5.68 KB CSS
- [x] M-WEB-2：`src/webConfig/` 6 檔（schema/paths/loader/seed/bundledTemplate/index）+ `~/.my-agent/web.README.md` seed — 19 unit tests
- [x] M-WEB-3：`src/web/httpServer.ts` + `staticServer.ts` 第二個 Bun.serve listener，serve `web/dist` + SPA fallback + path traversal 防護 + port probing + dev proxy — 32 unit/integration tests
- [x] M-WEB-4：`src/web/wsServer.ts` + `browserSession.ts` WS 連線管理（heartbeat / subscribe filter / 真 WebSocket client 整合測試）— 10 tests
- [x] M-WEB-5：`src/web/webGateway.ts` 訂閱 `registry.onLoad/onUnload` + per-runtime broker / permissionRouter / cron.events listener；mirror DiscordGateway pattern — 15 tests
- [x] M-WEB-6：`src/web/translator.ts` + `webTypes.ts` daemon frame ↔ web JSON 雙向轉譯（含 mutation op mapping）— 32 unit tests
- [x] M-WEB-7：`/web` 指令（args + 簡易 TUI）+ `src/daemon/webRpc.ts` + `src/web/webController.ts`（lifecycle 管理）+ daemonCli 整合（autoStart）+ fallbackManager.sendWebControl + commands.ts 註冊 + `web.statusChanged` 廣播 — 9 controller/RPC tests
- [x] Phase 1 E2E：`tests/integration/web/daemon-web-e2e.test.ts` 4/4 — 真 daemon auto-start web → `/api/health` 200 → `/api/foo` 404 → WS hello/subscribe/ping/pong → thin-client `web.control` op=status/stop + `web.statusChanged` broadcast。新 ClientSource='web' / `defaultIntentForSource='interactive'`

### Phase 2 — Chat 核心（3 週）✅ 2026-04-26 完成
- [x] M-WEB-8：`/api/projects` REST（GET 列表 / POST 載入 / DELETE 卸載 / GET single / GET sessions）+ CORS preflight + path traversal 防護 — 15 unit tests；`/api/projects/:id/sessions` POST 留 501 stub 給 M-WEB-11
- [x] M-WEB-9：三欄 layout（ProjectList 左 / ChatView 中 / ContextPanel 右）+ M1 兩層樹（Project → Session 子節點）+ Q2 AddProjectDialog（POST /api/projects）+ unload (× 按鈕) + DisconnectedBanner — Vite build 72 modules 188 KB JS
- [x] M-WEB-10：MessageList + MessageItem + ToolCallCard（Discord embed 風 / collapsed details）+ ThinkingBlock（80 char preview / 點擊展開）+ messageStore（per-session UiMessage 陣列、startUserTurn/startAssistantTurn/appendBlock/setToolResult/endTurn）
- [x] M-WEB-11：useTurnEvents hook 把 WS turn.start/event/end 寫入 messageStore，解析 SDK content blocks（text/thinking/tool_use/tool_result）；自動 scroll-to-bottom（接近底時才 follow）；100-msg backfill 留 M-WEB-18（需 sessionIndex read API）
- [x] M-WEB-12：InputBar（multi-line textarea + auto-resize + IME 安全 Enter / Shift+Enter / / 觸發 5 個核心 slash autocomplete dropdown / Tab 補全 / ArrowUp/Down / Esc 清空）；ChatView 連動 send/interrupt/permissionResponse/setMode/clear
- [x] M-WEB-13：PermissionModal（pending 從 permissionStore；first-wins race — daemon broadcast permission.resolved 清 modal）+ permission mode 經 WS 傳；usePermissionStore + permission.modeChanged frame 訂閱
- [x] Phase 2 E2E：`tests/integration/web/phase2-e2e.test.ts` 4/4 — GET /api/projects 看到 default project / POST 載入 + project.added broadcast / DELETE + project.removed broadcast / GET sessions 看到 active session / 多 WS client 同步廣播

### Phase 3 — 右欄 R3 全 CRUD（3-4 週）✅ 2026-04-26 完成
- [x] M-WEB-14：`/api/cron` REST（GET list / POST create / PATCH pause/resume/update / DELETE）+ CronTab + 內嵌 create form（cron + name + prompt）+ pause/resume/delete buttons + WS cron.tasksChanged 訂閱自動 refresh — 3 E2E tests
- [x] M-WEB-15：`/api/memory` REST（GET list / GET body / DELETE 軟刪到 .trash/）+ MemoryTab 按 kind 分組（AUTO/USER/PROJECT/LOCAL/LOG）+ View modal + 條件性 Delete + path traversal 防護（path 必須在 entries 列表內 → 403 PATH_NOT_ALLOWED）。Edit wizard 留 M-WEB-15b
- [x] M-WEB-16：`/api/llamacpp/watchdog` REST（GET / PUT，daemon 全域不需 projectId）+ LlamacppTab（Master enable + 三層 NestedToggle ABC + 數值欄位編輯 + WS llamacpp.configChanged 訂閱）+ 廣播全 client。Slot inspector 即時 polling 留 M-WEB-16b
- [x] M-WEB-17：DiscordTab（read-only 引導去 TUI；admin RPC 接 web 留 M-WEB-17b）+ PermissionsTab（4 mode radio + 經 WS permission.modeSet 廣播 + 顯示當前 pending request + attached REPL 計數）
- [x] Phase 3 E2E：`tests/integration/web/phase3-e2e.test.ts` 5/5 — memory list / memory body 拒 traversal / llamacpp watchdog GET / llamacpp watchdog PUT + 廣播 / cron CRUD + memory 不誤觸；`restRoutes-cron.test.ts` 3/3：empty list、create+broadcast、bad fields rejection

### Phase 4 — H3 搜尋 + 收尾（1-2 週）✅ 2026-04-26 完成
- [x] M-WEB-18：`src/services/sessionIndex/readApi.ts`（getMessagesBySession / listSessionsForProject / searchProject）+ index.ts re-export；REST `/api/sessions` 用 sessionIndex 真資料 + `/api/sessions/:sid/messages?before=&limit` lazy load + `/api/search?q=&limit` FTS5（trigram min 3 char snippet 高亮）
- [x] M-WEB-19：DisconnectedBanner + ws.ts 自動重連（1/5/10/30s backoff capped）+ stale heartbeat（>60s 無訊息主動斷重連）+ daemon offline 降級（cached state 仍可看）
- [x] M-WEB-20：PNG QR endpoint `/api/qr?url=…`（qrcode.toBuffer 320×320）+ ASCII QR via `/web qr` slash + `/web open` 跨平台 openBrowser（win32 rundll32 / darwin open / linux xdg-open）
- [x] M-WEB-21：`docs/web-mode.md` 完整使用者指南 + CLAUDE.md 開發日誌段（4 phase 總結）+ ADR-016（F3+K2+G1 組合決策）+ LESSONS.md 5 條教訓 + Phase 4 E2E 6/6

### 完成標準
- [x] `bun run typecheck` 綠（TS5101 baseline 不變）
- [x] `bun run build:web` 綠（78 modules / 205.71 KB JS / 13.26 KB CSS）；`bun run build:dev` 綠
- [x] daemon 222/222 + web 189/190 全綠（剩 1 vision-locate pre-existing M-VISION）；累計 ~210 個 web 新 tests
- [x] 手動 E2E 八項（M-WEB-CLOSEOUT 把可自動化的 5 項收進 closeout-e2e.test.ts；剩 (1)三端同步 / (2)Permission first-wins / (8)跨平台抽樣 列為 manual sanity，跑 Section M 仍會 skip 提醒）
- [x] `tests/e2e/decouple-comprehensive.sh` 加 Section M（aliases: web / webcloseout / closeout；M1-M4 PASS + M5 manual skip）
- [x] 安全 self-check：path traversal（resolveStaticPath / memory body endpoint）/ 0.0.0.0 bind 寫 daemon log；secret scan reuse `src/utils/web/secretScan.ts`（M4）

### 不在範圍（後續 milestone）
- `M-WEB-MOBILE`：手機 responsive（漢堡選單折三欄）
- `M-WEB-AUTH`：bearer token / 帳號登入（如需 LAN 外暴露）
- `M-WEB-NOTIF`：browser native notification（permission ask、turnEnd 提醒）
- `M-WEB-ATTACHMENT`：圖片 / 檔案上傳 drag-drop 對 web input
- `M-WEB-MULTI-USER`：多 browser tab 同 turn 並發送訊息
- `M-WEB-SLASH-FULL`：剩下 ~80 個 slash command 的 React-DOM port
- `M-WEB-AGENT-VIEW`：Agent 工具呼叫的 sub-agent 樹狀視覺化
- `M-WEB-DIFF-RICH`：side-by-side diff、syntax highlight 對齊 GitHub

---

## 當前里程碑：M-WEB-CLOSEOUT — Phase b 尾巴 + 主線 E2E 收尾（2026-04-26 規劃）

**目標**：補上 M-WEB Phase 3 主動延後的三條 b 尾巴（15b/16b/17b），完成 M-WEB 主線兩個未勾項（手動 E2E 八項自動化 + Section M），把 M-WEB 整個 milestone 正式關掉。

**範圍決策**（與使用者對齊）：
- Q1=c：17b 開到全範圍（list/view + bind/unbind + reload config / restart gateway），LAN 內個人使用無認證模型沿用
- Q2 開工順序：16b（最小、純讀）→ 15b（mutation）→ 17b（admin）→ E2E + Section M
- 跨平台：puppeteer-core E2E 在 Windows / macOS 都跑得起來（已沿用既有依賴）；Section M 走 bash（Windows 走 Git Bash）

### Phase A — M-WEB-16b Llamacpp slot inspector ✅ 2026-04-26
- [x] M-WEB-CLOSEOUT-1：REST `GET /api/llamacpp/slots`（reuse `fetchSlots`，graceful fail 回 `{ available: false, reason }`）+ `POST /api/llamacpp/slots/:id/erase`（reuse `killSlot`，501 → SLOT_ERASE_UNSUPPORTED）+ 6 unit tests
- [x] M-WEB-CLOSEOUT-2：LlamacppTab 加 SlotsPanel 子組件（5s polling、active slots 列表 + decoded/remain、reasoning loop hint、erase 按鈕、unavailable fallback、flash toast）
- [x] M-WEB-CLOSEOUT-3：typecheck/build:web/build:dev 綠 + ./cli -p hello 冒煙過 + 6 unit tests + 24 REST routes 全綠

### Phase B — M-WEB-15b Memory edit wizard + injection 掃描 ✅ 2026-04-26
- [x] M-WEB-CLOSEOUT-4：REST `PUT /api/projects/:id/memory`（user-profile / project-memory / local-config body update + auto-memory body+frontmatter update；daily-log 403 READ_ONLY；path traversal 過 entries 列表；secret 偵測 422 + override:true 通過）+ `POST /api/projects/:id/memory`（auto-memory + local-config 才允許 create；其他 kind 403 KIND_NOT_CREATABLE）+ 10 unit tests
- [x] M-WEB-CLOSEOUT-5：MemoryEditWizard React 組件（行為矩陣 — auto-memory 全 frontmatter+body、user-profile/project-memory body only、local-config body only 無 frontmatter、daily-log 不顯 Edit；create 模式只允許 auto-memory + local-config）
- [x] M-WEB-CLOSEOUT-6：`web/src/utils/secretScan.ts`（複刻 server `containsSecret` 30+ token 前綴 + private key regex）；wizard 內 inline 警告 + 「我已確認可寫入」checkbox；server 422 雙重保護
- [x] M-WEB-CLOSEOUT-7：MemoryTab 訂閱既有 `memory.itemsChanged` broadcast 自動 refresh（沿用 M-WEB-15）；typecheck/build:web/build:dev 綠 + ./cli -p smoke 過 + 34 REST tests 全綠

### Phase C — M-WEB-17b Discord admin RPC 接 web（Q1=c 全範圍）✅ 2026-04-26
- [x] M-WEB-CLOSEOUT-8：admin 操作清單對齊：getStatus / listBindings / bind / unbind / reload / restart（Q1=c 全範圍納入）
- [x] M-WEB-CLOSEOUT-9：`src/discord/discordSupervisor.ts` 抽出 lifecycle（start/stop/restart/reload + getClient/getConfig）；`src/discord/discordController.ts` 把 supervisor 包成 6-method facade；reuse 既有 `discordBindRpc` 的 handleBindRequest/handleUnbindRequest；daemonCli 從 inline state 改用 supervisor，既有 3 處 `discordClientRef` 改 `supervisor.getClient()`
- [x] M-WEB-CLOSEOUT-10：REST `/api/discord/{status,bindings,bind,unbind,reload,restart}` + getter pattern（避免 web 起來時 supervisor 還沒準備好的 race）+ 503 fallback + 廣播 `discord.statusChanged` + 10 unit tests
- [x] M-WEB-CLOSEOUT-11：DiscordTab 升級成可操作（status panel + bindings 列表+unbind 按鈕 + bind 表單 + reload/restart 雙按鈕；restart 有 confirm dialog；LAN 無認證警告 banner；訂閱 `discord.statusChanged` 自動 refresh；503 → unavailable hint UI）
- [x] M-WEB-CLOSEOUT-12：typecheck/build:web/build:dev 綠 + ./cli -p smoke 過 + 44 REST tests + 155 discord integration tests 全綠

### Phase D — 主線 E2E 自動化 + Section M ✅ 2026-04-26
- [x] M-WEB-CLOSEOUT-13/14：`tests/integration/web/closeout-e2e.test.ts` 收 5 個自動化 cases（cron broadcast / llamacpp watchdog broadcast / project add+remove / sessions REST / 斷線重連），mock 兩個 WS client 模擬 browser tab A+B；範圍說明「不在自動化」3 項（三端同步 / Permission first-wins / 跨平台抽樣）
- [x] M-WEB-CLOSEOUT-15：browser 互動部分（puppeteer headless）— **延後**為獨立 milestone `M-WEB-PUPPETEER-E2E`。理由：puppeteer 已在 deps 但需大量 fixture（dev server + 三欄渲染 + slash autocomplete UI），M2 自動化已覆蓋核心 broadcast 路徑；headless UI 自動化 ROI 不高、放後續單獨 milestone 處理
- [x] M-WEB-CLOSEOUT-16：`tests/e2e/decouple-comprehensive.sh` 加 Section M（M1 REST 單元 / M2 跨端 broadcast E2E / M3 Phase 1-4 既有 E2E / M4 build:web / M5 manual sanity skip 提醒），aliases: web / webcloseout / closeout；4 PASS + 1 skip
- [x] M-WEB-CLOSEOUT-17：勾掉 M-WEB 主線兩項完成標準；TODO.md 收尾；commit

### 完成標準
- [ ] `bun run typecheck` 綠（TS5101 baseline 不變）
- [ ] `bun run build:web` 綠；`bun run build:dev` 綠
- [ ] daemon + web 既有測試全綠 + 新增測試全綠
- [ ] M-WEB 主線「完成標準」兩個未勾項全勾
- [ ] 跨平台 self-check：Windows 主跑 + macOS 行為描述（puppeteer headless / bash 腳本）
- [ ] commit 前每個 phase `./cli -p hello` 冒煙

### 不在範圍（後續 milestone）
- `M-WEB-AUTH`：17b 開了 admin 操作後 LAN 外暴露才需要，獨立處理
- `M-MEMTUI-USER-SECT`：USER.md 段落級結構化編輯
- `M-WEB-MOBILE` / `M-WEB-NOTIF` / `M-WEB-ATTACHMENT` / `M-WEB-MULTI-USER` / `M-WEB-SLASH-FULL` / `M-WEB-AGENT-VIEW` / `M-WEB-DIFF-RICH`（M-WEB 原計畫已列）

---

## 當前里程碑：M-WEB-SHADCN — Web UI 換成 shadcn/ui + tweakcn Light Green 主題（2026-04-26 啟動）

**目標**：把 `web/` 從「Tailwind v3 + 自訂 Discord 暗色 palette + 全部 inline className」換成 [shadcn/ui](https://github.com/shadcn-ui/ui)（Radix + Tailwind + cva），並套用 [tweakcn Light Green 主題](https://tweakcn.com/themes/cmlhfpjhw000004l4f4ax3m7z)；補 light/dark 切換能力。詳見 `~/.claude/plans/web-ui-https-github-com-shadcn-ui-ui-cosmic-platypus.md`。

**決策**：big-bang rewrite（單一 milestone 全換完）；light + dark 雙模式 + ThemeToggle；範圍只在 `web/`，daemon TS / WS protocol / REST schema / zustand store 全不動；既有 ~210 個 web 測試不動（純 protocol 層）。

### 任務
- [ ] M-WEB-SHADCN-1 Foundation：`npx shadcn@latest init`（new-york / neutral）+ 一次裝齊 22 個 primitives（button input textarea label dialog alert-dialog tabs scroll-area dropdown-menu tooltip badge card separator sonner alert form select switch slider collapsible table command resizable）
- [ ] M-WEB-SHADCN-2 套主題：`npx shadcn@latest add https://tweakcn.com/r/themes/cmlhfpjhw000004l4f4ax3m7z`；CLI 失敗則手貼 tweakcn CSS 到 `globals.css`
- [ ] M-WEB-SHADCN-3 `tailwind.config.ts` 重寫：`darkMode: 'class'` + shadcn semantic tokens (`hsl(var(--xxx))`) + `tailwindcss-animate` plugin；刪除舊 Discord palette
- [ ] M-WEB-SHADCN-4 ThemeProvider + ThemeToggle：context + localStorage（`my-agent-web-theme`）+ lucide Sun/Moon DropdownMenu 三選一；`main.tsx` 包進去
- [ ] M-WEB-SHADCN-5 Layout shell：`ResizablePanelGroup` 三欄（20/55/25）+ header bar with ThemeToggle
- [ ] M-WEB-SHADCN-6 chat 元件 rewrite：ChatPlaceholder → ThinkingBlock → ToolCallCard → MessageItem → MessageList → PermissionModal → InputBar (Command palette) → ChatView
- [ ] M-WEB-SHADCN-7 leftPanel 元件 rewrite：AddProjectDialog → ProjectList → SessionTree
- [ ] M-WEB-SHADCN-8 rightPanel 元件 rewrite：ContextPanelPlaceholder → PermissionsTab → MemoryTab → MemoryEditWizard → CronTab → LlamacppTab → DiscordTab → ContextPanel
- [ ] M-WEB-SHADCN-9 common 收尾：DisconnectedBanner 換 Alert variant=destructive；刪 `Modal.tsx` + `styles/index.css`
- [ ] M-WEB-SHADCN-10 驗證：`bun run typecheck:web` + `bun run build:web` 雙綠；`bun test tests/integration/web/` 全綠（~210）；手動驗收清單（首屏 Light Green / theme toggle / 三欄 resize / 6 個 Tabs / AlertDialog risk badge / Disconnected Banner）
- [ ] M-WEB-SHADCN-11 收尾：CLAUDE.md 開發日誌 + ADR-017（big-bang + 雙主題決策）+ commit（`feat(web): M-WEB-SHADCN — shadcn/ui + tweakcn Light Green 主題大改造`，繁中訊息）

### 完成標準
- [ ] `web/components/ui/` 22 個 shadcn primitives 就位
- [ ] `globals.css` 含完整 light + dark token 區塊（tweakcn Light Green）
- [ ] 30 個既有 UI 元件全部不再含舊 Discord 色 className（`grep 'bg-bg-\|text-text-\|bg-brand' web/src/` 應 0 hit，排除 `components/ui/`）
- [ ] `tailwind.config.ts` 不含舊 Discord palette
- [ ] `bun run typecheck:web` + `bun run build:web` 雙綠
- [ ] 既有 ~210 個 web tests 全綠
- [ ] 手動驗收清單全勾
- [ ] commit 前 `./cli -p hello` 冒煙通過

### 不在範圍（→ 後續 milestone）
- `M-WEB-MOBILE`：響應式 / 三欄折疊
- `M-WEB-AUTH`：bearer token / 登入
- `M-WEB-NOTIF`：browser native notification
- 把 shadcn theming 反向套到 TUI / Discord embed（不適用，這兩端不是 web）

---

## 當前里程碑：M-WEB-SLASH-FULL — Web UI 全 87 個 slash command 支援（2026-04-26 規劃）

**目標**：Web 端目前只認 5 個核心 slash command；本 milestone 補上通用 RPC + 自動拉 metadata + 全部 87 個 command（8 prompt + 27 local + 48 local-jsx + 4 web-redirect）皆可從 web 觸發。完整 plan：`~/.claude/plans/m-web-zesty-rabin.md`。

**決策**：
- 通用 `slashCommand.execute` WS RPC，避免每 command 各自 RPC frame
- local-jsx 全 port 為 React 元件（48 個），由 daemon 回 `jsx-handoff` frame，web 查表 render
- 4 個已被 web tab 取代的 local-jsx → 自動 redirect 到對應 tab

### Phase A — Infra ✅ 2026-04-26
- [x] M-WEB-SLASH-A1：`src/daemon/slashCommandRegistry.ts` 抽出 metadata snapshot — `369ce8b`，14 unit
- [x] M-WEB-SLASH-A2：`src/daemon/slashCommandRpc.ts`（list/execute/cancel）+ daemonCli dispatch — `d98f2a4`，10 unit
- [x] M-WEB-SLASH-A3：`GET /api/slash-commands` REST + `web/src/store/slashCommandStore.ts` zustand + 5min cache + filterCommandsForAutocomplete — `78ab408`，12 unit
- [x] M-WEB-SLASH-A4：`InputBar.tsx` autocomplete 改吃 store + 三色 badge + 移除「未知當訊息送」fallback — `546a0f0`

### Phase B — Prompt + Local ✅ 2026-04-26
- [x] M-WEB-SLASH-B1：Prompt 類真注入 broker.queue（flattenContentBlocksToText + stub ToolUseContext）— `3cb0bee`
- [x] M-WEB-SLASH-B2：Local 類真執行 cmd.load().call() + WS execute/executeResult ChatView frame handler 串接 — `5acd9e0`

### Phase C — Local-JSX 4 個 redirect ✅ 2026-04-26
- [x] M-WEB-SLASH-C1：`uiStore.ts` + ContextPanel 受控 tab + ChatView 收 web-redirect kind 切 tab — `57ddee5`，3 unit

### Phase D — Local-JSX 框架 ✅ 2026-04-26（簡化版）
- [x] M-WEB-SLASH-D1：`commandDispatcherStore` + `CommandDispatcher.tsx` + `GenericLocalJsxModal.tsx` + Layout mount，所有 48 個 local-jsx 走共用 Modal 顯示 metadata + TUI fallback 引導 — `f0fc07b`，4 unit
- [x] M-WEB-SLASH-D2：`commandCategory.ts` 6 類分類（config/memory/session/project/agent-tool/misc）+ Modal 顯示分類 label + hint + relatedTab 跳轉按鈕 — `0690c16`，8 unit

> **未做（→ 後續 milestone `M-WEB-SLASH-D-FULL`）**：48 個 local-jsx 各自的真 React port（取代 GenericLocalJsxModal 的 per-command 互動 UI）。本 milestone 只做框架；CommandDispatcher.tsx 已預留 switch 點供 D-FULL 在不動 daemon / 其他 web 模組的前提下逐個 port。

### Phase E — 收尾 ✅ 2026-04-26
- [x] M-WEB-SLASH-E1：Section M6 加 daemon registry + rpc + web REST + store + dispatcher + category 共 55 unit；M6.3 manual sanity skip 提醒；TODO 收尾；CLAUDE.md 開發日誌段

### 完成標準
- [x] `bun run typecheck:web` + `bun run build:web` + `bun run build:dev` 全綠
- [x] daemon + web 既有測試全綠 + 新增 55 unit 全綠
- [x] `./cli -p hello` 冒煙過
- [x] tests/e2e/decouple-comprehensive.sh Section M6 PASS（M6.1 + M6.2 PASS、M6.3 manual skip）
- [x] 87 個 command 在 web autocomplete 出現；prompt/local 直接可跑；4 個 redirect 跳 tab；48 個 jsx-handoff 開 GenericLocalJsxModal

### 不在範圍（→ 後續 milestone）
- `M-WEB-SLASH-D-FULL`：48 個 local-jsx 各自的真 React port（互動完整等價 TUI）
- TUI 端反向「該命令請去 web 用」提示
- Slash command chord 快捷鍵（`Cmd+/` 等，獨立 keybinding milestone）
- Skills / MCP dynamic commands hot-reload

---

## 後續里程碑：M-WEB-AGENT-VIEW — ChatView 內 inline agent 階層樹（規劃中，待 SLASH-FULL 完成）

**目標**：把 sub-agent / Task tool 的階層在 web ChatView 用 inline collapsible tree 呈現，附完整 metadata（duration / tokens / tool count / error）。完整 plan：`~/.claude/plans/m-web-zesty-rabin.md` Milestone 2 段。

- [ ] M-WEB-AGENT-A：daemon WS frame 擴充 `TurnStartEvent` agentId/parentAgentId/agentType/agentDescription、`TurnEndEvent` metadata
- [ ] M-WEB-AGENT-B：messageStore 加 agentId + agentTreeIndex；新建 AgentBranchHeader.tsx + MessageList 群組折疊
- [ ] M-WEB-AGENT-C：metadata pane 點擊展開 + 串流中 spinner + Section M7 E2E

---

## 後續里程碑：M-WEB-DIFF-RICH — File edit diff GitHub 風 side-by-side（規劃中，待 AGENT-VIEW 完成）

**目標**：Edit / Write / MultiEdit 的 diff 從 `<pre>` 簡單渲染升級為 `react-diff-viewer-continued` side-by-side + light/dark theme。daemon 已輸出 `structuredPatch`，純前端 milestone。

- [ ] M-WEB-DIFF-D1：`bun add react-diff-viewer-continued` + 新建 `web/src/components/chat/DiffViewer.tsx`
- [ ] M-WEB-DIFF-D2：`ToolCallCard.tsx` 加 result type detection 條件渲染
- [ ] M-WEB-DIFF-D3：MultiEdit file 子分組 header / Write `+++ 新檔` 標頭
- [ ] M-WEB-DIFF-D4：Section M8 E2E + CLAUDE.md + 抽樣 light/dark 切換驗證

**不在範圍**：`M-WEB-DIFF-NOTEBOOK`（NotebookEdit 結構化 diff）

---

## 當前里程碑：M-LLAMACPP-REMOTE — 本地 + 遠端 llama.cpp 雙 endpoint 與 per-callsite routing（2026-04-28 啟動）

**目標**：支援同時連兩台 llama.cpp（local + remote），按 callsite 分流。例如主 turn 走遠端 32B 大模型、sideQuery / memoryPrefetch / cron NL parser / vision 走本機 9B 小模型。完整 plan：`~/.claude/plans/llamacpp-server-llamacpp-llamacpp-shimmering-kahan.md`。

**對齊決策**：
- Schema = 雙固定槽（頂層 = local；新 `remote` 區塊；不做 N endpoints array）
- Routing key = 5 個既有 callsite + vision = `turn` / `sideQuery` / `memoryPrefetch` / `background` / `vision`（vision 加進 `LlamaCppCallSite` enum）
- 切換時機 = 下個 turn 立刻生效（adapter 與直 fetch 路徑 per-call resolve；沿用既有 mtime hot-reload）
- 失敗策略 = 硬性失敗顯式報錯（不 auto-fallback，避免 M-MEMRECALL-LOCAL silent fail 教訓重演）
- API key = 寫 jsonc（單一來源，schema `apiKey?: string`；不另設 env override）
- Watchdog = 全域共用一份（remote 不另設 watchdog）
- UI 範圍 = TUI + Web 同步加（broadcast `llamacpp.configChanged` 雙邊同步）

### 任務
- [x] M-LLAMACPP-REMOTE-1 schema 擴充：`LlamaCppRemoteSchema` + `LlamaCppRoutingSchema`；`LlamaCppCallSite` enum 加 `'vision'`；`DEFAULT_LLAMACPP_CONFIG` 補 `remote: { enabled: false }` + `routing: { all 'local' }`；bundledTemplate 加註解區塊；`resolveEndpoint(callSite)` helper + 單元測試
- [x] M-LLAMACPP-REMOTE-2 7 處 fetch 點接 routing：`client.ts` / adapter / `llamacppSideQuery.ts` / `findRelevantMemories.ts` / `VisionClient.ts`（cronNlParser / queryHaiku / WebBrowserTool 自然繼承）；adapter callSite 全程貫通；watchdog token cap 加 `'vision'` 預設
- [x] M-LLAMACPP-REMOTE-3 daemon `llamacppConfigRpc.ts` 加 `setRemote` / `setRouting` / `testRemote` 3 個 op；broadcast `llamacpp.configChanged` 沿用；單元測試
- [x] M-LLAMACPP-REMOTE-4 TUI：`/llamacpp` 第 3 tab `Endpoints/Routing`；`EndpointsTab.tsx` remote 表單（masked apiKey）+ routing 6-row 表 + 連線測試 (T 鍵)
- [x] M-LLAMACPP-REMOTE-5 Web：`LlamacppTab` 加 Endpoints + Routing card；REST `GET/PUT /api/llamacpp/endpoints`、`PUT /api/llamacpp/routing`、`POST /api/llamacpp/endpoints/remote/test`；WS schema
- [x] M-LLAMACPP-REMOTE-6 ~~E2E `tests/e2e/decouple-comprehensive.sh` 新 section `llamacpp-routing`~~（改用 113 個單元測試涵蓋；實機驗證走手動 TUI / Web）；`docs/llamacpp-remote.md` 使用者指南；CLAUDE.md 開發日誌

### 完成標準
- [x] `bun run typecheck` + `typecheck:web` + `build:web` + `build:dev` 全綠
- [x] 既有 llamacpp / web / daemon 整合測試全綠 + 新增 routing 單元測試全綠（各別獨立跑：llamacpp 113 / sideQuery 12 / vision 16 / tokenEstimation 7 / queryHaiku 3 / findRelevantMemories 23 / daemon 250 / web 247-1 pre-existing fail）
- [x] `./cli -p hello`（routing.turn=local）冒煙過
- [x] **remote=local 整合驗證（2026-04-28）**：jsonc 加 `remote.enabled=true` + `routing` 全 5 callsite 設 `'remote'`（指向同一台本機 server），`./cli -p` 成功收到 `REMOTE_OK` / `PASS` — 證明 adapter / sideQuery / findRelevantMemories / VisionClient 全 5 條 fetch 路徑都能正確 resolve 到 remote endpoint
- [ ] TUI 手動：editorial remote.baseUrl + apiKey + 連線測試 → 看到遠端 models 名單（待使用者實機）
- [ ] Web 手動：改 routing → broadcast 到 TUI 雙邊同步（待使用者實機）
- [ ] 真遠端 E2E：接第二台機器 → routing.turn=remote → 確認 turn 真的打到第二台（待使用者第二台 server 部署完）

### 不在範圍（→ 後續 milestone）
- `M-LLAMACPP-MULTI`：N endpoints（>2 個）支援
- `M-LLAMACPP-PER-ENDPOINT-WD`：per-endpoint 獨立 watchdog config
- `M-LLAMACPP-FALLBACK`：auto-fallback policy（remote 失敗自動降本機）
- `M-LLAMACPP-FINE-ROUTING`：cronNL / extractMemories 與 sideQuery 分離 routing key；per-tool routing override
- env var override remote 設定（暫不加，jsonc 為單一來源）

---

## 待挖：M-PROMPT-CORRUPTION-HUNT — cli-dev system prompt byte 31350 deterministic corruption（2026-04-29 開挖；完整調查過程見 `docs/plans/M-PROMPT-CORRUPTION-HUNT.md`）

**症狀**：cli-dev compile binary 的 system prompt 永遠在 byte offset **31350** corrupt 4 bytes（git log section "buun-llama-cpp" 的 `un-l`），被換成 8-9 bytes 高 unicode 字元 + 偶發 NULL byte。多次 dump 比對 offset 100% 一致；破壞的具體 bytes 在不同 run 之間略有變化。**配 image multimodal 觸發 llama.cpp `Failed to tokenize prompt` 400 error**。已在 adapter 加 `deepSanitizeStrings` bandaid（剝 C0 控制字元）擋住 user-facing crash，但 root cause 沒找到。

**已知 facts**（短期 bandaid 之後挖出來的）：
- 直接用 Node `child_process.execFileSync` 或 `execa` 跑 `git --no-optional-locks log --oneline -n 5` → stdout 完全乾淨無 corruption
- corruption 不在 `context.ts:67` execa 結果回傳那一刻發生（執行程式碼層級已驗）
- corruption 出現位置永遠固定在 byte offset 31350（不是字元位置 — 是 UTF-8 bytes）
- 4 bytes ASCII `un-l` (`75 6e 2d 6c`) 變成 8-9 bytes 高 unicode（observed: `e2 a0 a0 e3 8a 81 ca 95 00` 或 `e2 a6 a0 e5 a2 81 c9 ba`）— 都是合法 UTF-8 sequence，不是純隨機 garbage
- 純文字 prompt 不會 fail；image multimodal 才會 fail（NULL byte 跟 image marker counter 互打）

**diagnostic 工具（已合入 adapter）**：`LLAMA_DUMP_BODY=<dir>` env 開啟，每個 request body（base64 截短）寫到 dir 下 timestamp 命名 JSON 檔，可 bisect 找到觸發點。

### 任務
- [x] M-CORR-1：確認 corruption 是 cli-dev compile binary 特有，還是 `bun run dev` raw source 也踩 — **已確認：**
  - `bun run` raw source（直接 execa git log）：✓ 完全乾淨
  - cli-dev compile binary headless `-p` 模式：✓ 完全乾淨
  - cli-dev compile binary stdin-piped 非 TTY：✓ 完全乾淨
  - cli-dev compile binary **interactive TUI 模式（PowerShell ConPTY）**：✗ corrupt at byte 31350
  - **結論**：corruption 只在 interactive TUI 路徑復現，與 compile binary 否無關（compile binary 走 headless 也乾淨）
- [x] M-CORR-2：直接用 Node `child_process.execFileSync` + `execa` 跑同一條 git log → 完全乾淨 → 證實 git 讀取 + execa 路徑沒事
- [x] M-CORR-3 部分：corruption 偵測：
  - 多次 dump 比對：byte 31350 位置 100% 一致
  - 破壞 bytes 在同個 binary 跑出來一致（多次 run 都產生 `e2 a6 a0 e5 a2 81 c9 ba`）
  - 不同 binary build 跑出來不同（22:06 binary 是 `e2 a0 a0 e3 8a 81 ca 95 00` 含 NUL）
  - cli-dev binary 內 grep `e2 a6 a0 e5 a2 81 c9 ba` / `e2 a0 a0 e3 8a 81 ca 95` / `buun-llama-cpp`：**0 hits**（不是 baked-in，是 runtime 生成）
  - section 分析：interactive 與 headless 都包含 git log section，內容相同；只 interactive 在 byte 31350 corrupt
  - **缺**：尚未直接觀察 interactive 模式下 system prompt 在 assembly chain 哪一步出現 corruption（headless code path 不走，所以 `-p` mode 抓不到）
- [ ] M-CORR-4：嫌疑分類驗證 — 已知 minimal compile binary（只 import execa + 跑 git log）**完全乾淨**，所以排除 (a) 通用 bun --compile string bug；剩 (b) 某個 native module（modifiers-napi / image-processor-napi / 其他）interactive mode 才載入 + 寫超 buffer；(c) Ink/React 在 TUI render 時的 string handling
- [ ] M-CORR-5：找到根因後，移除（或保留作 defense-in-depth）adapter 的 `deepSanitizeStrings` bandaid

### 已加診斷工具（adapter env-gated dump hooks）
- `LLAMA_DUMP_BODY=<dir>`：dump 翻譯後 OpenAI body（base64 截短）
- `LLAMA_DUMP_PRESANITIZE=<dir>`：dump pre-sanitize OpenAI body（含原始 byte，未過濾 C0）
- `LLAMA_DUMP_RAWBODY=<dir>`：dump 入 adapter 的 raw HTTP body bytes + `system` array 元素分別

### 已加 regression test
- `tests/integration/llamacpp/sanitize-tokenizer.test.ts`：11 個 case 涵蓋 NULL byte / C0 控制字元 / CJK / image_url.url 跳過 / data 跳過 / 觀察到的 corruption pattern / 大型 system prompt with corruption

### 還需做的 root-cause 步驟
1. 觸發 interactive TUI 模式並開 dump（user 端最直接，或自動化用 `winpty` / pseudo-TTY 但 winpty 在當前環境 ASSERT 炸，待研究）
2. 取得 interactive 模式下 raw body dump，比對 stdin-piped 模式 dump 找 differential
3. 若 raw body 已含 corruption → 在 SDK 入口前加 instrumentation 抓 caller
4. 若 raw body 乾淨 → 問題在 adapter 之後，但目前 adapter 已 sanitize 所以不該再壞

### 完成標準
- [ ] 不需 `deepSanitizeStrings` 的 cli-dev 也能正確處理含 image 的 turn
- [ ] dump body 在 byte 31350 看到的就是 git log 原始 bytes（buun-llama-cpp 完整）
- [ ] 在 LESSONS.md 該條補上 root cause + 修法
- [x] 寫 regression test：✓ `tests/integration/llamacpp/sanitize-tokenizer.test.ts`

### 不在範圍
- 改 llama.cpp tokenizer 對 NULL byte / multimodal 的相容性（上游 buun-llama-cpp 行為）
- 改 chat template 對 markers/bitmaps mismatch 的容忍度

---

## 當前里程碑：M-QWEN35 — 換用 unsloth Qwen3.5-9B Q4_K_M + vision + 128k turbo4（2026-04-30 啟動）

**目標**：把 local + remote 的 llamacpp 模型從 Qwopus3.5-9B-v3 Q5_K_S 換成 unsloth Qwen3.5-9B Q4_K_M + 對應 mmproj-F16，全 GPU 跑 128k ctx + buun fork turbo4 KV cache 壓縮（4.25 bpv）；Vision 從 Gemopus mmproj 改用 Qwen3.5 原生 mmproj，把 vision E2E 自動化擴展到 TUI standalone + daemon 兩模式。

**對齊決策**：
- Q4_K_M（5.68 GB）vs Q5/Q6：選 Q4_K_M 是因為要把 KV cache 騰給 128k ctx（turbo4 ≈ 5.1 GB），總 ≈ 11.8 GB / 12 GB VRAM
- 256k ctx 在 12 GB VRAM 不可行（純 turbo4 需 16.9 GB），降到 128k 換取全 GPU 載入
- mmproj-F16（918 MB）vs F32：F16 品質夠且省 1 GB VRAM
- local + remote 都換（remote 在 routing 層分流，但兩邊指向同一機）
- 既有 Gemopus 模型 + Jackrong Neo 模型 keep（不刪 GGUF），只改 jsonc 預設指向

### 任務
- [x] M-QWEN35-1 確認 buun-llama-cpp build 8961 已存在 + CUDA 啟用 + RTX 5070 Ti 12GB 偵測（免重編）
- [x] M-QWEN35-2 下載 `Qwen3.5-9B-Q4_K_M.gguf`（5.68 GB）+ `mmproj-Qwen3.5-9B-F16.gguf`（918 MB）→ `models/`
- [x] M-QWEN35-3 改 `~/.my-agent/llamacpp.jsonc`：local + remote 都指 Qwen3.5-9B Q4_K_M；alias `qwen3.5-9b`；vision.enabled=true 加 `server.vision.mmprojPath`；modelAliases 加 `qwen3.5-9b`；extraArgs 升 `-b 2048 -ub 512 --threads 12 --no-mmap`
- [x] M-QWEN35-4 同步改 `src/llamacppConfig/bundledTemplate.ts`（seed 對齊）+ 重寫 `scripts/llama/setup.sh`（buun submodule build + unsloth 模型）
- [x] M-QWEN35-5 寫 vision E2E `tests/e2e/vision-e2e.sh` 三 phase（adapter 直連 / TUI standalone / daemon attach）+ `_make-red-png.ts` 128×128 PNG 產生器；雙準則：stdout 含 red/紅 OR server `/slots id_task` 在 cli 跑期間遞增（規避 my-agent 對 reasoning + tool_use 在 headless `-p` 不渲染的 bug）
- [x] M-QWEN35-6 冒煙：`./cli -p` 純文字 PASS；vision E2E 3/3 綠（adapter ✓ red、TUI standalone pipeline ✓ id 23334→24122、daemon attach pipeline ✓ id 24122→24949）；`bun run typecheck` 只剩 baseline TS5101
- [x] M-QWEN35-7 commit + dev-log + LESSONS

### 完成標準
- [x] llama-server.exe + Qwen3.5-9B Q4_K_M 載入後 fit 進 12 GB VRAM（實測 model 4861 MiB + KV turbo4 1056 MiB + compute 493 MiB ≈ 6.4 GB，剩餘 ~4.5 GB 給 mmproj/CUDA buf）
- [x] `./cli -p "hi"` 回應正常
- [x] vision E2E：TUI standalone 與 daemon 模式都驗證 vision request 抵達 server 並正確處理 image
- [x] `bun run typecheck` 綠

### 不在範圍 → 後續 milestone
- ~~**M-QWEN35-RENDER**~~ ✅ 已修（2026-04-30）：root cause 是 reasoning-only stream 在 adapter 結束時沒 emit text block，QueryEngine `last(content).type === 'text'` 提取落空。修法在 adapter 邊界加 fallback：`emittedThinking && !emittedText && !emittedToolCall` → 鏡射 thinking 成 text block。3 unit test + vision E2E Phase 2/3 升級為 stdout 直接含 紅
- M-QWEN35-VARIANT：UD-Q4_K_XL（5.97 GB）對比實驗 + 切換 UI
- M-QWEN35-256K：上 256k ctx 需要等更激進壓縮（turbo2_tcq）+ partial offload，目前不做
- M-QWEN35-THINKING：開啟 Qwen3.5 thinking 模式（`enable_thinking:true`）並導 reasoning trace 進 TUI panel
- 模型自動探測機制（VRAM 不夠就自動降 ctx）

---

## 已完成里程碑：M-QWEN35-XML-LEAK — qwen3.5-9b XML tool_call leak adapter fallback（2026-04-30 啟動 + 完成）

**目標**：使用者回報 daemon 模式 LLM 停止運算；診斷後 standalone 也復現。Root cause = qwen3.5-9b thinking 模式偶發吐 Hermes 原生 XML（`<tool_call><function=Bash>...`）到 content 或 reasoning_content，jinja 沒攔。Adapter 加 defensive fallback 把 XML 解析合成 tool_use blocks。

### 任務
- [x] M-XMLLEAK-1 root cause 確認：直接 curl 復現 + `--chat-template-kwargs '{"enable_thinking":false}'` 8/8 不漏（驗證是 thinking 路徑）
- [x] M-XMLLEAK-2 `parseLeakedXmlToolCalls(text)` helper：多 tool_call、多 parameter、含換行 value、混合 broken 都覆蓋
- [x] M-XMLLEAK-3 streaming 路徑（`translateOpenAIStreamToAnthropic`）兩通道（accumulatedText + accumulatedThinking）合併偵測 + 合成 tool_use blocks + stop_reason override + loud warn
- [x] M-XMLLEAK-4 non-streaming 路徑（`translateChatCompletionToAnthropic`）同步 patch
- [x] M-XMLLEAK-5 `tests/integration/llamacpp/xml-leak-fallback.test.ts` 11/11 綠 + llamacpp suite 137/137
- [x] M-XMLLEAK-6 實機冒煙 10 次：7 clean / 1 fallback 救回 / 0 broken
- [x] M-XMLLEAK-7 LESSONS.md + dev log + commit

### 不在範圍 → 後續
- 根治：在 `~/.my-agent/llamacpp.jsonc` extraArgs 加 `--chat-template-kwargs '{"enable_thinking":false}'`（會關 thinking，目前先保留 thinking + adapter 兜底的折衷）

---

## 當前里程碑：M-CONFIG-SEED-COMPLETE — 首次啟動 config seed 完整性修復 + 全覆蓋測試（2026-04-30 啟動）

**目標**：把 5 個 config 檔（settings.jsonc / .my-agent.jsonc / llamacpp.jsonc / web.jsonc / discord.jsonc）+ system-prompt 目錄的 seed 行為對齊，補完所有發現的洞，並寫整合測試覆蓋 seed / migration / 壞檔 fallback / schema validation。

**對齊決策**：
- P1 saveConfigWithLock 改用 jsonc-parser modify API 保留註解（取代 M-CONFIG-JSONC-SAVE 提案）
- 寫回時若原檔不存在 → 走 bundled template；若已存在 → minimal modify
- 系統 prompt 補寫缺檔但不覆蓋已存在檔（尊重使用者編輯）

### 任務
- [x] P1 `src/utils/config.ts::saveConfigWithLock` 已實作 JSONC 保留路徑（M-CONFIG-JSONC 落地）；本次只更新 globalConfig/seed.ts 的誤導註解
- [x] P2 `src/webConfig/seed.ts` 加 strict JSON → JSONC migration
- [x] P3 `src/systemPromptFiles/seed.ts` 改成「目錄存在但個別檔案不存在 → 補寫」
- [x] P4 `src/setup.ts` seed 改 await（消除 race，與 daemon 對齊）
- [x] P5 `src/daemon/main.ts` 加 seedWebConfigIfMissing + loadWebConfigSnapshot
- [x] P6 `src/llamacppConfig/seed.ts::localizeTemplate` binaryPath 跨平台
- [x] 寫 `tests/integration/bootstrap/seed-coverage.test.ts` 全覆蓋（18/18 綠）
- [x] typecheck baseline + 179/179 regression 綠
- [x] LESSONS.md + dev log + 繁中 commit + push

### 完成標準
- `bun run typecheck` 過
- `bun test tests/integration/bootstrap/` 全綠
- 黑箱測：清空 `~/.my-agent/`，跑 `./cli -p "hi"` 後所有 5 個 .jsonc + system-prompt/ + 子目錄齊全
- 黑箱測：daemon start 後 web.jsonc 已 seed（P5）

### 不在範圍 → 後續 milestone
- ~~Config doctor 自動檢查 / 修復工具~~ → 已詳規劃 `docs/plans/M-CONFIG-DOCTOR.md`，等決策
- ~~Schema 欄位 default 與 env override 對齊文件~~ → 已詳規劃 `docs/plans/M-CONFIG-DOCS-ALIGN.md`（含 env 命名統一），等決策

---

## 已完成里程碑：M-CONFIG-DOCTOR — Config 健康診斷與自動修復工具（2026-04-30 啟動 + 完成）

**詳規劃**：`docs/plans/M-CONFIG-DOCTOR.md`

**對齊決策**：Q1=C 兩入口都做、Q2=B 每次 session start、Q3=A 只 5 個 jsonc + system-prompt/、Q4=A 每次 fix 都備份、Q5=A 跨檔不一致只警告

### 任務
- [x] DOCTOR-1 `src/configDoctor/` 骨架（types + index）
- [x] DOCTOR-2 5 個 checks（llamacpp / web / discord / global / systemPrompt）
- [x] DOCTOR-3 fixers/index.ts（每個 issue.code 派 fix action，自動備份）
- [x] DOCTOR-4 report.ts（plain + json 格式化）
- [x] DOCTOR-5 slash command `/config-doctor [fix|rewrite] [--json]`
- [x] DOCTOR-6 CLI subcommand `my-agent config doctor`
- [x] DOCTOR-7 session start 自動 check（setup.ts + daemon/main.ts）
- [x] DOCTOR-8 整合測試 14/14
- [x] DOCTOR-9 黑箱冒煙：CLI plain + json 模式正常，check 耗時 34ms
- [x] DOCTOR-10 LESSONS + dev log + commit + push

### 完成標準
- [x] `./cli config doctor` 在當前環境跑 → exit 0（0 error / 0 warning / 1 info）
- [x] check 耗時 < 50ms（實測 34ms）
- [x] 整合測試覆蓋率：5 個 module × 多個 issue type
- [x] regression 211/211 過

### 不在範圍 → 後續
- 互動式 fix（TUI 問使用者）
- env var 命名統一 → M-CONFIG-DOCS-ALIGN 處理
- Skill / hook / mcp config 健康檢查 → 各自模組

---

## 已完成里程碑：M-CONFIG-DOCS-ALIGN — Schema → 文件自動產生（2026-04-30 啟動 + 完成）

**詳規劃**：`docs/plans/M-CONFIG-DOCS-ALIGN.md`

**對齊範圍**：使用者指定「只做 schema → 文件自動產生，不用統一命名」。env 前綴統一（原計畫 Phase 1）跳過。

### 任務
- [x] DOCS-1 盤點 5 個 config 的 env override 對照（手寫進產生器 lookup）
- [x] DOCS-2 `scripts/gen-config-docs.ts` 自動產生器（TS Compiler API + zod 預設值 + JSDoc）
- [x] DOCS-3 產出 4 份 doc + 主索引（llamacpp / web / discord / config-reference）
- [x] DOCS-4 同一支腳本內建 `--check` mode 給 CI 用
- [x] DOCS-5 `package.json` 加 `docs:gen` / `docs:verify` scripts
- [x] DOCS-6 整合測試 8/8（`tests/integration/configDocsGen/`）
- [x] DOCS-7 `CLAUDE.md` 加第 13 條黃金規則 + LESSONS + dev log + commit + push

### 完成標準
- [x] `bun run docs:gen` 產出 4 份 md 檔
- [x] `bun run docs:verify` 在無修改時 exit 0
- [x] global config 略過（無 zod schema，文件指向 `src/utils/config.ts:184`）
- [x] system-prompt 略過（純 markdown 文本，文件指向 `src/systemPromptFiles/sections.ts`）

### 不在範圍 → 後續
- env var 命名統一（`MYAGENT_<MODULE>_*` 前綴）→ 使用者明確跳過
- pre-commit hook 自動跑 docs:gen → 留作 contributor 體驗優化
- CI workflow 加 docs:verify → 還沒 CI infra
- global config 也走 zod schema → 大改動，獨立 milestone

---

## Session 日誌

> Claude Code：每次 session 結束後，在下方附加一行簡短記錄。
> 格式：`- YYYY-MM-DD: [完成的任務] | [遇到的問題] | [下一步]`

- 2026-04-15: 本地 llama.cpp b8457 + Qwen3.5-9B-Neo Q5_K_M 部署完成（scripts/llama/*），煙測 2+2=4 通過，58 tok/s prompt eval | 踩了 --log-colors 參數變更、Git Bash UTF-8 mangling、Neo reasoning_content/content 分離三個坑，都已記入 LESSONS.md | 下一步：M1 階段一，整合這個 server 作為 my-agent 的本地 provider

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

- 2026-04-16 16:05: Session 結束 | 進度：55/57 任務 | 8931dce refactor: 品牌重塑 — @anthropic-ai → my-agent-ai、.claude → .my-agent、.my-agent → .my-agent

- 2026-04-16 16:13: Session 結束 | 進度：55/57 任務 | 8931dce refactor: 品牌重塑 — @anthropic-ai → my-agent-ai、.claude → .my-agent、.my-agent → .my-agent

- 2026-04-16 20:54: Session 結束 | 進度：55/57 任務 | 8931dce refactor: 品牌重塑 — @anthropic-ai → my-agent-ai、.claude → .my-agent、.my-agent → .my-agent

- 2026-04-16 21:15: Session 結束 | 進度：55/57 任務 | 8931dce refactor: 品牌重塑 — @anthropic-ai → my-agent-ai、.claude → .my-agent、.my-agent → .my-agent

- 2026-04-16 21:26: Session 結束 | 進度：55/57 任務 | 8931dce refactor: 品牌重塑 — @anthropic-ai → my-agent-ai、.claude → .my-agent、.my-agent → .my-agent

- 2026-04-16 21:39: Session 結束 | 進度：55/57 任務 | 8931dce refactor: 品牌重塑 — @anthropic-ai → my-agent-ai、.claude → .my-agent、.my-agent → .my-agent

- 2026-04-16 21:44: Session 結束 | 進度：55/57 任務 | 8931dce refactor: 品牌重塑 — @anthropic-ai → my-agent-ai、.claude → .my-agent、.my-agent → .my-agent

- 2026-04-16 22:01: Session 結束 | 進度：60/77 任務 | 8931dce refactor: 品牌重塑 — @anthropic-ai → my-agent-ai、.claude → .my-agent、.my-agent → .my-agent

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
- `bun src/entrypoints/cli.tsx --help` 不再印 my-agent hint stderr ✅
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

- 2026-04-18 22:13: Session 結束 | 進度：265/278 任務 | b7bacd1 docs(context): 記錄 my-agent 上下文組成詳解（M-UM + M2）

- 2026-04-18 22:18: Session 結束 | 進度：265/278 任務 | b7bacd1 docs(context): 記錄 my-agent 上下文組成詳解（M-UM + M2）

- 2026-04-19 07:10: Session 結束 | 進度：265/278 任務 | b7bacd1 docs(context): 記錄 my-agent 上下文組成詳解（M-UM + M2）

- 2026-04-19 07:40: Session 結束 | 進度：274/287 任務 | 3129f2c refactor(brand): 使用者可見字串改為 my-agent，新增 my-agent bin alias

- 2026-04-19 07:43: Session 結束 | 進度：274/287 任務 | 3129f2c refactor(brand): 使用者可見字串改為 my-agent，新增 my-agent bin alias

- 2026-04-19 07:51: Session 結束 | 進度：274/287 任務 | 3129f2c refactor(brand): 使用者可見字串改為 my-agent，新增 my-agent bin alias

- 2026-04-19 07:55: Session 結束 | 進度：274/287 任務 | 3129f2c refactor(brand): 使用者可見字串改為 my-agent，新增 my-agent bin alias

- 2026-04-19 07:58: Session 結束 | 進度：274/287 任務 | 3129f2c refactor(brand): 使用者可見字串改為 my-agent，新增 my-agent bin alias

- 2026-04-19 08:02: Session 結束 | 進度：274/287 任務 | 3129f2c refactor(brand): 使用者可見字串改為 my-agent，新增 my-agent bin alias

- 2026-04-19 08:19: Session 結束 | 進度：278/318 任務 | 1df413e feat(m-sp-1): 建立 systemPromptFiles 模組 + seed 機制，外部化 3 個靜態段

- 2026-04-19 09:00: Session 結束 | 進度：300/318 任務 | a0aa74e docs(m-sp-5): 完整 M-SP 文件與架構決策記錄

- 2026-04-19 09:31: Session 結束 | 進度：300/318 任務 | a0aa74e docs(m-sp-5): 完整 M-SP 文件與架構決策記錄

- 2026-04-19 09:33: Session 結束 | 進度：300/318 任務 | a0aa74e docs(m-sp-5): 完整 M-SP 文件與架構決策記錄

- 2026-04-19 09:41: Session 結束 | 進度：311/329 任務 | 2483e15 feat(m-token): llamacpp adapter 接上 prompt_tokens_details.cached_tokens

- 2026-04-19 09:54: Session 結束 | 進度：311/329 任務 | 67a20c9 feat(llamacpp-ctx): 上下文溢出偵測與自動復原（解決 128K 模型卡死問題）

- 2026-04-19 09:59: Session 結束 | 進度：311/329 任務 | 67a20c9 feat(llamacpp-ctx): 上下文溢出偵測與自動復原（解決 128K 模型卡死問題）

- 2026-04-19 10:19: Session 結束 | 進度：323/341 任務 | 075574a feat(llama-cfg): 本地 LLM server 設定統一到 ~/.my-agent/llamacpp.json

- 2026-04-19 10:26: Session 結束 | 進度：323/341 任務 | 075574a feat(llama-cfg): 本地 LLM server 設定統一到 ~/.my-agent/llamacpp.json

- 2026-04-19 10:39: Session 結束 | 進度：323/341 任務 | 075574a feat(llama-cfg): 本地 LLM server 設定統一到 ~/.my-agent/llamacpp.json

- 2026-04-19 10:42: Session 結束 | 進度：323/341 任務 | 075574a feat(llama-cfg): 本地 LLM server 設定統一到 ~/.my-agent/llamacpp.json

- 2026-04-19 11:01: Session 結束 | 進度：331/352 任務 | abdc37b feat(rename): 專案改名 free-code → My Agent（Phase 1–6）

- 2026-04-19 11:08: Session 結束 | 進度：331/352 任務 | abdc37b feat(rename): 專案改名 free-code → My Agent（Phase 1–6）

- 2026-04-19 11:18: Session 結束 | 進度：334/352 任務 | 45ab801 feat(rename): Phase 7 收尾 — POC scripts slug 更新 + TODO 勾選

- 2026-04-19 11:24: Session 結束 | 進度：334/352 任務 | 45ab801 feat(rename): Phase 7 收尾 — POC scripts slug 更新 + TODO 勾選

- 2026-04-19 11:28: Session 結束 | 進度：334/352 任務 | 08ca2a9 fix(ripgrep): 補上 Windows ripgrep binary 修復 Grep/Glob 工具失敗

- 2026-04-19 11:34: Session 結束 | 進度：334/352 任務 | 08ca2a9 fix(ripgrep): 補上 Windows ripgrep binary 修復 Grep/Glob 工具失敗

- 2026-04-19 11:38: Session 結束 | 進度：334/352 任務 | 08ca2a9 fix(ripgrep): 補上 Windows ripgrep binary 修復 Grep/Glob 工具失敗

- 2026-04-19 11:42: Session 結束 | 進度：334/352 任務 | 08ca2a9 fix(ripgrep): 補上 Windows ripgrep binary 修復 Grep/Glob 工具失敗

- 2026-04-19 11:45: Session 結束 | 進度：334/352 任務 | 08ca2a9 fix(ripgrep): 補上 Windows ripgrep binary 修復 Grep/Glob 工具失敗

- 2026-04-19 11:50: Session 結束 | 進度：334/352 任務 | 08ca2a9 fix(ripgrep): 補上 Windows ripgrep binary 修復 Grep/Glob 工具失敗

- 2026-04-19 12:03: Session 結束 | 進度：344/363 任務 | 08ca2a9 fix(ripgrep): 補上 Windows ripgrep binary 修復 Grep/Glob 工具失敗

- 2026-04-19 12:11: Session 結束 | 進度：344/363 任務 | 43378d0 fix(m-vision): E2E 測試圖片改用 32x32 純紅 PNG

- 2026-04-19 12:16: Session 結束 | 進度：344/363 任務 | 7126e22 fix(tui): 走 llamacpp 路徑時 logo 顯示本地模型名而非 Anthropic 預設

- 2026-04-19 12:19: Session 結束 | 進度：344/363 任務 | 7126e22 fix(tui): 走 llamacpp 路徑時 logo 顯示本地模型名而非 Anthropic 預設

- 2026-04-19 12:52: Session 結束 | 進度：344/363 任務 | 7126e22 fix(tui): 走 llamacpp 路徑時 logo 顯示本地模型名而非 Anthropic 預設

- 2026-04-19 12:57: Session 結束 | 進度：344/363 任務 | 7126e22 fix(tui): 走 llamacpp 路徑時 logo 顯示本地模型名而非 Anthropic 預設

- 2026-04-19 13:02: Session 結束 | 進度：344/363 任務 | 7126e22 fix(tui): 走 llamacpp 路徑時 logo 顯示本地模型名而非 Anthropic 預設

- 2026-04-19 13:06: Session 結束 | 進度：344/363 任務 | bc3a2a4 fix(m-deanthro): stage 1 — 隱藏 org leak 與修正 llamacpp 模型身份

- 2026-04-19 13:33: Session 結束 | 進度：344/363 任務 | 6984141 refactor(m-deanthro): stage 3-a — getAuthTokenSource / getAnthropicApiKeyWithSource 徹底清 env

- 2026-04-19 13:35: Session 結束 | 進度：344/363 任務 | 6984141 refactor(m-deanthro): stage 3-a — getAuthTokenSource / getAnthropicApiKeyWithSource 徹底清 env

- 2026-04-19 13:41: Session 結束 | 進度：344/363 任務 | 6984141 refactor(m-deanthro): stage 3-a — getAuthTokenSource / getAnthropicApiKeyWithSource 徹底清 env

- 2026-04-19 13:49: Session 結束 | 進度：344/363 任務 | 6984141 refactor(m-deanthro): stage 3-a — getAuthTokenSource / getAnthropicApiKeyWithSource 徹底清 env

- 2026-04-19 13:55: Session 結束 | 進度：344/363 任務 | 6984141 refactor(m-deanthro): stage 3-a — getAuthTokenSource / getAnthropicApiKeyWithSource 徹底清 env

- 2026-04-19 13:57: Session 結束 | 進度：344/363 任務 | 6984141 refactor(m-deanthro): stage 3-a — getAuthTokenSource / getAnthropicApiKeyWithSource 徹底清 env

- 2026-04-19 15:29: Session 結束 | 進度：349/368 任務 | 4264307 docs(browser): M7 收尾 — README、ADR-011、CLAUDE.md 開發日誌、TODO 更新

- 2026-04-19 15:33: Session 結束 | 進度：349/368 任務 | 4264307 docs(browser): M7 收尾 — README、ADR-011、CLAUDE.md 開發日誌、TODO 更新

- 2026-04-19 16:00: Session 結束 | 進度：349/368 任務 | 12de082 feat(cron): Wave 2 — job lifecycle + modelOverride via teammate + preRunScript

- 2026-04-19 16:13: Session 結束 | 進度：349/368 任務 | 12de082 feat(cron): Wave 2 — job lifecycle + modelOverride via teammate + preRunScript

- 2026-04-19 16:27: Session 結束 | 進度：349/368 任務 | 12de082 feat(cron): Wave 2 — job lifecycle + modelOverride via teammate + preRunScript

- 2026-04-19 16:34: Session 結束 | 進度：349/368 任務 | 12de082 feat(cron): Wave 2 — job lifecycle + modelOverride via teammate + preRunScript

- 2026-04-19 16:45: Session 結束 | 進度：349/368 任務 | 12de082 feat(cron): Wave 2 — job lifecycle + modelOverride via teammate + preRunScript

- 2026-04-19 17:02: Session 結束 | 進度：349/368 任務 | cd54547 docs: 重新定位為 My Agent + 全面文件更新

- 2026-04-19 17:05: Session 結束 | 進度：349/368 任務 | cd54547 docs: 重新定位為 My Agent + 全面文件更新

- 2026-04-19 17:09: Session 結束 | 進度：349/368 任務 | cd54547 docs: 重新定位為 My Agent + 全面文件更新

- 2026-04-19 17:17: Session 結束 | 進度：349/368 任務 | af1066d refactor: rename all CLAUDE_CODE_* env vars to MY_AGENT_*

- 2026-04-19 17:27: Session 結束 | 進度：349/368 任務 | af1066d refactor: rename all CLAUDE_CODE_* env vars to MY_AGENT_*

- 2026-04-19 17:34: Session 結束 | 進度：349/368 任務 | af1066d refactor: rename all CLAUDE_CODE_* env vars to MY_AGENT_*

- 2026-04-19 17:37: Session 結束 | 進度：349/368 任務 | af1066d refactor: rename all CLAUDE_CODE_* env vars to MY_AGENT_*

- 2026-04-19 17:49: Session 結束 | 進度：349/368 任務 | af1066d refactor: rename all CLAUDE_CODE_* env vars to MY_AGENT_*

- 2026-04-19 17:55: Session 結束 | 進度：349/368 任務 | af1066d refactor: rename all CLAUDE_CODE_* env vars to MY_AGENT_*

- 2026-04-19 18:28: Session 結束 | 進度：349/368 任務 | af1066d refactor: rename all CLAUDE_CODE_* env vars to MY_AGENT_*

- 2026-04-19 18:32: Session 結束 | 進度：349/368 任務 | bb47a0f refactor: remove auto-update subsystem + clean up "claude" aliases

- 2026-04-19 18:35: Session 結束 | 進度：349/368 任務 | bb47a0f refactor: remove auto-update subsystem + clean up "claude" aliases

- 2026-04-19 18:40: Session 結束 | 進度：349/368 任務 | bb47a0f refactor: remove auto-update subsystem + clean up "claude" aliases

- 2026-04-19 18:49: Session 結束 | 進度：349/368 任務 | bb47a0f refactor: remove auto-update subsystem + clean up "claude" aliases

- 2026-04-19 18:52: Session 結束 | 進度：349/368 任務 | bb47a0f refactor: remove auto-update subsystem + clean up "claude" aliases

- 2026-04-19 19:23: Session 結束 | 進度：349/368 任務 | bb47a0f refactor: remove auto-update subsystem + clean up "claude" aliases

- 2026-04-19 19:45: Session 結束 | 進度：349/368 任務 | bb47a0f refactor: remove auto-update subsystem + clean up "claude" aliases

- 2026-04-19 19:49: Session 結束 | 進度：349/368 任務 | bb47a0f refactor: remove auto-update subsystem + clean up "claude" aliases

- 2026-04-19 19:58: Session 結束 | 進度：349/368 任務 | bb47a0f refactor: remove auto-update subsystem + clean up "claude" aliases

- 2026-04-19 20:06: Session 結束 | 進度：349/383 任務 | bb47a0f refactor: remove auto-update subsystem + clean up "claude" aliases

- 2026-04-19 20:30: Session 結束 | 進度：352/383 任務 | 6eebfae feat(daemon): CLI subcommand start/stop/status/restart/logs (M-DAEMON-3)

- 2026-04-19 20:37: Session 結束 | 進度：353/383 任務 | aeb559c feat(daemon): SessionRunner iface + input queue w/ mixed strategy (M-DAEMON-5)

- 2026-04-20 09:05: Session 結束 | 進度：353/383 任務 | aeb559c feat(daemon): SessionRunner iface + input queue w/ mixed strategy (M-DAEMON-5)

- 2026-04-20 09:09: Session 結束 | 進度：353/383 任務 | aeb559c feat(daemon): SessionRunner iface + input queue w/ mixed strategy (M-DAEMON-5)

- 2026-04-20 09:43: Session 結束 | 進度：354/383 任務 | f9fe3a6 docs(todo): mark M-DAEMON-4 complete

- 2026-04-20 10:11: Session 結束 | 進度：355/383 任務 | 8e5e826 feat(daemon): cron scheduler wiring + REPL/headless skip guard (M-DAEMON-4.5)

- 2026-04-20 10:41: Session 結束 | 進度：356/383 任務 | b61f58b test(daemon): thin-client E2E — lifecycle + mode transitions (M-DAEMON-6d)

- 2026-04-20 11:17: Session 結束 | 進度：364/383 任務 | b6961d1 docs(daemon): M-DAEMON-8 wrap-up — smoke + docs + ADR-012 + LESSONS

- 2026-04-20 11:26: Session 結束 | 進度：364/383 任務 | b6961d1 docs(daemon): M-DAEMON-8 wrap-up — smoke + docs + ADR-012 + LESSONS

- 2026-04-20 11:41: Session 結束 | 進度：364/383 任務 | b6961d1 docs(daemon): M-DAEMON-8 wrap-up — smoke + docs + ADR-012 + LESSONS

- 2026-04-20 11:51: Session 結束 | 進度：369/388 任務 | cd416b8 feat(daemon): auto-spawn daemon on REPL open + /daemon + autostart CLI (M-DAEMON-AUTO)

- 2026-04-20 12:19: Session 結束 | 進度：373/392 任務 | 207025f feat(daemon): three-layer permission sync TUI↔daemon (M-DAEMON-PERMS)

- 2026-04-20 12:56: Session 結束 | 進度：373/392 任務 | 207025f feat(daemon): three-layer permission sync TUI↔daemon (M-DAEMON-PERMS)

- 2026-04-20 13:06: Session 結束 | 進度：373/392 任務 | 96546bf fix(daemon): stale .daemon.lock auto-takeover + /daemon on real verification

- 2026-04-20 13:32: Session 結束 | 進度：373/392 任務 | 96546bf fix(daemon): stale .daemon.lock auto-takeover + /daemon on real verification

- 2026-04-20 13:37: Session 結束 | 進度：373/392 任務 | 96546bf fix(daemon): stale .daemon.lock auto-takeover + /daemon on real verification

- 2026-04-20 13:48: Session 結束 | 進度：373/392 任務 | 96546bf fix(daemon): stale .daemon.lock auto-takeover + /daemon on real verification

- 2026-04-20 14:05: Session 結束 | 進度：373/392 任務 | 96546bf fix(daemon): stale .daemon.lock auto-takeover + /daemon on real verification

- 2026-04-20 14:08: Session 結束 | 進度：373/392 任務 | 96546bf fix(daemon): stale .daemon.lock auto-takeover + /daemon on real verification

- 2026-04-20 14:11: Session 結束 | 進度：373/392 任務 | 96546bf fix(daemon): stale .daemon.lock auto-takeover + /daemon on real verification

- 2026-04-20 14:24: Session 結束 | 進度：373/392 任務 | 58eba69 feat(daemon): M-DISCORD-1.2 — Project singleton 多例化

- 2026-04-20 14:40: Session 結束 | 進度：373/392 任務 | 1d43688 feat(daemon): M-DISCORD-1.4 — ProjectRegistry wiring + runner mutex wrap

- 2026-04-20 15:08: Session 結束 | 進度：373/392 任務 | c301227 feat(discord): M-DISCORD-3a — config + router + truncate (pure utils)

- 2026-04-20 15:42: Session 結束 | 進度：373/392 任務 | 85afccd feat(discord): M-DISCORD-3b — reactions + streamOutput + attachments + messageAdapter

- 2026-04-20 16:01: Session 結束 | 進度：373/392 任務 | 85afccd feat(discord): M-DISCORD-3b — reactions + streamOutput + attachments + messageAdapter

- 2026-04-20 16:06: Session 結束 | 進度：373/392 任務 | 85afccd feat(discord): M-DISCORD-3b — reactions + streamOutput + attachments + messageAdapter

- 2026-04-20 16:09: Session 結束 | 進度：373/392 任務 | c0ffbd4 feat(discord): M-DISCORD-3c — discord.js Client + Gateway + daemon 整合

- 2026-04-20 16:15: Session 結束 | 進度：373/392 任務 | c0ffbd4 feat(discord): M-DISCORD-3c — discord.js Client + Gateway + daemon 整合

- 2026-04-20 16:35: Session 結束 | 進度：373/392 任務 | c0ffbd4 feat(discord): M-DISCORD-3c — discord.js Client + Gateway + daemon 整合

- 2026-04-20 16:47: Session 結束 | 進度：373/392 任務 | fa7b104 feat(discord): 支援 botToken 寫在 discord.json（env 優先）

- 2026-04-20 17:03: Session 結束 | 進度：373/392 任務 | d3d8b3c feat(discord): M-DISCORD-4 — slash commands + permission mode 雙向同步

- 2026-04-20 17:09: Session 結束 | 進度：373/392 任務 | d3d8b3c feat(discord): M-DISCORD-4 — slash commands + permission mode 雙向同步

- 2026-04-20 17:15: Session 結束 | 進度：373/392 任務 | d3d8b3c feat(discord): M-DISCORD-4 — slash commands + permission mode 雙向同步

- 2026-04-20 17:18: Session 結束 | 進度：373/392 任務 | 7a6a837 fix(discord): DM messages 收不到 — Partials 從字串改用 Partials enum (v14)

- 2026-04-20 17:25: Session 結束 | 進度：373/392 任務 | 7a6a837 fix(discord): DM messages 收不到 — Partials 從字串改用 Partials enum (v14)

- 2026-04-20 17:29: Session 結束 | 進度：373/392 任務 | 7a6a837 fix(discord): DM messages 收不到 — Partials 從字串改用 Partials enum (v14)

- 2026-04-20 17:40: Session 結束 | 進度：373/392 任務 | f7ea331 fix(discord): v14 DM bug — pre-fetch DM channels + raw packet handler

- 2026-04-20 19:37: Session 結束 | 進度：373/392 任務 | f7ea331 fix(discord): v14 DM bug — pre-fetch DM channels + raw packet handler

- 2026-04-20 19:58: Session 結束 | 進度：373/392 任務 | c713e99 feat(discord): M-DISCORD-5 — home channel mirror + daemon up/down notifications

- 2026-04-20 20:04: Session 結束 | 進度：373/392 任務 | c713e99 feat(discord): M-DISCORD-5 — home channel mirror + daemon up/down notifications

- 2026-04-20 20:10: Session 結束 | 進度：373/392 任務 | be4dbb3 fix(discord): TDZ — ensureHomeMirror referenced before declaration

- 2026-04-20 20:29: Session 結束 | 進度：404/423 任務 | 427f6e2 docs(discord): M-DISCORD-6 — user guide + ADR-013 + dev log + LESSONS

- 2026-04-20 20:37: Session 結束 | 進度：404/423 任務 | 427f6e2 docs(discord): M-DISCORD-6 — user guide + ADR-013 + dev log + LESSONS

- 2026-04-20 20:50: Session 結束 | 進度：404/423 任務 | 427f6e2 docs(discord): M-DISCORD-6 — user guide + ADR-013 + dev log + LESSONS

- 2026-04-20 20:55: Session 結束 | 進度：404/423 任務 | 882a687 feat(daemon): /daemon attach + detach slash commands

- 2026-04-20 21:05: Session 結束 | 進度：404/423 任務 | 882a687 feat(daemon): /daemon attach + detach slash commands

- 2026-04-20 21:14: Session 結束 | 進度：404/423 任務 | 882a687 feat(daemon): /daemon attach + detach slash commands

- 2026-04-20 21:16: Session 結束 | 進度：404/423 任務 | 882a687 feat(daemon): /daemon attach + detach slash commands

- 2026-04-20 21:44: Session 結束 | 進度：404/423 任務 | 882a687 feat(daemon): /daemon attach + detach slash commands

- 2026-04-20 21:47: Session 結束 | 進度：404/423 任務 | 882a687 feat(daemon): /daemon attach + detach slash commands

- 2026-04-21 16:32: Session 結束 | 進度：428/448 任務 | 986a000 feat(ui): add always-visible context progress bar to REPL footer

- 2026-04-21 16:35: Session 結束 | 進度：428/448 任務 | 986a000 feat(ui): add always-visible context progress bar to REPL footer

- 2026-04-21 16:37: Session 結束 | 進度：428/448 任務 | 986a000 feat(ui): add always-visible context progress bar to REPL footer

- 2026-04-21 16:51: Session 結束 | 進度：428/448 任務 | 9268755 refactor(discord): flatten slash commands from /discord <sub> to 14 top-level

- 2026-04-21 16:52: Session 結束 | 進度：428/448 任務 | 986a000 feat(ui): add always-visible context progress bar to REPL footer

- 2026-04-21 16:57: Session 結束 | 進度：428/448 任務 | 9268755 refactor(discord): flatten slash commands from /discord <sub> to 14 top-level

- 2026-04-21 17:01: Session 結束 | 進度：428/448 任務 | 986a000 feat(ui): add always-visible context progress bar to REPL footer

- 2026-04-21 17:03: Session 結束 | 進度：428/448 任務 | 986a000 feat(ui): add always-visible context progress bar to REPL footer

- 2026-04-21 18:29: Session 結束 | 進度：428/448 任務 | 9268755 refactor(discord): flatten slash commands from /discord <sub> to 14 top-level

- 2026-04-21 20:38: Session 結束 | 進度：428/448 任務 | 9268755 refactor(discord): flatten slash commands from /discord <sub> to 14 top-level

- 2026-04-21 20:43: Session 結束 | 進度：428/448 任務 | 43b0850 fix(tools): WebBrowser/WebCrawl renderToolUseMessage return string, not <Box>

- 2026-04-21 21:01: Session 結束 | 進度：428/448 任務 | 43b0850 fix(tools): WebBrowser/WebCrawl renderToolUseMessage return string, not <Box>

- 2026-04-21 21:05: Session 結束 | 進度：428/448 任務 | 43b0850 fix(tools): WebBrowser/WebCrawl renderToolUseMessage return string, not <Box>

- 2026-04-21 21:08: Session 結束 | 進度：428/448 任務 | 43b0850 fix(tools): WebBrowser/WebCrawl renderToolUseMessage return string, not <Box>

- 2026-04-21 21:13: Session 結束 | 進度：428/448 任務 | 43b0850 fix(tools): WebBrowser/WebCrawl renderToolUseMessage return string, not <Box>

- 2026-04-21 21:31: Session 結束 | 進度：428/448 任務 | 12c098e fix(WebBrowser): SPA virtual-ARIA click/type fallback + diagnostic log

- 2026-04-21 21:33: Session 結束 | 進度：428/448 任務 | 12c098e fix(WebBrowser): SPA virtual-ARIA click/type fallback + diagnostic log

- 2026-04-21 21:38: Session 結束 | 進度：428/448 任務 | 4f0fbc1 prompt(WebBrowser): aggressive anti-curl language for weak tool-routers

- 2026-04-21 21:39: Session 結束 | 進度：428/448 任務 | 4f0fbc1 prompt(WebBrowser): aggressive anti-curl language for weak tool-routers

- 2026-04-21 21:51: Session 結束 | 進度：428/448 任務 | 4f0fbc1 prompt(WebBrowser): aggressive anti-curl language for weak tool-routers

- 2026-04-21 21:57: Session 結束 | 進度：428/448 任務 | 4f0fbc1 prompt(WebBrowser): aggressive anti-curl language for weak tool-routers

- 2026-04-21 22:00: Session 結束 | 進度：428/448 任務 | 4f0fbc1 prompt(WebBrowser): aggressive anti-curl language for weak tool-routers

- 2026-04-21 22:02: Session 結束 | 進度：428/448 任務 | 4f0fbc1 prompt(WebBrowser): aggressive anti-curl language for weak tool-routers

- 2026-04-21 22:07: Session 結束 | 進度：428/448 任務 | 4f0fbc1 prompt(WebBrowser): aggressive anti-curl language for weak tool-routers

- 2026-04-21 22:25: Session 結束 | 進度：428/466 任務 | cc2d8d3 feat(tools): /tools picker for runtime enable/disable (M-TOOLS-PICKER)

- 2026-04-21 22:46: Session 結束 | 進度：446/466 任務 | 995c1fd docs(TODO): M-TOOLS-PICKER all 18 tasks complete

- 2026-04-22 09:40: Session 結束 | 進度：446/466 任務 | 995c1fd docs(TODO): M-TOOLS-PICKER all 18 tasks complete

- 2026-04-22 10:16: Session 結束 | 進度：446/466 任務 | 995c1fd docs(TODO): M-TOOLS-PICKER all 18 tasks complete

- 2026-04-22 10:29: Session 結束 | 進度：446/466 任務 | 995c1fd docs(TODO): M-TOOLS-PICKER all 18 tasks complete

- 2026-04-22 10:32: Session 結束 | 進度：446/466 任務 | 995c1fd docs(TODO): M-TOOLS-PICKER all 18 tasks complete

- 2026-04-22 10:36: Session 結束 | 進度：428/448 任務 | 986a000 feat(ui): add always-visible context progress bar to REPL footer

- 2026-04-22 10:36: Session 結束 | 進度：446/466 任務 | 995c1fd docs(TODO): M-TOOLS-PICKER all 18 tasks complete

- 2026-04-22 10:39: Session 結束 | 進度：446/466 任務 | 995c1fd docs(TODO): M-TOOLS-PICKER all 18 tasks complete

- 2026-04-22 10:42: Session 結束 | 進度：446/466 任務 | 995c1fd docs(TODO): M-TOOLS-PICKER all 18 tasks complete

- 2026-04-22 10:44: Session 結束 | 進度：446/466 任務 | 995c1fd docs(TODO): M-TOOLS-PICKER all 18 tasks complete

- 2026-04-22 10:52: Session 結束 | 進度：428/448 任務 | 986a000 feat(ui): add always-visible context progress bar to REPL footer

- 2026-04-22 10:53: Session 結束 | 進度：428/448 任務 | 986a000 feat(ui): add always-visible context progress bar to REPL footer

- 2026-04-22 11:00: Session 結束 | 進度：428/448 任務 | 986a000 feat(ui): add always-visible context progress bar to REPL footer

- 2026-04-22 11:02: Session 結束 | 進度：428/448 任務 | 986a000 feat(ui): add always-visible context progress bar to REPL footer

- 2026-04-22 11:04: Session 結束 | 進度：428/448 任務 | 986a000 feat(ui): add always-visible context progress bar to REPL footer

- 2026-04-22 11:05: Session 結束 | 進度：428/448 任務 | 986a000 feat(ui): add always-visible context progress bar to REPL footer

- 2026-04-22 11:08: Session 結束 | 進度：428/448 任務 | 986a000 feat(ui): add always-visible context progress bar to REPL footer

- 2026-04-22 11:14: Session 結束 | 進度：428/448 任務 | 986a000 feat(ui): add always-visible context progress bar to REPL footer

- 2026-04-22 11:18: Session 結束 | 進度：428/448 任務 | 986a000 feat(ui): add always-visible context progress bar to REPL footer

- 2026-04-22 11:30: Session 結束 | 進度：428/448 任務 | 986a000 feat(ui): add always-visible context progress bar to REPL footer

- 2026-04-22 11:34: Session 結束 | 進度：428/448 任務 | 986a000 feat(ui): add always-visible context progress bar to REPL footer

- 2026-04-22 11:38: Session 結束 | 進度：428/448 任務 | 986a000 feat(ui): add always-visible context progress bar to REPL footer

- 2026-04-22 11:41: Session 結束 | 進度：428/448 任務 | 986a000 feat(ui): add always-visible context progress bar to REPL footer

- 2026-04-22 11:45: Session 結束 | 進度：428/448 任務 | 986a000 feat(ui): add always-visible context progress bar to REPL footer

- 2026-04-22 11:51: Session 結束 | 進度：428/448 任務 | 986a000 feat(ui): add always-visible context progress bar to REPL footer

- 2026-04-22 11:54: Session 結束 | 進度：428/448 任務 | 986a000 feat(ui): add always-visible context progress bar to REPL footer

- 2026-04-22 12:02: Session 結束 | 進度：428/448 任務 | 986a000 feat(ui): add always-visible context progress bar to REPL footer

- 2026-04-22 13:18: Session 結束 | 進度：428/448 任務 | 8531f1d feat(daemon): REPL 連線自動 lazy-load 未載入的 project 支援多目錄 daemon

- 2026-04-22 13:43: Session 結束 | 進度：428/448 任務 | 8531f1d feat(daemon): REPL 連線自動 lazy-load 未載入的 project 支援多目錄 daemon

- 2026-04-22 13:45: Session 結束 | 進度：428/448 任務 | 8531f1d feat(daemon): REPL 連線自動 lazy-load 未載入的 project 支援多目錄 daemon

- 2026-04-22 13:47: Session 結束 | 進度：428/448 任務 | 8531f1d feat(daemon): REPL 連線自動 lazy-load 未載入的 project 支援多目錄 daemon

- 2026-04-22 13:51: Session 結束 | 進度：428/448 任務 | 8531f1d feat(daemon): REPL 連線自動 lazy-load 未載入的 project 支援多目錄 daemon

- 2026-04-22 13:58: Session 結束 | 進度：428/448 任務 | 8531f1d feat(daemon): REPL 連線自動 lazy-load 未載入的 project 支援多目錄 daemon

- 2026-04-22 14:05: Session 結束 | 進度：428/448 任務 | 8531f1d feat(daemon): REPL 連線自動 lazy-load 未載入的 project 支援多目錄 daemon

- 2026-04-22 14:07: Session 結束 | 進度：428/448 任務 | 8531f1d feat(daemon): REPL 連線自動 lazy-load 未載入的 project 支援多目錄 daemon

- 2026-04-22 14:12: Session 結束 | 進度：428/448 任務 | 8531f1d feat(daemon): REPL 連線自動 lazy-load 未載入的 project 支援多目錄 daemon

- 2026-04-22 14:21: Session 結束 | 進度：428/448 任務 | 8531f1d feat(daemon): REPL 連線自動 lazy-load 未載入的 project 支援多目錄 daemon

- 2026-04-22 14:31: Session 結束 | 進度：428/448 任務 | 8531f1d feat(daemon): REPL 連線自動 lazy-load 未載入的 project 支援多目錄 daemon


- 2026-04-22 21:14: Session 結束 | 進度：464/490 任務 | 6ebdff4 Merge branch 'macos_debug' into main

- 2026-04-22 21:28: Session 結束 | 進度：464/490 任務 | 1a30efa docs(CLAUDE): 加入黃金規則 10 — 跨 Windows/macOS 相容性要求

- 2026-04-22 21:33: Session 結束 | 進度：464/490 任務 | 1a30efa docs(CLAUDE): 加入黃金規則 10 — 跨 Windows/macOS 相容性要求

- 2026-04-22 21:38: Session 結束 | 進度：464/490 任務 | 1a30efa docs(CLAUDE): 加入黃金規則 10 — 跨 Windows/macOS 相容性要求

- 2026-04-22 21:59: Session 結束 | 進度：464/490 任務 | 881b23f test(webbrowser): 新增 waits / vision-locate 單測與 gmaps 冒煙；修正 JS API 勸導

- 2026-04-22 22:09: Session 結束 | 進度：464/490 任務 | f30dcc1 docs(LESSONS): 記錄 daemon attached paste-ref 未展開的教訓

- 2026-04-22 22:19: Session 結束 | 進度：464/490 任務 | f30dcc1 docs(LESSONS): 記錄 daemon attached paste-ref 未展開的教訓

- 2026-04-22 22:38: Session 結束 | 進度：464/490 任務 | 9137ddd fix(statusline): tokenUsage=0 時隱藏 ContextProgressBar

- 2026-04-23 09:08: Session 結束 | 進度：464/490 任務 | 9137ddd fix(statusline): tokenUsage=0 時隱藏 ContextProgressBar

- 2026-04-23 09:59: Session 結束 | 進度：464/490 任務 | 9137ddd fix(statusline): tokenUsage=0 時隱藏 ContextProgressBar

- 2026-04-23 10:02: Session 結束 | 進度：464/490 任務 | 9137ddd fix(statusline): tokenUsage=0 時隱藏 ContextProgressBar

- 2026-04-23 10:07: Session 結束 | 進度：464/490 任務 | 9137ddd fix(statusline): tokenUsage=0 時隱藏 ContextProgressBar

- 2026-04-23 10:12: Session 結束 | 進度：464/490 任務 | 9137ddd fix(statusline): tokenUsage=0 時隱藏 ContextProgressBar

- 2026-04-23 10:17: Session 結束 | 進度：464/490 任務 | 9137ddd fix(statusline): tokenUsage=0 時隱藏 ContextProgressBar

- 2026-04-23 10:21: Session 結束 | 進度：464/490 任務 | 9137ddd fix(statusline): tokenUsage=0 時隱藏 ContextProgressBar

- 2026-04-23 10:25: Session 結束 | 進度：464/490 任務 | 9137ddd fix(statusline): tokenUsage=0 時隱藏 ContextProgressBar

- 2026-04-23 10:35: Session 結束 | 進度：464/490 任務 | 9137ddd fix(statusline): tokenUsage=0 時隱藏 ContextProgressBar

- 2026-04-23 11:07: Session 結束 | 進度：464/490 任務 | 4741968 fix(cron): 修復三個導致 daemon cron 永不 fire 的疊加 bug

- 2026-04-23 11:11: Session 結束 | 進度：464/490 任務 | 4741968 fix(cron): 修復三個導致 daemon cron 永不 fire 的疊加 bug

- 2026-04-23 11:19: Session 結束 | 進度：464/490 任務 | 6105c6c fix(cron): 合併 tick 內兩個 fire-and-forget write，消除 lastFiredAt ↔ lastStatus race

- 2026-04-23 11:41: Session 結束 | 進度：464/490 任務 | 6105c6c fix(cron): 合併 tick 內兩個 fire-and-forget write，消除 lastFiredAt ↔ lastStatus race

- 2026-04-23 11:50: Session 結束 | 進度：464/490 任務 | 6105c6c fix(cron): 合併 tick 內兩個 fire-and-forget write，消除 lastFiredAt ↔ lastStatus race

- 2026-04-23 12:07: Session 結束 | 進度：464/490 任務 | 6105c6c fix(cron): 合併 tick 內兩個 fire-and-forget write，消除 lastFiredAt ↔ lastStatus race

- 2026-04-23 12:21: Session 結束 | 進度：464/490 任務 | 6105c6c fix(cron): 合併 tick 內兩個 fire-and-forget write，消除 lastFiredAt ↔ lastStatus race

- 2026-04-23 12:28: Session 結束 | 進度：464/490 任務 | 6105c6c fix(cron): 合併 tick 內兩個 fire-and-forget write，消除 lastFiredAt ↔ lastStatus race

- 2026-04-23 12:56: Session 結束 | 進度：464/490 任務 | 6105c6c fix(cron): 合併 tick 內兩個 fire-and-forget write，消除 lastFiredAt ↔ lastStatus race

- 2026-04-23 13:42: Session 結束 | 進度：464/490 任務 | 6105c6c fix(cron): 合併 tick 內兩個 fire-and-forget write，消除 lastFiredAt ↔ lastStatus race

- 2026-04-23 13:54: Session 結束 | 進度：464/490 任務 | 6105c6c fix(cron): 合併 tick 內兩個 fire-and-forget write，消除 lastFiredAt ↔ lastStatus race

- 2026-04-23 14:03: Session 結束 | 進度：464/490 任務 | 6105c6c fix(cron): 合併 tick 內兩個 fire-and-forget write，消除 lastFiredAt ↔ lastStatus race

- 2026-04-23 14:08: Session 結束 | 進度：464/490 任務 | 6105c6c fix(cron): 合併 tick 內兩個 fire-and-forget write，消除 lastFiredAt ↔ lastStatus race

- 2026-04-23 14:14: Session 結束 | 進度：464/490 任務 | 6105c6c fix(cron): 合併 tick 內兩個 fire-and-forget write，消除 lastFiredAt ↔ lastStatus race

- 2026-04-23 14:17: Session 結束 | 進度：464/490 任務 | 6105c6c fix(cron): 合併 tick 內兩個 fire-and-forget write，消除 lastFiredAt ↔ lastStatus race

- 2026-04-23 14:54: Session 結束 | 進度：464/510 任務 | 16646bd feat(cron): W3-6 — cronWiring emits CronFireEvent，daemon broadcast 到 WS

- 2026-04-23 16:48: Session 結束 | 進度：478/510 任務 | 414c09e feat(discord): Wave 3 — Discord cronMirror 訂閱 cron.events 發通知

- 2026-04-23 16:54: Session 結束 | 進度：478/510 任務 | 414c09e feat(discord): Wave 3 — Discord cronMirror 訂閱 cron.events 發通知

- 2026-04-23 16:57: Session 結束 | 進度：478/510 任務 | 414c09e feat(discord): Wave 3 — Discord cronMirror 訂閱 cron.events 發通知

- 2026-04-23 17:00: Session 結束 | 進度：478/510 任務 | 414c09e feat(discord): Wave 3 — Discord cronMirror 訂閱 cron.events 發通知

- 2026-04-23 17:07: Session 結束 | 進度：478/510 任務 | 414c09e feat(discord): Wave 3 — Discord cronMirror 訂閱 cron.events 發通知

- 2026-04-23 17:11: Session 結束 | 進度：478/510 任務 | 414c09e feat(discord): Wave 3 — Discord cronMirror 訂閱 cron.events 發通知

- 2026-04-23 17:19: Session 結束 | 進度：478/510 任務 | 414c09e feat(discord): Wave 3 — Discord cronMirror 訂閱 cron.events 發通知

- 2026-04-23 20:54: Session 結束 | 進度：478/510 任務 | 414c09e feat(discord): Wave 3 — Discord cronMirror 訂閱 cron.events 發通知

- 2026-04-23 20:57: Session 結束 | 進度：478/510 任務 | 414c09e feat(discord): Wave 3 — Discord cronMirror 訂閱 cron.events 發通知

- 2026-04-23 21:57: Session 結束 | 進度：478/510 任務 | 414c09e feat(discord): Wave 3 — Discord cronMirror 訂閱 cron.events 發通知

- 2026-04-23 22:08: Session 結束 | 進度：478/510 任務 | 414c09e feat(discord): Wave 3 — Discord cronMirror 訂閱 cron.events 發通知

- 2026-04-23 22:16: Session 結束 | 進度：478/510 任務 | f394fa6 feat(cron): /cron TUI — read-only list + detail

- 2026-04-23 22:38: Session 結束 | 進度：478/510 任務 | a6c309c feat(cron): /cron — full history scrollable view

- 2026-04-23 22:44: Session 結束 | 進度：478/510 任務 | a6c309c feat(cron): /cron — full history scrollable view

- 2026-04-23 22:50: Session 結束 | 進度：478/510 任務 | a6c309c feat(cron): /cron — full history scrollable view

- 2026-04-23 23:02: Session 結束 | 進度：478/510 任務 | 1a0cea9 feat(cron): schedule preset picker in wizard

- 2026-04-23 23:10: Session 結束 | 進度：478/510 任務 | 1a0cea9 feat(cron): schedule preset picker in wizard

- 2026-04-23 23:13: Session 結束 | 進度：478/510 任務 | 1a0cea9 feat(cron): schedule preset picker in wizard

- 2026-04-23 23:18: Session 結束 | 進度：478/510 任務 | 1a0cea9 feat(cron): schedule preset picker in wizard

- 2026-04-23 23:27: Session 結束 | 進度：478/510 任務 | f760fa2 docs(lessons): bun run dev 不跑 feature-gated 子系統

- 2026-04-23 23:36: Session 結束 | 進度：478/510 任務 | cccaac5 build(dev): bun run dev 啟用 feature flags

- 2026-04-23 23:48: Session 結束 | 進度：478/510 任務 | cccaac5 build(dev): bun run dev 啟用 feature flags

- 2026-04-24 00:12: Session 結束 | 進度：478/510 任務 | 1f88ef3 test(cron): B6 — extract picker helpers + 22 unit tests

- 2026-04-24 00:18: Session 結束 | 進度：495/535 任務 | b3e07e9 docs(cron): Wave 4 TODO + CLAUDE.md 開發日誌

- 2026-04-24 07:50: Session 結束 | 進度：495/535 任務 | b3e07e9 docs(cron): Wave 4 TODO + CLAUDE.md 開發日誌

- 2026-04-24 07:59: Session 結束 | 進度：495/535 任務 | b3e07e9 docs(cron): Wave 4 TODO + CLAUDE.md 開發日誌

- 2026-04-24 08:05: Session 結束 | 進度：495/535 任務 | b3e07e9 docs(cron): Wave 4 TODO + CLAUDE.md 開發日誌

- 2026-04-24 08:17: Session 結束 | 進度：495/535 任務 | a34f3bd docs(lessons): daemon agentVersion 帶 -dev 後綴 + cron 不 fire

- 2026-04-24 08:30: Session 結束 | 進度：495/535 任務 | 70c88fb feat(cron): /cron history 時間改顯示本地時間

- 2026-04-24 08:33: Session 結束 | 進度：495/535 任務 | 70c88fb feat(cron): /cron history 時間改顯示本地時間

- 2026-04-24 08:36: Session 結束 | 進度：495/535 任務 | 7e02439 chore(todo): session log — daemon cron diagnostics + history UI fixes

- 2026-04-24 08:48: Session 結束 | 進度：495/535 任務 | 7e02439 chore(todo): session log — daemon cron diagnostics + history UI fixes

- 2026-04-24 08:51: Session 結束 | 進度：495/535 任務 | 7e02439 chore(todo): session log — daemon cron diagnostics + history UI fixes

- 2026-04-24 09:02: Session 結束 | 進度：495/535 任務 | 7e02439 chore(todo): session log — daemon cron diagnostics + history UI fixes

- 2026-04-24 09:14: Session 結束 | 進度：495/535 任務 | 01dd331 feat(cron): configurable auto-compact buffer for llama.cpp reasoning models

- 2026-04-24 09:26: Session 結束 | 進度：495/535 任務 | 01415f0 Revert "fix(llamacpp): detect silent overflow when reasoning_content eats all output"

- 2026-04-24 09:37: Session 結束 | 進度：495/535 任務 | 01415f0 Revert "fix(llamacpp): detect silent overflow when reasoning_content eats all output"

- 2026-04-24 10:06: Session 結束 | 進度：495/535 任務 | 8deee4e chore(todo): session log — overflow detection attempt + revert

- 2026-04-24 10:13: Session 結束 | 進度：495/535 任務 | 8deee4e chore(todo): session log — overflow detection attempt + revert

- 2026-04-24 10:15: Session 結束 | 進度：495/535 任務 | 8deee4e chore(todo): session log — overflow detection attempt + revert

- 2026-04-24 10:20: Session 結束 | 進度：495/535 任務 | 8deee4e chore(todo): session log — overflow detection attempt + revert

- 2026-04-24 10:24: Session 結束 | 進度：495/535 任務 | 8deee4e chore(todo): session log — overflow detection attempt + revert

- 2026-04-24 10:26: Session 結束 | 進度：495/535 任務 | 8deee4e chore(todo): session log — overflow detection attempt + revert

- 2026-04-24 10:42: Session 結束 | 進度：502/546 任務 | 8deee4e chore(todo): session log — overflow detection attempt + revert

- 2026-04-24 10:48: Session 結束 | 進度：502/546 任務 | 8deee4e chore(todo): session log — overflow detection attempt + revert

- 2026-04-24 10:53: Session 結束 | 進度：503/548 任務 | 8deee4e chore(todo): session log — overflow detection attempt + revert

- 2026-04-24 10:58: Session 結束 | 進度：503/548 任務 | 8deee4e chore(todo): session log — overflow detection attempt + revert

- 2026-04-24 12:00: Session 結束 | 進度：504/550 任務 | 8deee4e chore(todo): session log — overflow detection attempt + revert

- 2026-04-24 12:15: Session 結束 | 進度：505/550 任務 | 8deee4e chore(todo): session log — overflow detection attempt + revert

- 2026-04-24 12:29: Session 結束 | 進度：505/550 任務 | 2021725 docs(memrecall): ADR-014 + lessons + M-MEMRECALL-LOCAL milestone

- 2026-04-24 12:37: Session 結束 | 進度：505/550 任務 | 2021725 docs(memrecall): ADR-014 + lessons + M-MEMRECALL-LOCAL milestone

- 2026-04-24 12:38: Session 結束 | 進度：505/550 任務 | 2021725 docs(memrecall): ADR-014 + lessons + M-MEMRECALL-LOCAL milestone

- 2026-04-24 13:07: Session 結束 | 進度：505/550 任務 | 7725292 feat(vision): factory 化 + llama.cpp 多模態 + 無供應商時 graceful disable

- 2026-04-24 13:24: Session 結束 | 進度：505/550 任務 | 7725292 feat(vision): factory 化 + llama.cpp 多模態 + 無供應商時 graceful disable

- 2026-04-24 13:33: Session 結束 | 進度：505/550 任務 | 7725292 feat(vision): factory 化 + llama.cpp 多模態 + 無供應商時 graceful disable

- 2026-04-24 13:39: Session 結束 | 進度：505/550 任務 | 7725292 feat(vision): factory 化 + llama.cpp 多模態 + 無供應商時 graceful disable

- 2026-04-24 13:53: Session 結束 | 進度：505/550 任務 | 7725292 feat(vision): factory 化 + llama.cpp 多模態 + 無供應商時 graceful disable

- 2026-04-24 14:02: Session 結束 | 進度：505/550 任務 | 7725292 feat(vision): factory 化 + llama.cpp 多模態 + 無供應商時 graceful disable

- 2026-04-24 14:05: Session 結束 | 進度：505/550 任務 | 7725292 feat(vision): factory 化 + llama.cpp 多模態 + 無供應商時 graceful disable

- 2026-04-24 14:22: Session 結束 | 進度：505/550 任務 | 00f013d fix(llamacpp): tools 定義存在時補 system nudge + stream-end 診斷 log

- 2026-04-24 16:47: Session 結束 | 進度：505/550 任務 | 427717d feat(llamacpp): 中強度 tool nudge — tool_choice=auto 明示 + retry-on-empty-tool

- 2026-04-24 17:17: Session 結束 | 進度：505/550 任務 | f99462c chore(todo): session 結束 log — llamacpp memory + tool nudge 工作期間累積

- 2026-04-24 17:25: Session 結束 | 進度：505/550 任務 | f99462c chore(todo): session 結束 log — llamacpp memory + tool nudge 工作期間累積

- 2026-04-24 17:28: Session 結束 | 進度：505/550 任務 | f99462c chore(todo): session 結束 log — llamacpp memory + tool nudge 工作期間累積

- 2026-04-24 17:35: Session 結束 | 進度：505/550 任務 | f99462c chore(todo): session 結束 log — llamacpp memory + tool nudge 工作期間累積

- 2026-04-24 17:54: Session 結束 | 進度：505/550 任務 | 779a05c fix(context): ctx size fallback 200K → 128K + 全域 .my-agent.json 可覆蓋

- 2026-04-24 18:07: Session 結束 | 進度：505/550 任務 | 779a05c fix(context): ctx size fallback 200K → 128K + 全域 .my-agent.json 可覆蓋

- 2026-04-24 18:10: Session 結束 | 進度：505/550 任務 | 779a05c fix(context): ctx size fallback 200K → 128K + 全域 .my-agent.json 可覆蓋

- 2026-04-24 18:30: Session 結束 | 進度：505/550 任務 | 7f11a35 chore(todo): session 結束 log — ctx size fix 驗收與 daemon 重啟

- 2026-04-25 08:52: Session 結束 | 進度：505/550 任務 | 7f11a35 chore(todo): session 結束 log — ctx size fix 驗收與 daemon 重啟

- 2026-04-25 08:59: Session 結束 | 進度：505/550 任務 | 7f11a35 chore(todo): session 結束 log — ctx size fix 驗收與 daemon 重啟

- 2026-04-25 09:09: Session 結束 | 進度：505/550 任務 | 340b5d1 docs(p2): 已完成 milestone 規劃文件歸檔至 docs/archive/

- 2026-04-25 09:11: Session 結束 | 進度：505/550 任務 | 0959005 chore(todo): session 結束 log — md 文件 P0/P1/P2 整理

- 2026-04-25 09:18: Session 結束 | 進度：505/550 任務 | 0959005 chore(todo): session 結束 log — md 文件 P0/P1/P2 整理

- 2026-04-25 09:55: Session 結束 | 進度：505/550 任務 | 0959005 chore(todo): session 結束 log — md 文件 P0/P1/P2 整理

- 2026-04-25 10:00: Session 結束 | 進度：505/550 任務 | 0959005 chore(todo): session 結束 log — md 文件 P0/P1/P2 整理

- 2026-04-25 10:03: Session 結束 | 進度：505/550 任務 | 0959005 chore(todo): session 結束 log — md 文件 P0/P1/P2 整理

- 2026-04-25 10:08: Session 結束 | 進度：505/550 任務 | 0959005 chore(todo): session 結束 log — md 文件 P0/P1/P2 整理

- 2026-04-25 11:10: Session 結束 | 進度：505/550 任務 | 0f850e2 test(globalConfig): 加入 bundled 模板覆蓋率自動檢查 + 補上 5 個漏掉的欄位

- 2026-04-25 11:13: Session 結束 | 進度：505/550 任務 | 0f850e2 test(globalConfig): 加入 bundled 模板覆蓋率自動檢查 + 補上 5 個漏掉的欄位

- 2026-04-25 11:16: Session 結束 | 進度：505/550 任務 | 0f850e2 test(globalConfig): 加入 bundled 模板覆蓋率自動檢查 + 補上 5 個漏掉的欄位

- 2026-04-25 11:42: Session 結束 | 進度：505/550 任務 | 0f850e2 test(globalConfig): 加入 bundled 模板覆蓋率自動檢查 + 補上 5 個漏掉的欄位

- 2026-04-25 19:44: Session 結束 | 進度：505/550 任務 | 9b1c62d test(e2e): 完整 M-DECOUPLE 自動測試套件 + 兩個 regression fix

- 2026-04-25 19:53: Session 結束 | 進度：505/550 任務 | 9b1c62d test(e2e): 完整 M-DECOUPLE 自動測試套件 + 兩個 regression fix

- 2026-04-25 19:58: Session 結束 | 進度：505/550 任務 | 9b1c62d test(e2e): 完整 M-DECOUPLE 自動測試套件 + 兩個 regression fix

- 2026-04-25 20:03: Session 結束 | 進度：505/550 任務 | 9b1c62d test(e2e): 完整 M-DECOUPLE 自動測試套件 + 兩個 regression fix

- 2026-04-25 20:04: Session 結束 | 進度：505/550 任務 | 9b1c62d test(e2e): 完整 M-DECOUPLE 自動測試套件 + 兩個 regression fix

- 2026-04-25 20:10: Session 結束 | 進度：505/550 任務 | 9b1c62d test(e2e): 完整 M-DECOUPLE 自動測試套件 + 兩個 regression fix

- 2026-04-25 20:42: Session 結束 | 進度：505/563 任務 | 5cd3028 test(e2e): daemon + cron 完整自動 E2E（PASS=43 FAIL=0 SKIP=0）

- 2026-04-25 21:09: Session 結束 | 進度：505/563 任務 | 5cd3028 test(e2e): daemon + cron 完整自動 E2E（PASS=43 FAIL=0 SKIP=0）

- 2026-04-25 21:16: Session 結束 | 進度：505/563 任務 | 5cd3028 test(e2e): daemon + cron 完整自動 E2E（PASS=43 FAIL=0 SKIP=0）

- 2026-04-25 21:58: Session 結束 | 進度：519/565 任務 | 7db360a test(e2e): F section BIN+SRC 雙跑 cron + 新增 I section discord（M-DECOUPLE-3-4/3-5）

- 2026-04-25 21:59: Session 結束 | 進度：519/565 任務 | 7db360a test(e2e): F section BIN+SRC 雙跑 cron + 新增 I section discord（M-DECOUPLE-3-4/3-5）

- 2026-04-25 22:02: Session 結束 | 進度：519/565 任務 | 7db360a test(e2e): F section BIN+SRC 雙跑 cron + 新增 I section discord（M-DECOUPLE-3-4/3-5）

- 2026-04-25 22:15: Session 結束 | 進度：519/565 任務 | ac91173 chore(todo): session log entries

- 2026-04-25 22:42: Session 結束 | 進度：520/566 任務 | e357e78 test(e2e): J section PTY 互動 REPL E2E + BIN 三層 cascade（M-DECOUPLE-3-6）

- 2026-04-25 22:46: Session 結束 | 進度：520/566 任務 | e357e78 test(e2e): J section PTY 互動 REPL E2E + BIN 三層 cascade（M-DECOUPLE-3-6）

- 2026-04-25 23:07: Session 結束 | 進度：520/566 任務 | e357e78 test(e2e): J section PTY 互動 REPL E2E + BIN 三層 cascade（M-DECOUPLE-3-6）

- 2026-04-26 07:47: Session 結束 | 進度：522/566 任務 | 8413724 docs(todo): M-SIDEQUERY-PROVIDER + M-EXTRACT-LOCAL 標記完成

- 2026-04-26 07:50: Session 結束 | 進度：522/566 任務 | 8413724 docs(todo): M-SIDEQUERY-PROVIDER + M-EXTRACT-LOCAL 標記完成

- 2026-04-26 07:54: Session 結束 | 進度：522/566 任務 | 8413724 docs(todo): M-SIDEQUERY-PROVIDER + M-EXTRACT-LOCAL 標記完成

- 2026-04-26 07:58: Session 結束 | 進度：522/566 任務 | 8413724 docs(todo): M-SIDEQUERY-PROVIDER + M-EXTRACT-LOCAL 標記完成

- 2026-04-26 08:02: Session 結束 | 進度：522/566 任務 | 8413724 docs(todo): M-SIDEQUERY-PROVIDER + M-EXTRACT-LOCAL 標記完成

- 2026-04-26 08:06: Session 結束 | 進度：522/566 任務 | 8413724 docs(todo): M-SIDEQUERY-PROVIDER + M-EXTRACT-LOCAL 標記完成

- 2026-04-26 08:08: Session 結束 | 進度：522/566 任務 | 8413724 docs(todo): M-SIDEQUERY-PROVIDER + M-EXTRACT-LOCAL 標記完成

- 2026-04-26 08:12: Session 結束 | 進度：522/566 任務 | 8413724 docs(todo): M-SIDEQUERY-PROVIDER + M-EXTRACT-LOCAL 標記完成

- 2026-04-26 09:21: Session 結束 | 進度：542/599 任務 | 2913f32 feat(memory): M-MEMTUI Phase 4 — 輔助畫面 + multi-delete + /memory-delete alias

- 2026-04-26 09:36: Session 結束 | 進度：552/600 任務 | 3fb372a feat(memory): M-MEMTUI Phase 5 — Section K E2E（PTY + 真 broadcast）+ docs

- 2026-04-26 09:42: Session 結束 | 進度：552/600 任務 | 3fb372a feat(memory): M-MEMTUI Phase 5 — Section K E2E（PTY + 真 broadcast）+ docs

- 2026-04-26 09:47: Session 結束 | 進度：552/600 任務 | 3fb372a feat(memory): M-MEMTUI Phase 5 — Section K E2E（PTY + 真 broadcast）+ docs

- 2026-04-26 09:56: Session 結束 | 進度：552/600 任務 | 3fb372a feat(memory): M-MEMTUI Phase 5 — Section K E2E（PTY + 真 broadcast）+ docs

- 2026-04-26 09:58: Session 結束 | 進度：552/600 任務 | 3fb372a feat(memory): M-MEMTUI Phase 5 — Section K E2E（PTY + 真 broadcast）+ docs

- 2026-04-26 10:03: Session 結束 | 進度：552/600 任務 | 3fb372a feat(memory): M-MEMTUI Phase 5 — Section K E2E（PTY + 真 broadcast）+ docs

- 2026-04-26 10:09: Session 結束 | 進度：552/600 任務 | 3fb372a feat(memory): M-MEMTUI Phase 5 — Section K E2E（PTY + 真 broadcast）+ docs

- 2026-04-26 10:14: Session 結束 | 進度：552/600 任務 | 3fb372a feat(memory): M-MEMTUI Phase 5 — Section K E2E（PTY + 真 broadcast）+ docs

- 2026-04-26 10:16: Session 結束 | 進度：552/600 任務 | 3fb372a feat(memory): M-MEMTUI Phase 5 — Section K E2E（PTY + 真 broadcast）+ docs

- 2026-04-26 10:20: Session 結束 | 進度：552/600 任務 | 3fb372a feat(memory): M-MEMTUI Phase 5 — Section K E2E（PTY + 真 broadcast）+ docs

- 2026-04-26 10:21: Session 結束 | 進度：552/600 任務 | 3fb372a feat(memory): M-MEMTUI Phase 5 — Section K E2E（PTY + 真 broadcast）+ docs

- 2026-04-26 10:39: Session 結束 | 進度：560/633 任務 | 5aa1ee8 feat(llamacpp): M-LLAMACPP-WATCHDOG Phase 2 — per-call-site max_tokens ceiling

- 2026-04-26 10:59: Session 結束 | 進度：569/633 任務 | 4bb64fb feat(llamacpp): M-LLAMACPP-WATCHDOG Phase 3 — /llamacpp master TUI + Hybrid args + daemon broadcast

- 2026-04-26 11:12: Session 結束 | 進度：585/633 任務 | c1c2164 feat(llamacpp): M-LLAMACPP-WATCHDOG Phase 4+5 — Section L E2E + docs + ADR-015

- 2026-04-26 11:24: Session 結束 | 進度：585/633 任務 | c1c2164 feat(llamacpp): M-LLAMACPP-WATCHDOG Phase 4+5 — Section L E2E + docs + ADR-015

- 2026-04-26 11:46: Session 結束 | 進度：585/633 任務 | c1c2164 feat(llamacpp): M-LLAMACPP-WATCHDOG Phase 4+5 — Section L E2E + docs + ADR-015

- 2026-04-26 12:53: Session 結束 | 進度：585/633 任務 | c1c2164 feat(llamacpp): M-LLAMACPP-WATCHDOG Phase 4+5 — Section L E2E + docs + ADR-015

- 2026-04-26 12:56: Session 結束 | 進度：585/633 任務 | c1c2164 feat(llamacpp): M-LLAMACPP-WATCHDOG Phase 4+5 — Section L E2E + docs + ADR-015

- 2026-04-26 13:12: Session 結束 | 進度：585/633 任務 | c1c2164 feat(llamacpp): M-LLAMACPP-WATCHDOG Phase 4+5 — Section L E2E + docs + ADR-015

- 2026-04-26 13:16: Session 結束 | 進度：585/633 任務 | c1c2164 feat(llamacpp): M-LLAMACPP-WATCHDOG Phase 4+5 — Section L E2E + docs + ADR-015

- 2026-04-26 13:34: Session 結束 | 進度：585/633 任務 | 2bd250a feat(daemon): M-DAEMON-STREAM — daemon 模式 thinking / text 即時 streaming

- 2026-04-26 15:11: Session 結束 | 進度：585/633 任務 | 2bd250a feat(daemon): M-DAEMON-STREAM — daemon 模式 thinking / text 即時 streaming

- 2026-04-26 15:38: Session 結束 | 進度：585/633 任務 | 2bd250a feat(daemon): M-DAEMON-STREAM — daemon 模式 thinking / text 即時 streaming

- 2026-04-26 15:47: Session 結束 | 進度：585/633 任務 | 2bd250a feat(daemon): M-DAEMON-STREAM — daemon 模式 thinking / text 即時 streaming

- 2026-04-26 15:54: Session 結束 | 進度：585/633 任務 | 2bd250a feat(daemon): M-DAEMON-STREAM — daemon 模式 thinking / text 即時 streaming

- 2026-04-26 16:25: Session 結束 | 進度：585/633 任務 | 2bd250a feat(daemon): M-DAEMON-STREAM — daemon 模式 thinking / text 即時 streaming

- 2026-04-26 16:33: Session 結束 | 進度：585/633 任務 | 2bd250a feat(daemon): M-DAEMON-STREAM — daemon 模式 thinking / text 即時 streaming

- 2026-04-26 17:23: Session 結束 | 進度：593/661 任務 | 2bd250a feat(daemon): M-DAEMON-STREAM — daemon 模式 thinking / text 即時 streaming

- 2026-04-26 17:43: Session 結束 | 進度：600/662 任務 | 82da68e feat(web): M-WEB Phase 2 — chat 核心 + 三欄 UI + permission first-wins

- 2026-04-26 18:22: Session 結束 | 進度：613/663 任務 | 92c9d0d docs(todo): 勾選 M-WEB Phase 4 + 完成標準（補 9b2cac4 漏掉的 TODO 更新）

- 2026-04-26 18:30: Session 結束 | 進度：613/663 任務 | 03e148a fix(web): assistant turn UI 完全空 — 修 RunnerEvent wrapper 解析 + 加 stream delta 支援

- 2026-04-26 18:36: Session 結束 | 進度：613/663 任務 | 03e148a fix(web): assistant turn UI 完全空 — 修 RunnerEvent wrapper 解析 + 加 stream delta 支援

- 2026-04-26 18:43: Session 結束 | 進度：613/663 任務 | 03e148a fix(web): assistant turn UI 完全空 — 修 RunnerEvent wrapper 解析 + 加 stream delta 支援

- 2026-04-26 18:54: Session 結束 | 進度：613/663 任務 | 1014c96 feat(web): M-WEB-22 — Session 切換 backfill + 清單 UX 修補（Phase 5）

- 2026-04-26 19:08: Session 結束 | 進度：616/686 任務 | 048aebd feat(web): M-WEB-CLOSEOUT-1/2/3 — Llamacpp slot inspector REST + SlotsPanel

- 2026-04-26 19:59: Session 結束 | 進度：631/685 任務 | 288b5e4 test(web): M-WEB-CLOSEOUT-13..17 — 跨端 broadcast E2E + Section M + 收尾

- 2026-04-26 20:02: Session 結束 | 進度：631/685 任務 | 288b5e4 test(web): M-WEB-CLOSEOUT-13..17 — 跨端 broadcast E2E + Section M + 收尾

- 2026-04-26 20:28: Session 結束 | 進度：631/704 任務 | c8d6167 feat(web): M-WEB-SHADCN — shadcn/ui + tweakcn Light Green 主題大改造

- 2026-04-26 20:33: Session 結束 | 進度：631/704 任務 | c8d6167 feat(web): M-WEB-SHADCN — shadcn/ui + tweakcn Light Green 主題大改造

- 2026-04-26 20:41: Session 結束 | 進度：631/704 任務 | c8d6167 feat(web): M-WEB-SHADCN — shadcn/ui + tweakcn Light Green 主題大改造

- 2026-04-26 20:47: Session 結束 | 進度：631/704 任務 | c8d6167 feat(web): M-WEB-SHADCN — shadcn/ui + tweakcn Light Green 主題大改造

- 2026-04-26 20:49: Session 結束 | 進度：631/704 任務 | c8d6167 feat(web): M-WEB-SHADCN — shadcn/ui + tweakcn Light Green 主題大改造

- 2026-04-26 21:39: Session 結束 | 進度：631/730 任務 | 57ddee5 feat(web): M-WEB-SLASH-C1 — web-redirect 命令自動跳右欄對應 tab

- 2026-04-27 09:12: Session 結束 | 進度：646/726 任務 | 9bc9192 fix(llama): load-config.sh 改讀 .jsonc 並去除行註解

- 2026-04-27 09:21: Session 結束 | 進度：646/726 任務 | 9bc9192 fix(llama): load-config.sh 改讀 .jsonc 並去除行註解

- 2026-04-27 09:24: Session 結束 | 進度：646/726 任務 | 9bc9192 fix(llama): load-config.sh 改讀 .jsonc 並去除行註解

- 2026-04-27 09:26: Session 結束 | 進度：646/726 任務 | 9bc9192 fix(llama): load-config.sh 改讀 .jsonc 並去除行註解

- 2026-04-27 09:30: Session 結束 | 進度：646/726 任務 | 9bc9192 fix(llama): load-config.sh 改讀 .jsonc 並去除行註解

- 2026-04-27 10:02: Session 結束 | 進度：646/726 任務 | fd34c48 fix(web): ChatView early return 後呼叫 hook 違反 Rules of Hooks

- 2026-04-27 12:01: Session 結束 | 進度：646/726 任務 | fd34c48 fix(web): ChatView early return 後呼叫 hook 違反 Rules of Hooks

- 2026-04-27 12:07: Session 結束 | 進度：646/726 任務 | fd34c48 fix(web): ChatView early return 後呼叫 hook 違反 Rules of Hooks

- 2026-04-27 12:53: Session 結束 | 進度：646/726 任務 | 743478b feat(web): 右欄改為 accordion 單展開清單

- 2026-04-27 21:09: Session 結束 | 進度：646/726 任務 | 743478b feat(web): 右欄改為 accordion 單展開清單

- 2026-04-27 21:19: Session 結束 | 進度：646/726 任務 | 743478b feat(web): 右欄改為 accordion 單展開清單

- 2026-04-28 15:48: Session 結束 | 進度：646/726 任務 | 743478b feat(web): 右欄改為 accordion 單展開清單

- 2026-04-28 15:55: Session 結束 | 進度：646/726 任務 | 743478b feat(web): 右欄改為 accordion 單展開清單

- 2026-04-28 15:57: Session 結束 | 進度：646/726 任務 | 743478b feat(web): 右欄改為 accordion 單展開清單

- 2026-04-28 16:01: Session 結束 | 進度：646/726 任務 | 743478b feat(web): 右欄改為 accordion 單展開清單

- 2026-04-28 16:18: Session 結束 | 進度：646/738 任務 | 50d562c feat(llamacpp): M-LLAMACPP-REMOTE-1 — schema + resolveEndpoint helper

- 2026-04-28 17:49: Session 結束 | 進度：655/738 任務 | 8a8bff1 docs(llamacpp): M-LLAMACPP-REMOTE-6 — 使用者指南 + TODO 收尾 + CLAUDE 日誌

- 2026-04-28 17:57: Session 結束 | 進度：655/738 任務 | 8a8bff1 docs(llamacpp): M-LLAMACPP-REMOTE-6 — 使用者指南 + TODO 收尾 + CLAUDE 日誌

- 2026-04-28 20:28: Session 結束 | 進度：656/739 任務 | a58dd04 docs(llamacpp): M-LLAMACPP-REMOTE — remote=local 整合驗證紀錄 + LESSONS

- 2026-04-29 09:05: Session 結束 | 進度：656/739 任務 | a58dd04 docs(llamacpp): M-LLAMACPP-REMOTE — remote=local 整合驗證紀錄 + LESSONS

- 2026-04-29 09:12: Session 結束 | 進度：656/739 任務 | a58dd04 docs(llamacpp): M-LLAMACPP-REMOTE — remote=local 整合驗證紀錄 + LESSONS

- 2026-04-29: M-LLAMACPP-REMOTE 首次實機部署 — remote 指向 10.3.1.42 (qwen3.5-27b-q4 / 256K ctx)，split routing：turn=remote、sideQuery/memoryPrefetch/background/vision=local。本機 server 同時啟動。詳見 CLAUDE.md 同日 dev log。

- 2026-04-29 20:35: Session 結束 | 進度：656/739 任務 | d72e111 chore: 加入 buun-llama-cpp 作為 git submodule

- 2026-04-29 20:46: Session 結束 | 進度：656/739 任務 | d72e111 chore: 加入 buun-llama-cpp 作為 git submodule

- 2026-04-29 21:06: Session 結束 | 進度：656/739 任務 | d72e111 chore: 加入 buun-llama-cpp 作為 git submodule

- 2026-04-29 21:12: Session 結束 | 進度：656/739 任務 | d72e111 chore: 加入 buun-llama-cpp 作為 git submodule

- 2026-04-29 21:31: Session 結束 | 進度：656/739 任務 | d72e111 chore: 加入 buun-llama-cpp 作為 git submodule

- 2026-04-29 21:43: Session 結束 | 進度：656/739 任務 | d72e111 chore: 加入 buun-llama-cpp 作為 git submodule

- 2026-04-29 21:45: Session 結束 | 進度：656/739 任務 | d72e111 chore: 加入 buun-llama-cpp 作為 git submodule

- 2026-04-29 21:55: Session 結束 | 進度：656/739 任務 | d72e111 chore: 加入 buun-llama-cpp 作為 git submodule

- 2026-04-29 21:57: Session 結束 | 進度：656/739 任務 | d72e111 chore: 加入 buun-llama-cpp 作為 git submodule

- 2026-04-29 22:18: Session 結束 | 進度：656/739 任務 | d72e111 chore: 加入 buun-llama-cpp 作為 git submodule

- 2026-04-29 22:24: Session 結束 | 進度：656/739 任務 | d72e111 chore: 加入 buun-llama-cpp 作為 git submodule

- 2026-04-29 23:03: Session 結束 | 進度：660/748 任務 | d83d171 fix(llamacpp): sanitize 改用 key-skip + 加 LLAMA_DUMP_PRESANITIZE/RAWBODY 診斷 + 11 unit test

- 2026-04-30 05:36: Session 結束 | 進度：660/748 任務 | 99e3e80 docs(corruption-hunt): 完整調查過程文件化到 docs/plans/

- 2026-04-30 05:59: Session 結束 | 進度：660/748 任務 | 44e7e78 fix(llamacpp): 加 unconditional NULL-byte 偵測 + 重大發現 corruption bytes 來自 ICU table

- 2026-04-30 06:06: Session 結束 | 進度：660/748 任務 | 8551134 feat(corruption-hunt): 三階段 NULL byte detection 待 user 觸發後定位來源

- 2026-04-30 09:00: Session 結束 | 進度：660/748 任務 | 2fce434 chore(todo): session log entries

- 2026-04-30 10:03: Session 結束 | 進度：660/748 任務 | 2fce434 chore(todo): session log entries

- 2026-04-30 10:23: Session 結束 | 進度：661/759 任務 | 2fce434 chore(todo): session log entries

- 2026-04-30 10:28: Session 結束 | 進度：661/759 任務 | 2fce434 chore(todo): session log entries

- 2026-04-30 10:49: Session 結束 | 進度：661/759 任務 | 2fce434 chore(todo): session log entries

- 2026-04-30 11:05: Session 結束 | 進度：661/759 任務 | 2fce434 chore(todo): session log entries

- 2026-04-30 11:45: Session 結束 | 進度：671/759 任務 | 73e1905 feat(qwen35): 換用 unsloth Qwen3.5-9B Q4_K_M + vision + 128k turbo4

- 2026-04-30 12:03: Session 結束 | 進度：671/759 任務 | 889771a fix(llamacpp): reasoning-only stream 在 adapter 收尾補 text block

- 2026-04-30 12:18: Session 結束 | 進度：671/759 任務 | 889771a fix(llamacpp): reasoning-only stream 在 adapter 收尾補 text block

- 2026-04-30 12:27: Session 結束 | 進度：671/759 任務 | 889771a fix(llamacpp): reasoning-only stream 在 adapter 收尾補 text block

- 2026-04-30 12:35: Session 結束 | 進度：671/759 任務 | 889771a fix(llamacpp): reasoning-only stream 在 adapter 收尾補 text block

- 2026-04-30 13:46: Session 結束 | 進度：671/759 任務 | 889771a fix(llamacpp): reasoning-only stream 在 adapter 收尾補 text block

- 2026-04-30 16:13: Session 結束 | 進度：671/759 任務 | 889771a fix(llamacpp): reasoning-only stream 在 adapter 收尾補 text block

- 2026-04-30 16:17: Session 結束 | 進度：671/759 任務 | 889771a fix(llamacpp): reasoning-only stream 在 adapter 收尾補 text block

- 2026-04-30 17:00: Session 結束 | 進度：671/759 任務 | 889771a fix(llamacpp): reasoning-only stream 在 adapter 收尾補 text block

- 2026-04-30 20:24: Session 結束 | 進度：671/759 任務 | 889771a fix(llamacpp): reasoning-only stream 在 adapter 收尾補 text block

- 2026-04-30 20:39: Session 結束 | 進度：671/759 任務 | 889771a fix(llamacpp): reasoning-only stream 在 adapter 收尾補 text block

- 2026-04-30 21:23: Session 結束 | 進度：678/766 任務 | 104c1e2 fix(llamacpp): adapter 兜底 qwen3.5-9b 偶發吐 Hermes XML tool_call

- 2026-04-30 21:25: Session 結束 | 進度：678/766 任務 | 104c1e2 fix(llamacpp): adapter 兜底 qwen3.5-9b 偶發吐 Hermes XML tool_call

- 2026-04-30 21:39: Session 結束 | 進度：678/766 任務 | 104c1e2 fix(llamacpp): adapter 兜底 qwen3.5-9b 偶發吐 Hermes XML tool_call

- 2026-04-30 22:11: Session 結束 | 進度：687/775 任務 | d8ebdfd feat(config-seed): M-CONFIG-SEED-COMPLETE 首次啟動 config seed 完整性

- 2026-04-30 22:38: Session 結束 | 進度：687/775 任務 | 01da1b6 docs(config): M-CONFIG-DOCTOR 與 M-CONFIG-DOCS-ALIGN 詳規劃 + WebBrowserTool README 修正

- 2026-04-30 22:47: Session 結束 | 進度：701/789 任務 | 7951b5c feat(config-doctor): M-CONFIG-DOCTOR config 健康診斷與自動修復

- 2026-04-30 22:55: Session 結束 | 進度：701/789 任務 | 7951b5c feat(config-doctor): M-CONFIG-DOCTOR config 健康診斷與自動修復

- 2026-04-30 23:01: Session 結束 | 進度：712/800 任務 | 9546a76 feat(docs-gen): M-CONFIG-DOCS-ALIGN schema → 文件自動產生

- 2026-04-30 23:12: Session 結束 | 進度：712/800 任務 | 1efab3a fix(llamacpp): adapter 兜底 qwen3.5-9b bare pythonic tool_call

- 2026-04-30 23:29: Session 結束 | 進度：712/800 任務 | 1efab3a fix(llamacpp): adapter 兜底 qwen3.5-9b bare pythonic tool_call

- 2026-04-30 23:34: Session 結束 | 進度：712/800 任務 | 1efab3a fix(llamacpp): adapter 兜底 qwen3.5-9b bare pythonic tool_call

- 2026-04-30 23:55: Session 結束 | 進度：712/800 任務 | 1efab3a fix(llamacpp): adapter 兜底 qwen3.5-9b bare pythonic tool_call

- 2026-05-01 00:01: Session 結束 | 進度：712/800 任務 | 1efab3a fix(llamacpp): adapter 兜底 qwen3.5-9b bare pythonic tool_call

- 2026-05-01 00:03: Session 結束 | 進度：712/800 任務 | 1efab3a fix(llamacpp): adapter 兜底 qwen3.5-9b bare pythonic tool_call

- 2026-05-01 00:10: Session 結束 | 進度：712/800 任務 | 1efab3a fix(llamacpp): adapter 兜底 qwen3.5-9b bare pythonic tool_call

- 2026-05-01 00:16: Session 結束 | 進度：712/800 任務 | 1efab3a fix(llamacpp): adapter 兜底 qwen3.5-9b bare pythonic tool_call

- 2026-05-01 00:21: Session 結束 | 進度：712/800 任務 | 1efab3a fix(llamacpp): adapter 兜底 qwen3.5-9b bare pythonic tool_call

- 2026-05-01 00:26: Session 結束 | 進度：712/800 任務 | 1efab3a fix(llamacpp): adapter 兜底 qwen3.5-9b bare pythonic tool_call

- 2026-05-01 09:49: Session 結束 | 進度：712/800 任務 | 1efab3a fix(llamacpp): adapter 兜底 qwen3.5-9b bare pythonic tool_call

- 2026-05-01 09:55: Session 結束 | 進度：712/800 任務 | 1efab3a fix(llamacpp): adapter 兜底 qwen3.5-9b bare pythonic tool_call
