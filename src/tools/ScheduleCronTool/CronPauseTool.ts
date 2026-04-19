import { z } from 'zod/v4'
import type { ValidationResult } from '../../Tool.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import {
  getCronFilePath,
  listAllCronTasks,
  updateCronTask,
} from '../../utils/cronTasks.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { getTeammateContext } from '../../utils/teammateContext.js'
import {
  CRON_PAUSE_DESCRIPTION,
  CRON_PAUSE_TOOL_NAME,
  isKairosCronEnabled,
} from './prompt.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    id: z.string().describe('Job ID returned by CronCreate / CronList.'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({ id: z.string(), pausedAt: z.string() }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type PauseOutput = z.infer<OutputSchema>

export const CronPauseTool = buildTool({
  name: CRON_PAUSE_TOOL_NAME,
  searchHint: 'pause a scheduled cron job',
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
  toAutoClassifierInput(input) {
    return input.id
  },
  async description() {
    return CRON_PAUSE_DESCRIPTION
  },
  async prompt() {
    return `${CRON_PAUSE_DESCRIPTION} Use CronResume to re-enable it; next fire is computed from now.`
  },
  getPath() {
    return getCronFilePath()
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
        message: `Cannot pause cron job '${input.id}': owned by another agent`,
        errorCode: 2,
      }
    }
    if (task.state === 'paused') {
      return {
        result: false,
        message: `Job '${input.id}' is already paused.`,
        errorCode: 3,
      }
    }
    return { result: true }
  },
  async call({ id }) {
    const pausedAt = new Date().toISOString()
    await updateCronTask(id, t => ({ ...t, state: 'paused', pausedAt }))
    return { data: { id, pausedAt } }
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: `Paused job ${output.id} at ${output.pausedAt}. Use CronResume to re-enable.`,
    }
  },
} satisfies ToolDef<InputSchema, PauseOutput>)
