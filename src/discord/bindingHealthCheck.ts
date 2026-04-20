/**
 * M-DISCORD-AUTOBIND：daemon 啟動時檢查 channelBindings 健康狀態。
 *
 * 三種 stale：
 *   1. Guild 本身不存在（bot 被踢 / guild 刪）→ 整個 gateway 應停用（caller 處理）
 *   2. Channel 不存在（使用者手動刪）→ 清掉 binding
 *   3. cwd 不存在（使用者刪目錄）→ archive channel + 清 binding
 */
import { existsSync } from 'fs'
import type { Client } from 'discord.js'
import type { DiscordConfig } from '../discordConfig/schema.js'
import {
  archiveProjectChannel,
  channelExists,
} from './channelFactory.js'
import { removeChannelBinding } from '../discordConfig/loader.js'

export interface HealthCheckReport {
  /** Guild 是否還存在且 bot 可存取；false 時 gateway 不該啟動 */
  guildAccessible: boolean
  /** Binding 存在但 Discord channel 已被刪（清了 binding） */
  staleChannels: string[]
  /** Binding 存在但 cwd 不在（archive + 清 binding） */
  staleCwds: Array<{ channelId: string; cwd: string }>
  /** 剩下健康的 binding 數 */
  healthy: number
}

/**
 * 執行健康檢查。會在必要時寫回 discord.json（刪 binding）與修改 Discord channel
 * （archive）。回傳 summary 供 caller log 與決策。
 */
export async function verifyBindings(
  client: Client,
  config: DiscordConfig,
): Promise<HealthCheckReport> {
  const report: HealthCheckReport = {
    guildAccessible: false,
    staleChannels: [],
    staleCwds: [],
    healthy: 0,
  }

  if (!config.guildId) {
    // 沒 guildId 但有 bindings — bindings 仍可用於純路由（使用者可能手動綁）
    // 跳過健康檢查（不動 bindings），當 guildAccessible=true 讓 gateway 照常啟動
    report.guildAccessible = true
    report.healthy = Object.keys(config.channelBindings).length
    return report
  }

  try {
    await client.guilds.fetch(config.guildId)
    report.guildAccessible = true
  } catch {
    report.guildAccessible = false
    return report
  }

  const entries = Object.entries(config.channelBindings)
  for (const [channelId, cwd] of entries) {
    // 1) channel 存活檢查
    const exists = await channelExists(client, config.guildId, channelId)
    if (!exists) {
      await removeChannelBinding(channelId).catch(() => undefined)
      report.staleChannels.push(channelId)
      continue
    }
    // 2) cwd 存活檢查
    if (!existsSync(cwd)) {
      try {
        await archiveProjectChannel(
          client,
          config.guildId,
          channelId,
          config.archiveCategoryId,
        )
      } catch {
        // ignore — binding 仍 remove
      }
      await removeChannelBinding(channelId).catch(() => undefined)
      report.staleCwds.push({ channelId, cwd })
      continue
    }
    report.healthy++
  }

  return report
}
