/**
 * Informix 設定檔路徑解析。
 *
 * 單一來源：~/.my-agent/informix.json
 * env override：INFORMIX_CONFIG_PATH（絕對路徑）
 */
import { join } from 'path'
import { getMemoryBaseDir } from '../memdir/paths.js'

export const INFORMIX_CONFIG_FILENAME = 'informix.json'

export function getInformixConfigPath(): string {
  const override = process.env.INFORMIX_CONFIG_PATH
  if (override && override.trim().length > 0) {
    return override
  }
  return join(getMemoryBaseDir(), INFORMIX_CONFIG_FILENAME)
}
