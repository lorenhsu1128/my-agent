/**
 * M-WEB-CLOSEOUT-9：DiscordSupervisor — 把原本 daemonCli 內聯的 discord 啟動 / dispose
 * 抽成可重複呼叫的 lifecycle 物件，讓 web admin 端能 reload / restart。
 *
 * Lifecycle：
 *   - `start()` 讀 ~/.virtual-assistant-desktop/discord.json + env token，跑 `startDiscordGateway`
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

/**
 * 給 supervisor.start() 的選項（embedded 模式用以繞過 jsonc 編輯流程）。
 *
 * 一般 daemonCli 路徑不傳 → 行為與 G7 Phase 2 前完全相同（讀 jsonc + env）。
 * embedded `AgentEmbedded.startDiscordBot()` 路徑：透過桌寵設定 UI 取得 token
 * 後傳入 tokenOverride，並設 forceEnabled=true 跳過 cfg.enabled gate（使用者
 * 不必手動把 discord.jsonc enabled 改成 true）。
 */
export interface DiscordSupervisorStartOptions {
  /** 覆寫 token；優先序：override > env > config */
  tokenOverride?: string
  /** 跳過 cfg.enabled 檢查（embedded mascot UI 直接 toggle 用） */
  forceEnabled?: boolean
}

export type DiscordTokenSource = 'env' | 'config' | 'override'

export interface DiscordSupervisor {
  start(
    opts?: DiscordSupervisorStartOptions,
  ): Promise<{ ok: boolean; reason?: string; tokenSource?: DiscordTokenSource }>
  stop(): Promise<void>
  restart(
    opts?: DiscordSupervisorStartOptions,
  ): Promise<{ ok: boolean; reason?: string }>
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

  async function start(
    startOpts?: DiscordSupervisorStartOptions,
  ): Promise<{ ok: boolean; reason?: string; tokenSource?: DiscordTokenSource }> {
    if (dispose) return { ok: true, reason: 'already running' }
    try {
      const cfg = await loadDiscordConfigSnapshot()
      config = cfg
      if (!cfg.enabled && !startOpts?.forceEnabled) {
        return { ok: false, reason: 'discord disabled in config' }
      }
      // Token 解析優先序：override > env > config
      let token: string | undefined
      let tokenSource: DiscordTokenSource
      if (startOpts?.tokenOverride) {
        token = startOpts.tokenOverride
        tokenSource = 'override'
      } else {
        token = getDiscordBotToken()
        tokenSource = process.env.DISCORD_BOT_TOKEN ? 'env' : 'config'
      }
      if (!token) {
        return {
          ok: false,
          reason:
            'no token (set DISCORD_BOT_TOKEN env, discord.json botToken, or pass tokenOverride)',
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

  async function restart(
    startOpts?: DiscordSupervisorStartOptions,
  ): Promise<{ ok: boolean; reason?: string }> {
    await stop()
    resetDiscordConfigCache()
    const r = await start(startOpts)
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
