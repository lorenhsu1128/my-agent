/**
 * Discord gateway 設定檔 JSONC 模板（bundled）。
 *
 * 首次 seed 時寫入 ~/.my-agent/discord.json。schema.ts 有欄位改動需同步本檔。
 */

export const DISCORD_JSONC_TEMPLATE = `{
  // ═══════════════════════════════════════════════════════════════════
  // Discord Gateway 設定（~/.my-agent/discord.json）
  //
  // 讓 my-agent daemon 接上 Discord bot，使用者可透過 DM / guild channel
  // 跨專案跟 agent 對話。單 daemon 多 project（M-DISCORD）。
  //
  // 路由規則：
  //   - DM：訊息前綴 #<projectId> 或 #<alias> 指定 project
  //         沒前綴 → defaultProjectPath（未設則忽略）
  //   - Channel：channelBindings[channelId] 查到 projectPath 才處理
  //         沒綁的 channel 一律忽略（即使 bot 被 invite）
  //
  // 首次啟用步驟見 docs/discord-mode.md（8 步）。
  // ═══════════════════════════════════════════════════════════════════

  // 開關。false 時 daemon 完全不起 gateway，其他欄位可留著不影響。
  "enabled": false,

  // Bot token — 從 Discord Developer Portal → Bot → Token 取得。
  // 安全提醒：
  //   - 此檔在家目錄（~/.my-agent/），建議檔案權限 0600（chmod 600 discord.json）
  //   - 不要 commit 進 git（家目錄預設不會，但仍請確認）
  //   - 外洩立即到 Developer Portal → Reset Token
  //   - 或改用 env var DISCORD_BOT_TOKEN（env 優先於此欄位，適合 CI / 容器部署）
  // "botToken": "<貼進你的 bot token>",

  // 白名單 Discord user id（snowflake 字串）。只有這些 user 送的訊息 bot 才會回。
  // 拿法：Discord 開啟 Developer Mode → 右鍵使用者 → Copy User ID。
  // 空陣列 = bot 不回任何人（預設安全）。
  "whitelistUserIds": [],

  // DM 沒前綴時的 fallback project path（絕對路徑）。
  // 必須是下方 projects[].path 其中之一；loader 啟動時驗證、warn。
  // 未設 = DM 沒 #<id> 前綴的訊息一律忽略。
  // "defaultProjectPath": "C:/Users/LOREN/Documents/_projects/my-agent",

  // 多 project 宣告。每個 project 代表 daemon 可以掛載的一個 cwd。
  // 範例：
  // "projects": [
  //   {
  //     "id": "my-agent",
  //     "name": "My Agent（本專案）",
  //     "path": "C:/Users/LOREN/Documents/_projects/my-agent",
  //     "aliases": ["ma", "agent"]
  //   }
  // ]
  "projects": [],

  // Channel ID → project path 映射。guild text channel 送訊息才會被處理。
  // 可手動加，但更推薦用 REPL 內 /discord-bind 自動建頻道並寫入。
  // 範例：
  // "channelBindings": {
  //   "1234567890": "C:/Users/LOREN/Documents/_projects/my-agent"
  // }
  "channelBindings": {},

  // Home channel ID（guild text channel）：
  //   - cron 完成 / 長任務通知
  //   - daemon up/down 訊息
  //   - 非 Discord source（REPL / cron）的 turn 輸出鏡像
  // 未設 = 不 post 任何 home channel 訊息。
  // "homeChannelId": "1234567890",

  // Guild ID：/discord-bind 建立 per-project channel 時建在哪個 server。
  // Bot 須實際在此 guild 且有 Manage Channels 權限。未設時 /discord-bind 會報錯。
  // "guildId": "1234567890",

  // Archive category ID：daemon 發現 binding 的 cwd 已不存在時，對應 channel
  // 移到此 category（保留歷史訊息但不收新訊息）。未設則只清 binding。
  // "archiveCategoryId": "1234567890",

  // 輸出策略：
  //   "turn-end"（預設）：等 turn 結束一次送完整回覆，超過 2000 字自動切多段
  //   "edit"（未來擴充）：每 N ms edit 首則訊息模擬 streaming
  "streamStrategy": "turn-end",

  // 多段訊息的 reply 行為：
  //   "first"（預設）：只首段 @ 回覆原訊息（像 Hermes）
  //   "all"：每段都加 reply reference
  //   "off"：不加 reply
  "replyMode": "first"
}
`
