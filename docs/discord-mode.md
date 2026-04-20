# Discord Gateway（M-DISCORD）

把 my-agent 接到 Discord — DM / guild channel 都能跟 agent 聊，支援 slash commands、permission mode 雙向同步、cron 通知、REPL↔Discord 互鏡。

## TL;DR

1. 在 Discord Developer Portal 建 bot，拿 token
2. 開 `MESSAGE CONTENT INTENT`
3. OAuth2 URL 邀請 bot 進你的私人 guild（scope: `bot`+`applications.commands`）
4. 編輯 `~/.my-agent/discord.json`（bot token / 白名單 / project / home channel）
5. `bun run dev daemon start`
6. Discord DM bot 一般文字（或在綁定的 channel）

## 架構

```
┌────────────┐                         ┌──────────────────────┐
│  Discord   │   DM / guild msg        │   my-agent daemon    │
│   server   │ ──────────────────────▶ │  ┌────────────────┐  │
│            │                         │  │ DiscordGateway │  │
│  (你 + bot)│ ◀───────── reply ─────── │  └───────┬────────┘  │
└────────────┘                         │          ▼            │
                                       │  ┌────────────────┐   │
                                       │  │ ProjectRegistry│   │
                                       │  │   (lazy load)  │   │
                                       │  └───────┬────────┘   │
                                       │          ▼            │
                                       │  ┌────────────────┐   │
                                       │  │   broker +     │   │
                                       │  │   QueryEngine  │   │
                                       │  └───────┬────────┘   │
                                       │          │  (broadcast) │
                                       └──────────┼────────────┘
                                                  ▼
                                           ┌──────────┐
                                           │ attached │
                                           │  REPL    │
                                           └──────────┘
```

訊息進來 → `routeMessage`（white + prefix + channel binding）→ `registry.loadProject(projectPath)` → `adaptDiscordMessage`（含圖片快取）→ `broker.queue.submit` → `QueryEngine.ask()` 跑 turn → `runnerEvent` 廣播 → REPL 同步收到、`StreamOutputController` 組輸出回 Discord。

## 前置作業

### 1. Discord Developer Portal

- https://discord.com/developers/applications → 點你的 application → Bot
- Reset Token → 複製
- **Privileged Gateway Intents** → 開 `MESSAGE CONTENT INTENT`

### 2. 邀請 bot 進 guild

- 在你的 guild 裡右鍵 → 邀請朋友 / 或自己建一個私人 guild
- Developer Portal → OAuth2 → URL Generator
- SCOPES：`bot` + `applications.commands`
- BOT PERMISSIONS（最少）：Read Messages, Send Messages, Attach Files, Add Reactions, Read Message History, Use External Emojis
- 複製產出的 URL 到瀏覽器貼上 → 選目標 guild → 授權

### 3. 找你自己的 User ID

- Discord 設定 ⚙️ → 進階 → 開啟「開發者模式」
- 右鍵自己頭像 → 複製使用者 ID

### 4. 找 home channel ID（可選）

- guild 建一個 `#bot-home` 類似頻道
- 右鍵頻道 → 複製頻道 ID

### 5. 確認 bot 在 home channel 有權限

編輯頻道 → 權限 → MY-AGENT 允許：View Channel + Send Messages

## 設定檔

`~/.my-agent/discord.json`（首次啟動 daemon 會自動 seed + README）：

```json
{
  "enabled": true,
  "botToken": "MT...your-token-here",
  "whitelistUserIds": ["123456789012345678"],
  "defaultProjectPath": "C:/Users/me/projects/my-agent",
  "projects": [
    {
      "id": "my-agent",
      "name": "My Agent",
      "path": "C:/Users/me/projects/my-agent",
      "aliases": ["ma", "agent"]
    }
  ],
  "channelBindings": {
    "987654321098765432": "C:/Users/me/projects/my-agent"
  },
  "homeChannelId": "987654321098765433",
  "streamStrategy": "turn-end",
  "replyMode": "first"
}
```

### 欄位速查

