import * as React from 'react'
import { getSdkBetas } from '../bootstrap/state.js'
import { Box, Text } from '../ink.js'
import { getContextWindowForModel } from '../utils/context.js'
import { formatTokens } from '../utils/format.js'
import { renderModelName, type ModelName } from '../utils/model/model.js'

type Props = {
  tokenUsage: number
  model: string
}

const BAR_WIDTH = 10

/**
 * 依用量百分比挑顏色：<65% 綠、65-85% 橘（yellow）、>85% 紅。
 * Ink 的 'yellow' 在大多數終端機會渲染為橘色調。
 */
function pickColor(pct: number): 'green' | 'yellow' | 'red' {
  if (pct > 85) return 'red'
  if (pct >= 65) return 'yellow'
  return 'green'
}

function buildBar(pct: number): { filled: string; empty: string } {
  const clamped = Math.min(100, Math.max(0, pct))
  const filledCount = Math.round((clamped / 100) * BAR_WIDTH)
  return {
    filled: '█'.repeat(filledCount),
    empty: '░'.repeat(BAR_WIDTH - filledCount),
  }
}

/**
 * Always-visible context progress bar. 讀取上一輪 API response 的實際
 * prompt token 數（經 Notifications.tokenCountFromLastAPIResponse 上行），
 * 對比模型 context window 大小算百分比，渲染彩色 bar。
 *
 * 沒資料（沒跑過任何 turn）時 tokenUsage 為 0 → 顯示 0% 綠色空條。
 */
export function ContextProgressBar({ tokenUsage, model }: Props): React.ReactNode {
  const windowSize = getContextWindowForModel(model, getSdkBetas())
  if (!windowSize || windowSize <= 0) return null

  const pct = Math.min(
    100,
    Math.max(0, Math.round((tokenUsage / windowSize) * 100)),
  )
  const color = pickColor(pct)
  const { filled, empty } = buildBar(pct)
  const modelDisplay = renderModelName(model as ModelName)

  return (
    <Box flexDirection="row">
      <Text dimColor wrap="truncate">{modelDisplay} · </Text>
      <Text color={color} wrap="truncate">{filled}</Text>
      <Text dimColor wrap="truncate">{empty}</Text>
      <Text color={color} wrap="truncate"> {pct}%</Text>
      <Text dimColor wrap="truncate">
        {' '}({formatTokens(tokenUsage)}/{formatTokens(windowSize)})
      </Text>
    </Box>
  )
}
