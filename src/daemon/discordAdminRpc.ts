/**
 * M-DISCORD-ADMIN：REPL → daemon 的 Discord admin RPC。
 *
 * 使用單一 frame type `discord.admin` + `op` 分流，共用一個 result frame type
 * `discord.adminResult`。避免每個操作都開新 frame 的 boilerplate。
 *
 * 支援的 op：
 *   - `whitelistAdd` / `whitelistRemove` — 管理 whitelistUserIds
 *   - `invite`                          — 回傳 bot OAuth invite URL + appId
 *   - `guilds`                          — 回傳 bot 當前所在 guilds 清單
 *
 * 設計同 discordBindRpc：getClient / getConfig 用 getter 以支援 gateway late-ready。
 */
import type { Client, GuildTextBasedChannel } from 'discord.js'
import { PermissionFlagsBits } from 'discord.js'
import { basename } from 'path'
import { readFile, writeFile } from 'fs/promises'
import type { DiscordConfig } from '../discordConfig/schema.js'
import {
  addChannelBinding,
  addWhitelistUser,
  removeChannelBinding,
  removeWhitelistUser,
} from '../discordConfig/loader.js'
import { getDiscordConfigPath } from '../discordConfig/paths.js'
import { normalizeProjectPath } from '../discordConfig/pathNormalize.js'

/** Invite URL 預設權限 bits — 跟 slash `/discord invite` 一致。 */
const INVITE_PERMISSION_BITS =
  PermissionFlagsBits.ViewChannel |
  PermissionFlagsBits.SendMessages |
  PermissionFlagsBits.ReadMessageHistory |
  PermissionFlagsBits.AttachFiles

export interface DiscordAdminContext {
  getClient: () => Client | null
  getConfig: () => DiscordConfig
}

export type DiscordAdminOp =
  | 'whitelistAdd'
  | 'whitelistRemove'
  | 'invite'
  | 'guilds'
  | 'bindChannel'
  | 'unbindChannel'

export interface DiscordAdminRequest {
  type: 'discord.admin'
  requestId: string
  op: DiscordAdminOp
  /** whitelistAdd / whitelistRemove 用 */
  userId?: string
  /** bindChannel / unbindChannel 用 */
  channelId?: string
  /** bindChannel 用 — 已由 REPL 端解析 projectKey → path */
  projectPath?: string
  /** bindChannel 用 — true 時若 projectPath 不在 projects[] 自動 append */
  autoRegister?: boolean
}

export interface GuildInfo {
  id: string
  name: string
  memberCount: number
}

export interface DiscordAdminResult {
  type: 'discord.adminResult'
  requestId: string
  op: DiscordAdminOp
  ok: boolean
  error?: string
  /** whitelistAdd / whitelistRemove / unbindChannel 回傳：是否實際改了（冪等） */
  changed?: boolean
  /** invite 回傳 */
  inviteUrl?: string
  appId?: string
  /** guilds 回傳 */
  guilds?: GuildInfo[]
  /** bindChannel / unbindChannel 回傳 */
  channelId?: string
  channelName?: string
  guildId?: string
  guildName?: string
  /** bindChannel：若 projectPath 不在 projects[] 自動 append，此欄為 true */
  autoRegistered?: boolean
  /** bindChannel：此 projectPath 已有其他 channel 綁；listing warn 給 REPL */
  existingChannels?: string[]
  /** unbindChannel：解綁前的 projectPath */
  previousPath?: string
}

export function isDiscordAdminRequest(m: unknown): m is DiscordAdminRequest {
  return (
    !!m &&
    typeof m === 'object' &&
    (m as { type?: string }).type === 'discord.admin'
  )
}

