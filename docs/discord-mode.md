# Discord Gateway 使用說明

把 my-agent 接上 Discord，讓你用 DM 或 guild channel 跟 agent 聊天，支援多 project 路由、slash command、permission 雙向同步、cron 通知、REPL ↔ Discord 互鏡。

---

## 1. TL;DR（懶人版 6 步）

1. Discord Developer Portal 建 bot，複製 token
2. 開 `MESSAGE CONTENT INTENT`（Privileged Gateway Intent）
3. OAuth2 URL 邀請 bot 到**你自己的**私人 guild（scope: `bot` + `applications.commands`）
4. 編輯 `~/.my-agent/discord.json`（token、白名單 userId、project、home channel）
5. 終端機 `bun run dev daemon start`
6. Discord DM bot 任意訊息（或在綁定的 channel）即開始對話

---

## 2. 原理：為什麼是這樣設計

要理解 Discord 模式，先看三層角色：

### 2.1 Daemon（常駐程序）
my-agent 本身是 CLI 工具，跑完一條命令就結束。但 Discord bot 要**永遠在線**才能即時收訊息，所以引入 **daemon 模式**：一個常駐的 Bun process，同時扮演：
- WebSocket 伺服器（讓 REPL thin-client 連進來）
- Discord gateway host（保持與 Discord 的 WebSocket 連線）
- Cron scheduler（排程任務）

**關鍵**：daemon 是 in-process 設計（ADR-012 Path A），不是 spawn 子程序。所以所有 project 共用同一個 Node heap、狀態透明、方便 debug。

### 2.2 ProjectRegistry（多 project 管理）
一個 daemon 同時能伺服 N 個 project（每個 = 一個 cwd + 獨立 AppState + session JSONL + cron + memory）。`ProjectRegistry` 負責：
- **Lazy load**：第一次收到某 project 的訊息才啟動它
- **Idle sweep**：30 分鐘沒動靜自動 unload（但 REPL 仍 attach 時不 unload）
- **並行策略 B-1**：daemon 級 turn mutex — 兩個 project 同時跑 turn 會**排隊**，不並行（個人使用場景的簡化取捨）

### 2.3 DiscordGateway（訊息橋樑）
`discord.js v14` 的薄封裝。收到訊息後流程：

```
Discord msg
   ↓ routeMessage（whitelist + prefix + channelBinding）
   ↓ registry.loadProject(projectPath)
   ↓ adaptDiscordMessage（文字 + 圖片 attachment）
   ↓ broker.queue.submit → QueryEngine.ask()
   ↓ runnerEvent 廣播（所有 attached REPL 同步收到）
   ↓ StreamOutputController 組好回覆 → Discord reply
```

### 2.4 為什麼要 whitelist
Bot token 一旦外洩，任何人都能 DM 你的 bot 叫 agent 跑 `rm -rf`。`whitelistUserIds` 是第一道防線：**不在白名單的使用者靜默忽略**（連 log 都不印，避免浪費），即使 bot 意外出現在公開 server 也無礙。

---

## 3. 架構圖

```
┌─────────────┐                        ┌────────────────────────┐
│   Discord   │   DM / guild msg       │   my-agent daemon      │
│   servers   │ ─────────────────────▶ │ ┌────────────────────┐ │
│             │                        │ │ DiscordGateway     │ │
│  (你 + bot) │ ◀────── reply ──────── │ └─────────┬──────────┘ │
└─────────────┘                        │           ▼            │
                                       │ ┌────────────────────┐ │
                                       │ │ ProjectRegistry    │ │
                                       │ │ (lazy load N cwds) │ │
                                       │ └─────────┬──────────┘ │
                                       │           ▼            │
                                       │ ┌────────────────────┐ │
                                       │ │ broker +           │ │
                                       │ │ QueryEngineRunner  │ │
                                       │ └─────────┬──────────┘ │
                                       │           │ broadcast  │
                                       └───────────┼────────────┘
                                                   ▼
                                           ┌──────────────┐
                                           │ attached     │
                                           │ REPL (可選)  │
                                           └──────────────┘
```

