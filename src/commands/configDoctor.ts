/**
 * REPL slash command `/config-doctor`（M-CONFIG-DOCTOR）
 *
 * 用法：
 *   /config-doctor              預設 --check（純讀，列 issue）
 *   /config-doctor fix          --fix（自動修可修的）
 *   /config-doctor rewrite      --rewrite-with-docs（強制套全域模板）
 *   /config-doctor --json       JSON 輸出
 */
import type { Command } from '../commands.js'
import type { LocalCommandCall } from '../types/command.js'
import { runConfigDoctor, formatReport } from '../configDoctor/index.js'

const call: LocalCommandCall = async args => {
  const tokens = (args ?? '').trim().split(/\s+/).filter(Boolean)
  const json = tokens.includes('--json')
  const sub = tokens.find(t => !t.startsWith('--'))

  let mode: 'check' | 'fix' | 'rewrite-with-docs' = 'check'
  if (sub === 'fix') mode = 'fix'
  else if (sub === 'rewrite' || sub === 'rewrite-with-docs') {
    mode = 'rewrite-with-docs'
  }

  const result = await runConfigDoctor({ mode, json })
  return {
    type: 'text',
    value: formatReport(result, json),
  }
}

const command = {
  type: 'local',
  name: 'config-doctor',
  description:
    'Config 健康診斷與自動修復（用法：/config-doctor [fix|rewrite] [--json]）',
  argumentHint: '[fix|rewrite] [--json]',
  isEnabled: () => true,
  isHidden: false,
  supportsNonInteractive: true,
  load: () => Promise.resolve({ call }),
} satisfies Command

export default command
