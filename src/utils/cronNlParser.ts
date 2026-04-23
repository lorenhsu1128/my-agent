// M-CRON-W3-9：Natural-language schedule parser via LLM (pure-LLM strategy
// per Q1 = 純 LLM；no chrono-node fallback). Single source of truth: the
// active provider's small-fast model interprets the user's phrase, returns
// a structured JSON {cron, recurring, humanReadable}, validated against
// parseCronExpression. Failure → typed error so caller can route to user
// rather than silently substituting wrong cron.

import { queryHaiku } from '../services/api/claude.js'
import { asSystemPrompt } from './systemPromptType.js'
import { parseCronExpression } from './cron.js'
import { logForDebugging } from './debug.js'

export type ParsedNL = {
  cron: string
  recurring: boolean
  humanReadable: string
}

export class CronNLParseError extends Error {
  constructor(
    message: string,
    readonly rawInput: string,
    readonly rawResponse?: string,
  ) {
    super(message)
    this.name = 'CronNLParseError'
  }
}

const SYSTEM_PROMPT = `You are a schedule parser. Convert a natural-language schedule phrase into a 5-field cron expression in the user's local timezone.

OUTPUT FORMAT — emit ONLY a single JSON object. No prose, no markdown, no code fences.
{
  "cron": "<5 fields: minute hour day-of-month month day-of-week>",
  "recurring": <boolean>,
  "humanReadable": "<short English description of the cron, max 60 chars>"
}

Rules:
- 5-field cron only (minute hour dom month dow). No seconds. No "@yearly" macros.
- Use values 0-59 / 0-23 / 1-31 / 1-12 / 0-6 (Sunday=0). "*" for any.
- recurring = true for repeating schedules ("every Tuesday"), false for one-shots ("at 3pm today").
- For one-shots, fill the dom/month with the actual date based on "now" so it lands once.
- If the phrase is ambiguous OR cannot be parsed, set "cron" to "INVALID" and put the reason in humanReadable.
- Avoid landing on minute :00 or :30 unless the user said an exact wall-clock time. Pick :03, :17, :47, etc., for vague phrases like "every morning".`

export interface ParseScheduleNLOptions {
  /** Inject AbortSignal (callers should pass tool's signal). */
  signal: AbortSignal
  /** Override now for tests / time-pinned recurring resolutions. */
  now?: Date
  /** Inject query function for tests. */
  query?: typeof queryHaiku
}

/**
 * Parse a natural-language schedule via LLM. Throws CronNLParseError on any
 * failure (network, model returned bad JSON, cron string didn't validate).
 * Retries once on the first failure to absorb transient model glitches.
 */
export async function parseScheduleNL(
  input: string,
  opts: ParseScheduleNLOptions,
): Promise<ParsedNL> {
  const trimmed = input.trim()
  if (!trimmed) {
    throw new CronNLParseError('Empty schedule input', input)
  }
  const now = opts.now ?? new Date()
  const userPrompt = buildUserPrompt(trimmed, now)
  const query = opts.query ?? queryHaiku

  let lastErr: Error | null = null
  let lastRaw: string | undefined
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const resp = await query({
        systemPrompt: asSystemPrompt([SYSTEM_PROMPT]),
        userPrompt,
        signal: opts.signal,
        options: {
          querySource: 'cron_nl_parser' as never,
          enablePromptCaching: false,
          agents: [],
          isNonInteractiveSession: true,
          hasAppendSystemPrompt: false,
          mcpTools: [],
        },
      })
      const text = extractText(resp)
      lastRaw = text
      const parsed = parseAndValidate(text)
      return parsed
    } catch (e) {
      lastErr = e as Error
      logForDebugging(
        `[cronNlParser] attempt ${attempt} failed: ${(e as Error).message}`,
      )
    }
  }
  throw new CronNLParseError(
    `Failed to parse schedule after 2 attempts: ${lastErr?.message ?? 'unknown'}`,
    input,
    lastRaw,
  )
}

function buildUserPrompt(phrase: string, now: Date): string {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  return `Now: ${now.toISOString()} (timezone: ${tz})

Phrase: ${phrase}

Emit the JSON object only:`
}

function extractText(resp: {
  message: { content: Array<{ type: string; text?: string }> }
}): string {
  return resp.message.content
    .filter(b => b.type === 'text')
    .map(b => b.text ?? '')
    .join('')
    .trim()
}

function parseAndValidate(text: string): ParsedNL {
  // Some models may add prose around JSON despite instructions; extract first
  // JSON object.
  const m = text.match(/\{[\s\S]*\}/)
  if (!m) {
    throw new Error('Model output did not contain a JSON object')
  }
  let obj: unknown
  try {
    obj = JSON.parse(m[0])
  } catch (e) {
    throw new Error(`JSON parse error: ${(e as Error).message}`)
  }
  if (!obj || typeof obj !== 'object') {
    throw new Error('Parsed JSON is not an object')
  }
  const r = obj as Record<string, unknown>
  const cronStr = typeof r.cron === 'string' ? r.cron.trim() : ''
  if (!cronStr || cronStr === 'INVALID') {
    throw new Error(
      `Model could not parse: ${typeof r.humanReadable === 'string' ? r.humanReadable : 'unspecified'}`,
    )
  }
  if (!parseCronExpression(cronStr)) {
    throw new Error(`Model emitted invalid cron string: "${cronStr}"`)
  }
  const recurring =
    typeof r.recurring === 'boolean' ? r.recurring : false
  const humanReadable =
    typeof r.humanReadable === 'string' && r.humanReadable.length > 0
      ? r.humanReadable.slice(0, 60)
      : cronStr
  return { cron: cronStr, recurring, humanReadable }
}
