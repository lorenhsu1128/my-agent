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
import type { ContentBlockParam } from 'my-agent-ai/sdk/resources/index'
import type { SessionBroker } from './sessionBroker.js'

/**
 * 給 local 命令用的 minimal stub context。多數簡單 local 命令（cost / help /
 * version / clear 顯示文字）不會碰到深層欄位；碰到的會在 handler 裡 catch 回
 * ok=false。
 *
 * setMessages / canUseTool / onChangeAPIKey 等 web 場景不適用的 callback 全成
 * no-op。getAppState / setAppState 透過 src/bootstrap/state.js 讀全域 STATE，
 * 在 daemon 內已 bootstrap 完成所以可用。
 */
function makeStubLocalContext(): Parameters<
  Awaited<ReturnType<Extract<Command, { type: 'local' }>['load']>>['call']
>[1] {
  const noop = (): void => {}
  const ac = new AbortController()
  return {
    abortController: ac,
    options: { isNonInteractiveSession: false },
    readFileTimestamps: {},
    setMessages: noop,
    onChangeAPIKey: noop,
    setToolJSX: noop,
    setForkConvoWithMessagesOnTheNextRender: noop,
  } as unknown as Parameters<
    Awaited<ReturnType<Extract<Command, { type: 'local' }>['load']>>['call']
  >[1]
}

/**
 * 把 prompt 命令展開後的 ContentBlockParam[] 攤平成單一 text 字串，
 * 給 broker.queue.submit 用（queue payload 是 string）。非 text block 退化成
 * 描述文字（image/document 在 prompt slash 場景幾乎不會出現，僅做 defensive）。
 */
export function flattenContentBlocksToText(blocks: ContentBlockParam[]): string {
  return blocks
    .map(b => {
      if (b.type === 'text') return b.text
      if (b.type === 'image') return '[image]'
      if (b.type === 'document') return '[document]'
      if (b.type === 'thinking') return ''
      return `[${(b as { type: string }).type}]`
    })
    .join('\n')
    .trim()
}

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
  | { kind: 'prompt-injected'; inputId: string }
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

export interface SlashCommandExecuteContext {
  /** Project broker — prompt 注入會用 broker.queue.submit。沒給的話 prompt 命令回 ok=false。 */
  broker?: SessionBroker
  /** 來源 client id；submit 時帶；沒給用 'web-anonymous' fallback */
  clientId?: string
  /** 來源（決定 default intent；web 預設 interactive） */
  source?: 'web' | 'repl' | 'discord' | 'cron' | 'unknown'
}

/**
 * Phase B1 的 execute：
 *
 * - local-jsx + 已被 redirect 的 → 回 web-redirect
 * - local-jsx + 尚未 redirect → 回 jsx-handoff（web 端查表 render React 元件）
 * - prompt → 真展開 + 注入 broker.queue（**B1**）；context 為 stub（多數 prompt
 *   命令不依賴 ToolUseContext；依賴的會在 catch 內回 ok=false）
 * - local → A2 暫回 stub text（B2 接 cmd.load().call()）
 */
export async function handleSlashCommandExecute(
  cwd: string,
  req: SlashCommandExecuteRequest,
  ctx: SlashCommandExecuteContext = {},
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
      if (!ctx.broker) {
        return {
          type: 'slashCommand.executeResult',
          requestId: req.requestId,
          ok: false,
          error: 'prompt command requires broker context (no project runtime)',
        }
      }
      // 多數 prompt 命令不需 ToolUseContext；用 stub。少數依賴 context（如
      // skillify 讀 sessionMemory）會在這 try 內 throw → 走 catch 回 ok=false。
      const stubContext = {
        abortController: { signal: new AbortController().signal },
        options: { isNonInteractiveSession: true },
        readFileTimestamps: {},
      } as unknown as Parameters<typeof cmd.getPromptForCommand>[1]
      let blocks: ContentBlockParam[]
      try {
        blocks = await cmd.getPromptForCommand(req.args, stubContext)
      } catch (err) {
        return {
          type: 'slashCommand.executeResult',
          requestId: req.requestId,
          ok: false,
          error: `prompt expansion failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        }
      }
      const text = flattenContentBlocksToText(blocks)
      if (text.length === 0) {
        return {
          type: 'slashCommand.executeResult',
          requestId: req.requestId,
          ok: false,
          error: 'prompt expanded to empty text',
        }
      }
      const inputId = ctx.broker.queue.submit(text, {
        clientId: ctx.clientId ?? 'web-anonymous',
        source: ctx.source ?? 'web',
        intent: 'interactive',
      })
      return {
        type: 'slashCommand.executeResult',
        requestId: req.requestId,
        ok: true,
        result: { kind: 'prompt-injected', inputId },
      }
    }

    if (cmd.type === 'local') {
      const stubContext = makeStubLocalContext()
      try {
        const mod = await cmd.load()
        const result = await mod.call(req.args, stubContext)
        if (result.type === 'text') {
          return {
            type: 'slashCommand.executeResult',
            requestId: req.requestId,
            ok: true,
            result: { kind: 'text', value: result.value },
          }
        }
        if (result.type === 'skip') {
          return {
            type: 'slashCommand.executeResult',
            requestId: req.requestId,
            ok: true,
            result: { kind: 'skip' },
          }
        }
        // 'compact' — 大型副作用，B2 階段不在 web 端跑
        return {
          type: 'slashCommand.executeResult',
          requestId: req.requestId,
          ok: false,
          error: `local command type "${result.type}" not supported via web RPC`,
        }
      } catch (err) {
        return {
          type: 'slashCommand.executeResult',
          requestId: req.requestId,
          ok: false,
          error: `local command failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        }
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