export async function handleAdminRequest(
  req: DiscordAdminRequest,
  ctx: DiscordAdminContext,
): Promise<DiscordAdminResult> {
  const base = { type: 'discord.adminResult' as const, requestId: req.requestId, op: req.op }

  if (req.op === 'whitelistAdd') {
    if (!req.userId) return { ...base, ok: false, error: 'userId required' }
    try {
      const changed = await addWhitelistUser(req.userId)
      return { ...base, ok: true, changed }
    } catch (e) {
      return { ...base, ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  }

  if (req.op === 'whitelistRemove') {
    if (!req.userId) return { ...base, ok: false, error: 'userId required' }
    try {
      const changed = await removeWhitelistUser(req.userId)
      return { ...base, ok: true, changed }
    } catch (e) {
      return { ...base, ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  }

  if (req.op === 'invite') {
    const client = ctx.getClient()
    if (!client) {
      return { ...base, ok: false, error: 'Discord gateway not running' }
    }
    const appId = client.application?.id ?? client.user?.id
    if (!appId) {
      return { ...base, ok: false, error: 'client not ready (no application id)' }
    }
    const perms = INVITE_PERMISSION_BITS.toString()
    const inviteUrl =
      `https://discord.com/api/oauth2/authorize` +
      `?client_id=${appId}` +
      `&permissions=${perms}` +
      `&scope=bot%20applications.commands`
    return { ...base, ok: true, inviteUrl, appId }
  }

  if (req.op === 'guilds') {
    const client = ctx.getClient()
    if (!client) {
      return { ...base, ok: false, error: 'Discord gateway not running' }
    }
    const guilds: GuildInfo[] = []
    for (const g of client.guilds.cache.values()) {
      guilds.push({ id: g.id, name: g.name, memberCount: g.memberCount })
    }
    return { ...base, ok: true, guilds }
  }

  if (req.op === 'bindChannel') {
    if (!req.channelId) return { ...base, ok: false, error: 'channelId required' }
    if (!req.projectPath) return { ...base, ok: false, error: 'projectPath required' }
    const projectPath = normalizeProjectPath(req.projectPath)
    const client = ctx.getClient()
    if (!client) return { ...base, ok: false, error: 'Discord gateway not running' }

    // 1. 驗證 bot 可見 channel
    let channel: GuildTextBasedChannel
    try {
      const fetched = await client.channels.fetch(req.channelId)
      if (!fetched) {
        return { ...base, ok: false, error: `channel ${req.channelId} not found or bot 沒權限 View` }
      }
      if (!('guildId' in fetched) || !fetched.isTextBased()) {
        return { ...base, ok: false, error: `channel ${req.channelId} 不是 guild text channel` }
      }
      channel = fetched as GuildTextBasedChannel
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return {
        ...base,
        ok: false,
        error: `無法讀取 channel（bot 未被邀進該 guild、或缺 View Channel 權限）：${msg}`,
      }
    }

    const config = ctx.getConfig()
    // 2. 檢查 projectPath 是否在 projects[]；否且 autoRegister 就 append
    let autoRegistered = false
    const projectExists = config.projects.some(p => p.path === projectPath)
    if (!projectExists) {
      if (req.autoRegister) {
        try {
          await appendProject(config, projectPath)
          autoRegistered = true
        } catch (e) {
          return {
            ...base,
            ok: false,
            error: `auto-register project 失敗：${e instanceof Error ? e.message : String(e)}`,
          }
        }
      } else {
        const ids = config.projects.map(p => `${p.id} (${p.path})`).join(', ')
        return {
          ...base,
          ok: false,
          error: `projectPath \`${projectPath}\` 不在 projects[] 中。可用：${ids || '(空)'}。`,
        }
      }
    }

    // 3. 衝突偵測（警告但仍 proceed）
    const existingChannels = Object.entries(config.channelBindings)
      .filter(([, p]) => p === projectPath)
      .map(([chId]) => chId)

    // 4. 寫入 binding
    try {
      await addChannelBinding(req.channelId, projectPath)
    } catch (e) {
      return { ...base, ok: false, error: e instanceof Error ? e.message : String(e) }
    }

    const guild = channel.guild
    return {
      ...base,
      ok: true,
      channelId: req.channelId,
      channelName: channel.name,
      guildId: guild.id,
      guildName: guild.name,
      ...(autoRegistered && { autoRegistered: true }),
      ...(existingChannels.length > 0 && { existingChannels }),
    }
  }

  if (req.op === 'unbindChannel') {
    if (!req.channelId) return { ...base, ok: false, error: 'channelId required' }
    const config = ctx.getConfig()
    const previousPath = config.channelBindings[req.channelId]
    if (!previousPath) {
      return {
        ...base,
        ok: true,
        changed: false,
        channelId: req.channelId,
      }
    }
    try {
      await removeChannelBinding(req.channelId)
    } catch (e) {
      return { ...base, ok: false, error: e instanceof Error ? e.message : String(e) }
    }
    return {
      ...base,
      ok: true,
      changed: true,
      channelId: req.channelId,
      previousPath,
    }
  }

  return { ...base, ok: false, error: `unknown op: ${String(req.op)}` }
}

/**
 * 把一個新 project 加進 discord.json 的 projects[]，同時 in-place mutate
 * cached snapshot 讓 running gateway 立即看到。id / name 從 basename(path) 推導。
 * 若 id 已被佔用會 append 一個短 hash 避免重複。
 */
async function appendProject(cfg: DiscordConfig, rawPath: string): Promise<void> {
  const projectPath = normalizeProjectPath(rawPath)
  const path = getDiscordConfigPath()
  let raw: string
  try {
    raw = await readFile(path, 'utf-8')
  } catch {
    raw = JSON.stringify({ projects: [] }, null, 2)
  }
  const parsed = JSON.parse(raw.replace(/^\uFEFF/, '')) as Record<string, unknown>
  const projects = (parsed.projects as Array<Record<string, unknown>> | undefined) ?? []

  // id 衝突偵測：取 basename，若已有重名加 4 字 hex 後綴
  const baseId = basename(projectPath).toLowerCase().replace(/[^a-z0-9_-]/g, '-') || 'proj'
  let id = baseId
  const usedIds = new Set(projects.map(p => String(p.id ?? '')))
  if (usedIds.has(id)) {
    const hash = Math.floor(Math.random() * 0xffff).toString(16).padStart(4, '0')
    id = `${baseId}-${hash}`
  }
  const name = basename(projectPath)
  const entry = { id, name, path: projectPath, aliases: [] as string[] }
  projects.push(entry)
  parsed.projects = projects
  await writeFile(path, JSON.stringify(parsed, null, 2) + '\n', 'utf-8')
  // 同步 mutate cached snapshot（gateway 共用 reference）
  cfg.projects.push(entry)
}
