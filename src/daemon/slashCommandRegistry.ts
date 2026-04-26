/**
 * M-WEB-SLASH-FULL Phase A1：把 src/commands.ts 的完整 Command registry
 * 投影成「web client 可消費」的 metadata snapshot。
 *
 * Web 端不能直接拿 Command 物件（含 React node、function、SDK type 等），
 * 只能拿純資料。本模組負責 projection + 標記三種 web 行為：
 *
 *   - kind='runnable' → 可在 web 端透過 slashCommand.execute RPC 執行
 *     （type='prompt' / type='local'）
 *   - kind='jsx-handoff' → daemon 不執行；web 端查表 render 對應 React 元件
 *     （type='local-jsx'，且該 command 還沒被 web tab 取代）
 *   - kind='web-redirect' → daemon 不執行；web 端跳到既有 tab + flash toast
 *     （4 個已被 web tab 取代的 local-jsx：cron / memory / llamacpp / discord-bind）
 *
 * Phase A1 只做 metadata snapshot；execute / jsx-handoff 的實際路徑在 A2 RPC
 * + D 階段對應 React 元件就位。
 */

import {
  getCommandName,
  getCommands,
  isCommandEnabled,
  meetsAvailabilityRequirement,
} from '../commands.js'
import type { Command } from '../types/command.js'

/**
 * 已被 web 既有 tab 取代的 local-jsx command name → 跳轉目標 tab id。
 *
 * web 端 ContextPanel 的 7 個 tab：overview / cron / memory / llamacpp /
 * discord / permissions / sessions（M-WEB Phase 3 後的版本）。
 */
export const WEB_TAB_REDIRECTS: Readonly<Record<string, string>> = Object.freeze(
  {
    cron: 'cron',
    memory: 'memory',
    llamacpp: 'llamacpp',
    'discord-bind': 'discord',
  },
)

export type SlashCommandWebKind = 'runnable' | 'jsx-handoff' | 'web-redirect'

export type SlashCommandMetadata = {
  /** 命令唯一識別名稱（如 "cron"），不含前綴斜線。 */
  name: string
  /** 使用者可見名稱（多數情況等同 name；plugin 命令可能有前綴） */
  userFacingName: string
  /** 簡短描述，autocomplete dropdown 顯示用 */
  description: string
  /** `/cron <args>` 後面那段 hint 文字，autocomplete 灰字顯示 */
  argumentHint?: string
  /** 別名（如 ["q"] 對應 "quit"） */
  aliases?: string[]
  /** 原始 Command type — daemon dispatch 時要看；web 端通常只看 webKind */
  type: 'prompt' | 'local' | 'local-jsx'
  /** Web 端的處理策略 */
  webKind: SlashCommandWebKind
  /**
   * 當 webKind='jsx-handoff'：web component 查表 key（同 name）。
   * 當 webKind='web-redirect'：跳轉目標 tab id（如 "cron"）。
   * 當 webKind='runnable'：undefined。
   */
  handoffKey?: string
  /** 來源（builtin / plugin / mcp / bundled / skills 等），display 用 */
  source?: string
  /** prompt command 才有；其餘 undefined */
  argNames?: string[]
  /** 是否從 typeahead/help 隱藏（web autocomplete 也應隱藏） */
  isHidden?: boolean
  /** kind='workflow' 等次類別標記，autocomplete 加 badge */
  kind?: 'workflow'
  /** 模型可否呼叫（agent 端 SkillTool 用；web 不直接看） */
  disableModelInvocation?: boolean
}

/**
 * 從單一 Command 投影出 SlashCommandMetadata。
 * 不對外 export — 透過 getSlashCommandMetadataSnapshot 統一拿。
 */
export function projectCommand(cmd: Command): SlashCommandMetadata {
  const name = cmd.name
  const userFacingName = getCommandName(cmd)

  let webKind: SlashCommandWebKind
  let handoffKey: string | undefined

  if (cmd.type === 'prompt' || cmd.type === 'local') {
    webKind = 'runnable'
  } else {
    // local-jsx
    const redirectTarget = WEB_TAB_REDIRECTS[name]
    if (redirectTarget) {
      webKind = 'web-redirect'
      handoffKey = redirectTarget
    } else {
      webKind = 'jsx-handoff'
      handoffKey = name
    }
  }

  const meta: SlashCommandMetadata = {
    name,
    userFacingName,
    description: cmd.description,
    type: cmd.type,
    webKind,
  }

  if (cmd.argumentHint !== undefined) meta.argumentHint = cmd.argumentHint
  if (cmd.aliases && cmd.aliases.length > 0) meta.aliases = [...cmd.aliases]
  if (handoffKey !== undefined) meta.handoffKey = handoffKey
  if (cmd.isHidden !== undefined) meta.isHidden = cmd.isHidden
  if (cmd.kind !== undefined) meta.kind = cmd.kind
  if (cmd.disableModelInvocation !== undefined) {
    meta.disableModelInvocation = cmd.disableModelInvocation
  }

  if (cmd.type === 'prompt') {
    if (cmd.source !== undefined) meta.source = cmd.source
    if (cmd.argNames && cmd.argNames.length > 0) meta.argNames = [...cmd.argNames]
  }

  return meta
}

/**
 * 拉一次完整 snapshot，給 web client。
 *
 * - 已過 meetsAvailabilityRequirement + isCommandEnabled（getCommands 內已過）
 * - 預設不過濾 isHidden（讓 web autocomplete 自己決定要不要顯示，
 *   help / typeahead 才該真的隱藏）
 * - 排序：userFacingName a-z（autocomplete 友善）
 */
export async function getSlashCommandMetadataSnapshot(
  cwd: string,
): Promise<SlashCommandMetadata[]> {
  const commands = await getCommands(cwd)
  return commands
    .map(projectCommand)
    .sort((a, b) => a.userFacingName.localeCompare(b.userFacingName))
}

/**
 * 同步版本：用既有的 in-memory commands 陣列做投影。
 * 給已經拿到 commands 的呼叫者用（避免 getCommands 又跑一次 skill 載入）。
 */
export function projectCommands(commands: Command[]): SlashCommandMetadata[] {
  return commands
    .filter(c => meetsAvailabilityRequirement(c) && isCommandEnabled(c))
    .map(projectCommand)
    .sort((a, b) => a.userFacingName.localeCompare(b.userFacingName))
}

/**
 * 統計 snapshot 各種 webKind 的數量（debug / 健檢用）。
 */
export function summarizeSnapshot(snapshot: SlashCommandMetadata[]): {
  total: number
  runnable: number
  jsxHandoff: number
  webRedirect: number
  byType: Record<'prompt' | 'local' | 'local-jsx', number>
} {
  const byType = { prompt: 0, local: 0, 'local-jsx': 0 } as Record<
    'prompt' | 'local' | 'local-jsx',
    number
  >
  let runnable = 0
  let jsxHandoff = 0
  let webRedirect = 0
  for (const m of snapshot) {
    byType[m.type] += 1
    if (m.webKind === 'runnable') runnable += 1
    else if (m.webKind === 'jsx-handoff') jsxHandoff += 1
    else if (m.webKind === 'web-redirect') webRedirect += 1
  }
  return {
    total: snapshot.length,
    runnable,
    jsxHandoff,
    webRedirect,
    byType,
  }
}