---

## 4. 初次設定

### 4.1 Discord 端

#### Step A — 建 Application 與 Bot
1. 開 https://discord.com/developers/applications
2. 右上 **New Application** → 填名字（ex. `my-agent`）→ Create
3. 左側選單 **Bot**
4. **Reset Token** → **Yes, do it!** → 複製 token（只顯示一次）
5. 往下捲 **Privileged Gateway Intents** → 打開 **MESSAGE CONTENT INTENT**（這一步最多人漏掉，沒開的話 bot 收不到訊息內容）

#### Step B — 邀請 bot 進 guild
1. 先建一個**只有你自己**的 guild（Discord 左欄 `+` → 建立伺服器 → 只為我和朋友）
2. 回 Developer Portal → 左側 **OAuth2** → **URL Generator**
3. SCOPES 勾：`bot` + `applications.commands`
4. BOT PERMISSIONS 最少勾：
   - Read Messages / View Channels
   - Send Messages
   - Attach Files
   - Add Reactions
   - Read Message History
   - Use External Emojis
   - **Manage Channels**（如果要用 `/discord-bind`）
5. 複製頁面最底產出的 URL → 瀏覽器貼上 → 選你的 guild → **授權**

#### Step C — 開啟開發者模式並取 ID
Discord 本體設定 → **進階** → 打開 **開發者模式**。接著：
- **你的 User ID**：右鍵自己頭像 → 複製使用者 ID
- **Guild ID**（AUTOBIND 用）：右鍵 server 名稱 → 複製伺服器 ID
- **Home channel ID**（選用）：在 guild 建一個 `#bot-home`，右鍵頻道 → 複製頻道 ID
- **Archive category ID**（選用）：建一個 category `archived`，右鍵 → 複製 ID

#### Step D — 檢查 bot 在 home channel 有權限
右鍵 home channel → 編輯頻道 → 權限 → 加入你的 bot role → 允許 **View Channel** + **Send Messages**。

### 4.2 本機端

#### Step E — 填 `~/.my-agent/discord.json`

首次啟動 daemon 會自動 seed 出一份空範本 + `discord.README.md`。最小可用範例：

```json
{
  "enabled": true,
  "botToken": "MT...你剛才複製的 token",
  "whitelistUserIds": ["123456789012345678"],
  "defaultProjectPath": "C:/Users/me/Documents/_projects/my-agent",
  "projects": [
    {
      "id": "my-agent",
      "name": "My Agent",
      "path": "C:/Users/me/Documents/_projects/my-agent",
      "aliases": ["ma", "agent"]
    }
  ],
  "channelBindings": {},
  "homeChannelId": "987654321098765433",
  "guildId": "111222333444555666",
  "archiveCategoryId": "777888999000111222"
}
```

**欄位速查**

| 欄位 | 必填 | 用途 |
|------|------|------|
| `enabled` | ✓ | 總開關。false 時 daemon 不起 gateway |
| `botToken` | ✓ | Bot token。env var `DISCORD_BOT_TOKEN` 優先 |
| `whitelistUserIds` | ✓ | 允許互動的 Discord user ID；空 = 全擋 |
| `defaultProjectPath` |  | DM 沒前綴時的 fallback。必須在 `projects[].path` 裡 |
| `projects[].id` | ✓ | DM 前綴 `#<id>` 路由 key |
| `projects[].path` | ✓ | 實際 cwd 絕對路徑 |
| `projects[].aliases` |  | 備用前綴 |
| `channelBindings` |  | `{channelId: projectPath}`；guild 訊息路由表 |
| `homeChannelId` |  | cron / daemon 事件 / REPL turn 鏡像到此 |
| `guildId` |  | `/discord-bind` 建 channel 的目標 server |
| `archiveCategoryId` |  | cwd 不存在時自動 archive 舊 channel |
| `streamStrategy` |  | `turn-end`（預設） / `edit`（預留） |
| `replyMode` |  | `first` / `all` / `off` — 多段訊息的 reply ref |

#### Step F — 啟動 daemon

