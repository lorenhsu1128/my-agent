/**
 * Discord 設定檔載入 + session 凍結快照。
 *
 * 與 llamacppConfig/loader 同模式：
 *   - loadDiscordConfigSnapshot() session 啟動時呼叫一次並凍結
 *   - getDiscordConfigSnapshot() 同步回傳凍結結果
 *   - 檔案不存在 / JSON 壞 / schema 失敗 → 走 DEFAULT + stderr warn；enabled=false
 */
import { readFile } from 'fs/promises'
import { getDiscordConfigPath } from './paths.js'
import {
  DEFAULT_DISCORD_CONFIG,
  DiscordConfigSchema,
  type DiscordConfig,
} from './schema.js'

let cached: DiscordConfig | null = null
let loadInFlight: Promise<DiscordConfig> | null = null
let warned = false

function warnOnce(reason: string): void {
  if (warned) return
  warned = true
  // biome-ignore lint/suspicious/noConsole: startup diagnostic
  console.error(`[discord-config] ${reason}；Discord gateway 停用`)
}

async function readLive(): Promise<DiscordConfig> {
  const path = getDiscordConfigPath()
  let raw: string
  try {
    raw = await readFile(path, 'utf-8')
  } catch {
    return DEFAULT_DISCORD_CONFIG
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw.replace(/^\uFEFF/, ''))
  } catch (e) {
    warnOnce(
      `${path} JSON 解析失敗：${e instanceof Error ? e.message : String(e)}`,
    )
    return DEFAULT_DISCORD_CONFIG
  }
  const result = DiscordConfigSchema.safeParse(parsed)
  if (!result.success) {
    warnOnce(`${path} schema 驗證失敗：${result.error.message}`)
    return DEFAULT_DISCORD_CONFIG
  }
  const cfg = result.data

  // 交叉驗證：defaultProjectPath 必須是 projects[].path 之一（若設了）。
  if (cfg.defaultProjectPath) {
    const known = new Set(cfg.projects.map(p => p.path))
    if (!known.has(cfg.defaultProjectPath)) {
      warnOnce(
        `defaultProjectPath=${cfg.defaultProjectPath} 不在 projects[].path 中；DM 沒前綴訊息將被忽略`,
      )
    }
  }
  // channelBindings 的 value 也應該是 projects[].path
  for (const [chId, projPath] of Object.entries(cfg.channelBindings)) {
    if (!cfg.projects.some(p => p.path === projPath)) {
      warnOnce(
        `channelBindings[${chId}]=${projPath} 不在 projects[].path 中；該 channel 訊息將被忽略`,
      )
    }
  }

  return cfg
}

export async function loadDiscordConfigSnapshot(): Promise<DiscordConfig> {
  if (cached) return cached
  if (loadInFlight) return loadInFlight
  loadInFlight = readLive().then(cfg => {
    cached = cfg
    loadInFlight = null
    return cfg
  })
  return loadInFlight
}

export function getDiscordConfigSnapshot(): DiscordConfig {
  return cached ?? DEFAULT_DISCORD_CONFIG
}

export function isDiscordEnabled(): boolean {
  return getDiscordConfigSnapshot().enabled
}

export function _resetDiscordConfigForTests(): void {
  cached = null
  loadInFlight = null
  warned = false
}
