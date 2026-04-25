/**
 * Discord 設定檔路徑解析。
 *
 * 單一來源：~/.my-agent/discord.jsonc
 * - 位於 getMemoryBaseDir()（與 USER.md、llamacpp.jsonc 同層）
 * - env override：DISCORD_CONFIG_PATH（絕對路徑）
 * - 自動遷移：若 .jsonc 不存在但 .json 存在 → rename .json → .jsonc
 */
import { join } from 'path'
import { getMemoryBaseDir } from '../memdir/paths.js'
import { migrateJsonToJsoncIfNeeded } from '../utils/jsoncStore.js'

export const DISCORD_CONFIG_FILENAME = 'discord.jsonc'

export function getDiscordConfigPath(): string {
  const override = process.env.DISCORD_CONFIG_PATH
  if (override && override.trim().length > 0) {
    return override
  }
  const path = join(getMemoryBaseDir(), DISCORD_CONFIG_FILENAME)
  migrateJsonToJsoncIfNeeded(path)
  return path
}