| 欄位 | 用途 |
|------|------|
| `enabled` | 總開關。false 時 daemon 不起 gateway |
| `botToken` | Bot token。`DISCORD_BOT_TOKEN` env var 優先於此欄位 |
| `whitelistUserIds` | 允許互動的 Discord user ID 清單；空 = 全擋 |
| `defaultProjectPath` | DM 沒前綴時的 fallback project。須是 `projects[].path` 之一 |
| `projects[].id` | DM 前綴 `#<id>` 路由用（短名稱） |
| `projects[].path` | 實際 cwd 絕對路徑 |
| `projects[].aliases` | 備用前綴（例如 `"ma"`） |
| `channelBindings` | `{channelId: projectPath}`；未綁 channel 的訊息忽略 |
| `homeChannelId` | REPL / cron / daemon 事件鏡像到此頻道 |
| `streamStrategy` | `turn-end`（一次送）/ `edit`（預留，未實作） |
| `replyMode` | `first` / `all` / `off` — 多段訊息的 reply ref 策略 |

### Token 保護

- `~/.my-agent/discord.json` 不在 repo 內（家目錄），不會意外 commit
- Windows 建議：檔案右鍵 → 內容 → 安全性 → 只允許自己讀
- Token 外洩：Developer Portal → Reset Token

## 訊息路由

| 來源 | 路由規則 | 範例 |
|------|---------|------|
| DM 有前綴 | `^#<id\|alias>\s+` → 對應 `projects[].id` / `aliases` | `#my-agent 幫我看 main.ts` |
| DM 無前綴 | fallback 到 `defaultProjectPath` | `你好` |
| Guild channel | 查 `channelBindings[channelId]` | 在 `#my-agent-dev` 打字 |
| Guild 非綁定 channel | **忽略**（安全預設） | 公開聊天室不會被打擾 |
| 非白名單使用者 | **靜默拒絕**（log 都不印） | 陌生人 DM 不處理 |

### 路由錯誤回饋

- `#unknown-project ...` → ❓ 加 hint 列出可用 `#id`
- DM 無前綴 + `defaultProjectPath` 未設 → ❓ hint 設定方式

## Slash commands

全部在 DM / guild channel 都可用（白名單保護）。

| 指令 | 用途 |
|------|------|
| `/status` | daemon + 已 load projects 狀態 |
| `/list` | 設定的 projects + channel bindings |
| `/help` | 指令說明 |
| `/mode <mode>` | 切當前 project permission mode（雙向同步給 REPL） |
| `/clear` | 清 project session（下一條訊息開新 session） |
| `/interrupt` | 中斷當前 turn |
| `/allow` | 放行最近待決的 tool permission |
| `/deny [reason]` | 拒絕最近待決的 tool permission |

### Permission mode 值

- `default` — destructive 工具會問（REPL 或 Discord `/allow` `/deny`）
- `acceptEdits` — Edit/Write 自動放行
- `plan` — 只讀，擋所有寫入
- `bypassPermissions` — YOLO 全放行

## Permission flow

destructive 工具（`rm`、`mv`、shell 寫入等）觸發時：

1. **REPL 有 attach 在同 project** → prompt 送 REPL；用 REPL 的 `/allow` `/deny`（或 keyboard shortcut）
2. **REPL 不在場** → 送 Discord（目前是在 DM 以文字回覆，非 embed；M-DISCORD-7+ 可能加 button UX）
3. **回應**：任一側送 `/allow` 或 `/deny reason: <理由>`，permissionRouter 處理完 turn 繼續跑
4. **5 分鐘沒回應** → auto-allow（跟既有 timeout 行為一致）

## Home channel

`homeChannelId` 設定後，以下事件會 post 到該頻道：

### Daemon 事件
- `🟢 my-agent daemon up · bot connected · 2026-04-20 12:34:56` — daemon 啟動
- `🔴 my-agent daemon shutting down` — daemon 停止（best-effort；connection 快斷時可能錯過）

