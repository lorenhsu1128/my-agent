# M-WEB：Discord 風格 Web UI 嵌入 daemon

## Context

my-agent 目前有兩個前端：Ink TUI（REPL）與 Discord gateway（M-DISCORD）。兩者透過 daemon 內的 ProjectRegistry / sessionBroker / permissionRouter 共享同一份多 project state。本里程碑新增第三個前端：**嵌在 daemon 內的 Web UI**，瀏覽器透過 LAN IP 連入即可使用。

**目的**：
- 讓 my-agent 可在不開終端機的情境下使用（手機 / 平板 / 同事的瀏覽器）
- TUI / Discord / Web 三端對同一 ProjectRuntime 雙向同步（送訊息、permission 批准、cron 改設定任一端均同步）
- 把 TUI 已有功能完整 React-DOM 化，建立長期 UI 雙渲染路線基底

**範圍決策**（與使用者對齊 12 輪後鎖定）：
- **A 雙向訊息同步** + **B 無認證 IP-only**（W2 預設綁 0.0.0.0）+ **C Discord 三欄式**
- **D Vite + React 獨立 `web/` 專案**（daemon serve dist）
- **E `/web` master TUI**（start/stop/status/open/qr/config）
- **F3 嵌在 daemon 內額外開 port**（同一 process、共用 broker reference）
- **G1 完全 React 重寫**（TUI 全 parity，含右欄 R3 cron/memory/llamacpp 全 CRUD）
- **H3 跨 session 切換**（左欄兩層樹 M1，FTS5 搜尋）
- **J2 Phase A 含 chat + permission + 5 個核心 slash**（/clear /interrupt /allow /deny /mode）
- **K2 web 內部 protocol bridge**（browser 看到乾淨 REST + WS，不直送 daemon thin-client frame）
- **L2 右欄 Discord context-panel 風**（跟著左欄 selected project 切）
- **P2 master TUI（/cron /memory /llamacpp）導向右欄；其他 slash 第一刀不支援**
- **Q2 web 可 add/remove project**（call daemon `loadProject(cwd)`）
- **S3 雙向 session 建立同步**（任一端開新 session 即時廣播）
- **T1 一刀切**（單一大 milestone，內含 ~12 個 sub-task commit）
- **V3 `~/.my-agent/web.json` 控制 port + autoStart**（預設 port 9090，conflict +1）

預估工期：**8–12 週**（單人）。

---

## 架構總覽

### 程序結構（F3）

```
daemon process (single Bun process)
├── Bun.serve #1 (existing, 127.0.0.1:os-assigned)
│   └── /sessions  WS  → thin-client (REPL)
└── Bun.serve #2 (NEW, 0.0.0.0:9090)
    ├── /api/*    HTTP REST
    ├── /ws       WS (browser ↔ web bridge)
    └── /*        static files (web/dist/*)
```

採「**第二個獨立 Bun.serve**」而非單一 listener fetch 分支：因為 (a) 綁定 host 不同（loopback vs 0.0.0.0）、(b) 認證模型不同（thin-client 走 bearer，web 無認證）、(c) 故障隔離（web 出問題不影響 thin-client）。

`WebGateway` 在 daemon 啟動時依 `web.json.autoStart` 條件 spawn 第二 listener，與 Discord gateway 並列為 `registry.onLoad / onUnload` listener。

### 模組結構

