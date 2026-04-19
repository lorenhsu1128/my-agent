/**
 * llama.cpp 設定檔路徑解析。
 *
 * 單一來源：~/.my-agent/llamacpp.json
 * - 位於 getMemoryBaseDir()（與 USER.md、system-prompt/、memdir 同層）
 * - env override：LLAMACPP_CONFIG_PATH（絕對路徑）
 */
import { join } from 'path'
import { getMemoryBaseDir } from '../memdir/paths.js'

export const LLAMACPP_CONFIG_FILENAME = 'llamacpp.json'

export function getLlamaCppConfigPath(): string {
  const override = process.env.LLAMACPP_CONFIG_PATH
  if (override && override.trim().length > 0) {
    return override
  }
  return join(getMemoryBaseDir(), LLAMACPP_CONFIG_FILENAME)
}
