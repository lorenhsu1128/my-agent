/**
 * M-DISCORD-3：Discord 訊息切段 — port 自 Hermes `base.py:truncate_message`。
 *
 * Discord 單訊息上限 2000 字元。超過時要切段：
 *   - 優先在換行 `\n` 處切，否則 space，否則硬切
 *   - 程式碼區塊（```lang）警覺：切到區塊中間時補 closing ```，下一段開同語言 ``` 重啟
 *   - 多段時可選加 `(i/total)` 標示
 *
 * 不處理 UTF-16 長度（Discord 用 UTF-8），JS 字串 `.length` 足夠。
 */

export const DISCORD_MAX_LENGTH = 2000

interface CodeBlockState {
  open: boolean
  lang: string
}

function scanCodeBlockState(
  text: string,
  prevState: CodeBlockState,
): CodeBlockState {
  let state = { ...prevState }
  const lines = text.split('\n')
  for (const line of lines) {
    const match = /^```(.*)$/.exec(line)
    if (match) {
      if (state.open) {
        state = { open: false, lang: '' }
      } else {
        state = { open: true, lang: match[1]!.trim() }
      }
    }
  }
  return state
}

export interface TruncateOptions {
  /** 最大長度；預設 2000。測試可調小。 */
  maxLength?: number
  /** 多段時是否加 `(i/N)` 前綴；預設 true。 */
  addCounter?: boolean
}

/**
 * 把超長 content 切成多段，每段 ≤ maxLength（含 counter / codefence 補償）。
 * 若原文 ≤ maxLength 且不需 counter，回傳單元素陣列。
 */
export function truncateForDiscord(
  content: string,
  opts: TruncateOptions = {},
): string[] {
  const max = opts.maxLength ?? DISCORD_MAX_LENGTH
  // counterReserve=12 會吃掉 maxLength；若使用者指定很小的 max（測試 / 極端 UX）
  // 就主動停用 counter 避免 budget 變負導致 cut 進入 1 char/iter 的退化路徑。
  const addCounter = (opts.addCounter ?? true) && max >= 40

  if (content.length === 0) return ['']
  if (content.length <= max) return [content]

  const chunks: string[] = []
  let remaining = content
  let codeState: CodeBlockState = { open: false, lang: '' }

  // 大約估 counter 長度 " (NNN/NNN)"，保留 16 字元 headroom
  const counterReserve = addCounter ? 12 : 0
  // 若目前開著程式碼區塊，下一段需在結尾補 ``` + 開頭補 ```lang\n；留 buffer
  const codeReserve = 20

  while (remaining.length > 0) {
    const inCodeBlock = codeState.open
    const headerForNext = inCodeBlock
      ? '```' + codeState.lang + '\n'
      : ''
    const budget = max - counterReserve - (inCodeBlock ? codeReserve : 0)

    // 第一段不需要 header；之後的段落若在 code block 中需補 header
    const prefix = chunks.length === 0 ? '' : headerForNext

    if (prefix.length + remaining.length <= max - counterReserve) {
      // 最後一段（不用切了）
      let piece = prefix + remaining
      if (codeState.open && !remaining.trimEnd().endsWith('```')) {
        // 還沒關 code block → 補上（避免下游 markdown 破）
        piece = piece + '\n```'
      }
      chunks.push(piece)
      codeState = scanCodeBlockState(remaining, codeState)
      remaining = ''
      break
    }

    // 為 closing ``` (\n``` = 4 chars) 預留；即使目前 state 是 closed，切片內也可能開新 code block
    const closeSuffixReserve = 4
    // Guard：若 maxLength 很小（測試或極端情況）導致 budget 扣完變負或近零，
    // 退化為單純硬切 — 確保每 iter 至少吃掉 1 char，避免無限迴圈。
    let sliceLimit = budget - prefix.length - closeSuffixReserve
    if (sliceLimit < 1) {
      sliceLimit = Math.max(1, budget - prefix.length)
    }
    if (sliceLimit < 1) sliceLimit = 1
    // 找斷點：優先 \n，其次空白；找不到就硬切
    let cut = sliceLimit
    const searchFrom = Math.max(0, sliceLimit - 200)
    const newlineIdx = remaining.lastIndexOf('\n', sliceLimit)
    if (newlineIdx > searchFrom) {
      cut = newlineIdx
    } else {
      const spaceIdx = remaining.lastIndexOf(' ', sliceLimit)
      if (spaceIdx > searchFrom) {
        cut = spaceIdx
      }
    }
    if (cut < 1) cut = sliceLimit
    // 終極 guard：絕不讓 cut==0 造成無限迴圈
    if (cut < 1) cut = 1

    const slice = remaining.slice(0, cut)
    const newCodeState = scanCodeBlockState(slice, codeState)

    let piece = prefix + slice
    // 若切完後 code block 還開著，補 closing ```
    if (newCodeState.open) {
      piece = piece + '\n```'
    }
    chunks.push(piece)

    remaining = remaining.slice(cut).replace(/^\n/, '')
    codeState = newCodeState
  }

  if (addCounter && chunks.length > 1) {
    const total = chunks.length
    return chunks.map((c, i) => {
      const suffix = ` (${i + 1}/${total})`
      // 若已接近 max，切掉尾端再貼 suffix
      if (c.length + suffix.length > max) {
        return c.slice(0, max - suffix.length) + suffix
      }
      return c + suffix
    })
  }

  return chunks
}