```
my-agent/
├── web/                          # NEW — Vite + React + TS + Tailwind
│   ├── package.json              # 獨立依賴，不污染主 package.json
│   ├── vite.config.ts
│   ├── tsconfig.json
│   ├── tailwind.config.ts
│   ├── index.html
│   ├── public/
│   └── src/
│       ├── main.tsx              # React 進入點 + router
│       ├── App.tsx               # 三欄 layout
│       ├── api/
│       │   ├── client.ts         # REST client (fetch wrapper)
│       │   ├── ws.ts             # WS client + auto-reconnect
│       │   └── types.ts          # browser-side type defs
│       ├── store/
│       │   ├── projectStore.ts   # zustand: project list + selected
│       │   ├── sessionStore.ts   # session list + selected + messages
│       │   ├── permissionStore.ts
│       │   └── settingsStore.ts  # cron/memory/llamacpp state
│       ├── pages/
│       │   ├── Layout.tsx
│       │   ├── ProjectChat.tsx
│       │   └── NotFound.tsx
│       ├── components/
│       │   ├── leftPanel/
│       │   │   ├── ProjectList.tsx
│       │   │   ├── ProjectItem.tsx
│       │   │   ├── SessionTree.tsx        # M1 兩層樹
│       │   │   └── AddProjectDialog.tsx   # Q2
│       │   ├── chat/
│       │   │   ├── MessageList.tsx
│       │   │   ├── MessageItem.tsx
│       │   │   ├── ToolCallCard.tsx       # Discord-embed 風格
│       │   │   ├── ThinkingBlock.tsx      # collapsed by default
│       │   │   ├── DiffViewer.tsx
│       │   │   ├── CodeBlock.tsx          # shiki
│       │   │   ├── InputBar.tsx           # multi-line + slash autocomplete
│       │   │   ├── PermissionPrompt.tsx   # modal
│       │   │   └── StreamingIndicator.tsx
│       │   ├── rightPanel/
│       │   │   ├── ContextPanel.tsx       # tab container (L2)
│       │   │   ├── tabs/
│       │   │   │   ├── CronTab.tsx        # R3：reuses cronPickerLogic
│       │   │   │   ├── CronCreateForm.tsx
│       │   │   │   ├── CronScheduleEditor.tsx
│       │   │   │   ├── MemoryTab.tsx      # R3：reuses memoryManagerLogic
│       │   │   │   ├── MemoryEditWizard.tsx
│       │   │   │   ├── LlamacppTab.tsx    # R3：reuses llamacppManagerLogic
│       │   │   │   ├── DiscordTab.tsx     # bind/unbind/whitelist
│       │   │   │   └── PermissionsTab.tsx # mode toggle + recent requests
│       │   ├── common/
│       │   │   ├── Modal.tsx
│       │   │   ├── Toast.tsx
│       │   │   └── DisconnectedBanner.tsx
│       └── styles/
│           └── theme.css         # Discord 配色（深色為主）
│
├── src/
│   ├── webConfig/                # NEW — 沿用 discordConfig pattern
│   │   ├── schema.ts             # Zod: enabled / port / autoStart / bindHost / starredProjects
│   │   ├── paths.ts              # ~/.my-agent/web.json
│   │   ├── loader.ts             # frozen snapshot
│   │   ├── seed.ts               # default seed
│   │   └── index.ts
│   ├── web/                      # NEW — daemon 內 web bridge
│   │   ├── webGateway.ts         # 對 DiscordGateway 的 web 鏡像
│   │   ├── httpServer.ts         # Bun.serve #2
│   │   ├── staticServer.ts       # web/dist 靜態檔 + SPA fallback
│   │   ├── restRoutes.ts         # /api/* 路由
│   │   ├── wsServer.ts           # /ws WS handler
│   │   ├── wsBroadcast.ts        # 跨 browser 廣播
│   │   ├── browserSession.ts     # 每個 browser tab 的 session state
│   │   ├── translator.ts         # daemon frame ↔ web JSON schema 雙向轉譯
│   │   ├── messageBackfill.ts    # 讀 sessionIndex / JSONL
│   │   └── webTypes.ts           # 對外 API 型別（與 web/src/api/types.ts 共生）
│   ├── daemon/
│   │   ├── webRpc.ts             # NEW — /web start/stop/status RPC handler
│   │   └── daemonCli.ts          # MODIFIED — 啟 webGateway
│   ├── commands/
│   │   └── web/                  # NEW — `/web` master TUI
│   │       ├── index.ts
│   │       ├── web.tsx
│   │       ├── WebManager.tsx    # master TUI（mirror /llamacpp 兩 tab pattern）
│   │       ├── webManagerLogic.ts
│   │       ├── webMutations.ts
│   │       └── argsParser.ts     # /web start/stop/status/open/qr/config 子指令
│   └── components/web/           # NEW
│       ├── WebStatusTab.tsx      # status / running / port / connected clients
│       ├── WebConfigTab.tsx      # port / autoStart / bindHost
│       └── QrCodeView.tsx        # ASCII QR
│
└── tests/integration/web/        # NEW — 單元 + integration tests
    ├── webGateway.test.ts
    ├── translator.test.ts
    ├── webRpc.test.ts
    ├── messageBackfill.test.ts
    ├── webManagerLogic.test.ts
    └── webMutations.test.ts
```

