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
  CRON_RESUME_DESCRIPTION,
  CRON_RESUME_TOOL_NAME,
  isKairosCronEnabled,
} from './prompt.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    id: z.string().describe('Job ID returned by CronCreate / CronList.'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() => z.object({ id: z.string() }))
type OutputSchema = ReturnType<typeof outputSchema>
export type ResumeOutput = z.infer<OutputSchema>

export const CronResumeTool = buildTool({
  name: CRON_RESUME_TOOL_NAME,
  searchHint: 'resume a paused cron job',
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
    return CRON_RESUME_DESCRIPTION
  },
  async prompt() {
    return CRON_RESUME_DESCRIPTION
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
        message: `Cannot resume cron job '${input.id}': owned by another agent`,
        errorCode: 2,
      }
    }
    if (task.state !== 'paused') {
      return {
        result: false,
        message: `Job '${input.id}' is not paused (state=${task.state ?? 'scheduled'}).`,
        errorCode: 3,
      }
    }
    return { result: true }
  },
  async call({ id }) {
    await updateCronTask(id, t => {
      // Clear paused markers; first-sight after reload re-anchors from
      // lastFiredAt (if any) or createdAt — the scheduler will compute the
      // next future fire on its own.
      const { pausedAt: _pausedAt, ...rest } = t
      return { ...rest, state: 'scheduled' }
    })
    return { data: { id } }
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: `Resumed job ${output.id}. Next fire will be computed from the current time.`,
    }
  },
} satisfies ToolDef<InputSchema, ResumeOutput>)
