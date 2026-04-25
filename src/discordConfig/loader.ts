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
import { normalizeProjectPath } from './pathNormalize.js'
import {
  DEFAULT_DISCORD_CONFIG,
  DiscordConfigSchema,
  type DiscordConfig,
} from './schema.js'
import {
  parseJsonc,
  writeJsoncPreservingComments,
} from '../utils/jsoncStore.js'

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
    parsed = parseJsonc(raw.replace(/^\uFEFF/, ''))
  } catch (e) {
    warnOnce(
      `${path} JSONC 解析失敗：${e instanceof Error ? e.message : String(e)}`,
    )
    return DEFAULT_DISCORD_CONFIG
  }
  const result = DiscordConfigSchema.safeParse(parsed)
  if (!result.success) {
    warnOnce(`${path} schema 驗證失敗：${result.error.message}`)
    return DEFAULT_DISCORD_CONFIG
  }
  const cfg = result.data

  // 路徑 normalize — 消除 Windows 正/反斜線、驅動字母大小寫差異造成的比對錯誤。
  // 只動 in-memory；下一次 write 會自然 persist。
  for (const p of cfg.projects) {
    p.path = normalizeProjectPath(p.path)
  }
  if (cfg.defaultProjectPath) {
    cfg.defaultProjectPath = normalizeProjectPath(cfg.defaultProjectPath)
  }
  for (const chId of Object.keys(cfg.channelBindings)) {
    cfg.channelBindings[chId] = normalizeProjectPath(cfg.channelBindings[chId]!)
  }

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

/**
 * Resolve bot token — env var `DISCORD_BOT_TOKEN` 優先，其次 config.botToken。
 * 兩者皆空回 undefined；caller 應印 warning 並跳過 gateway 啟動。
 */
export function getDiscordBotToken(): string | undefined {
  const env = process.env.DISCORD_BOT_TOKEN
  if (env && env.trim().length > 0) return env.trim()
  const fromCfg = getDiscordConfigSnapshot().botToken
  if (fromCfg && fromCfg.trim().length > 0) return fromCfg.trim()
  return undefined
}

/**
 * M-DISCORD-AUTOBIND：對 discord.json `channelBindings` 增刪的 atomic 寫回。
 *
 * 為了讓 running daemon 的 gateway 馬上看到新 binding（gateway 關閉了 config
 * reference），這裡**就地**修改 `cached.channelBindings` 物件（delete + assign），
 * 而非 replace whole snapshot。該 Map 物件是跟 gateway 共用的。
 *
 * 若 cached 尚未 load（edge case）→ 會先跑一次 load。
 */
export async function addChannelBinding(
  channelId: string,
  projectPath: string,
): Promise<void> {
  const normalized = normalizeProjectPath(projectPath)
  const cfg = await loadDiscordConfigSnapshot()
  // 讀 live 檔案重新 parse（避免覆蓋其他使用者外部編輯）
  const path = getDiscordConfigPath()
  let raw: string
  try {
    raw = await readFile(path, 'utf-8')
  } catch {
    raw = JSON.stringify(DEFAULT_DISCORD_CONFIG, null, 2)
  }
  const parsed = parseJsonc(raw.replace(/^\uFEFF/, '')) as Record<string, unknown>
  const bindings =
    (parsed.channelBindings as Record<string, string> | undefined) ?? {}
  bindings[channelId] = normalized
  parsed.channelBindings = bindings
  await writeJsoncPreservingComments(path, raw.replace(/^﻿/, ''), parsed)
  // 同步更新 in-memory（gateway 共用此物件 reference）
  cfg.channelBindings[channelId] = normalized
}

export async function removeChannelBinding(channelId: string): Promise<void> {
  const cfg = await loadDiscordConfigSnapshot()
  const path = getDiscordConfigPath()
  let raw: string
  try {
    raw = await readFile(path, 'utf-8')
  } catch {
    return
  }
  const parsed = parseJsonc(raw.replace(/^\uFEFF/, '')) as Record<string, unknown>
  const bindings =
    (parsed.channelBindings as Record<string, string> | undefined) ?? {}
  if (!(channelId in bindings)) {
    // 已經不在檔案裡 — 仍確保 in-memory 清乾淨
    delete cfg.channelBindings[channelId]
    return
  }
  delete bindings[channelId]
  parsed.channelBindings = bindings
  await writeJsoncPreservingComments(path, raw.replace(/^﻿/, ''), parsed)
  delete cfg.channelBindings[channelId]
}

/**
 * 加 user ID 到 whitelistUserIds（冪等）。寫回 disk + in-place mutate cached
 * snapshot（gateway 共用 reference 立即生效）。回傳是否實際加入。
 */
export async function addWhitelistUser(userId: string): Promise<boolean> {
  const cfg = await loadDiscordConfigSnapshot()
  const already = cfg.whitelistUserIds.includes(userId)
  const path = getDiscordConfigPath()
  let raw: string
  try {
    raw = await readFile(path, 'utf-8')
  } catch {
    raw = JSON.stringify(DEFAULT_DISCORD_CONFIG, null, 2)
  }
  const parsed = parseJsonc(raw.replace(/^\uFEFF/, '')) as Record<string, unknown>
  const list = (parsed.whitelistUserIds as string[] | undefined) ?? []
  if (list.includes(userId)) {
    // disk 已有；確保 in-memory 同步（理論上一致，防邊界情況）
    if (!already) cfg.whitelistUserIds.push(userId)
    return false
  }
  list.push(userId)
  parsed.whitelistUserIds = list
  await writeJsoncPreservingComments(path, raw.replace(/^﻿/, ''), parsed)
  if (!already) cfg.whitelistUserIds.push(userId)
  return true
}

export async function removeWhitelistUser(userId: string): Promise<boolean> {
  const cfg = await loadDiscordConfigSnapshot()
  const path = getDiscordConfigPath()
  let raw: string
  try {
    raw = await readFile(path, 'utf-8')
  } catch {
    return false
  }
  const parsed = parseJsonc(raw.replace(/^\uFEFF/, '')) as Record<string, unknown>
  const list = (parsed.whitelistUserIds as string[] | undefined) ?? []
  const idx = list.indexOf(userId)
  const memIdx = cfg.whitelistUserIds.indexOf(userId)
  if (idx < 0) {
    if (memIdx >= 0) cfg.whitelistUserIds.splice(memIdx, 1)
    return false
  }
  list.splice(idx, 1)
  parsed.whitelistUserIds = list
  await writeJsoncPreservingComments(path, raw.replace(/^﻿/, ''), parsed)
  if (memIdx >= 0) cfg.whitelistUserIds.splice(memIdx, 1)
  return true
}

export function _resetDiscordConfigForTests(): void {
  cached = null
  loadInFlight = null
  warned = false
}
