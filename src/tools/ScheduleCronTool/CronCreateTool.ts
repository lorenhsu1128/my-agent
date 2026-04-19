import { z } from 'zod/v4'
import { setScheduledTasksEnabled } from '../../bootstrap/state.js'
import type { ValidationResult } from '../../Tool.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import { cronToHuman, parseCronExpression } from '../../utils/cron.js'
import {
  addCronTask,
  getCronFilePath,
  listAllCronTasks,
  nextCronRunMs,
  parseSchedule,
  type ParsedSchedule,
} from '../../utils/cronTasks.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { semanticBoolean } from '../../utils/semanticBoolean.js'
import { getTeammateContext } from '../../utils/teammateContext.js'
import { containsSecret } from '../../utils/web/secretScan.js'
import {
  buildCronCreateDescription,
  buildCronCreatePrompt,
  CRON_CREATE_TOOL_NAME,
  DEFAULT_MAX_AGE_DAYS,
  isDurableCronEnabled,
  isKairosCronEnabled,
} from './prompt.js'
import { renderCreateResultMessage, renderCreateToolUseMessage } from './UI.js'

const MAX_JOBS = 50

// Shell-ish exfiltration patterns that we block in cron prompts. Catches the
// common "curl evil | sh" / "cat ~/.ssh | curl" shapes that the model might
// be tricked into scheduling. Not exhaustive; containsSecret() handles
// literal tokens baked into the prompt.
const EXFIL_PATTERNS: RegExp[] = [
  /\b(?:curl|wget|fetch)\b[^\n]{0,200}\$\([^)]*(?:cat|ls|grep|awk|sed)[^)]*\)/i,
  /\b(?:cat|type)\b[^\n]{0,80}(?:~?[/\\]\.ssh[/\\]|authorized_keys|id_rsa|id_ed25519)/i,
  /\bauthorized_keys\b/i,
  /\b(?:curl|wget)\b[^\n]{0,200}\|[^\n]{0,200}\b(?:sh|bash|zsh|cmd|powershell)\b/i,
]

export function scanCronPrompt(prompt: string): string | null {
  if (containsSecret(prompt)) {
    return 'Prompt appears to contain a live secret (API key / token / private key). Refusing to schedule — a cron can exfiltrate on repeat without further review.'
  }
  for (const re of EXFIL_PATTERNS) {
    if (re.test(prompt)) {
      return 'Prompt matches a known exfiltration pattern (reading credentials or piping remote content to a shell). Refusing to schedule.'
    }
  }
  return null
}

