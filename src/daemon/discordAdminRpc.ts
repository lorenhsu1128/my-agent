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
import type { Client } from 'discord.js'
import { PermissionFlagsBits } from 'discord.js'
import type { DiscordConfig } from '../discordConfig/schema.js'
import {
  addWhitelistUser,
  removeWhitelistUser,
} from '../discordConfig/loader.js'

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

export interface DiscordAdminRequest {
  type: 'discord.admin'
  requestId: string
  op: DiscordAdminOp
  /** whitelistAdd / whitelistRemove 用 */
  userId?: string
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
  /** whitelistAdd / whitelistRemove 回傳：是否實際改了（冪等） */
  changed?: boolean
  /** invite 回傳 */
  inviteUrl?: string
  appId?: string
  /** guilds 回傳 */
  guilds?: GuildInfo[]
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

  return { ...base, ok: false, error: `unknown op: ${String(req.op)}` }
}
