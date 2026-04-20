/**
 * Discord 設定檔路徑解析。
 *
 * 單一來源：~/.my-agent/discord.json
 * - 位於 getMemoryBaseDir()（與 USER.md、llamacpp.json 同層）
 * - env override：DISCORD_CONFIG_PATH（絕對路徑）
 */
import { join } from 'path'
import { getMemoryBaseDir } from '../memdir/paths.js'

export const DISCORD_CONFIG_FILENAME = 'discord.json'

export function getDiscordConfigPath(): string {
  const override = process.env.DISCORD_CONFIG_PATH
  if (override && override.trim().length > 0) {
    return override
  }
  return join(getMemoryBaseDir(), DISCORD_CONFIG_FILENAME)
}
