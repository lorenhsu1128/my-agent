// Session Review Agent — analyzes tool usage patterns at session end
// to produce skill drafts and trajectory summaries.
//
// Triggered from stopHooks.ts after executeAutoDream.
// Runs as a forked agent with restricted tool permissions.

import type { REPLHookContext } from '../../utils/hooks/postSamplingHooks.js'
import {
  createCacheSafeParams,
  runForkedAgent,
} from '../../utils/forkedAgent.js'
import { createUserMessage } from '../../utils/messages.js'
import { logForDebugging } from '../../utils/debug.js'
import type { ToolUseContext } from '../../Tool.js'
import { isAutoMemoryEnabled, getAutoMemPath } from '../../memdir/paths.js'
import {
  getOriginalCwd,
  getIsRemoteMode,
} from '../../bootstrap/state.js'
import { createAutoMemCanUseTool } from '../extractMemories/extractMemories.js'
import { getProjectDir } from '../../utils/sessionStorage.js'
import { buildSessionReviewPrompt } from './sessionReviewPrompt.js'
import { getSelfImproveThresholds } from './thresholds.js'
import type { Message } from '../../types/message.js'
import type { Tool } from '../../Tool.js'

// ── canUseTool for Session Review ────────────────────────────────────────

/**
 * Session Review can read anywhere but only write to memory/ directory
 * (including skill-drafts/ and trajectories/ subdirectories).
 * It CANNOT write to .my-agent/skills/ — only AutoDream does that
 * after cross-session verification.
 */
export function createSessionReviewCanUseTool(
  memoryDir: string,
): (tool: Tool, input: Record<string, unknown>) => Promise<{
  behavior: 'allow' | 'deny'
  updatedInput: Record<string, unknown>
  message?: string
}> {
  // Delegate to the standard auto-memory permission function
  // which already handles: Read/Grep/Glob anywhere, Bash read-only,
  // Edit/Write only in memoryDir
  return createAutoMemCanUseTool(memoryDir)
}

// ── Tool use counting ────────────────────────────────────────────────────

function countToolUsesInMessages(messages: Message[]): number {
  let count = 0
  for (const msg of messages) {
    if (msg.type !== 'assistant') continue
    const content = msg.message?.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (block.type === 'tool_use') count++
    }
  }
  return count
}

// ── Session Review runner ────────────────────────────────────────────────

type AppendSystemMessageFn = NonNullable<ToolUseContext['appendSystemMessage']>

let lastReviewAt = 0

export function initSessionReview(): void {
  lastReviewAt = 0
}

export async function executeSessionReview(
  context: REPLHookContext,
  _appendSystemMessage?: AppendSystemMessageFn,
): Promise<void> {
  // Gate: only main thread
  if (context.toolUseContext.agentId) return

  // Gate: remote mode skip
  if (getIsRemoteMode()) return

  // Gate: auto-memory must be enabled
  if (!isAutoMemoryEnabled()) return

  // Gate: minimum time between reviews
  const thresholds = getSelfImproveThresholds()
  const hoursSince = (Date.now() - lastReviewAt) / 3_600_000
  if (lastReviewAt > 0 && hoursSince < thresholds.sessionReviewMinIntervalHours) {
    logForDebugging(
      `[sessionReview] skip — only ${hoursSince.toFixed(1)}h since last review`,
    )
    return
  }

  // Gate: minimum tool uses in this session
  const toolUseCount = countToolUsesInMessages(context.messages)
  if (toolUseCount < thresholds.sessionReviewMinToolUses) {
    logForDebugging(
      `[sessionReview] skip — only ${toolUseCount} tool uses (need ${thresholds.sessionReviewMinToolUses})`,
    )
    return
  }

  lastReviewAt = Date.now()

  const memoryRoot = getAutoMemPath()
  const transcriptDir = getProjectDir(getOriginalCwd())
  const prompt = buildSessionReviewPrompt(memoryRoot, transcriptDir)

  logForDebugging(
    `[sessionReview] firing — ${toolUseCount} tool uses in session`,
  )

  try {
    await runForkedAgent({
      promptMessages: [createUserMessage({ content: prompt })],
      cacheSafeParams: createCacheSafeParams(context),
      canUseTool: createSessionReviewCanUseTool(memoryRoot),
      querySource: 'session_review',
      forkLabel: 'session_review',
      skipTranscript: true,
      maxTurns: 8,
    })

    logForDebugging('[sessionReview] completed')
  } catch (e: unknown) {
    logForDebugging(
      `[sessionReview] failed: ${(e as Error).message}`,
    )
  }
}
