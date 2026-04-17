// Memory Nudge Hook — detects user corrections and preferences mid-session.
// Complements extractMemories (session-end) with real-time detection of
// "don't do X" / "always do Y" style corrections.
//
// Based on the apiQueryHookHelper pattern proven by skillImprovement.ts.

import type { Message } from '../../types/message.js'
import { count } from '../array.js'
import { logError } from '../log.js'
import { toError } from '../errors.js'
import {
  createUserMessage,
  extractTag,
} from '../messages.js'
import { getSmallFastModel } from '../model/model.js'
import { jsonParse } from '../slowOperations.js'
import {
  type ApiQueryHookConfig,
  createApiQueryHook,
} from './apiQueryHookHelper.js'
import { registerPostSamplingHook } from './postSamplingHooks.js'
import { getSelfImproveThresholds } from '../../services/selfImprove/thresholds.js'

export type MemoryNudgeItem = {
  content: string
  type: string
  reason: string
}

function formatRecentMessages(messages: Message[]): string {
  return messages
    .filter(m => m.type === 'user' || m.type === 'assistant')
    .map(m => {
      const role = m.type === 'user' ? 'User' : 'Assistant'
      const content = m.message.content
      if (typeof content === 'string')
        return `${role}: ${content.slice(0, 500)}`
      const text = content
        .filter(
          (b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text',
        )
        .map(b => b.text)
        .join('\n')
      return `${role}: ${text.slice(0, 500)}`
    })
    .join('\n\n')
}

export function parseMemoryNudgeResponse(content: string): MemoryNudgeItem[] {
  const memoriesStr = extractTag(content, 'memories')
  if (!memoriesStr) return []
  try {
    return jsonParse(memoriesStr) as MemoryNudgeItem[]
  } catch {
    return []
  }
}

export function createMemoryNudgeHook() {
  let lastAnalyzedCount = 0
  let lastAnalyzedIndex = 0

  const config: ApiQueryHookConfig<MemoryNudgeItem[]> = {
    name: 'memory_nudge',

    async shouldRun(context) {
      if (context.querySource !== 'repl_main_thread') return false

      const userCount = count(context.messages, m => m.type === 'user')
      if (userCount - lastAnalyzedCount < getSelfImproveThresholds().memoryNudgeTurnBatch) return false

      lastAnalyzedCount = userCount
      return true
    },

    buildMessages(context) {
      const newMessages = context.messages.slice(lastAnalyzedIndex)
      lastAnalyzedIndex = context.messages.length

      return [
        createUserMessage({
          content: `You are analyzing a conversation for user preferences and corrections worth remembering permanently.

<recent_messages>
${formatRecentMessages(newMessages)}
</recent_messages>

Look for:
- User corrections: "don't do X", "always do Y", "I prefer Z", "stop doing W"
- User expectations about behavior or work style
- Personal details worth remembering for future sessions (role, expertise, tools they use)

Ignore:
- Routine conversation that doesn't generalize (one-time answers, chitchat)
- Things that are task-specific and won't apply to future sessions
- Preferences already well-known or obvious from context

Output a JSON array inside <memories> tags. Each item: {"content": "what to remember", "type": "user|feedback|project|reference", "reason": "which user message prompted this"}.
Output <memories>[]</memories> if nothing is worth saving.`,
        }),
      ]
    },

    systemPrompt:
      'You detect user preferences and behavioral corrections during conversations. Flag anything the user says that should be remembered for future sessions.',

    useTools: false,

    parseResponse(content) {
      return parseMemoryNudgeResponse(content)
    },

    logResult(result, context) {
      if (result.type === 'success' && result.result.length > 0) {
        context.toolUseContext.setAppState(prev => ({
          ...prev,
          pendingMemoryNudge: {
            memories: result.result,
          },
        }))
      }
    },

    getModel: getSmallFastModel,
  }

  return createApiQueryHook(config)
}

export function initMemoryNudge(): void {
  try {
    registerPostSamplingHook(createMemoryNudgeHook())
  } catch (error) {
    logError(toError(error))
  }
}
