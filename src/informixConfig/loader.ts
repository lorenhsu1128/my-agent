/**
 * Informix 設定檔載入 + session 凍結快照。
 *
 * 沿用 llamacppConfig/loader.ts 模式：
 *   - loadInformixConfigSnapshot() session 啟動時呼叫一次並凍結
 *   - getInformixConfigSnapshot() 同步回傳凍結結果
 *   - 檔案不存在 / JSON 壞 / schema 失敗 → 走 DEFAULT_INFORMIX_CONFIG + stderr warn
 */
import { readFile } from 'fs/promises'
import { readFileSync } from 'fs'
import { getInformixConfigPath } from './paths.js'
import {
  DEFAULT_INFORMIX_CONFIG,
  InformixConfigSchema,
  type InformixConfig,
  type InformixConnection,
} from './schema.js'

let cached: InformixConfig | null = null
let loadInFlight: Promise<InformixConfig> | null = null
let warned = false

function warnOnce(reason: string): void {
  if (warned) return
  warned = true
  // biome-ignore lint/suspicious/noConsole: startup diagnostic
  console.error(`[informix-config] ${reason}；走內建預設`)
}

async function readLive(): Promise<InformixConfig> {
  const path = getInformixConfigPath()
  let raw: string
  try {
    raw = await readFile(path, 'utf-8')
  } catch {
    return DEFAULT_INFORMIX_CONFIG
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw.replace(/^﻿/, ''))
  } catch (e) {
    warnOnce(
      `${path} JSON 解析失敗：${e instanceof Error ? e.message : String(e)}`,
    )
    return DEFAULT_INFORMIX_CONFIG
  }
  const result = InformixConfigSchema.safeParse(parsed)
  if (!result.success) {
    warnOnce(`${path} schema 驗證失敗：${result.error.message}`)
    return DEFAULT_INFORMIX_CONFIG
  }
  return result.data
}

export async function loadInformixConfigSnapshot(): Promise<InformixConfig> {
  if (cached) return cached
  if (loadInFlight) return loadInFlight
  loadInFlight = readLive().then(cfg => {
    cached = cfg
    loadInFlight = null
    return cfg
  })
  return loadInFlight
}

export function getInformixConfigSnapshot(): InformixConfig {
  if (cached) return cached
  try {
    const raw = readFileSync(getInformixConfigPath(), 'utf-8')
    const parsed = JSON.parse(raw.replace(/^﻿/, ''))
    const result = InformixConfigSchema.safeParse(parsed)
    if (result.success) {
      cached = result.data
      return cached
    }
  } catch {
    // 走預設
  }
  return DEFAULT_INFORMIX_CONFIG
}

/**
 * 取得指定名稱的連線設定，並注入環境變數密碼
 */
export function getConnectionConfig(name?: string): InformixConnection & { password?: string } {
  const config = getInformixConfigSnapshot()
  const connName = name ?? config.defaultConnection
  const conn = config.connections[connName]

  if (!conn) {
    throw new Error(`Informix connection "${connName}" not found in config. Available: ${Object.keys(config.connections).join(', ')}`)
  }

  // 密碼從環境變數注入
  const envKey = connName === 'default'
    ? 'INFORMIX_PASSWORD'
    : `INFORMIX_PASSWORD_${connName.toUpperCase()}`
  const password = process.env[envKey] || process.env.INFORMIX_PASSWORD

  return { ...conn, password }
}

export function _resetInformixConfigForTests(): void {
  cached = null
  loadInFlight = null
  warned = false
}
