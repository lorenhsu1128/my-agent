# Web Mode（M-WEB）

從 v2026-04-26 起，my-agent 內建 Discord 風格 Web UI，嵌在 daemon process 內。
瀏覽器透過 LAN IP 連入即可使用，與 TUI / Discord 三端對同一 ProjectRuntime
雙向同步（送訊息、permission 批准、cron / memory / llamacpp 設定任一端均同步）。

## 啟動

1. 編輯 `~/.my-agent/web.jsonc`：

   ```jsonc
   {
     "enabled": true,
     "autoStart": true,
     "port": 9090,
     "bindHost": "0.0.0.0"  // LAN 全開；要限本機改 "127.0.0.1"
   }
   ```

2. 啟 daemon（會自動起 web）：

   ```bash
   my-agent daemon start
   ```

3. 在 REPL 內或 daemon 啟動 log 看實際綁定 URL，或在 REPL 跑：

   ```
   /web status      # 顯示 running / port / 連線 URL 清單
   /web open        # 在預設瀏覽器開啟
   /web qr          # 印 ASCII QR code 給手機掃
   ```

4. 正常瀏覽器網址：`http://<LAN-IP>:9090`（如 `http://192.168.1.50:9090`）。

## 三欄式 UI

```
┌──────────────┬───────────────────────────────┬──────────────┐
│ Projects     │  Chat                         │ Context Panel│
│              │                               │              │
│  ▾ project-a │  Assistant: hello             │ [Overview]   │
│      sess-1  │  …                            │ [Cron]       │
│      sess-2  │                               │ [Memory]     │
│  ▸ project-b │  ─── (input bar) ─────────    │ [Llamacpp]   │
│              │  > 送訊息（Enter / Shift+⏎）│ [Discord]    │
│  + 加入      │                               │ [Perms]      │
└──────────────┴───────────────────────────────┴──────────────┘
```

**左欄**：project list + 兩層樹（project → sessions）。`+` 加入新 project（呼
叫 daemon `loadProject`），`×` unload。點 session 切到該 session 的訊息歷史。

**中欄**：當前 session 的 chat — 訊息按時序顯示，user 訊息有 brand 色左邊
條，assistant 含可摺疊 thinking + Discord-embed 風 tool-call 卡片（input + result
+ ok/error 標記）。底下 InputBar 支援 multi-line（Shift+Enter 換行）+ 5 個
核心 slash 自動完成（`/clear` `/interrupt` `/allow` `/deny` `/mode`）。

**右欄**：6-tab context panel。跟著左欄選中 project 即時切換。

## 核心 Slash 指令（在 web 輸入框）

| 指令 | 行為 |
|---|---|
| `/clear` | 清空當前 session 的 chat 顯示（不刪 daemon 歷史） |
| `/interrupt` | 中斷當前 turn |
| `/allow` | 同意目前等待中的 permission |
| `/deny` | 拒絕目前等待中的 permission |
| `/mode <name>` | 切 permission mode：default / acceptEdits / bypassPermissions / plan |

非核心 slash command（`/cron` `/memory` `/llamacpp` 等）目前須在 TUI 端執行；
等同功能在 web 右欄已可操作。

## 三端同步

任一端送訊息 / 改 cron / 編 memory / 切 permission mode，daemon 透過 WS broadcast
即時通知其他兩端：

| 動作來源 | 影響 |
|---|---|
| TUI 送訊息 | web + Discord 都看到 turn 串流 |
| Web 送訊息 | TUI + Discord 都看到 turn 串流 |
| Discord 送訊息 | TUI + web 都看到 turn 串流 |
| 任一端 `/allow` | 其他兩端的 permission modal 自動消失（first-wins） |
| 任一端切 mode | 三端 status bar 同步顯示新 mode |
| 任一端建/改/刪 cron | 其他兩端的 cron 列表自動 refresh |
| 任一端編 memory | 其他兩端的 memory tab 自動 refresh |
| 任一端改 llamacpp watchdog | 三端通知（daemon 全域設定） |

## 安全

**預設無認證**。`bindHost: "0.0.0.0"` 表示 LAN 內任何人知道你的 IP 就能控制
my-agent。建議：
- 信任的家用 / 工作 LAN 才開 LAN bind
- 不信任環境改 `"127.0.0.1"` 限本機
- 將來想開遠端 + 認證 → 等 M-WEB-AUTH milestone

