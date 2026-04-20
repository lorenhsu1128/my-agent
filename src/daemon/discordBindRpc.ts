/**
 * M-DISCORD-AUTOBIND：daemon 側處理 `/discord-bind` 與 `/discord-unbind` RPC。
 *
 * Frame 協議（WS 單行 JSON）：
 *
 * client → daemon：
 *   { type: 'discord.bind',   requestId, cwd, projectName }
 *   { type: 'discord.unbind', requestId, cwd }
 *
 * daemon → client（對應同 requestId）：
 *   { type: 'discord.bindResult', requestId, ok, channelId?, channelName?, url?, error? }
 *   { type: 'discord.unbindResult', requestId, ok, error? }
 *
 * `channelFactory` 的實際 Discord API 呼叫由這裡觸發；要 client handle 能工作代表
 * Discord gateway 已啟動（enabled=true + token 有效 + 連線完成）。
 */
import type { Client } from 'discord.js'
import type { DiscordConfig } from '../discordConfig/schema.js'
import {
  addChannelBinding,
  removeChannelBinding,
} from '../discordConfig/loader.js'
import {
  archiveProjectChannel,
  createProjectChannel,
  renameChannel,
  sendWelcomeMessage,
} from '../discord/channelFactory.js'
import { computeChannelName } from '../discord/channelNaming.js'
import { basename } from 'path'
import { projectIdFromCwd } from './projectRegistry.js'

export interface DiscordBindContext {
  /**
   * 取當前 Discord raw client；未啟用 Discord 時回 null。
   * 用 getter 而非直接傳 Client 以支援 gateway 啟動後才 available 的 race。
   */
  getClient: () => Client | null
  /** 讀當前 config 快照（要用 live ref，不要快取一次性） */
  getConfig: () => DiscordConfig
}

export interface BindRequest {
  type: 'discord.bind'
  requestId: string
  cwd: string
  projectName?: string
}

export interface UnbindRequest {
  type: 'discord.unbind'
  requestId: string
  cwd: string
}

export interface BindResult {
  type: 'discord.bindResult'
  requestId: string
  ok: boolean
  channelId?: string
  channelName?: string
  url?: string
  alreadyBound?: boolean
  error?: string
}

export interface UnbindResult {
  type: 'discord.unbindResult'
  requestId: string
  ok: boolean
  error?: string
}

/** 判斷 frame 是否為 discord.bind / discord.unbind；供 daemon onMessage dispatch。 */
export function isDiscordBindRequest(m: unknown): m is BindRequest {
  return (
    !!m &&
    typeof m === 'object' &&
    (m as { type?: string }).type === 'discord.bind'
  )
}

export function isDiscordUnbindRequest(m: unknown): m is UnbindRequest {
  return (
    !!m &&
    typeof m === 'object' &&
    (m as { type?: string }).type === 'discord.unbind'
  )
}

export async function handleBindRequest(
  req: BindRequest,
  ctx: DiscordBindContext,
): Promise<BindResult> {
  const client = ctx.getClient()
  const config = ctx.getConfig()
  if (!client) {
    return {
      type: 'discord.bindResult',
      requestId: req.requestId,
      ok: false,
      error: 'Discord gateway not running. Check ~/.my-agent/discord.json has enabled=true and valid bot token.',
    }
  }
  if (!config.guildId) {
    return {
      type: 'discord.bindResult',
      requestId: req.requestId,
      ok: false,
      error: 'guildId not set in ~/.my-agent/discord.json. Add your Discord server ID first.',
    }
  }

  const projectId = projectIdFromCwd(req.cwd)

  // 檢查是否已綁
  const existingEntry = Object.entries(config.channelBindings).find(
    ([, path]) => path === req.cwd,
  )
  if (existingEntry) {
    const [chId] = existingEntry
    return {
      type: 'discord.bindResult',
      requestId: req.requestId,
      ok: true,
      alreadyBound: true,
      channelId: chId,
      url: `https://discord.com/channels/${config.guildId}/${chId}`,
    }
  }

  const channelName = computeChannelName(projectId, basename(req.cwd))
  try {
    const result = await createProjectChannel(
      client,
      config.guildId,
      channelName,
      req.cwd,
    )
    await addChannelBinding(result.channelId, req.cwd)
    // Welcome message (best-effort; 失敗不算 bind 失敗)
    try {
      await sendWelcomeMessage(client, result.channelId, {
        projectName: req.projectName ?? basename(req.cwd),
        projectPath: req.cwd,
        projectId,
      })
    } catch {
      // ignore
    }
    return {
      type: 'discord.bindResult',
      requestId: req.requestId,
      ok: true,
      channelId: result.channelId,
      channelName: result.name,
      url: result.url,
    }
  } catch (e) {
    return {
      type: 'discord.bindResult',
      requestId: req.requestId,
      ok: false,
      error:
        e instanceof Error
          ? e.message
          : `channel create failed: ${String(e)}`,
    }
  }
}

export async function handleUnbindRequest(
  req: UnbindRequest,
  ctx: DiscordBindContext,
): Promise<UnbindResult> {
  const client = ctx.getClient()
  const config = ctx.getConfig()
  if (!client) {
    return {
      type: 'discord.unbindResult',
      requestId: req.requestId,
      ok: false,
      error: 'Discord gateway not running.',
    }
  }
  if (!config.guildId) {
    return {
      type: 'discord.unbindResult',
      requestId: req.requestId,
      ok: false,
      error: 'guildId not set.',
    }
  }
  const entry = Object.entries(config.channelBindings).find(
    ([, path]) => path === req.cwd,
  )
  if (!entry) {
    return {
      type: 'discord.unbindResult',
      requestId: req.requestId,
      ok: false,
      error: `no binding for ${req.cwd}`,
    }
  }
  const [channelId] = entry
  try {
    // Rename to unbound- 前綴（頻道保留）
    const currentChannel = client.channels.cache.get(channelId)
    const currentName =
      currentChannel && 'name' in currentChannel
        ? (currentChannel as { name: string }).name
        : channelId
    if (!currentName.startsWith('unbound-')) {
      await renameChannel(
        client,
        config.guildId,
        channelId,
        `unbound-${currentName}`,
      )
    }
    await removeChannelBinding(channelId)
    return {
      type: 'discord.unbindResult',
      requestId: req.requestId,
      ok: true,
    }
  } catch (e) {
    return {
      type: 'discord.unbindResult',
      requestId: req.requestId,
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    }
  }
}

/**
 * Archive stale channel — 給 bindingHealthCheck 用（daemon 啟動時發現 cwd 已消失）。
 */
export async function archiveStaleChannel(
  client: Client,
  config: DiscordConfig,
  channelId: string,
): Promise<void> {
  if (!config.guildId) return
  await archiveProjectChannel(
    client,
    config.guildId,
    channelId,
    config.archiveCategoryId,
  )
  await removeChannelBinding(channelId)
}
