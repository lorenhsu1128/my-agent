/**
 * M-DISCORD-AUTOBIND：REPL / cron turn 鏡像目標選擇（β 策略）。
 *
 * 規則：
 *   - 有 per-project binding → 鏡到該 project channel（prefix [from REPL]/[from cron]）
 *   - 沒綁 → 鏡到 homeChannelId（舊行為，prefix `<projectId>`）
 *   - 兩個都沒 → null（caller 跳過）
 *
 * 獨立成模組以便 unit test（不用真的 Discord client）。
 */
export interface MirrorTarget {
  channelId: string
  /** `project` = per-project binding 命中；`home` = fallback 到 home channel */
  kind: 'project' | 'home'
}

export function pickMirrorTarget(params: {
  cwd: string
  channelBindings: Record<string, string>
  homeChannelId: string | undefined
}): MirrorTarget | null {
  for (const [chId, path] of Object.entries(params.channelBindings)) {
    if (path === params.cwd) {
      return { channelId: chId, kind: 'project' }
    }
  }
  if (params.homeChannelId) {
    return { channelId: params.homeChannelId, kind: 'home' }
  }
  return null
}

/**
 * 做 mirror 訊息的 header 組裝。per-project channel 加來源 tag、home channel
 * 維持既有 `<projectId>` 前綴格式。
 */
export function formatMirrorHeader(params: {
  kind: 'project' | 'home'
  projectId: string
  source: string // 'repl' / 'cron' / 其他
  durationStr: string
  reason: 'done' | 'error' | 'cancelled' | string
  errorMessage?: string
}): string {
  const icon =
    params.reason === 'done'
      ? '✅'
      : params.reason === 'error'
        ? '❌'
        : '⏹️'
  const errorSuffix =
    params.reason === 'error' && params.errorMessage
      ? ` · error: ${params.errorMessage.slice(0, 80)}`
      : ''
  if (params.kind === 'project') {
    const sourceTag = params.source === 'cron' ? '[from cron]' : '[from REPL]'
    return `${icon} ${sourceTag} ${params.durationStr}${errorSuffix}`
  }
  return (
    `${icon} \`${params.projectId.slice(0, 28)}\` ` +
    `${params.source} turn · ${params.durationStr}${errorSuffix}`
  )
}
