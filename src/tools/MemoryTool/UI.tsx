import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import React from 'react'
import { MessageResponse } from 'src/components/MessageResponse.js'
import { extractTag } from 'src/utils/messages.js'
import { FallbackToolUseErrorMessage } from '../../components/FallbackToolUseErrorMessage.js'
import { TOOL_SUMMARY_MAX_LENGTH } from '../../constants/toolLimits.js'
import { Text } from '../../ink.js'
import { truncate } from '../../utils/format.js'

export function userFacingName(): string {
  return 'Memory'
}

export function renderToolUseMessage(
  {
    action,
    filename,
    type,
  }: Partial<{ action: string; filename: string; type: string }>,
  _opts: { verbose: boolean },
): React.ReactNode {
  if (!action || !filename) return null
  const parts = [`${action} ${filename}`]
  if (type) parts.push(`(${type})`)
  return parts.join(' ')
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
        <Text color="error">Memory 執行錯誤</Text>
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
  return <Text>{text}</Text>
}

export function getToolUseSummary(
  input: Partial<{ action: string; filename: string }> | undefined,
): string | null {
  if (!input?.action || !input?.filename) return null
  return truncate(`${input.action} ${input.filename}`, TOOL_SUMMARY_MAX_LENGTH)
}
