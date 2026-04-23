import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { cronToHuman } from '../../utils/cron.js'
import { listAllCronTasks, nextCronRunMs } from '../../utils/cronTasks.js'
import { truncate } from '../../utils/format.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { getTeammateContext } from '../../utils/teammateContext.js'
import {
  buildCronListPrompt,
  CRON_LIST_DESCRIPTION,
  CRON_LIST_TOOL_NAME,
  isDurableCronEnabled,
  isKairosCronEnabled,
} from './prompt.js'
import { renderListResultMessage, renderListToolUseMessage } from './UI.js'

const inputSchema = lazySchema(() => z.strictObject({}))
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    jobs: z.array(
      z.object({
        id: z.string(),
        cron: z.string(),
        humanSchedule: z.string(),
        prompt: z.string(),
        recurring: z.boolean().optional(),
        durable: z.boolean().optional(),
        name: z.string().optional(),
        nextRunAt: z.string().optional(),
        /** Raw schedule string the user originally supplied (5-field cron
         * or NL phrase like "每週一早上 9 點"). Only present when the task
         * was created with a scheduleSpec (Wave 3+). */
        scheduleRaw: z.string().optional(),
        scheduleKind: z.enum(['cron', 'nl']).optional(),
        lastStatus: z.enum(['ok', 'error']).optional(),
        lastError: z.string().optional(),
        repeat: z
          .object({ times: z.number().nullable(), completed: z.number() })
          .optional(),
      }),
    ),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type ListOutput = z.infer<OutputSchema>

export const CronListTool = buildTool({
  name: CRON_LIST_TOOL_NAME,
  searchHint: 'list active cron jobs',
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
    return CRON_LIST_DESCRIPTION
  },
  async prompt() {
    return buildCronListPrompt(isDurableCronEnabled())
  },
  async call() {
    const allTasks = await listAllCronTasks()
    // Teammates only see their own crons; team lead (no ctx) sees all.
    const ctx = getTeammateContext()
    const tasks = ctx
      ? allTasks.filter(t => t.agentId === ctx.agentId)
      : allTasks
    const now = Date.now()
    const jobs = tasks.map(t => {
      const nextMs = nextCronRunMs(t.cron, t.lastFiredAt ?? t.createdAt)
      const anchored =
        nextMs !== null && nextMs > now
          ? nextMs
          : nextCronRunMs(t.cron, now)
      return {
        id: t.id,
        cron: t.cron,
        humanSchedule: cronToHuman(t.cron),
        prompt: t.prompt,
        ...(t.recurring ? { recurring: true } : {}),
        ...(t.durable === false ? { durable: false } : {}),
        ...(t.name ? { name: t.name } : {}),
        ...(anchored !== null
          ? { nextRunAt: new Date(anchored).toISOString() }
          : {}),
        ...(t.scheduleSpec?.raw
          ? {
              scheduleRaw: t.scheduleSpec.raw,
              scheduleKind: t.scheduleSpec.kind as 'cron' | 'nl',
            }
          : {}),
        ...(t.lastStatus ? { lastStatus: t.lastStatus } : {}),
        ...(t.lastError ? { lastError: t.lastError } : {}),
        ...(t.repeat ? { repeat: t.repeat } : {}),
      }
    })
    return { data: { jobs } }
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content:
        output.jobs.length > 0
          ? output.jobs
              .map(j => {
                const label = j.name ? ` [${j.name}]` : ''
                const flavor = j.recurring ? ' (recurring)' : ' (one-shot)'
                const session = j.durable === false ? ' [session-only]' : ''
                const status = j.lastStatus ? ` last=${j.lastStatus}` : ''
                const reps = j.repeat
                  ? ` reps=${j.repeat.completed}/${j.repeat.times ?? '∞'}`
                  : ''
                const next = j.nextRunAt ? ` next=${j.nextRunAt}` : ''
                // When the user originally authored the schedule in NL
                // ("每週一早上 9 點"), surface that phrase; otherwise the
                // cronToHuman translation is enough.
                const raw =
                  j.scheduleRaw && j.scheduleKind === 'nl'
                    ? ` "${j.scheduleRaw}"`
                    : ''
                return `${j.id}${label} — ${j.humanSchedule}${raw}${flavor}${session}${status}${reps}${next}: ${truncate(j.prompt, 80, true)}`
              })
              .join('\n')
          : 'No scheduled jobs.',
    }
  },
  renderToolUseMessage: renderListToolUseMessage,
  renderToolResultMessage: renderListResultMessage,
} satisfies ToolDef<InputSchema, ListOutput>)
