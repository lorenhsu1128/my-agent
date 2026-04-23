// M-CRON-W3 Discord cronMirror：把 daemon cronWiring 的 CronFireEvent
// 鏡到 Discord。預設 off（不打擾）；使用者在 task 的 notify.discord 設
// 'home' 或 'project' 才發送。
//
// 不處理：task-level subscription、token redaction skip、動態設定重載 —
// 這些都走既有 Discord gateway 基礎建設（redactSecrets/truncateForDiscord
// 已內建在 send path）。
//
// 'project' 模式走 pickAllMirrorTargets（與 REPL turn mirror 共用邏輯）；
// 'home' 模式強制走 homeChannelId 不論 project binding。

import type { DiscordConfig } from '../discordConfig/schema.js'
import { redactSecrets } from '../utils/web/secretScan.js'
import type { MirrorTarget } from './replMirror.js'
import { pickAllMirrorTargets } from './replMirror.js'
import { truncateForDiscord } from './truncate.js'

export type CronMirrorEvent = {
  type: 'cronFireEvent'
  taskId: string
  taskName?: string
  schedule: string
  status: 'fired' | 'completed' | 'failed' | 'retrying' | 'skipped'
  startedAt: number
  finishedAt?: number
  durationMs?: number
  errorMsg?: string
  attempt?: number
  skipReason?: string
  source: 'cron'
}

/** 給 gateway 用的決定函式：找出此 event 要發到哪些 channel（可能空 = 不發）。 */
export function pickCronMirrorTargets(params: {
  notify: 'home' | 'project' | 'off' | undefined
  cwd: string
  channelBindings: Record<string, string>
  homeChannelId: string | undefined
}): MirrorTarget[] {
  if (!params.notify || params.notify === 'off') return []
  if (params.notify === 'home') {
    return params.homeChannelId
      ? [{ channelId: params.homeChannelId, kind: 'home' }]
      : []
  }
  // 'project' — 交給 pickAllMirrorTargets 做 binding 匹配 + home fallback
  return pickAllMirrorTargets({
    cwd: params.cwd,
    channelBindings: params.channelBindings,
    homeChannelId: params.homeChannelId,
  })
}

const STATUS_ICON: Record<CronMirrorEvent['status'], string> = {
  fired: '⏰',
  completed: '✅',
  failed: '❌',
  retrying: '🔁',
  skipped: '⏭️',
}

/** 把 CronFireEvent 格式成 Discord 訊息內容（redact secrets + truncate）。 */
export function formatCronMirrorMessage(e: CronMirrorEvent): string[] {
  const icon = STATUS_ICON[e.status] ?? '⏰'
  const label = e.taskName ?? e.taskId.slice(0, 8)
  const dur =
    e.durationMs !== undefined
      ? ` · ${(e.durationMs / 1000).toFixed(1)}s`
      : ''
  const att =
    e.attempt !== undefined && e.attempt > 1 ? ` · att ${e.attempt}` : ''
  const sched = ` · \`${e.schedule}\``
  const head = `${icon} **cron** ${label} — ${e.status}${dur}${att}${sched}`
  const parts = [head]
  if (e.status === 'skipped' && e.skipReason) {
    parts.push(`↷ ${e.skipReason}`)
  }
  if (e.errorMsg) {
    parts.push('```\n' + redactSecrets(e.errorMsg).slice(0, 1500) + '\n```')
  }
  const full = parts.join('\n')
  return truncateForDiscord(full)
}

/** Returns the task.notify.discord value if set, else DiscordConfig's default. */
export function resolveCronNotifyMode(
  taskNotify: { discord?: 'home' | 'project' | 'off' } | undefined,
  defaultMode: 'home' | 'project' | 'off' = 'off',
): 'home' | 'project' | 'off' {
  if (!taskNotify || !taskNotify.discord) return defaultMode
  return taskNotify.discord
}

/**
 * 供測試查 DiscordConfig 有沒有 cronDefaults section。目前 DiscordConfig
 * 沒有這個欄位 — cronDefaults 是 optional concept 留給後續擴充。
 */
export function getCronDiscordDefault(config: DiscordConfig): 'home' | 'project' | 'off' {
  // DiscordConfigSchema 目前無 cronDefaults；預設 off 不打擾。
  void config
  return 'off'
}
