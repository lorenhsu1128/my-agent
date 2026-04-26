/**
 * 簡易相對時間 formatter — 不拉大 lib（dayjs / date-fns 增 30+ KB bundle 不值）。
 *
 * 行為：
 *   - <1 min   → "just now"
 *   - <60 min  → "Nm ago"
 *   - <24 hr   → "Nh ago"
 *   - <7 day   → "Nd ago"
 *   - else     → 顯示日期（YYYY-MM-DD）
 */
export function formatTimeAgo(epochMs: number, now: number = Date.now()): string {
  if (!Number.isFinite(epochMs) || epochMs <= 0) return ''
  const diff = now - epochMs
  if (diff < 0) return 'just now'
  const sec = Math.floor(diff / 1000)
  if (sec < 60) return 'just now'
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const day = Math.floor(hr / 24)
  if (day < 7) return `${day}d ago`
  // ≥ 7 天直接顯示日期
  const d = new Date(epochMs)
  const yyyy = d.getFullYear()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}
