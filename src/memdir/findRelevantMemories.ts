import { feature } from 'bun:bundle'
import { getSessionId } from '../bootstrap/state.js'
import { logForDebugging } from '../utils/debug.js'
import { errorMessage } from '../utils/errors.js'
import { jsonParse } from '../utils/slowOperations.js'
import {
  formatMemoryManifest,
  type MemoryHeader,
  scanMemoryFiles,
} from './memoryScan.js'
import { recordRecall } from './sessionRecallLog.js'

/**
 * Default fallback cap when the selector returns empty (no API key, parse failure,
 * llamacpp server down, etc). Without this, llama.cpp users see zero memory
 * recall — the selector silently fails and the prefetch returns []. Capped
 * by file count rather than bytes to avoid an extra stat round; memories
 * are already mtime-sorted so we keep the freshest N.
 *
 * Overridable via settings `memoryRecall.fallbackMaxFiles` (M-MEMRECALL-CMD).
 */
const DEFAULT_FALLBACK_MAX_FILES = 8

/**
 * Default selector cap (max files the LLM may pick per turn).
 * Overridable via settings `memoryRecall.maxFiles` (M-MEMRECALL-CMD).
 */
const DEFAULT_SELECTOR_MAX_FILES = 5

/**
 * Read memoryRecall settings with safe defaults + range clamp.
 * Exported for unit tests and TUI / Web tabs that need to display current values.
 */
export function readMemoryRecallSettings(): {
  maxFiles: number
  fallbackMaxFiles: number
} {
  try {
    // Lazy require：避免 module 載入期撞 settings 初始化序列
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getInitialSettings } =
      require('../utils/settings/settings.js') as typeof import('../utils/settings/settings.js')
    const r = getInitialSettings().memoryRecall ?? {}
    return {
      maxFiles:
        typeof r.maxFiles === 'number' && r.maxFiles >= 1 && r.maxFiles <= 20
          ? r.maxFiles
          : DEFAULT_SELECTOR_MAX_FILES,
      fallbackMaxFiles:
        typeof r.fallbackMaxFiles === 'number' &&
        r.fallbackMaxFiles >= 1 &&
        r.fallbackMaxFiles <= 20
          ? r.fallbackMaxFiles
          : DEFAULT_FALLBACK_MAX_FILES,
    }
  } catch {
    return {
      maxFiles: DEFAULT_SELECTOR_MAX_FILES,
      fallbackMaxFiles: DEFAULT_FALLBACK_MAX_FILES,
    }
  }
}

export type RelevantMemory = {
  path: string
  mtimeMs: number
}

function buildSelectMemoriesSystemPrompt(maxFiles: number): string {
  return `You are selecting memories that will be useful to my-agent as it processes a user's query. You will be given the user's query and a list of available memory files with their filenames and descriptions.

Return a list of filenames for the memories that will clearly be useful to my-agent as it processes the user's query (up to ${maxFiles}). Only include memories that you are certain will be helpful based on their name and description.
- If you are unsure if a memory will be useful in processing the user's query, then do not include it in your list. Be selective and discerning.
- If there are no memories in the list that would clearly be useful, feel free to return an empty list.
- If a list of recently-used tools is provided, do not select memories that are usage reference or API documentation for those tools (my-agent is already exercising them). DO still select memories containing warnings, gotchas, or known issues about those tools — active use is exactly when those matter.
`
}

/**
 * Find memory files relevant to a query by scanning memory file headers
 * and asking Sonnet to select the most relevant ones.
 *
 * Returns absolute file paths + mtime of the most relevant memories
 * (up to 5). Excludes MEMORY.md (already loaded in system prompt).
 * mtime is threaded through so callers can surface freshness to the
 * main model without a second stat.
 *
 * `alreadySurfaced` filters paths shown in prior turns before the
 * Sonnet call, so the selector spends its 5-slot budget on fresh
 * candidates instead of re-picking files the caller will discard.
 */
export async function findRelevantMemories(
  query: string,
  memoryDir: string,
  signal: AbortSignal,
  recentTools: readonly string[] = [],
  alreadySurfaced: ReadonlySet<string> = new Set(),
): Promise<RelevantMemory[]> {
  const memories = (await scanMemoryFiles(memoryDir, signal)).filter(
    m => !alreadySurfaced.has(m.filePath),
  )
  if (memories.length === 0) {
    return []
  }

  const recallCfg = readMemoryRecallSettings()

  const selectedFilenames = await selectRelevantMemories(
    query,
    memories,
    signal,
    recentTools,
    recallCfg.maxFiles,
  )
  const byFilename = new Map(memories.map(m => [m.filename, m]))
  let selected = selectedFilenames
    .map(filename => byFilename.get(filename))
    .filter((m): m is MemoryHeader => m !== undefined)
  // 截到 maxFiles（防 LLM 不守規則）
  selected = selected.slice(0, recallCfg.maxFiles)
  let recallSource: import('./sessionRecallLog.js').RecallSource = 'selector'

  // M-MEMRECALL-LOCAL: selector returned nothing but candidates exist.
  // Most likely cause: no Anthropic API key + llamacpp parse failure / server
  // down. Without this fallback, llama.cpp users get zero memory recall and
  // every new session starts blind. Take the freshest N (already mtime-sorted)
  // so the model at least sees recent context.
  if (selected.length === 0 && memories.length > 0) {
    selected = memories.slice(0, recallCfg.fallbackMaxFiles)
    recallSource = 'fallback'
    logForDebugging(
      `[memdir] selector returned 0 of ${memories.length} candidates; fallback attached ${selected.length} freshest memories`,
      { level: 'warn' },
    )
  }

  // M-MEMRECALL-CMD：把命中結果寫到 session-scoped log，供 /memory-recall 顯示
  if (selected.length > 0) {
    const sessionId = getSessionId()
    for (const m of selected) {
      recordRecall(sessionId, m.filePath, recallSource)
    }
  }

  // Fires even on empty selection: selection-rate needs the denominator,
  // and -1 ages distinguish "ran, picked nothing" from "never ran".
  if (feature('MEMORY_SHAPE_TELEMETRY')) {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { logMemoryRecallShape } =
      require('./memoryShapeTelemetry.js') as typeof import('./memoryShapeTelemetry.js')
    /* eslint-enable @typescript-eslint/no-require-imports */
    logMemoryRecallShape(memories, selected)
  }

  return selected.map(m => ({ path: m.filePath, mtimeMs: m.mtimeMs }))
}