### Browser ↔ daemon protocol（K2 bridge schema）

#### REST endpoints（`/api/*`）

| Method | Path | 用途 |
|---|---|---|
| GET | `/api/health` | `{ ok, daemonUp, version, uptime }` |
| GET | `/api/projects` | 列已 load 的 ProjectRuntime（id, name, cwd, idleSince, attachedClients, hasActiveTurn）|
| POST | `/api/projects` | body `{ cwd }` → 呼叫 `registry.loadProject(cwd)` |
| DELETE | `/api/projects/:id` | unload |
| GET | `/api/projects/:id/sessions` | session 列表（M1 樹左欄子節點）|
| POST | `/api/projects/:id/sessions` | 新建 session（S3）|
| GET | `/api/projects/:id/sessions/:sid/messages?before=&limit=100` | lazy load 訊息（H3）|
| GET | `/api/projects/:id/search?q=&limit=50` | sessionIndex FTS5 搜尋 |
| GET | `/api/projects/:id/cron` | cron 任務列表（reuse cronPickerLogic.enrich）|
| POST `/PUT/DELETE/PATCH` | `/api/projects/:id/cron[/...]` | reuse cronMutationRpc 5 ops |
| GET | `/api/projects/:id/memory` | memory entry 列表（5 tab 整合）|
| POST `/PUT/DELETE` | `/api/projects/:id/memory[/...]` | reuse memoryMutationRpc 5 ops |
| GET | `/api/llamacpp/config` | 全域 watchdog config（**無 projectId**，與 cron/memory 不同）|
| PUT | `/api/llamacpp/config` | reuse llamacppConfigRpc setWatchdog |
| GET | `/api/projects/:id/permissionMode` | 當前 mode |
| PUT | `/api/projects/:id/permissionMode` | 切換 mode（觸發 permissionModeChanged 廣播）|
| GET | `/api/discord/status` | Discord 啟用 / bot 名 / guild 數 |
| POST | `/api/discord/bind` `/unbind` | reuse discordBindRpc |

translator.ts 把每個 REST request 轉成對應的 daemon frame（cron.mutation / memory.mutation 等），等 result frame 回來再翻譯成 HTTP JSON response。

#### WS endpoint（`/ws`）

WS 是 server → browser 廣播為主、browser → server 是 stream input + 輕量 op。

**server → browser 事件**（`event` 欄位）：
- `hello` — 連線確認，含 daemonVersion / serverTime / availableProjects
- `project.added` / `project.removed` / `project.updated` — registry 變動廣播
- `session.created` / `session.deleted` / `session.updated`（S3 雙向同步）
- `turn.start` — { projectId, sessionId, inputId, source∈{repl, web, discord, cron, agent}, clientId, startedAt }
- `turn.event` — { projectId, sessionId, inputId, runnerEvent }（streaming 主要載體）
- `turn.end` — { projectId, sessionId, inputId, reason, error?, durationMs }
- `permission.pending` — { projectId, toolUseID, toolName, input, riskLevel, description, affectedPaths }
- `permission.resolved` — { projectId, toolUseID, decision, by∈{repl, web, discord} }
- `permission.modeChanged` — { projectId, mode }
- `cron.tasksChanged` — { projectId }（觸發 web 重抓 /api/projects/:id/cron）
- `memory.itemsChanged` — { projectId }
- `llamacpp.configChanged` — 無 projectId
- `cron.fired` — { projectId, taskId, ts }（mirror cronFireEvent，做 toast 用）

**browser → server 事件**：
- `subscribe` — { projectIds: string[] }（決定該 tab 要收哪些 project 的廣播）
- `input.submit` — { projectId, sessionId?, text, intent∈{interactive, background, slash} }
- `input.interrupt` — { projectId, inputId }
- `permission.respond` — { projectId, toolUseID, decision, updatedInput? }
- `permissionContextSync` — { projectId, mode }（與 thin-client 同 frame，daemon 端共用 handler）

