/**
 * M-DISCORD-3：Discord gateway 設定 schema。
 *
 * 存放位置：~/.my-agent/discord.json
 * 預設啟用時需要 `DISCORD_BOT_TOKEN` 環境變數（不寫進 config 避免 secrets 進檔）。
 *
 * 路由規則：
 *   - DM：訊息前綴 `#<projectId|alias> ...` 指定 project；沒前綴 → defaultProjectPath
 *   - Channel：`channelBindings[channelId]` 查到 projectPath，沒綁就忽略訊息
 */
import { z } from 'zod'

/** 單一 project 的宣告：id（路由 key）、顯示名、實體 cwd、alias 清單。 */
export const DiscordProjectSchema = z.object({
  /**
   * Project 識別字（DM 前綴 `#<id>` 會對到它）。通常是短名稱如 `my-agent`。
   * 需唯一；大小寫敏感（前綴解析會 toLowerCase 比對 aliases 一併）。
   */
  id: z.string().min(1),
  /** 顯示名（`/list` 等 UI 用）。 */
  name: z.string().min(1),
  /** 實際 filesystem 絕對路徑；daemon loadProject 會用它。 */
  path: z.string().min(1),
  /** 備用前綴（DM 裡 `#ma hi` 若 aliases 包含 `ma` 則路由到此 project）。 */
  aliases: z.array(z.string().min(1)).default([]),
})

export type DiscordProject = z.infer<typeof DiscordProjectSchema>

export const DiscordConfigSchema = z.object({
  /** 開關；為 false 時 daemon 不起 Discord gateway。 */
  enabled: z.boolean().default(false),
  /**
   * Bot token。可直接寫在此處（~/.my-agent/ 在使用者家目錄、非 git 目錄，風險低）
   * 或改用 env var `DISCORD_BOT_TOKEN`（env 優先於此欄位）。
   *
   * 安全提醒：
   *   - 這檔不要 commit 進 git（家目錄預設不會）
   *   - 檔案權限建議 0600（ssh/credentials 慣例）
   *   - 若 token 外洩請立刻到 Discord Developer Portal → Bot → Reset Token
   */
  botToken: z.string().optional(),
  /** 白名單 Discord user id（snowflake 字串）；必填非空。 */
  whitelistUserIds: z.array(z.string().min(1)).default([]),
  /**
   * DM 沒前綴時的 fallback project path。必須是 projects[].path 中的其中一個；
   * loader 會驗證。沒設 = DM 沒前綴時忽略訊息。
   */
  defaultProjectPath: z.string().optional(),
  /** 多 project 宣告。 */
  projects: z.array(DiscordProjectSchema).default([]),
  /**
   * Channel ID → project path 映射。guild channel 送訊息必須 match；
   * 沒 match 的 channel 一律忽略（即使 bot 被 invite 進去）。
   */
  channelBindings: z.record(z.string(), z.string()).default({}),
  /** Home channel ID：cron 完成 / 長任務通知 / daemon 事件 post 至此。未設則不 post。 */
  homeChannelId: z.string().optional(),
  /**
   * Guild ID：`/discord-bind` 建立 per-project channel 時指定建在哪個 server。
   * Bot 須實際在此 guild 且擁有 Manage Channels 權限。未設時 `/discord-bind` 報錯。
   */
  guildId: z.string().optional(),
  /**
   * Archive category ID：daemon 啟動發現 binding 的 cwd 已不存在時，對應頻道
   * 會被移到此 category（保留歷史訊息但不再接收新訊息）。未設則不 archive，
   * 只清 binding。
   */
  archiveCategoryId: z.string().optional(),
  /**
   * 輸出策略：
   *   - `turn-end`（預設）：等 turn 結束一次送完整回覆，超過 2000 字切多段
   *   - `edit`（未來擴充）：每 N ms edit 首則訊息模擬 streaming
   */
  streamStrategy: z.enum(['turn-end', 'edit']).default('turn-end'),
  /**
   * Reply mode 控制多段訊息是否都加 `reply` reference：
   *   - `first`（預設）：只首段回覆原訊息（像 Hermes）
   *   - `all`：每段都加 reply
   *   - `off`：不加
   */
  replyMode: z.enum(['first', 'all', 'off']).default('first'),
})

export type DiscordConfig = z.infer<typeof DiscordConfigSchema>

export const DEFAULT_DISCORD_CONFIG: DiscordConfig = {
  enabled: false,
  botToken: undefined,
  whitelistUserIds: [],
  defaultProjectPath: undefined,
  projects: [],
  channelBindings: {},
  homeChannelId: undefined,
  guildId: undefined,
  archiveCategoryId: undefined,
  streamStrategy: 'turn-end',
  replyMode: 'first',
}