### Turn mirror（非 Discord 發起）
每個 REPL / cron / 其他 source 的 turn 完成後 post：
```
✅ `<projectId>` repl turn · 12.3s
<assistant 回覆全文>
```

- Discord 發起的 turn **不鏡**（避免跟原 DM reply 雙貼）
- 超過 2000 字自動切段（code block 警覺）
- reason=error 附上 error；reason=aborted 加 ⏹️

### 關掉 home channel
刪掉 `homeChannelId` 欄位（或設 `null`），所有 home 通知跳過。

## 圖片

### 你傳圖給 bot
- Discord attachment（image/*）→ 下載快取到 `~/.my-agent/cache/discord-images/`
- 如果 llamacpp vision 開啟（`llamacpp.json` 的 `vision.enabled: true`），組成 Anthropic image block 送進 agent
- 沒 vision → 退回 `[Image attachment: name]` 字串佔位符

### bot 產圖給你
- agent 回覆含 Markdown `![alt](path|url)`：
  - 絕對路徑存在 → 以 `AttachmentBuilder` 上傳 Discord
  - http(s) URL → 保留，Discord 自動 preview
  - 相對路徑 / 不存在 → 保留原文

## 實務注意

### 重啟 daemon 才吃新 config

`discord.json` / `llamacpp.json` 都是 session 啟動時凍結快照。改完要重啟 daemon：
```powershell
bun run dev daemon stop
bun run dev daemon start
```

### Slash command 傳播時間

- Guild-scope：instant（bot 連上後幾秒內）
- Global（DM）：Discord 端最多 1 小時傳播

Guild 優先 OK 就用，DM 等一下再試。

### DM 訊息收不到

若出現 `Failed to find guild, or unknown type for channel X undefined`：
- M-DISCORD 已內建 workaround：白名單使用者啟動時自動 prefetch DM channel
- 若還是有問題，確認 Developer Portal `MESSAGE CONTENT INTENT` 真的開了

### cron per-project

每個 `ProjectRuntime` 自己有 cron scheduler；unload 時自動停。Fire 時 turn 走 broker → 透過 home mirror 鏡到 home channel。

### 兩個 project 同時跑 turn

B-1 並行策略：daemon 級 turn mutex 序列化 → 兩邊 turn 會**排隊**跑，不並行。個人使用場景極少遇到；若遇到，後到的等前面跑完再進。

## 故障排查

啟動看 log：
```powershell
Get-Content ~/.my-agent/daemon.log -Tail 20
```

預期出現的關鍵訊息：
- `daemon started ... agentVersion:2.1.87-dev`
- `project loaded ...`
- `discord ready botId:... botTag:MY-AGENT#3666`
- `prefetched DM channel userId:...`（每個 whitelist user 一次）
- `slash commands registered guildOk:1 guildFail:0 global:true`

沒有這些表示某個步驟失敗，看前面是否有 `error` / `warn` 行。

| 症狀 | 可能原因 | 解決 |
|------|---------|------|
| bot 顯示離線 | token 無效 / daemon 沒跑 | check log，`daemon status` |
| DM 沒反應但 `/status` 有 | MESSAGE CONTENT INTENT 沒開 | Developer Portal 檢查 |
| slash 命令在 DM 看不到 | Global 還沒傳播 | 等 ~15 分鐘，或在 guild 測 |
| home channel 沒訊息 | `homeChannelId` 錯 / bot 無權限 | log 會有 `home channel startup notification failed` |
| `Used disallowed intents` | Privileged intent 沒開 | 回 Developer Portal |
| REPL 沒收到 /mode 同步 | REPL 用的是舊 code | REPL 也要 Ctrl+C 重啟 |

## 範圍外（延後）

- Voice channel（Hermes voice ~3000 行 RTP/Opus/DAVE E2EE，延後）
- Button / embed interactive permission UX（目前用文字 slash）
- Slack / Telegram（M-DAEMON 架構能支援但未實作）
- 多使用者 guild（白名單設計假設 1 人，多人需重新設計 permission routing）