```bash
conda activate aiagent
cd C:/Users/me/Documents/_projects/my-agent
bun run dev daemon start
```

看 log 確認：
```bash
tail -f ~/.my-agent/daemon.log
```

應出現：
- `daemon started ... agentVersion:2.1.87-dev`
- `discord ready botId:... botTag:MY-AGENT#3666`
- `prefetched DM channel userId:...`（每個 whitelist user 一次）
- `slash commands registered guildOk:1 guildFail:0 global:true`

---

## 5. 完整流程案例（從零到跑通）

想像你從零開始、今天就要把一個 project 接上 Discord。

### 情境
- Project：`C:/Users/me/Documents/_projects/my-agent`
- 你的 Discord user：`@loren`（ID `123456789012345678`）
- 建立的 guild：`my-lab`，guildId `111...`

### 一條龍操作

**① 建 bot + 邀請**（Step A / B / C）→ 拿到 token、自己的 ID、guild ID。

**② 編輯設定**
```bash
notepad ~/.my-agent/discord.json
```
填入 Step E 的範例，替換對應 ID 與 token。

**③ 啟 daemon**
```bash
bun run dev daemon start
tail -f ~/.my-agent/daemon.log
```
看到 `discord ready` 即可。打開 Discord，bot `MY-AGENT#xxxx` 應顯示**綠點在線**，presence 文字 `Managing 0 projects`（還沒 lazy-load）。

**④ 發第一則 DM**
在 Discord DM bot：
```
hi
```
預期：
- 訊息出現 👀 反應（已收到）
- 幾秒後出現 ✅ 反應 + bot reply（agent 的回覆）
- daemon log 多一行 `project loaded ...`，presence 變 `Managing 1 projects`

**⑤ REPL attach 同一 project**（可選）
另開一個終端：
```bash
cd C:/Users/me/Documents/_projects/my-agent
bun run dev
```
REPL 啟動時會自動偵測 daemon（2 秒內）並 attach。狀態列會顯示「attached」badge。

**⑥ 用 /discord-bind 建 per-project channel**
在 REPL 內打：
```
/discord-bind
```
預期：
- daemon 在你的 guild 建一個 `my-agent-a1b2c3` 頻道（dirname + 6 位 hash）
- 自動寫回 `discord.json` 的 `channelBindings`
- 頻道 topic = cwd 絕對路徑
- REPL 回覆 `bound #my-agent-a1b2c3`

此後在這個 channel 打字，訊息直接路由到這個 project，不需要前綴。

**⑦ 觸發 permission 流程**
在 Discord DM 打：
```
#my-agent 幫我刪掉 tmp/ 下所有檔案
```
預期：
- agent 要呼叫 Bash 工具執行 `rm`，destructive → 觸發 permission
- REPL 端彈出 permission prompt（如果 attach 中）
- **同時** Discord 頻道也收到 `⚠ Tool Bash 要求授權，用 /allow 或 /deny [reason] 回覆`
- 你在 Discord 打 `/deny reason: 還沒想好` → agent 收到拒絕 → REPL 的 prompt 自動消失（`permissionResolved` frame）

**⑧ 切換 permission mode**
在 Discord 打：
```
/mode plan
```
預期：
- Discord 回 `mode set: plan`
- REPL 狀態列同步變成 `plan mode`
- 之後 agent 只讀、不能寫

**⑨ 看 home channel**
切到 `#bot-home`：
- 應該看到 `🟢 my-agent daemon up · bot connected · 2026-04-21 10:23:45`
- REPL 發起的 turn（不是 Discord 發起的）會鏡像到這裡
- cron fire 的 turn 也會鏡到這裡

**⑩ 結束**
```bash
bun run dev daemon stop
```
- `#bot-home` 收到 `🔴 my-agent daemon shutting down`
- bot 離線
- REPL fallback 回 standalone 模式繼續跑

---

## 6. 使用方式

### 6.1 DM 對話與前綴路由