`webGateway.ts` 為每個 ProjectRuntime 訂閱 `broker.queue.on('turnStart' | 'runnerEvent' | 'turnEnd')`、`permissionRouter.onPending / onResolved`、`cron.events.on('cronFireEvent')`，把事件透過 `wsBroadcast.ts` 廣播給所有 browser tab，同時根據 `subscribe` 訂閱清單做 per-tab 過濾。

### 三端同步機制

| 動作來源 | 觸發路徑 | 同步效果 |
|---|---|---|
| TUI 送訊息 | `broker.queue.submit({source: 'repl'})` | broker 廣播 → DiscordGateway / WebGateway 各自 mirror |
| Web 送訊息 | `wsServer` 收 `input.submit` → `runtime.broker.queue.submit({source: 'web', clientId})` | 同 broker pattern；TUI / Discord 收到 `runnerEvent` 顯示 |
| Discord 送訊息 | DiscordGateway → `broker.queue.submit({source: 'discord'})` | Web / TUI 都收到 turn 開始 + 串流 |
| Permission 批准 | 任一端送 `permissionResponse` → `permissionRouter.handleResponse()`（first-wins）| 其他端收 `permissionResolved` 清掉 modal |
| Permission mode 切 | 任一端 `setPermissionMode` → `broadcastPermissionMode` callback | 三端同步 |
| Cron CRUD | 任一端 → `cronMutationRpc` → 廣播 `cron.tasksChanged` | 其他端重抓列表 |
| Memory CRUD | 同上 → `memoryMutationRpc` → `memory.itemsChanged` | 同上 |
| Session 新建 | 任一端 → 新 session 寫盤 + 廣播 `session.created` | M1 左欄樹刷新 |

### 訊息 backfill / FTS5 搜尋（H3）

- **進入 session**：browser 呼叫 `GET /api/projects/:id/sessions/:sid/messages?limit=100`，daemon 從 sessionIndex SQLite 讀最近 100 條（依 `ORDER BY message_index DESC`）
- **上滑載更多**：`?before=<message_index>&limit=100`，再讀 100 條
- **跨 session 搜尋**：`GET /api/projects/:id/search?q=foo` 走 FTS5 `MATCH 'foo'`
- 假設 sessionIndex 已暴露 read API；若未暴露需在 `src/services/sessionIndex/` 新增 `getMessagesBySession()` / `searchProject()`（探索結果說「search read API not yet fully exposed」）

### `/web` master TUI（沿用 /llamacpp 兩 tab 架構）

- **Tab 1：Status** — 顯示 running / port / bindHost / connectedClients / uptime / config-summary；按鍵 `s` start、`x` stop、`o` open browser、`q` show QR
- **Tab 2：Config** — 編 port / autoStart / bindHost；變更後寫 `web.json` + 重啟 listener
- 子指令 hybrid：`/web` 進 TUI、`/web start`、`/web stop`、`/web status`、`/web open`、`/web qr`、`/web config <key> <value>` 直接套
- 實作 mirror /llamacpp 結構：`webManagerLogic.ts` 純函式、`webMutations.ts` 寫盤、`argsParser.ts` 子指令解析、daemon RPC 透過 `src/daemon/webRpc.ts`（broadcast `web.statusChanged` 給 attached REPL 同步狀態列 badge）

---

## Sub-task 拆分（commit 級別）

每個 commit 自成可 typecheck + 冒煙測試的單元：

### Phase 1 — Infra & 骨架（2 週）
1. **M-WEB-1**：`web/` Vite 專案 scaffold（React 18 + TS + Tailwind + zustand + react-router）+ `bun run build:web` script + `bun run dev:web`（Vite dev port 5173）
2. **M-WEB-2**：`webConfig/` 模組 5 檔（schema/paths/loader/seed/index）+ `~/.my-agent/web.README.md` seed
3. **M-WEB-3**：`src/web/httpServer.ts` + `staticServer.ts` 第二個 Bun.serve listener，serve `web/dist` + SPA fallback；daemonCli 條件啟動（autoStart）
4. **M-WEB-4**：`src/web/wsServer.ts` + `wsBroadcast.ts` + `browserSession.ts` WS 連線管理（heartbeat / reconnect）
5. **M-WEB-5**：`src/web/webGateway.ts` 訂閱 `registry.onLoad/onUnload` + per-runtime `broker.queue` / `permissionRouter` / `cron.events` listener；mirror DiscordGateway pattern
6. **M-WEB-6**：`src/web/translator.ts` daemon frame ↔ web JSON 雙向轉譯 + 對應 unit tests
7. **M-WEB-7**：`/web` master TUI 5 檔 + `src/daemon/webRpc.ts`（start/stop/status）+ `commands.ts` 註冊；`web.statusChanged` daemon 廣播

