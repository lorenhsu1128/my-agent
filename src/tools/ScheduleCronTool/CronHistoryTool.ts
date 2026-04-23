import React from 'react'
import { z } from 'zod/v4'
import { MessageResponse } from '../../components/MessageResponse.js'
import { Text } from '../../ink.js'
import { buildTool, type ToolDef, type ValidationResult } from '../../Tool.js'
import { readHistory } from '../../utils/cronHistory.js'
import { listAllCronTasks } from '../../utils/cronTasks.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { getTeammateContext } from '../../utils/teammateContext.js'
import {
  buildCronHistoryPrompt,
  CRON_HISTORY_DESCRIPTION,
  CRON_HISTORY_TOOL_NAME,
  isKairosCronEnabled,
} from './prompt.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    id: z.string().describe('Job ID returned by CronCreate / shown by CronList.'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(200)
      .optional()
      .describe('How many recent entries to return (default 20, max 200).'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    id: z.string(),
    total: z.number(),
    entries: z.array(
      z.object({
        ts: z.number(),
        status: z.enum(['ok', 'error', 'skipped', 'retrying']),
        durationMs: z.number().optional(),
        attempt: z.number().optional(),
        outputFile: z.string().optional(),
        errorMsg: z.string().optional(),
      }),
    ),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type HistoryOutput = z.infer<OutputSchema>

const STATUS_ICON: Record<string, string> = {
  ok: '✓',
  error: '✗',
  skipped: '↷',
  retrying: '↻',
}

export const CronHistoryTool = buildTool({
  name: CRON_HISTORY_TOOL_NAME,
  searchHint: 'read cron job run history',
  maxResultSizeChars: 100_000,
  shouldDefer: true,
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  isEnabled() {
    return isKairosCronEnabled()
  },
  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return true
  },
  async description() {
    return CRON_HISTORY_DESCRIPTION
  },
  async prompt() {
    return buildCronHistoryPrompt()
  },
  async validateInput(input): Promise<ValidationResult> {
    const tasks = await listAllCronTasks()
    const task = tasks.find(t => t.id === input.id)
    if (!task) {
      return {
        result: false,
        message: `No scheduled job with id '${input.id}'`,
        errorCode: 1,
      }
    }
    const ctx = getTeammateContext()
    if (ctx && task.agentId !== ctx.agentId) {
      return {
        result: false,
        message: `Cannot read history for cron '${input.id}': owned by another agent`,
        errorCode: 2,
      }
    }
    return { result: true }
  },
  async call({ id, limit }) {
    const all = await readHistory(id)
    const cap = limit ?? 20
    const tail = all.slice(Math.max(0, all.length - cap)).reverse() // newest first
    return {
      data: {
        id,
        total: all.length,
        entries: tail,
      },
    }
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    if (output.entries.length === 0) {
      return {
        tool_use_id: toolUseID,
        type: 'tool_result',
        content: `No history yet for ${output.id}.`,
      }
    }
    const lines = output.entries.map(e => {
      const icon = STATUS_ICON[e.status] ?? '?'
      const when = new Date(e.ts).toISOString()
      const dur = e.durationMs !== undefined ? ` ${e.durationMs}ms` : ''
      const att = e.attempt !== undefined ? ` att=${e.attempt}` : ''
      const err = e.errorMsg ? ` err="${e.errorMsg.slice(0, 80)}"` : ''
      return `${icon} ${when}${dur}${att}${err}`
    })
    const header = `${output.id} — showing ${output.entries.length} of ${output.total} fires`
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: `${header}\n${lines.join('\n')}`,
    }
  },
  renderToolUseMessage(input: Partial<{ id: string; limit: number }>) {
    return input.id ?? ''
  },
  renderToolResultMessage(output: HistoryOutput) {
    if (output.entries.length === 0) {
      return React.createElement(
        MessageResponse,
        null,
        React.createElement(Text, { dimColor: true }, `No history for ${output.id}`),
      )
    }
    return React.createElement(
      MessageResponse,
      null,
      React.createElement(
        Text,
        null,
        React.createElement(Text, { bold: true }, `${output.id}`),
        React.createElement(
          Text,
          { dimColor: true },
          ` — ${output.entries.length}/${output.total} fires`,
        ),
      ),
      ...output.entries.map(e =>
        React.createElement(
          Text,
          { key: `${e.ts}` },
          `${STATUS_ICON[e.status] ?? '?'} ${new Date(e.ts).toISOString()}`,
          e.errorMsg
            ? React.createElement(
                Text,
                { color: 'red' },
                ` ${e.errorMsg.slice(0, 60)}`,
              )
            : null,
        ),
      ),
    )
  },
} satisfies ToolDef<InputSchema, HistoryOutput>)
