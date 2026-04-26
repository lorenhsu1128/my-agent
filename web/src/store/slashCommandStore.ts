/**
 * M-WEB-SLASH-A3：slash command metadata zustand store。
 *
 * - 第一次需要時透過 `api.slashCommands.list()` 拉一份完整 snapshot
 * - 5 分鐘 TTL，過期才重拉；外部可呼叫 `refresh()` 強制重新整理
 * - InputBar autocomplete + CommandDispatcher 共用同一個 cache
 *
 * 不做 per-project store — daemon 端目前只有 default project 跑時 plugin /
 * skill 命令載入；A3 階段先共用一份 snapshot，A4 之後 plugin 系統真的支援
 * per-project 客製時再 split by projectId。
 */
import { create } from 'zustand'
import { api, type WebSlashCommandMetadata } from '../api/client'

const CACHE_TTL_MS = 5 * 60 * 1000

interface SlashCommandState {
  commands: WebSlashCommandMetadata[]
  loadedAt: number
  loading: boolean
  error: string | null
  /** 確保有 fresh snapshot（過期則重拉，沒過期直接 noop） */
  ensureLoaded(projectId?: string): Promise<void>
  /** 強制重拉（忽略 TTL） */
  refresh(projectId?: string): Promise<void>
}

export const useSlashCommandStore = create<SlashCommandState>((set, get) => ({
  commands: [],
  loadedAt: 0,
  loading: false,
  error: null,

  async ensureLoaded(projectId) {
    const { loadedAt, loading } = get()
    if (loading) return
    if (loadedAt > 0 && Date.now() - loadedAt < CACHE_TTL_MS) return
    await get().refresh(projectId)
  },

  async refresh(projectId) {
    set({ loading: true, error: null })
    try {
      const { commands } = await api.slashCommands.list(projectId)
      set({
        commands,
        loadedAt: Date.now(),
        loading: false,
        error: null,
      })
    } catch (err) {
      set({
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  },
}))

/**
 * Selector helper：autocomplete 用的「prefix 過濾 + 隱藏 isHidden + 排序」。
 *
 * 排序規則（與 TUI typeahead 一致）：
 *   1. exact name match 第一
 *   2. name startsWith query 其次
 *   3. alias startsWith query 再次
 *
 * description 不參與 autocomplete 比對 — 避免「co」誤撈到「show command help」
 * 之類的雜訊；description 留給 dropdown 顯示用。
 */
export function filterCommandsForAutocomplete(
  commands: WebSlashCommandMetadata[],
  query: string,
  options: { includeHidden?: boolean } = {},
): WebSlashCommandMetadata[] {
  const q = query.toLowerCase().replace(/^\//, '')
  const visible = options.includeHidden
    ? commands
    : commands.filter(c => !c.isHidden)
  if (q.length === 0) return visible

  type Scored = { cmd: WebSlashCommandMetadata; rank: number }
  const scored: Scored[] = []
  for (const cmd of visible) {
    const name = cmd.userFacingName.toLowerCase()
    const aliases = (cmd.aliases ?? []).map(a => a.toLowerCase())
    let rank = -1
    if (name === q) rank = 0
    else if (aliases.some(a => a === q)) rank = 0
    else if (name.startsWith(q)) rank = 1
    else if (aliases.some(a => a.startsWith(q))) rank = 2
    if (rank >= 0) scored.push({ cmd, rank })
  }
  scored.sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank
    return a.cmd.userFacingName.localeCompare(b.cmd.userFacingName)
  })
  return scored.map(s => s.cmd)
}
