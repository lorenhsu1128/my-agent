import type { Command } from '../commands.js'
import {
  getCurrentDaemonManager,
  getLatestPendingPermission,
  respondToPermission,
} from '../hooks/useDaemonMode.js'
import type { LocalCommandCall } from '../types/command.js'

const call: LocalCommandCall = async () => {
  const mgr = getCurrentDaemonManager()
  if (!mgr) {
    return { type: 'text', value: '✗ 未連接 daemon' }
  }
  if (mgr.state.mode !== 'attached') {
    return {
      type: 'text',
      value: `✗ daemon 連線狀態：${mgr.state.mode}（需 attached）`,
    }
  }
  const pending = getLatestPendingPermission()
  if (!pending) {
    return { type: 'text', value: 'ℹ 目前沒有 pending permission' }
  }
  const ok = respondToPermission(pending.toolUseID, 'deny')
  return {
    type: 'text',
    value: ok
      ? `✓ 已 deny ${pending.toolName} (${pending.toolUseID.slice(0, 8)}…)`
      : '✗ 送出失敗（socket 異常）',
  }
}

const denyCommand = {
  type: 'local',
  name: 'deny',
  description: '拒絕 daemon 待回應的工具請求',
  isEnabled: () => true,
  supportsNonInteractive: false,
  load: () => Promise.resolve({ call }),
} satisfies Command

export default denyCommand