async function selectRelevantMemories(
  query: string,
  memories: MemoryHeader[],
  signal: AbortSignal,
  recentTools: readonly string[],
  maxFiles: number,
): Promise<string[]> {
  const validFilenames = new Set(memories.map(m => m.filename))

  const manifest = formatMemoryManifest(memories)

  // When my-agent is actively using a tool (e.g. mcp__X__spawn),
  // surfacing that tool's reference docs is noise — the conversation
  // already contains working usage.  The selector otherwise matches
  // on keyword overlap ("spawn" in query + "spawn" in a memory
  // description → false positive).
  const toolsSection =
    recentTools.length > 0
      ? `\n\nRecently used tools: ${recentTools.join(', ')}`
      : ''

  // Phase 3 (dapper-sonnet plan): all utility-level LLM traffic flows
  // through llama.cpp now. The previous Anthropic-SDK path + structured-
  // output beta have been removed — selectViaLlamaCpp is the only branch.
  return await selectViaLlamaCpp(
    query,
    manifest,
    toolsSection,
    validFilenames,
    signal,
    maxFiles,
  )
}

/**
 * llama.cpp branch of the memory selector. Talks directly to the OpenAI-
 * compatible /v1/chat/completions endpoint instead of going through
 * sideQuery (which is Anthropic-only). Local models are unreliable with
 * the structured-output beta header, so we steer with the prompt and
 * extract the first JSON array from the response.
 *
 * On any failure (network, parse, empty) returns []. Caller's fallback path
 * (findRelevantMemories) handles the empty case by attaching the freshest N
 * memories so recall still works.
 */
async function selectViaLlamaCpp(
  query: string,
  manifest: string,
  toolsSection: string,
  validFilenames: Set<string>,
  signal: AbortSignal,
  maxFiles: number,
): Promise<string[]> {
  try {
    // M-LLAMACPP-REMOTE: 走 routing.memoryPrefetch（缺欄位 = 'local'）
    const { resolveEndpoint } = await import('../llamacppConfig/index.js')
    const ep = resolveEndpoint('memoryPrefetch')
    const userPrompt = `Query: ${query}\n\nAvailable memories:\n${manifest}${toolsSection}\n\nReply with ONLY a JSON array of filenames (e.g. ["foo.md","bar.md"]). No prose, no markdown fences, no keys. Empty array [] if none apply.`
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (ep.apiKey) headers['Authorization'] = `Bearer ${ep.apiKey}`
    const response = await fetch(`${ep.baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: ep.model,
        max_tokens: 256,
        temperature: 0,
        messages: [
          { role: 'system', content: buildSelectMemoriesSystemPrompt(maxFiles) },
          { role: 'user', content: userPrompt },
        ],
      }),
      signal,
    })
    if (!response.ok) {
      logForDebugging(
        `[memdir] llamacpp selector HTTP ${response.status}`,
        { level: 'warn' },
      )
      return []
    }
    const json = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>
    }
    const text = json.choices?.[0]?.message?.content ?? ''
    return extractFilenamesFromText(text, validFilenames)
  } catch (e) {
    if (signal.aborted) {
      return []
    }
    logForDebugging(
      `[memdir] selectViaLlamaCpp failed: ${errorMessage(e)}`,
      { level: 'warn' },
    )
    return []
  }
}

/**
 * Extract a JSON array of strings from arbitrary model output. Local models
 * sometimes wrap in ```json fences, prepend "Here are the relevant files:",
 * or emit `{"selected_memories":[...]}` despite the prompt. Try the first
 * `[ ... ]` substring; fall back to parsing the whole thing as an object
 * with a `selected_memories` key (matches the Anthropic schema for parity).
 */
export function extractFilenamesFromText(
  text: string,
  validFilenames: Set<string>,
): string[] {
  if (!text) return []
  const arrayMatch = text.match(/\[[\s\S]*?\]/)
  if (arrayMatch) {
    try {
      const arr: unknown = jsonParse(arrayMatch[0])
      if (
        Array.isArray(arr) &&
        arr.every((x): x is string => typeof x === 'string')
      ) {
        return arr.filter(f => validFilenames.has(f))
      }
    } catch {
      // fall through to object form
    }
  }
  try {
    const obj = jsonParse(text) as { selected_memories?: unknown }
    if (
      obj &&
      Array.isArray(obj.selected_memories) &&
      obj.selected_memories.every((x: unknown): x is string => typeof x === 'string')
    ) {
      return (obj.selected_memories as string[]).filter(f =>
        validFilenames.has(f),
      )
    }
  } catch {
    // give up
  }
  return []
}
