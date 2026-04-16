import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import React from 'react'
import { MessageResponse } from 'src/components/MessageResponse.js'
import { extractTag } from 'src/utils/messages.js'
import { FallbackToolUseErrorMessage } from '../../components/FallbackToolUseErrorMessage.js'
import { TOOL_SUMMARY_MAX_LENGTH } from '../../constants/toolLimits.js'
import { Text } from '../../ink.js'
import { truncate } from '../../utils/format.js'

export function userFacingName(): string {
  return 'SessionSearch'
}

export function renderToolUseMessage(
  {
    query,
    limit,
    summarize,
  }: Partial<{ query: string; limit: number; summarize: boolean }>,
  _opts: { verbose: boolean },
): React.ReactNode {
  if (!query) return null
  const parts = [`query: "${query}"`]
  if (typeof limit === 'number') parts.push(`limit: ${limit}`)
  if (summarize) parts.push('summarize: true')
  return parts.join(', ')
}

export function renderToolUseErrorMessage(
  result: ToolResultBlockParam['content'],
  { verbose }: { verbose: boolean },
): React.ReactNode {
  if (
    !verbose &&
    typeof result === 'string' &&
    extractTag(result, 'tool_use_error')
  ) {
    return (
      <MessageResponse>
        <Text color="error">SessionSearch 執行錯誤</Text>
      </MessageResponse>
    )
  }
  return <FallbackToolUseErrorMessage result={result} verbose={verbose} />
}

export function renderToolResultMessage(
  content: ToolResultBlockParam['content'],
  _opts: { verbose: boolean },
): React.ReactNode {
  const text = typeof content === 'string' ? content : ''
  if (!text) return null
  // 簡單顯示：回傳的 markdown 全文（verbose 與否都展完，因為結果量級已受 limit 控制）
  return <Text>{text}</Text>
}

export function getToolUseSummary(
  input: Partial<{ query: string }> | undefined,
): string | null {
  if (!input?.query) return null
  return truncate(input.query, TOOL_SUMMARY_MAX_LENGTH)
}
