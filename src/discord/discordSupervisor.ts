/**
 * M-WEB-CLOSEOUT-9：DiscordSupervisor — 把原本 daemonCli 內聯的 discord 啟動 / dispose
 * 抽成可重複呼叫的 lifecycle 物件，讓 web admin 端能 reload / restart。
 *
 * Lifecycle：
 *   - `start()` 讀 ~/.my-agent/discord.json + env token，跑 `startDiscordGateway`
 *   - `stop()` 呼叫 dispose（gateway 自己處理 client.destroy）
 *   - `restart()` = stop + start（讀最新 config，可重啟連線、套新 token / intents）
 *   - `reload()` 不重啟連線，只重讀 config 快照（影響 channelBindings / whitelistUserIds
 *     等 gateway 內查 live snapshot 的欄位；token / intents 須 restart 才生效）
 *
 * 不變式：
 *   - `getClient()` / `getConfig()` 在未啟動時回 null / undefined
 *   - 任一 lifecycle 操作 race 由 caller（restRoutes / daemonCli）保證序列化
 */
import type { Client } from 'discord.js'
import {
  loadDiscordConfigSnapshot,
  _resetDiscordConfigForTests as resetDiscordConfigCache,
} from '../discordConfig/loader.js'
import { getDiscordBotToken } from '../discordConfig/index.js'
import type { DiscordConfig } from '../discordConfig/schema.js'
import type { ProjectRegistry } from '../daemon/projectRegistry.js'
import type {
  PermissionMode,
} from '../utils/permissions/permissionMode.js'

export interface DiscordSupervisorBroadcasts {
  broadcastPermissionMode: (projectId: string, mode: PermissionMode) => void
  broadcastDiscordInbound: (projectId: string, payload: unknown) => void
  broadcastDiscordTurn: (projectId: string, payload: unknown) => void
}

export interface DiscordSupervisorOptions {
  registry: ProjectRegistry
  visionEnabled: () => boolean
  log: (msg: string) => void
  broadcasts: DiscordSupervisorBroadcasts
}

export interface DiscordSupervisor {
  start(): Promise<{ ok: boolean; reason?: string; tokenSource?: 'env' | 'config' }>
  stop(): Promise<void>
  restart(): Promise<{ ok: boolean; reason?: string }>
  /** 重讀 config 但不重啟連線。token / intents 改變需 restart。 */
  reload(): Promise<{ ok: boolean; reason?: string }>
  getClient(): Client | null
  /** 取目前 in-memory config（live snapshot；reload 會更新）。 */
  getConfig(): DiscordConfig | null
  isRunning(): boolean
}

export function createDiscordSupervisor(
  opts: DiscordSupervisorOptions,
): DiscordSupervisor {
  let dispose: (() => Promise<void>) | null = null
  let client: Client | null = null
  let config: DiscordConfig | null = null

  async function start(): Promise<{ ok: boolean; reason?: string; tokenSource?: 'env' | 'config' }> {
    if (dispose) return { ok: true, reason: 'already running' }
    try {
      const cfg = await loadDiscordConfigSnapshot()
      config = cfg
      if (!cfg.enabled) {
        return { ok: false, reason: 'discord disabled in config' }
      }
      const token = getDiscordBotToken()
      if (!token) {
        return {
          ok: false,
          reason:
            'no token (set DISCORD_BOT_TOKEN env or discord.json botToken)',
        }
      }
      const { startDiscordGateway } = await import('./gateway.js')
      const dg = await startDiscordGateway({
        config: cfg,
        token,
        registry: opts.registry,
        visionEnabled: opts.visionEnabled(),
        log: {
          info: msg => void opts.log(msg),
          warn: msg => void opts.log(msg),
          error: msg => void opts.log(msg),
        },
        broadcastPermissionMode: opts.broadcasts.broadcastPermissionMode,
        broadcastDiscordInbound: opts.broadcasts.broadcastDiscordInbound,
        broadcastDiscordTurn: opts.broadcasts.broadcastDiscordTurn,
      })
      dispose = dg.dispose
      client = dg.client.raw
      const tokenSource = process.env.DISCORD_BOT_TOKEN ? 'env' : 'config'
      opts.log(`discord supervisor: started (token=${tokenSource})`)
      return { ok: true, tokenSource }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      opts.log(`discord supervisor: start failed: ${msg}`)
      return { ok: false, reason: msg }
    }
  }

  async function stop(): Promise<void> {
    if (!dispose) return
    try {
      await dispose()
    } catch (e) {
      opts.log(
        `discord supervisor: dispose error (continuing): ${e instanceof Error ? e.message : String(e)}`,
      )
    }
    dispose = null
    client = null
    opts.log('discord supervisor: stopped')
  }

  async function restart(): Promise<{ ok: boolean; reason?: string }> {
    await stop()
    resetDiscordConfigCache()
    const r = await start()
    return { ok: r.ok, reason: r.reason }
  }

  async function reload(): Promise<{ ok: boolean; reason?: string }> {
    try {
      resetDiscordConfigCache()
      const cfg = await loadDiscordConfigSnapshot()
      config = cfg
      opts.log(
        'discord supervisor: config reloaded (token/intents changes require restart)',
      )
      return { ok: true }
    } catch (e) {
      return {
        ok: false,
        reason: e instanceof Error ? e.message : String(e),
      }
    }
  }

  return {
    start,
    stop,
    restart,
    reload,
    getClient: () => client,
    getConfig: () => config,
    isRunning: () => dispose !== null,
  }
}