| 訊息 | 路由結果 |
|------|---------|
| `hi`（DM） | 送到 `defaultProjectPath` |
| `#my-agent 看 main.ts`（DM） | 送到 id=my-agent 的 project |
| `#ma hi`（DM，`ma` 是 alias） | 送到 alias 對應 project |
| `#unknown xx` | ❓ 反應 + hint 列出可用 id |

### 6.2 Guild channel

| 情境 | 結果 |
|------|------|
| 訊息在 `channelBindings` 有對應 | 路由到該 project，不需前綴 |
| 訊息在未綁定的 channel | **忽略**（安全預設） |
| 非白名單 user 在任何地方發訊 | **靜默拒絕** |

### 6.3 圖片進出

- **你傳圖給 bot**：image/* attachment → 下載快取到 `~/.my-agent/cache/discord-images/` → 若 llamacpp vision 啟用則送入 agent；否則回傳 `[Image attachment: name]` 佔位
- **Bot 產圖**：回覆內 `![alt](path)` 若為絕對路徑且存在 → `AttachmentBuilder` 上傳；http(s) URL → 保留讓 Discord 自動 preview

### 6.4 Permission flow

destructive 工具（Bash 寫入、Edit、Write、rm 類）：
1. **REPL attach 中** → 以 REPL prompt 優先
2. **Discord 也雙發**（AUTOBIND 後）：原頻道 or DM 收到 `⚠ Tool X 要求授權`
3. 任一側回 `/allow` 或 `/deny reason: ...` 即解鎖，另一側 UI 自動清 pending
4. **5 分鐘沒回應 → auto-allow**（跟 timeout 行為一致）

### 6.5 Home channel

`homeChannelId` 設定後會收到：
- **Daemon lifecycle**：🟢 up / 🔴 shutting down
- **Turn mirror**（非 Discord 發起的）：
  ```
  ✅ `my-agent` repl turn · 12.3s
  <assistant 回覆全文>
  ```
- Discord 發起的 turn **不鏡**（避免雙貼）
- 超過 2000 字自動切段（避 code block 中間斷）
- `reason=error` 附 error；`reason=aborted` 加 ⏹️

關掉：刪除 `homeChannelId` 欄位或設 null。

---

## 7. 指令大全

### 7.1 Discord slash commands（8 個）

| 指令 | 參數 | 用途 |
|------|------|------|
| `/status` | — | daemon 狀態 + 已 load projects |
| `/list` | — | 列出所有 projects + channel bindings |
| `/help` | — | 指令說明 |
| `/mode` | `mode: default \| acceptEdits \| plan \| bypassPermissions` | 切當前 project permission mode，雙向同步給 REPL |
| `/clear` | — | 清 project session（下條訊息開新 session） |
| `/interrupt` | — | 中斷當前跑中的 turn |
| `/allow` | — | 放行最近待決的 tool permission |
| `/deny` | `reason: ...`（選用） | 拒絕最近待決的 tool permission |

**Permission mode 值**
- `default` — destructive 會問
- `acceptEdits` — Edit/Write 自動放行
- `plan` — 只讀，擋所有寫入
- `bypassPermissions` — YOLO 全放行

### 7.2 REPL 內 Discord 指令

| 指令 | 用途 |
|------|------|
| `/discord-bind` | 在 `guildId` 指定的 server 建 `<dirname>-<hash6>` 頻道並綁當前 cwd，寫回 `channelBindings` |
| `/discord-unbind` | 把頻道改名 `unbound-<原名>`、清 binding（保留歷史訊息） |

兩個都要 daemon 啟動 + REPL attached。中文目錄名走 pinyin；非 CJK 非 ASCII → `proj-<hash>`。

---

## 8. 進階

### 8.1 Per-project channel（M-DISCORD-AUTOBIND）

前置：`discord.json` 設 `guildId` + `archiveCategoryId`，bot role 有 **Manage Channels**。

使用：REPL `/discord-bind`（不自動偵測目錄建立）。頻道節流、離線 queue、多 guild 都不支援。

### 8.2 鏡像策略 β

| 來源 | 去處 |
|------|------|
| REPL turn（有 per-project binding） | 該 per-project channel，前綴 `[from REPL]` |
| REPL turn（無 binding） | home channel |
| Cron turn | 同上 |
| Discord-sourced turn | 原頻道 reply + 廣播給 attached REPL（REPL 看到 `[via Discord DM from @user]` 或 `[via #channel]`） |

per-project channel vs home channel **互斥**，不雙貼。

### 8.3 權限雙發

Discord-sourced turn 要權限時：
- 同 project 所有 attached REPL 收到 `permissionRequest` frame
- 原 Discord 頻道也收到 `⚠` 訊息
- 任一邊 first-wins；另一邊透過 `permissionResolved` frame 清 pending

DM-sourced turn **不**鏡 per-project channel（DM 保密）。

### 8.4 健康檢查（daemon 啟動時）

掃所有 binding：
- Guild 不可達（bot 被踢）→ binding 不動，log warn
- Channel 被手動刪 → 清 binding
- cwd 目錄不存在 → 移到 `archiveCategoryId`（若設）+ 清 binding

---

## 9. 實務注意

### 重啟 daemon 才吃新 config
`discord.json` / `llamacpp.json` 都是 session 啟動時凍結快照：
```bash
bun run dev daemon stop
bun run dev daemon start
```

### Slash command 傳播時間
- Guild-scope：bot 連上後幾秒內可見
- Global（DM）：Discord 端最多 **1 小時**傳播

Guild 先能用就先試，DM 等 ~15 分鐘再確認。

### DM 收不到訊息
若 log 出現 `Failed to find guild, or unknown type for channel X undefined`：
- M-DISCORD 已內建 workaround（啟動時 pre-fetch whitelist DM channel + 'raw' packet handler）
- 仍失敗 → 回 Developer Portal 確認 **MESSAGE CONTENT INTENT** 真的開了

### Token 保護
- `~/.my-agent/discord.json` 在家目錄，不會進 git
- Windows：右鍵檔案 → 內容 → 安全性 → 只允許自己讀
- 外洩：Developer Portal → Bot → Reset Token

### 並行限制
daemon turn mutex 序列化跨 project turn — 兩個 project 同時來會**排隊**。個人使用極少遇到。

### Cron per-project
每個 `ProjectRuntime` 自己的 cron scheduler；unload 時自動停。Fire 時透過 home mirror 鏡到 home channel。

---

## 10. 故障排查

看 log：
```bash
tail -n 50 ~/.my-agent/daemon.log
```

| 症狀 | 可能原因 | 解決 |
|------|---------|------|
| bot 一直離線 | token 無效 / daemon 沒跑 | check log；`bun run dev daemon status` |
| DM 沒反應、`/status` 有反應 | MESSAGE CONTENT INTENT 沒開 | Developer Portal 檢查 |
| slash 命令在 DM 看不到 | Global 還沒傳播 | 等 15 分鐘，或先在 guild 測 |
| home channel 沒訊息 | `homeChannelId` 錯 / bot 無權限 | log 有 `home channel startup notification failed` |
| `Used disallowed intents` | Privileged intent 沒開 | 回 Developer Portal |
| REPL 沒收到 `/mode` 同步 | REPL 用舊 code | REPL 也 Ctrl+C 重啟 |
| `/discord-bind` 失敗 `guildId not set` | config 沒填 `guildId` | 編輯 discord.json 補上、重啟 daemon |
| 建 channel 失敗 `Missing Permissions` | bot role 沒 Manage Channels | server 設定 → 身分組 → bot role 勾選 |

---

## 11. 範圍外 / 已知限制

- **Voice channel**（Hermes 的 voice 約 3000 行 RTP/Opus/DAVE E2EE，延後）
- **Button / embed 互動式 permission UX**（目前純文字 slash command）
- **Slack / Telegram**（M-DAEMON 架構可支援，未實作）
- **多使用者 guild**（白名單設計假設 1 人；多人需重新設計 permission routing）
- **頻道命名上限**：Discord 100 字元，超長自動裁切 dirname
- **Standalone 模式**（無 daemon）**不能** `/discord-bind`
- **單 guild**：`guildId` 只能設一個值