### Phase 2 — Chat 核心（3 週）
8. **M-WEB-8**：`/api/projects` + `/api/sessions` REST 路由（GET 列表、POST 新建、DELETE unload；S3 廣播 `session.created`）
9. **M-WEB-9**：`web/` 三欄 layout 骨架 + 左欄 ProjectList + SessionTree（M1 兩層樹）+ Q2 add/remove project dialog
10. **M-WEB-10**：中欄 MessageList + MessageItem + ToolCallCard + ThinkingBlock + CodeBlock（shiki）+ DiffViewer；訊息 data shape 對齊 `messages.ts:2898+` `StreamingToolUse / StreamingThinking`
11. **M-WEB-11**：WS `turn.start/event/end` 串流接收 + 增量 render；`messageBackfill.ts` 讀 sessionIndex 最近 100 條
12. **M-WEB-12**：InputBar 雙向送訊息（multi-line / Shift+Enter / 5 個核心 slash autocomplete）+ turn 進行中其他 client disabled lock
13. **M-WEB-13**：PermissionPrompt modal + first-wins race + `permission.resolved` 清 modal；permission mode toggle（status bar）

### Phase 3 — 右欄 R3 全 CRUD（3-4 週）
14. **M-WEB-14**：`/api/cron` REST + 新 daemon helper（reuse cronMutationRpc handler）；CronTab + CronCreateForm + CronScheduleEditor（reuse cronPickerLogic.enrich/sortEnriched/labels）
15. **M-WEB-15**：`/api/memory` REST + MemoryTab 5-tab 結構（reuse memoryManagerLogic.tabs/filter/sort）+ MemoryEditWizard（frontmatter 編輯）+ injection 警告
16. **M-WEB-16**：`/api/llamacpp/config` REST + LlamacppTab（reuse llamacppManagerLogic.WATCHDOG_FIELDS）+ slot inspector 即時 polling
17. **M-WEB-17**：DiscordTab（bind/unbind/whitelist 透過既有 discordBindRpc / discordAdminRpc bridge）+ PermissionsTab（mode + recent requests log）

### Phase 4 — H3 跨 session 搜尋 + 收尾（1-2 週）
18. **M-WEB-18**：`src/services/sessionIndex/` 加 `getMessagesBySession(sid, before?, limit)` + `searchProject(pid, query, limit)` read API（若尚未存在）；上滑 lazy load + FTS 搜尋框
19. **M-WEB-19**：DisconnectedBanner + 自動重連（5/10/30s backoff）+ daemon offline 降級 read-only
20. **M-WEB-20**：QR code（ASCII QR in TUI、PNG QR endpoint `/api/qr` for browser）+ `/web open` opens default browser（cross-platform：`start` / `open` / `xdg-open`）
21. **M-WEB-21**：跨平台 build verify（Windows + macOS）+ `docs/web-mode.md` 使用者指南 + ADR-016 + CLAUDE.md 開發日誌 + LESSONS.md

每個 sub-task 完成標準：typecheck 通過 + `./cli -p hello` 冒煙 + 對應 unit test 全綠（依 LESSONS.md「commit 前必跑冒煙測」+「自己讀 log」），總計新增 ~150–200 個 unit test。

---

## 關鍵檔案（現存、會被修改）

