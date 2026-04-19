import React from 'react'
import { Text } from '../../ink.js'

type SkillManageInput = {
  action: string
  name: string
  content?: string
  old_string?: string
  new_string?: string
  file_path?: string
  [key: string]: unknown
}

type SkillManageResult = {
  success: boolean
  message?: string
  error?: string
  path?: string
}

export function userFacingName(): string {
  return 'SkillManage'
}

export function renderToolUseMessage(
  input: SkillManageInput,
): React.ReactNode {
  const detail = input.file_path
    ? `${input.action} ${input.name}/${input.file_path}`
    : `${input.action} ${input.name}`
  return <Text dimColor>{detail}</Text>
}

export function renderToolResultMessage(
  output: SkillManageResult,
): React.ReactNode {
  if (output.success) {
    return <Text color="green">{output.message ?? 'OK'}</Text>
  }
  return <Text color="red">{output.error ?? 'Error'}</Text>
}
