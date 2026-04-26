/**
 * M-WEB-SLASH-FULL Phase A2 — daemon-side WS RPC for slash commands.
 *
 * Frame protocol（WS 單行 JSON）：
 *
 * client → daemon：
 *   { type: 'slashCommand.list', requestId }
 *   { type: 'slashCommand.execute', requestId, projectId?, name, args }
 *
 * daemon → client（same requestId）：
 *   { type: 'slashCommand.listResult', requestId, ok, error?, commands? }
 *   { type: 'slashCommand.executeResult', requestId, ok, error?, result? }
 *
 * executeResult.result 三種型別：
 *   { kind: 'text', value }            — local 命令的字串回顯
 *   { kind: 'prompt-injected' }        — prompt 命令已注入下個 user turn
 *                                       （目前 stub，B1 commit 才會真做注入）
 *   { kind: 'jsx-handoff', name }      — 把控制權交給 web 端 component table
 *   { kind: 'web-redirect', tabId }    — 跳右欄 tab + flash toast
 *   { kind: 'skip' }                   — 命令明確 no-op
 *
 * 設計取捨：
 * - **不用 in-process React tree**：daemon 是 headless，不能 render local-jsx
 *   命令的 React node。jsx-handoff 把責任丟回 web，搭配 web/src/components/
 *   slash/handoffs/ 下的對應元件。
 * - **prompt 不在這裡 expand**：B1 才會把 prompt 注入到 input queue 變成下
 *   一個 user turn。本 phase 只回 prompt-injected stub，方便 web RPC 流程
 *   先走通。
 * - **local 命令的副作用範圍**：許多 local 命令（如 /clear /cost /help）跑
 *   在 LocalJSXCommandContext 上，需 setMessages / canUseTool 等 callback。
 *   本 phase 只 cover 純讀取 / 純文字輸出的 local；需要 callback 的留 B2
 *   case-by-case 處理。
 */

import {
  getSlashCommandMetadataSnapshot,
  type SlashCommandMetadata,
} from './slashCommandRegistry.js'
import { getCommands } from '../commands.js'
import type { Command } from '../types/command.js'

// ─── Frame types ────────────────────────────────────────────────────────────

export type SlashCommandListRequest = {
  type: 'slashCommand.list'
  requestId: string
}

export type SlashCommandListResult = {
  type: 'slashCommand.listResult'
  requestId: string
  ok: boolean
  error?: string
  commands?: SlashCommandMetadata[]
}

export type SlashCommandExecuteRequest = {
  type: 'slashCommand.execute'
  requestId: string
  projectId?: string
  name: string
  args: string
}

export type SlashCommandExecutionResult =
  | { kind: 'text'; value: string }
  | { kind: 'prompt-injected' }
  | { kind: 'jsx-handoff'; name: string }
  | { kind: 'web-redirect'; tabId: string }
  | { kind: 'skip' }

export type SlashCommandExecuteResult = {
  type: 'slashCommand.executeResult'
  requestId: string
  ok: boolean
  error?: string
  result?: SlashCommandExecutionResult
}

// ─── Type guards ────────────────────────────────────────────────────────────

export function isSlashCommandListRequest(
  m: unknown,
): m is SlashCommandListRequest {
  if (!m || typeof m !== 'object') return false
  const r = m as Record<string, unknown>
  return r.type === 'slashCommand.list' && typeof r.requestId === 'string'
}

export function isSlashCommandExecuteRequest(
  m: unknown,
): m is SlashCommandExecuteRequest {
  if (!m || typeof m !== 'object') return false
  const r = m as Record<string, unknown>
  return (
    r.type === 'slashCommand.execute' &&
    typeof r.requestId === 'string' &&
    typeof r.name === 'string' &&
    typeof r.args === 'string'
  )
}

// ─── Handlers ───────────────────────────────────────────────────────────────

export async function handleSlashCommandList(
  cwd: string,
  req: SlashCommandListRequest,
): Promise<SlashCommandListResult> {
  try {
    const commands = await getSlashCommandMetadataSnapshot(cwd)
    return {
      type: 'slashCommand.listResult',
      requestId: req.requestId,
      ok: true,
      commands,
    }
  } catch (err) {
    return {
      type: 'slashCommand.listResult',
      requestId: req.requestId,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

/**
 * 找 command — 支援 name / userFacingName / aliases 三種形式
 * （等同 commands.ts findCommand 但只看當前 cwd 的 snapshot）。
 */
function findCommandByName(
  commands: Command[],
  name: string,
): Command | undefined {
  return commands.find(
    c =>
      c.name === name ||
      c.aliases?.includes(name) ||
      (c.userFacingName?.() ?? c.name) === name,
  )
}

/**
 * Phase A2 的 execute：
 *
 * - local-jsx + 已被 redirect 的 → 回 web-redirect
 * - local-jsx + 尚未 redirect → 回 jsx-handoff（web 端查表 render React 元件）
 * - prompt → 回 prompt-injected stub（B1 真注入）
 * - local → A2 暫回 jsx-handoff='__local_a2_pending__' 標示「等 B2 接 call()」
 *   （不直接跑 load().call() 因為 A2 還沒接 LocalJSXCommandContext callback）
 */
export async function handleSlashCommandExecute(
  cwd: string,
  req: SlashCommandExecuteRequest,
): Promise<SlashCommandExecuteResult> {
  try {
    const commands = await getCommands(cwd)
    const cmd = findCommandByName(commands, req.name)
    if (!cmd) {
      return {
        type: 'slashCommand.executeResult',
        requestId: req.requestId,
        ok: false,
        error: `unknown command: ${req.name}`,
      }
    }

    if (cmd.type === 'local-jsx') {
      // 4 個 redirect command 走特殊 result kind
      const { WEB_TAB_REDIRECTS } = await import('./slashCommandRegistry.js')
      const tabId = WEB_TAB_REDIRECTS[cmd.name]
      if (tabId) {
        return {
          type: 'slashCommand.executeResult',
          requestId: req.requestId,
          ok: true,
          result: { kind: 'web-redirect', tabId },
        }
      }
      return {
        type: 'slashCommand.executeResult',
        requestId: req.requestId,
        ok: true,
        result: { kind: 'jsx-handoff', name: cmd.name },
      }
    }

    if (cmd.type === 'prompt') {
      // B1 實作真注入；A2 stub
      return {
        type: 'slashCommand.executeResult',
        requestId: req.requestId,
        ok: true,
        result: { kind: 'prompt-injected' },
      }
    }

    if (cmd.type === 'local') {
      // B2 實作 call()；A2 stub 走 jsx-handoff 路徑讓 web 端有東西可顯示
      return {
        type: 'slashCommand.executeResult',
        requestId: req.requestId,
        ok: true,
        result: { kind: 'text', value: `[A2 stub] /${cmd.name} ${req.args}`.trim() },
      }
    }

    return {
      type: 'slashCommand.executeResult',
      requestId: req.requestId,
      ok: false,
      error: `unsupported command type: ${(cmd as { type: string }).type}`,
    }
  } catch (err) {
    return {
      type: 'slashCommand.executeResult',
      requestId: req.requestId,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}
