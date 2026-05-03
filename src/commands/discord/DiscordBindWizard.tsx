/**
 * /discord bind-other-channel wizard：兩欄位輸入（channelId 必填、projectKey 選填）。
 * 為 single-tab 場景設計：父層用 useInput 完全停用，由本元件接管。
 */
import * as React from 'react'
import { useState } from 'react'
import { Box, Text, useInput } from '../../ink.js'
import { isValidSnowflake } from './discordManagerLogic.js'

export interface DiscordBindWizardSubmit {
  channelId: string
  /** 空字串視為 undefined（auto-register cwd）。 */
  projectKey: string | undefined
}

interface Props {
  onSubmit: (v: DiscordBindWizardSubmit) => void
  onCancel: () => void
}

export function DiscordBindWizard({ onSubmit, onCancel }: Props): React.ReactNode {
  const [field, setField] = useState<'channelId' | 'projectKey'>('channelId')
  const [channelId, setChannelId] = useState('')
  const [projectKey, setProjectKey] = useState('')
  const [err, setErr] = useState<string | null>(null)

  useInput((input, key) => {
    if (key.escape) {
      onCancel()
      return
    }
    if (key.tab) {
      setField(f => (f === 'channelId' ? 'projectKey' : 'channelId'))
      return
    }
    if (key.return) {
      if (!channelId.trim()) {
        setErr('channelId 必填')
        setField('channelId')
        return
      }
      if (!isValidSnowflake(channelId.trim())) {
        setErr(`不像 Discord snowflake（17–20 位純數字）`)
        return
      }
      onSubmit({
        channelId: channelId.trim(),
        projectKey: projectKey.trim() === '' ? undefined : projectKey.trim(),
      })
      return
    }
    if (key.backspace || key.delete) {
      if (field === 'channelId') setChannelId(s => s.slice(0, -1))
      else setProjectKey(s => s.slice(0, -1))
      setErr(null)
      return
    }
    if (input && !key.ctrl && !key.meta) {
      if (field === 'channelId') setChannelId(s => s + input)
      else setProjectKey(s => s + input)
      setErr(null)
    }
  })

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold>綁定既有 Discord channel</Text>
      <Box marginTop={1}>
        <Box width={14}>
          <Text dimColor>Channel ID:</Text>
        </Box>
        <Text color={field === 'channelId' ? 'cyan' : undefined}>
          {field === 'channelId' ? `[${channelId}_]` : channelId || '(空)'}
        </Text>
      </Box>
      <Box>
        <Box width={14}>
          <Text dimColor>Project key:</Text>
        </Box>
        <Text color={field === 'projectKey' ? 'cyan' : undefined}>
          {field === 'projectKey'
            ? `[${projectKey}_]`
            : projectKey || '(空 = auto-register cwd)'}
        </Text>
      </Box>
      {err && (
        <Box marginTop={1}>
          <Text color="red">⚠ {err}</Text>
        </Box>
      )}
      <Box marginTop={1}>
        <Text dimColor>Tab 切欄位 · Enter 送出 · Esc 取消</Text>
      </Box>
    </Box>
  )
}