const inputSchema = lazySchema(() =>
  z.strictObject({
    // Primary field — accepts plain 5-field cron, 'every 30m', '30m', ISO ts.
    // `cron` kept as alias for backward compat (older callers may still pass it).
    schedule: z
      .string()
      .optional()
      .describe(
        'Schedule string. Supported: 5-field cron ("0 9 * * *"), duration ("30m", "2h", "1d"; one-shot), interval ("every 5m", "every 2h"; recurring), or ISO timestamp ("2026-04-20T14:30"; one-shot). Local timezone.',
      ),
    cron: z
      .string()
      .optional()
      .describe(
        'Alias for `schedule` — 5-field cron in local time. Kept for backward compatibility; prefer `schedule` for human-friendly forms.',
      ),
    prompt: z.string().describe('The prompt to enqueue at each fire time.'),
    name: z
      .string()
      .optional()
      .describe(
        'Optional friendly label shown in CronList output. Falls back to the first line of prompt.',
      ),
    recurring: semanticBoolean(z.boolean().optional()).describe(
      `For 5-field cron / 'every N' only. true (default) = fire on every match until deleted or auto-expired after ${DEFAULT_MAX_AGE_DAYS} days. false = fire once then auto-delete. Ignored for duration ('30m') and ISO timestamps (always one-shot).`,
    ),
    repeat: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        'Cap on how many times a recurring task fires before self-deleting. Omit for unlimited. Ignored for one-shots.',
      ),
    durable: semanticBoolean(z.boolean().optional()).describe(
      'true = persist to .my-agent/scheduled_tasks.json and survive restarts. false (default) = in-memory only, dies when this Claude session ends. Use true only when the user asks the task to survive across sessions.',
    ),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    id: z.string(),
    humanSchedule: z.string(),
    recurring: z.boolean(),
    durable: z.boolean().optional(),
    name: z.string().optional(),
    repeat: z.number().optional(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type CreateOutput = z.infer<OutputSchema>

// Resolve schedule/cron inputs into the normalized { cron, recurring } pair.
// Throws with a user-friendly message on invalid input.
function resolveSchedule(input: {
  schedule?: string
  cron?: string
  recurring?: boolean
}): ParsedSchedule {
  const raw = input.schedule ?? input.cron
  if (!raw) {
    throw new Error(
      'Provide a schedule (e.g. "every 30m", "30m", "0 9 * * *", or "2026-04-20T14:30").',
    )
  }
  const parsed = parseSchedule(raw)
  // Caller's `recurring` override only applies when the input was a raw cron
  // string (parseSchedule defaults cron to recurring: true). Durations and ISO
  // timestamps are always one-shot; intervals are always recurring.
  const parts = raw.trim().split(/\s+/)
  const isPlainCron = parts.length === 5 && parseCronExpression(raw) != null
  if (isPlainCron && typeof input.recurring === 'boolean') {
    return { ...parsed, recurring: input.recurring }
  }
  return parsed
}

export const CronCreateTool = buildTool({
  name: CRON_CREATE_TOOL_NAME,
  searchHint: 'schedule a recurring or one-shot prompt',
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
    return `${input.schedule ?? input.cron ?? ''}: ${input.prompt}`
  },
  async description() {
    return buildCronCreateDescription(isDurableCronEnabled())
  },
  async prompt() {
    return buildCronCreatePrompt(isDurableCronEnabled())
  },
  getPath() {
    return getCronFilePath()
  },
  async validateInput(input): Promise<ValidationResult> {
    let parsed: ParsedSchedule
    try {
      parsed = resolveSchedule(input)
    } catch (e) {
      return {
        result: false,
        message: e instanceof Error ? e.message : String(e),
        errorCode: 1,
      }
    }
    if (nextCronRunMs(parsed.cron, Date.now()) === null) {
      return {
        result: false,
        message: `Schedule '${input.schedule ?? input.cron}' does not match any calendar date in the next year.`,
        errorCode: 2,
      }
    }
    const injectionReason = scanCronPrompt(input.prompt)
    if (injectionReason) {
      return { result: false, message: injectionReason, errorCode: 5 }
    }
    const tasks = await listAllCronTasks()
    if (tasks.length >= MAX_JOBS) {
      return {
        result: false,
        message: `Too many scheduled jobs (max ${MAX_JOBS}). Cancel one first.`,
        errorCode: 3,
      }
    }
    // Teammates don't persist across sessions, so a durable teammate cron
    // would orphan on restart (agentId would point to a nonexistent teammate).
    if (input.durable && getTeammateContext()) {
      return {
        result: false,
        message:
          'durable crons are not supported for teammates (teammates do not persist across sessions)',
        errorCode: 4,
      }
    }
    return { result: true }
  },
  async call({ prompt, durable = false, name, repeat, ...rest }) {
    const parsed = resolveSchedule(rest)
    // Kill switch forces session-only; schema stays stable so the model sees
    // no validation errors when the gate flips mid-session.
    const effectiveDurable = durable && isDurableCronEnabled()
    const id = await addCronTask(
      parsed.cron,
      prompt,
      parsed.recurring,
      effectiveDurable,
      getTeammateContext()?.agentId,
      {
        ...(name ? { name } : {}),
        // repeat only makes sense on recurring tasks; addCronTask also
        // guards this, but filtering here keeps the data shape clean.
        ...(parsed.recurring && typeof repeat === 'number'
          ? { repeatTimes: repeat }
          : {}),
      },
    )
    setScheduledTasksEnabled(true)
    return {
      data: {
        id,
        humanSchedule: parsed.display || cronToHuman(parsed.cron),
        recurring: parsed.recurring,
        durable: effectiveDurable,
        ...(name ? { name } : {}),
        ...(parsed.recurring && typeof repeat === 'number' ? { repeat } : {}),
      },
    }
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    const where = output.durable
      ? 'Persisted to .my-agent/scheduled_tasks.json'
      : 'Session-only (not written to disk, dies when Claude exits)'
    const label = output.name ? ` [${output.name}]` : ''
    const repeatSuffix =
      typeof output.repeat === 'number' ? ` for ${output.repeat} runs` : ''
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: output.recurring
        ? `Scheduled recurring job ${output.id}${label} (${output.humanSchedule})${repeatSuffix}. ${where}. Auto-expires after ${DEFAULT_MAX_AGE_DAYS} days. Use CronDelete to cancel sooner.`
        : `Scheduled one-shot task ${output.id}${label} (${output.humanSchedule}). ${where}. It will fire once then auto-delete.`,
    }
  },
  renderToolUseMessage: renderCreateToolUseMessage,
  renderToolResultMessage: renderCreateResultMessage,
} satisfies ToolDef<InputSchema, CreateOutput>)
