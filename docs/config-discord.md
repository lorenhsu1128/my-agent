# discord.jsonc 欄位參考

> 本檔由 `bun run docs:gen` 從 zod schema 自動產生表格部分。
> 表格區段以外的敘述請手寫在 AUTO-GENERATED 段落之外。

## 概覽

M-DISCORD：Discord bot 嵌入 daemon 的設定。

**來源優先序**：env var override → `~/.my-agent/discord.jsonc` → schema default。


## Env 變數一覽

| Env | 覆蓋欄位 |
|---|---|
| `DISCORD_BOT_TOKEN` | botToken（建議用此 env，不要寫進 jsonc） |
| `DISCORD_CONFIG_PATH` | (整個檔案路徑) |

## Schema 欄位

<!-- AUTO-GENERATED-START — 跑 `bun run docs:gen` 重新產生 -->

### `DiscordProjectSchema`

| 欄位 | 型別 | Default | Env override | 說明 |
|---|---|---|---|---|
| `id` | `string` | _(無)_ | — | Project 識別字（DM 前綴 `#<id>` 會對到它）。通常是短名稱如 `my-agent`。 需唯一；大小寫敏感（前綴解析會 toLowerCase 比對 aliases 一併）。 |
| `name` | `string` | _(無)_ | — | 顯示名（`/list` 等 UI 用）。 |
| `path` | `string` | _(無)_ | — | 實際 filesystem 絕對路徑；daemon loadProject 會用它。 |
| `aliases` | `array<string>` | `[]` | — | 備用前綴（DM 裡 `#ma hi` 若 aliases 包含 `ma` 則路由到此 project）。 |

### `DiscordConfigSchema`

| 欄位 | 型別 | Default | Env override | 說明 |
|---|---|---|---|---|
| `enabled` | `boolean` | `false` | — | 開關；為 false 時 daemon 不起 Discord gateway。 |
| `botToken` | `string` _(optional)_ | _(undefined)_ | — | Bot token。可直接寫在此處（~/.my-agent/ 在使用者家目錄、非 git 目錄，風險低） 或改用 env var `DISCORD_BOT_TOKEN`（env 優先於此欄位）。 安全提醒： - 這檔不要 commit 進 git（家目錄預設不會） - 檔案權限建議 0600（ssh/credentials 慣例） - 若 token 外洩請立刻到 Discord Developer Portal → Bot → Reset Token |
| `whitelistUserIds` | `array<string>` | `[]` | — | 白名單 Discord user id（snowflake 字串）；必填非空。 |
| `defaultProjectPath` | `string` _(optional)_ | _(undefined)_ | — | DM 沒前綴時的 fallback project path。必須是 projects[].path 中的其中一個； loader 會驗證。沒設 = DM 沒前綴時忽略訊息。 |
| `projects` | `array` | `[]` | — | 多 project 宣告。 |
| `channelBindings` | `record` | `{}` | — | Channel ID → project path 映射。guild channel 送訊息必須 match； 沒 match 的 channel 一律忽略（即使 bot 被 invite 進去）。 |
| `homeChannelId` | `string` _(optional)_ | _(undefined)_ | — | Home channel ID：cron 完成 / 長任務通知 / daemon 事件 post 至此。未設則不 post。 |
| `guildId` | `string` _(optional)_ | _(undefined)_ | — | Guild ID：`/discord-bind` 建立 per-project channel 時指定建在哪個 server。 Bot 須實際在此 guild 且擁有 Manage Channels 權限。未設時 `/discord-bind` 報錯。 |
| `archiveCategoryId` | `string` _(optional)_ | _(undefined)_ | — | Archive category ID：daemon 啟動發現 binding 的 cwd 已不存在時，對應頻道 會被移到此 category（保留歷史訊息但不再接收新訊息）。未設則不 archive， 只清 binding。 |
| `streamStrategy` | `enum` | `'turn-end'` | — | 輸出策略： - `turn-end`（預設）：等 turn 結束一次送完整回覆，超過 2000 字切多段 - `edit`（未來擴充）：每 N ms edit 首則訊息模擬 streaming |
| `replyMode` | `enum` | `'first'` | — | Reply mode 控制多段訊息是否都加 `reply` reference： - `first`（預設）：只首段回覆原訊息（像 Hermes） - `all`：每段都加 reply - `off`：不加 |

<!-- AUTO-GENERATED-END -->