Web 對檔案讀取做 path traversal 防護：
- `/api/memory/body?path=…` 必須在 `listAllMemoryEntries()` 結果內
- 靜態檔走 `staticServer.ts` 拒絕 `..` / 跳出 web/dist

## REST API

對應 browser 與第三方工具使用。回應格式統一 JSON、CORS 全開：

| Method | Path | 用途 |
|---|---|---|
| GET | `/api/health` | daemon 存活探測 |
| GET | `/api/version` | api 版本 |
| GET | `/api/projects` | project 列表 |
| POST | `/api/projects` | body `{ cwd }` 載入新 project |
| GET | `/api/projects/:id` | 單一 project |
| DELETE | `/api/projects/:id` | unload |
| GET | `/api/projects/:id/sessions` | session 列表（sessionIndex 為主） |
| GET | `/api/projects/:id/sessions/:sid/messages?before=&limit=100` | 訊息 backfill |
| GET | `/api/projects/:id/search?q=&limit=50` | FTS5 搜尋 |
| GET | `/api/projects/:id/cron` | cron 列表 |
| POST | `/api/projects/:id/cron` | 新增 cron |
| PATCH | `/api/projects/:id/cron/:taskId` | body `{ op: pause/resume/update, patch? }` |
| DELETE | `/api/projects/:id/cron/:taskId` | 刪除 |
| GET | `/api/projects/:id/memory` | memory entries 列表 |
| GET | `/api/projects/:id/memory/body?path=…` | 讀 entry body |
| DELETE | `/api/projects/:id/memory` | body `{ kind, absolutePath }` 軟刪 |
| GET | `/api/llamacpp/watchdog` | watchdog config |
| PUT | `/api/llamacpp/watchdog` | 寫入 watchdog config |
| GET | `/api/qr?url=…` | PNG QR code |

## WS Protocol

`ws://<host>:<port>/ws`，新建分頁自動連線，server 送 `hello` frame。

**Browser → server**：`subscribe` / `ping` / `input.submit` / `input.interrupt`
/ `permission.respond` / `permission.modeSet` / `mutation`。

**Server → browser**：`hello` / `keepalive` / `subscribed` / `pong` / `error` /
`project.added` / `project.updated` / `project.removed` / `state` / `turn.start`
/ `turn.event` / `turn.end` / `permission.pending` / `permission.resolved` /
`permission.modeChanged` / `cron.tasksChanged` / `cron.fired` /
`memory.itemsChanged` / `llamacpp.configChanged` / `web.statusChanged`。

完整型別定義見 `web/src/api/types.ts`。

## Dev Mode

`bun run dev:web` 起 Vite dev server（`http://127.0.0.1:5173`，HMR）。在
`web.jsonc` 設：

```jsonc
"devProxyUrl": "http://127.0.0.1:5173"
```

daemon 會把 `GET /` 反向 proxy 到 vite，`/api` 與 `/ws` 仍由 daemon 處理。

正式部署 `bun run build:web` 產出 `web/dist/`，daemon 直接 serve。

## 跨平台

- Windows（包含 bun + Git Bash / pwsh）：✓
- macOS：✓
- Linux：✓（依賴 standard `xdg-open` 開瀏覽器）

`/web open` 跨平台行為：win32 用 `rundll32 url,OpenURL`，darwin 用 `open`，
其他用 `xdg-open`，`BROWSER` env var 可覆寫。

## Phase 路線

| Phase | 範圍 | 狀態 |
|---|---|---|
| Phase 1（M-WEB-1~7） | Infra + scaffold + `/web` 指令 + daemon 整合 | ✅ |
| Phase 2（M-WEB-8~13） | 三欄 UI + chat 串流 + permission first-wins + 5 slash | ✅ |
| Phase 3（M-WEB-14~17） | 右欄全 CRUD（cron/memory/llamacpp/discord/perms） | ✅ |
| Phase 4（M-WEB-18~21） | sessionIndex backfill + FTS 搜尋 + QR + docs | ✅ |

**未做（後續 milestone）**：
- M-WEB-MOBILE：手機 responsive
- M-WEB-AUTH：認證機制（如要 LAN 外暴露）
- M-WEB-NOTIF：browser notification
- M-WEB-15b：Memory edit wizard
- M-WEB-16b：Llamacpp slot inspector polling
- M-WEB-17b：Discord admin RPC（bind/unbind/whitelist）走 web
- M-WEB-SLASH-FULL：全 80+ slash command React-DOM port
