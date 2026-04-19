import { z } from 'zod/v4'
import type { ValidationResult } from '../../Tool.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import {
  getCronFilePath,
  listAllCronTasks,
  parseSchedule,
  updateCronTask,
} from '../../utils/cronTasks.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { getTeammateContext } from '../../utils/teammateContext.js'
import { scanCronPrompt } from './CronCreateTool.js'
import {
  CRON_UPDATE_DESCRIPTION,
  CRON_UPDATE_TOOL_NAME,
  isKairosCronEnabled,
} from './prompt.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    id: z.string().describe('Job ID returned by CronCreate / CronList.'),
    name: z.string().optional().describe('New friendly label.'),
    prompt: z.string().optional().describe('Replace the prompt body.'),
    schedule: z
      .string()
      .optional()
      .describe(
        'Replace the schedule. Accepts the same forms as CronCreate (cron, "every 5m", "30m", ISO).',
      ),
    repeat: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('New repeat cap (times). Resets `completed` to 0.'),
    modelOverride: z
      .string()
      .optional()
      .describe(
        'Set per-job model override (e.g. "claude-opus-4-7", "qwen3.5-9b-neo"). Pass empty string to clear.',
      ),
    preRunScript: z
      .string()
      .optional()
      .describe(
        'Shell command run before each fire; stdout is prepended to the prompt. Pass empty string to clear.',
      ),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({ id: z.string(), changed: z.array(z.string()) }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type UpdateOutput = z.infer<OutputSchema>

export const CronUpdateTool = buildTool({
  name: CRON_UPDATE_TOOL_NAME,
  searchHint: 'edit a scheduled cron job',
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
    return CRON_UPDATE_DESCRIPTION
  },
  async prompt() {
    return CRON_UPDATE_DESCRIPTION
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
        message: `Cannot update cron job '${input.id}': owned by another agent`,
        errorCode: 2,
      }
    }
    // Same injection defense as CronCreate.
    if (input.prompt !== undefined) {
      const injectionReason = scanCronPrompt(input.prompt)
      if (injectionReason) {
        return { result: false, message: injectionReason, errorCode: 3 }
      }
    }
    if (input.schedule !== undefined) {
      try {
        parseSchedule(input.schedule)
      } catch (e) {
        return {
          result: false,
          message: e instanceof Error ? e.message : String(e),
          errorCode: 4,
        }
      }
    }
    return { result: true }
  },
  async call({
    id,
    name,
    prompt,
    schedule,
    repeat,
    modelOverride,
    preRunScript,
  }) {
    const changed: string[] = []
    await updateCronTask(id, t => {
      let next: typeof t = { ...t }
      if (name !== undefined) {
        next.name = name
        changed.push('name')
      }
      if (prompt !== undefined) {
        next.prompt = prompt
        changed.push('prompt')
      }
      if (schedule !== undefined) {
        const parsed = parseSchedule(schedule)
        next.cron = parsed.cron
        next.recurring = parsed.recurring || undefined
        // Resetting lastFiredAt so the scheduler re-anchors from the new
        // schedule (otherwise next-fire math carries the old cadence).
        delete next.lastFiredAt
        changed.push('schedule')
      }
      if (repeat !== undefined) {
        next.repeat = { times: repeat, completed: 0 }
        changed.push('repeat')
      }
      if (modelOverride !== undefined) {
        if (modelOverride === '') delete next.modelOverride
        else next.modelOverride = modelOverride
        changed.push('modelOverride')
      }
      if (preRunScript !== undefined) {
        if (preRunScript === '') delete next.preRunScript
        else next.preRunScript = preRunScript
        changed.push('preRunScript')
      }
      return next
    })
    return { data: { id, changed } }
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content:
        output.changed.length > 0
          ? `Updated job ${output.id}: ${output.changed.join(', ')}.`
          : `No changes applied to job ${output.id} (all fields omitted).`,
    }
  },
} satisfies ToolDef<InputSchema, UpdateOutput>)
