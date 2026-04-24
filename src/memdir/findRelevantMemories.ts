import { feature } from 'bun:bundle'
import { logForDebugging } from '../utils/debug.js'
import { errorMessage } from '../utils/errors.js'
import { getDefaultSonnetModel } from '../utils/model/model.js'
import { isLlamaCppActive } from '../utils/model/providers.js'
import { getLlamaCppConfigSnapshot } from '../llamacppConfig/index.js'
import { sideQuery } from '../utils/sideQuery.js'
import { jsonParse } from '../utils/slowOperations.js'
import {
  formatMemoryManifest,
  type MemoryHeader,
  scanMemoryFiles,
} from './memoryScan.js'

/**
 * Fallback cap when the selector returns empty (no API key, parse failure,
 * llamacpp server down, etc). Without this, llama.cpp users see zero memory
 * recall — the selector silently fails and the prefetch returns []. Capped
 * by file count rather than bytes to avoid an extra stat round; memories
 * are already mtime-sorted so we keep the freshest N.
 */
const FALLBACK_MAX_FILES = 8

export type RelevantMemory = {
  path: string
  mtimeMs: number
}

const SELECT_MEMORIES_SYSTEM_PROMPT = `You are selecting memories that will be useful to my-agent as it processes a user's query. You will be given the user's query and a list of available memory files with their filenames and descriptions.

Return a list of filenames for the memories that will clearly be useful to my-agent as it processes the user's query (up to 5). Only include memories that you are certain will be helpful based on their name and description.
- If you are unsure if a memory will be useful in processing the user's query, then do not include it in your list. Be selective and discerning.
- If there are no memories in the list that would clearly be useful, feel free to return an empty list.
- If a list of recently-used tools is provided, do not select memories that are usage reference or API documentation for those tools (my-agent is already exercising them). DO still select memories containing warnings, gotchas, or known issues about those tools — active use is exactly when those matter.
`

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

  const selectedFilenames = await selectRelevantMemories(
    query,
    memories,
    signal,
    recentTools,
  )
  const byFilename = new Map(memories.map(m => [m.filename, m]))
  let selected = selectedFilenames
    .map(filename => byFilename.get(filename))
    .filter((m): m is MemoryHeader => m !== undefined)

  // M-MEMRECALL-LOCAL: selector returned nothing but candidates exist.
  // Most likely cause: no Anthropic API key + llamacpp parse failure / server
  // down. Without this fallback, llama.cpp users get zero memory recall and
  // every new session starts blind. Take the freshest N (already mtime-sorted)
  // so the model at least sees recent context.
  if (selected.length === 0 && memories.length > 0) {
    selected = memories.slice(0, FALLBACK_MAX_FILES)
    logForDebugging(
      `[memdir] selector returned 0 of ${memories.length} candidates; fallback attached ${selected.length} freshest memories`,
      { level: 'warn' },
    )
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

  // M-MEMRECALL-LOCAL: sideQuery is hardcoded to Anthropic SDK. Pure llama.cpp
  // users (no ANTHROPIC_API_KEY) would otherwise 401 silently and lose memory
  // recall entirely. Branch to a direct OpenAI-compatible /v1/chat/completions
  // call against the local server when llamacpp is the active provider.
  if (isLlamaCppActive()) {
    return await selectViaLlamaCpp(
      query,
      manifest,
      toolsSection,
      validFilenames,
      signal,
    )
  }

  try {
    const result = await sideQuery({
      model: getDefaultSonnetModel(),
      system: SELECT_MEMORIES_SYSTEM_PROMPT,
      skipSystemPromptPrefix: true,
      messages: [
        {
          role: 'user',
          content: `Query: ${query}\n\nAvailable memories:\n${manifest}${toolsSection}`,
        },
      ],
      max_tokens: 256,
      output_format: {
        type: 'json_schema',
        schema: {
          type: 'object',
          properties: {
            selected_memories: { type: 'array', items: { type: 'string' } },
          },
          required: ['selected_memories'],
          additionalProperties: false,
        },
      },
      signal,
      querySource: 'memdir_relevance',
    })

    const textBlock = result.content.find(block => block.type === 'text')
    if (!textBlock || textBlock.type !== 'text') {
      return []
    }

    const parsed: { selected_memories: string[] } = jsonParse(textBlock.text)
    return parsed.selected_memories.filter(f => validFilenames.has(f))
  } catch (e) {
    if (signal.aborted) {
      return []
    }
    logForDebugging(
      `[memdir] selectRelevantMemories failed: ${errorMessage(e)}`,
      { level: 'warn' },
    )
    return []
  }
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
): Promise<string[]> {
  try {
    const cfg = getLlamaCppConfigSnapshot()
    const userPrompt = `Query: ${query}\n\nAvailable memories:\n${manifest}${toolsSection}\n\nReply with ONLY a JSON array of filenames (e.g. ["foo.md","bar.md"]). No prose, no markdown fences, no keys. Empty array [] if none apply.`
    const response = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: cfg.model,
        max_tokens: 256,
        temperature: 0,
        messages: [
          { role: 'system', content: SELECT_MEMORIES_SYSTEM_PROMPT },
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
