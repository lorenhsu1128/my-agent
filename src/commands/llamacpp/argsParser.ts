// M-LLAMACPP-WATCHDOG Phase 3-4：Hybrid args parser。
//
// 解析 `/llamacpp ...` 的子命令字串為 mutation 指令。
// 無參數 → 開 TUI；有參數 → 直接套用 mutation。
//
// 支援動詞：
//   watchdog                     → 印當前狀態（status）
//   watchdog enable / disable    → master 開關
//   watchdog A on/off            → A.enabled = true/false（同 interChunk.enabled）
//   watchdog B 180000            → reasoning.blockMs = 180000
//   watchdog all on/off          → master + ABC 全開/全關
//   watchdog reset               → DEFAULT_WATCHDOG_CONFIG
//   watchdog C.background 8000   → tokenCap.background = 8000
//   slots                        → 印 slot 狀態
//   slots kill <id>              → POST /slots/<id>?action=erase
//
// flags：
//   --session   只 session 內生效，不寫檔（in-memory override）

import type { WatchdogFieldId } from './llamacppManagerLogic.js'

export type ParsedArgs =
  | { kind: 'tui' } // 無參數
  | { kind: 'watchdog-status' }
  | {
      kind: 'watchdog-master'
      enabled: boolean
      session?: boolean
    }
  | {
      kind: 'watchdog-toggle'
      field: WatchdogFieldId
      enabled: boolean
      session?: boolean
    }
  | {
      kind: 'watchdog-set-number'
      field: WatchdogFieldId
      value: number
      session?: boolean
    }
  | { kind: 'watchdog-all'; on: boolean; session?: boolean }
  | { kind: 'watchdog-reset'; session?: boolean }
  | { kind: 'slots-status' }
  | { kind: 'slots-kill'; slotId: number }
  | { kind: 'help' }
  | { kind: 'error'; message: string }

const SHORTCUT_TO_FIELD: Record<
  string,
  { toggle: WatchdogFieldId; number?: WatchdogFieldId }
> = {
  a: {
    toggle: 'interChunk.enabled',
    number: 'interChunk.gapMs',
  },
  b: {
    toggle: 'reasoning.enabled',
    number: 'reasoning.blockMs',
  },
  c: {
    toggle: 'tokenCap.enabled',
    number: 'tokenCap.default',
  },
}

const SUBKEY_TO_FIELD: Record<string, WatchdogFieldId> = {
  'c.default': 'tokenCap.default',
  'c.memoryprefetch': 'tokenCap.memoryPrefetch',
  'c.sidequery': 'tokenCap.sideQuery',
  'c.background': 'tokenCap.background',
}

/**
 * 解析 args 字串為 ParsedArgs。
 * 接受空字串、`watchdog`、`watchdog A on` 等。
 */
export function parseLlamacppArgs(raw: string): ParsedArgs {
  const trimmed = raw.trim()
  if (!trimmed) return { kind: 'tui' }

  // 抽 --session flag
  const sessionFlag = / --session\b| -s\b/.test(' ' + trimmed)
  const cleaned = trimmed.replace(/(?: --session\b| -s\b)/g, '').trim()
  const tokens = cleaned.split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return { kind: 'tui' }

  const head = tokens[0]!.toLowerCase()

  if (head === 'help' || head === '-h' || head === '--help') {
    return { kind: 'help' }
  }

  if (head === 'watchdog') {
    return parseWatchdogTokens(tokens.slice(1), sessionFlag)
  }

  if (head === 'slots') {
    return parseSlotsTokens(tokens.slice(1))
  }

  return {
    kind: 'error',
    message: `不認識的命令：${head}（試試：watchdog / slots / help）`,
  }
}

function parseWatchdogTokens(
  tokens: string[],
  session: boolean,
): ParsedArgs {
  if (tokens.length === 0) return { kind: 'watchdog-status' }
  const head = tokens[0]!.toLowerCase()

  if (head === 'enable') return { kind: 'watchdog-master', enabled: true, session }
  if (head === 'disable')
    return { kind: 'watchdog-master', enabled: false, session }
  if (head === 'reset') return { kind: 'watchdog-reset', session }
  if (head === 'all') {
    if (tokens[1]?.toLowerCase() === 'on')
      return { kind: 'watchdog-all', on: true, session }
    if (tokens[1]?.toLowerCase() === 'off')
      return { kind: 'watchdog-all', on: false, session }
    return {
      kind: 'error',
      message: 'watchdog all 後面要接 on / off',
    }
  }

  // C.background 8000 / A on / B 180000
  const sub = SUBKEY_TO_FIELD[head]
  if (sub) {
    const valStr = tokens[1]
    if (!valStr) {
      return {
        kind: 'error',
        message: `${head} 後面要接數字（例如 ${head} 8000）`,
      }
    }
    const n = Number(valStr)
    if (!Number.isFinite(n) || n <= 0) {
      return { kind: 'error', message: `數值不合法：${valStr}` }
    }
    return { kind: 'watchdog-set-number', field: sub, value: n, session }
  }

  const shortcut = SHORTCUT_TO_FIELD[head]
  if (shortcut) {
    const arg = tokens[1]?.toLowerCase()
    if (arg === 'on') {
      return {
        kind: 'watchdog-toggle',
        field: shortcut.toggle,
        enabled: true,
        session,
      }
    }
    if (arg === 'off') {
      return {
        kind: 'watchdog-toggle',
        field: shortcut.toggle,
        enabled: false,
        session,
      }
    }
    if (arg !== undefined) {
      const n = Number(arg)
      if (Number.isFinite(n) && n > 0 && shortcut.number) {
        return {
          kind: 'watchdog-set-number',
          field: shortcut.number,
          value: n,
          session,
        }
      }
    }
    return {
      kind: 'error',
      message: `${head.toUpperCase()} 後面要接 on / off / 數字`,
    }
  }

  return {
    kind: 'error',
    message: `不認識：watchdog ${head}（試 enable/disable/A/B/C/all/reset）`,
  }
}

function parseSlotsTokens(tokens: string[]): ParsedArgs {
  if (tokens.length === 0) return { kind: 'slots-status' }
  const head = tokens[0]!.toLowerCase()
  if (head === 'kill') {
    const idStr = tokens[1]
    const id = Number(idStr)
    if (!Number.isFinite(id) || id < 0) {
      return { kind: 'error', message: 'slots kill 後面要接 slot 編號（整數）' }
    }
    return { kind: 'slots-kill', slotId: id }
  }
  return {
    kind: 'error',
    message: `不認識：slots ${head}（試 kill <id>）`,
  }
}

export const HELP_TEXT = `/llamacpp                                # 開 TUI
/llamacpp watchdog                       # 印 watchdog 狀態
/llamacpp watchdog enable | disable      # master toggle
/llamacpp watchdog A on | off            # A. inter-chunk 開關
/llamacpp watchdog B 180000              # B. reasoning blockMs（毫秒）
/llamacpp watchdog C.background 8000     # tokenCap.background ceiling
/llamacpp watchdog all on | off          # master + ABC 全開/全關
/llamacpp watchdog reset                 # 全部回預設（all off）
/llamacpp watchdog --session A on        # 只 session 內生效不寫檔
/llamacpp slots                          # 印 slot 狀態
/llamacpp slots kill <id>                # kill slot（需 server 帶 --slot-save-path）`
