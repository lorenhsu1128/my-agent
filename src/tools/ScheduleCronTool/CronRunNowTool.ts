import { z } from 'zod/v4'
import type { ValidationResult } from '../../Tool.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import {
  getCronFilePath,
  listAllCronTasks,
} from '../../utils/cronTasks.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { enqueuePendingNotification } from '../../utils/messageQueueManager.js'
import { getTeammateContext } from '../../utils/teammateContext.js'
import { WORKLOAD_CRON } from '../../utils/workloadContext.js'
import {
  CRON_RUN_NOW_DESCRIPTION,
  CRON_RUN_NOW_TOOL_NAME,
  isKairosCronEnabled,
} from './prompt.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    id: z.string().describe('Job ID returned by CronCreate / CronList.'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({ id: z.string(), prompt: z.string() }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type RunNowOutput = z.infer<OutputSchema>

export const CronRunNowTool = buildTool({
  name: CRON_RUN_NOW_TOOL_NAME,
  searchHint: 'fire a cron job immediately',
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
    return CRON_RUN_NOW_DESCRIPTION
  },
  async prompt() {
    return `${CRON_RUN_NOW_DESCRIPTION} Enqueues the prompt at 'later' priority (drains between turns), same path as a normal scheduled fire.`
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
        message: `Cannot trigger cron job '${input.id}': owned by another agent`,
        errorCode: 2,
      }
    }
    return { result: true }
  },
  async call({ id }) {
    const tasks = await listAllCronTasks()
    const task = tasks.find(t => t.id === id)!
    // Run-now bypasses schedule bookkeeping (no lastFiredAt bump, no
    // repeat.completed increment). It's a manual trigger for verification
    // or one-off catch-up; the scheduled cadence continues untouched.
    enqueuePendingNotification({
      value: task.prompt,
      mode: 'prompt',
      priority: 'later',
      isMeta: true,
      workload: WORKLOAD_CRON,
    })
    return { data: { id, prompt: task.prompt } }
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: `Triggered job ${output.id} — enqueued for immediate execution. The task's next scheduled fire is unchanged.`,
    }
  },
} satisfies ToolDef<InputSchema, RunNowOutput>)
