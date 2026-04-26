/**
 * M-WEB-CLOSEOUT-9：DiscordController — 把 supervisor + bind/unbind 包成 web admin
 * 用的小型 facade。所有方法都跟 user-action 對應一個 REST 端點：
 *
 *   getStatus()      → GET  /api/discord/status
 *   listBindings()   → GET  /api/discord/bindings
 *   bind(cwd, name?) → POST /api/discord/bind
 *   unbind(cwd)      → POST /api/discord/unbind
 *   reload()         → POST /api/discord/reload
 *   restart()        → POST /api/discord/restart
 *
 * Controller 不直接管 client；透過 supervisor 取 live ref（gateway 啟動後才有）。
 */
import {
  handleBindRequest,
  handleUnbindRequest,
} from '../daemon/discordBindRpc.js'
import type { DiscordSupervisor } from './discordSupervisor.js'

export interface DiscordControllerStatus {
  enabled: boolean
  running: boolean
  guildId?: string
  homeChannelId?: string
  archiveCategoryId?: string
  whitelistUserCount: number
  projectCount: number
  bindingCount: number
  /** 連線後 bot tag（user#xxxx）— gateway 沒起則 undefined */
  botTag?: string
}

export interface DiscordBindingInfo {
  channelId: string
  cwd: string
}

export interface DiscordController {
  getStatus(): DiscordControllerStatus
  listBindings(): DiscordBindingInfo[]
  bind(
    cwd: string,
    projectName?: string,
  ): Promise<{
    ok: boolean
    channelId?: string
    channelName?: string
    url?: string
    alreadyBound?: boolean
    error?: string
  }>
  unbind(cwd: string): Promise<{ ok: boolean; error?: string }>
  reload(): Promise<{ ok: boolean; error?: string }>
  restart(): Promise<{ ok: boolean; error?: string }>
}

export function createDiscordController(
  supervisor: DiscordSupervisor,
): DiscordController {
  return {
    getStatus() {
      const cfg = supervisor.getConfig()
      const client = supervisor.getClient()
      const botTag = client?.user?.tag
      if (!cfg) {
        return {
          enabled: false,
          running: false,
          whitelistUserCount: 0,
          projectCount: 0,
          bindingCount: 0,
        }
      }
      return {
        enabled: cfg.enabled,
        running: supervisor.isRunning(),
        guildId: cfg.guildId,
        homeChannelId: cfg.homeChannelId,
        archiveCategoryId: cfg.archiveCategoryId,
        whitelistUserCount: cfg.whitelistUserIds.length,
        projectCount: cfg.projects.length,
        bindingCount: Object.keys(cfg.channelBindings).length,
        botTag,
      }
    },
    listBindings() {
      const cfg = supervisor.getConfig()
      if (!cfg) return []
      return Object.entries(cfg.channelBindings).map(([channelId, cwd]) => ({
        channelId,
        cwd,
      }))
    },
    async bind(cwd, projectName) {
      const r = await handleBindRequest(
        {
          type: 'discord.bind',
          requestId: `web-${Date.now()}`,
          cwd,
          projectName,
        },
        {
          getClient: () => supervisor.getClient(),
          getConfig: () => {
            const cfg = supervisor.getConfig()
            if (!cfg) throw new Error('discord supervisor has no config loaded')
            return cfg
          },
        },
      )
      return {
        ok: r.ok,
        channelId: r.channelId,
        channelName: r.channelName,
        url: r.url,
        alreadyBound: r.alreadyBound,
        error: r.error,
      }
    },
    async unbind(cwd) {
      const r = await handleUnbindRequest(
        {
          type: 'discord.unbind',
          requestId: `web-${Date.now()}`,
          cwd,
        },
        {
          getClient: () => supervisor.getClient(),
          getConfig: () => {
            const cfg = supervisor.getConfig()
            if (!cfg) throw new Error('discord supervisor has no config loaded')
            return cfg
          },
        },
      )
      return { ok: r.ok, error: r.error }
    },
    async reload() {
      const r = await supervisor.reload()
      return { ok: r.ok, error: r.reason }
    },
    async restart() {
      const r = await supervisor.restart()
      return { ok: r.ok, error: r.reason }
    },
  }
}
