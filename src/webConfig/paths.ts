/**
 * Web UI 設定檔路徑解析。
 *
 * 單一來源：~/.my-agent/web.jsonc
 *   - 位於 getMemoryBaseDir()（與 USER.md / llamacpp.jsonc / discord.jsonc 同層）
 *   - env override：MYAGENT_WEB_CONFIG_PATH（絕對路徑）
 *   - 自動遷移：若 .jsonc 不存在但 .json 存在 → rename .json → .jsonc
 */
import { join } from 'path'
import { getMemoryBaseDir } from '../memdir/paths.js'
import { migrateJsonToJsoncIfNeeded } from '../utils/jsoncStore.js'

export const WEB_CONFIG_FILENAME = 'web.jsonc'

export function getWebConfigPath(): string {
  const override = process.env.MYAGENT_WEB_CONFIG_PATH
  if (override && override.trim().length > 0) {
    return override
  }
  const path = join(getMemoryBaseDir(), WEB_CONFIG_FILENAME)
  migrateJsonToJsoncIfNeeded(path)
  return path
}