- `src/daemon/daemonCli.ts:432-502` — 啟 / 停 webGateway，注入 broadcast callbacks
- `src/server/directConnectServer.ts:128` — **不修改**（保留 thin-client server 不動，新 listener 獨立）
- `src/daemon/projectRegistry.ts:80-107` — reuse `onLoad/onUnload/listProjects/loadProject/unloadProject`
- `src/daemon/permissionRouter.ts:85-150` — reuse `setFallbackHandler/onPending/onResolved`
- `src/daemon/sessionBroker.ts:54-58` — reuse `queue.submit + queue.on`
- `src/daemon/cronMutationRpc.ts` / `memoryMutationRpc.ts` / `llamacppConfigRpc.ts` — REST 路由內部呼叫 handler，不重寫邏輯
- `src/discord/gateway.ts:336-341` — **作為 webGateway.ts 範本**（registry listener 模式）
- `src/discord/replMirror.ts:154-207` — **作為 webGateway 訂閱 pattern 範本**
- `src/utils/messages.ts:2898-2944` — `StreamingToolUse/StreamingThinking` 共用 type，web 直接 import
- `src/services/sessionIndex/db.ts` `schema.ts` — 加 read API（getMessagesBySession / searchProject）
- `src/utils/sessionStorage.ts` — `Project.Map<cwd, Project>` 已支援 multi-project，無需動
- `src/commands.ts:255-350` — 新增 `web` command
- `package.json` — 加 `build:web` / `dev:web` script；`web/package.json` 獨立依賴

---

## 驗證計畫

### 自動測試
- 純函式 unit：webManagerLogic / translator / messageBackfill / browserSession reconnect logic（~80 tests）
- daemon-side integration：webGateway lifecycle / WS broadcast / REST routes / project lifecycle subscription（~40 tests，mock browser ws client）
- frontend：vitest + React Testing Library 測 store + key components（~60 tests）

### 手動 E2E
1. **三端同步驗證**：A 開 TUI → B 開 web tab → C 開 Discord DM → A 送 `hi` → B/C 即時看到 turn；B 在 web 送 `count` → A/C 收到
2. **Permission first-wins**：B 觸發 ToolUse 等批准 → A 在 TUI 按 y → B/C 的 permission modal 自動消失
3. **Cron CRUD 三端同步**：A 在 TUI `/cron` 建立任務 → B web 右欄 CronTab 即時刷出
4. **Memory edit 同步**：B 在 web 編 memory entry → A 重啟 TUI / `/memory` 看到變更
5. **Session 切換 + 歷史 backfill**：B 點左欄歷史 session → 中欄載入舊訊息 → 上滑載更多
6. **斷線重連**：daemon 重啟 → web 顯示 disconnected banner → daemon 起 → 自動重連 + 補抓錯過的 turn
7. **Q2 project 管理**：web 點「+」加新 cwd → daemon 載入新 ProjectRuntime → A TUI `attach <cwd>` 可連
8. **跨平台**：Windows + macOS 各跑一次 `/web start`、open browser、build / serve dist

### Section 加進 `tests/e2e/decouple-comprehensive.sh`
- Section M：M-WEB E2E（含 PTY 起 daemon + curl REST + headless browser ws client smoke）

### Bench
- WS broadcast 1000 tab 訂閱壓力測（reuse cron-fire 連發測 broker 廣播 throughput）
- LAN latency：訊息 token 第一個 byte → browser 顯示 < 100ms

### 安全 self-check（即使 W2 不警告）
- 所有 REST 路由都要做 path traversal 檢查（`/api/projects/:id/sessions/:sid` 不可帶 `..`）
- secret scan：訊息 / log / cron prompt 出去前 reuse `src/utils/web/secretScan.ts`（M4 已有）
- 確認 `bindHost = '0.0.0.0'` 寫死提示一行 daemon log，方便事後 audit

---

## Out of scope（後續 milestone）

- **M-WEB-MOBILE**：手機 responsive（漢堡選單折三欄）
- **M-WEB-AUTH**：bearer token / 帳號登入（如使用者改變主意要 LAN 外暴露）
- **M-WEB-NOTIF**：browser native notification（permission ask、turnEnd 提醒）
- **M-WEB-ATTACHMENT**：圖片 / 檔案上傳 drag-drop 對 web input 解開
- **M-WEB-MULTI-USER**：多 browser tab 同 turn 並發送訊息（目前 turn 進行中其他 tab disabled lock）
- **M-WEB-SLASH-FULL**：剩下 ~80 個 slash command 的 React-DOM port（Phase A 只做 5 個 + 4 個 master TUI）
- **M-WEB-AGENT-VIEW**：Agent 工具呼叫的 sub-agent 樹狀視覺化
- **M-WEB-DIFF-RICH**：side-by-side diff、syntax highlight 對齊 GitHub
