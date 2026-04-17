// Skill Creation Nudge Hook — detects when a multi-step workflow could become
// a reusable skill. Complements Skillify (manual /skillify) with automatic
// detection of "you should probably save this as a skill" moments.
//
// Based on the apiQueryHookHelper pattern proven by skillImprovement.ts.

import type { Message } from '../../types/message.js'
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

export type SkillCandidate = {
  isCandidate: boolean
  name?: string
  description?: string
  steps?: string[]
}

export function countRecentToolUses(
  messages: Message[],
  sinceIndex: number,
): number {
  let count = 0
  for (let i = sinceIndex; i < messages.length; i++) {
    const msg = messages[i]
    if (msg.type !== 'assistant') continue
    const content = msg.message.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (block.type === 'tool_use') count++
    }
  }
  return count
}

export function formatToolSequence(messages: Message[]): string {
  const entries: string[] = []
  for (const msg of messages) {
    if (msg.type !== 'assistant') continue
    const content = msg.message.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (block.type === 'tool_use') {
        const inputSummary =
          typeof block.input === 'object' && block.input !== null
            ? Object.keys(block.input as Record<string, unknown>)
                .slice(0, 3)
                .join(', ')
            : ''
        entries.push(`- tool_use: ${block.name}(${inputSummary})`)
      }
    }
  }
  return entries.slice(-30).join('\n') // cap at last 30 tool calls
}

export function parseSkillCandidateResponse(content: string): SkillCandidate {
  const candidateStr = extractTag(content, 'candidate')
  if (!candidateStr) return { isCandidate: false }
  try {
    return jsonParse(candidateStr) as SkillCandidate
  } catch {
    return { isCandidate: false }
  }
}

export function createSkillCreationNudgeHook() {
  let lastAnalyzedIndex = 0

  const config: ApiQueryHookConfig<SkillCandidate> = {
    name: 'skill_creation_nudge',

    async shouldRun(context) {
      if (context.querySource !== 'repl_main_thread') return false

      const recentToolUses = countRecentToolUses(
        context.messages,
        lastAnalyzedIndex,
      )
      if (recentToolUses < getSelfImproveThresholds().skillCreationToolUseThreshold) return false

      return true
    },

    buildMessages(context) {
      const recentMessages = context.messages.slice(lastAnalyzedIndex)
      lastAnalyzedIndex = context.messages.length

      return [
        createUserMessage({
          content: `You are analyzing a tool usage sequence to determine if it represents a reusable workflow worth saving as a skill.

<tool_sequence>
${formatToolSequence(recentMessages)}
</tool_sequence>

Consider:
- Was a non-trivial approach used (5+ distinct steps)?
- Did it require trial and error, or changing course due to discoveries?
- Would this workflow be useful to repeat in future sessions?
- Is this a common development pattern (deploy, test, refactor, etc.)?

Do NOT flag:
- One-off debugging sessions
- Simple file reads/edits
- Conversations that are mostly Q&A without tool usage patterns

Output inside <candidate> tags:
{"isCandidate": true/false, "name": "suggested-skill-name", "description": "one-line description", "steps": ["step1", "step2", ...]}

If not a candidate, output: <candidate>{"isCandidate": false}</candidate>`,
        }),
      ]
    },

    systemPrompt:
      'You identify reusable multi-step workflows from tool usage patterns. Only flag genuinely reusable processes, not one-off tasks.',

    useTools: false,

    parseResponse(content) {
      return parseSkillCandidateResponse(content)
    },

    logResult(result, context) {
      if (result.type === 'success' && result.result.isCandidate) {
        context.toolUseContext.setAppState(prev => ({
          ...prev,
          pendingSkillCandidate: result.result,
        }))
      }
    },

    getModel: getSmallFastModel,
  }

  return createApiQueryHook(config)
}

export function initSkillCreationNudge(): void {
  try {
    registerPostSamplingHook(createSkillCreationNudgeHook())
  } catch (error) {
    logError(toError(error))
  }
}
