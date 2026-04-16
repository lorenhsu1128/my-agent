/**
 * M2-10：Prefetch 預算控制。
 *
 * 把 FTS snippets 組成 `<memory-context>` fence 字串，
 * 控制總 token 預算在 ~2000 以內（用 char/token 比例估算）。
 *
 * 設計：
 * - 預算以 char 計（heuristic: 1 token ≈ 3 chars for 中英混合）
 * - FTS snippets 按順序塞，超額就截斷
 * - 輸出為 `<memory-context>...</memory-context>` fence 字串
 *   供 M2-11 注入到 user message 前綴
 */
import type { FtsSnippet } from './ftsSearch.js'

// ── 常數 ────────────────────────────────────────────────────────────

/** 總 token 預算（ADR-M2-04：~2000 tokens）。 */
export const TOKEN_BUDGET = 2000

/** chars/token 比例（中英混合保守估計）。 */
const CHARS_PER_TOKEN = 3

/** 總 char 預算。 */
export const CHAR_BUDGET = TOKEN_BUDGET * CHARS_PER_TOKEN // 6000

/** FTS snippets 上限。 */
export const MAX_FTS_SNIPPETS = 3

// ── helpers ─────────────────────────────────────────────────────────

function formatDate(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number) => n.toString().padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

// ── 主 export ───────────────────────────────────────────────────────

/**
 * 把 FTS 搜尋結果組成 `<memory-context>` fence 字串。
 *
 * 格式範例：
 * ```
 * <memory-context>
 * [past-sessions]
 * (2026-04-15) user: 我想設定 llama.cpp server 的 context size...
 * (2026-04-16) assistant: 建議把 ctx 從 32K 加到 49K...
 * </memory-context>
 * ```
 *
 * 預算控制：
 * - 最多 MAX_FTS_SNIPPETS 筆 FTS snippet
 * - 總 chars 不超過 CHAR_BUDGET
 * - 超額時截斷最後一筆的 content
 * - 無結果時回空字串（不產生空 fence）
 */
export function buildMemoryContextFence(
  ftsSnippets: FtsSnippet[],
): string {
  if (ftsSnippets.length === 0) return ''

  const capped = ftsSnippets.slice(0, MAX_FTS_SNIPPETS)
  const header = '<memory-context>\n[past-sessions]\n'
  const footer = '</memory-context>'

  let budget = CHAR_BUDGET - header.length - footer.length
  if (budget <= 0) return ''

  const lines: string[] = []

  for (const s of capped) {
    const prefix = `(${formatDate(s.startedAt)}) ${s.role}: `
    const line = prefix + s.content
    if (line.length <= budget) {
      lines.push(line)
      budget -= line.length + 1 // +1 for \n
    } else if (budget > prefix.length + 20) {
      // 剩餘空間夠放截斷版
      // -2: 1 for '…' char + 1 for \n
      const truncated = prefix + s.content.slice(0, budget - prefix.length - 2) + '…'
      lines.push(truncated)
      break
    } else {
      break
    }
  }

  if (lines.length === 0) return ''
  return header + lines.join('\n') + '\n' + footer
}
