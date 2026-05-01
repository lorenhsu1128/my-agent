import chalk from 'chalk'
import { logForDebugging } from 'src/utils/debug.js'
import { fileHistoryEnabled } from 'src/utils/fileHistory.js'
import {
  getInitialSettings,
  getSettings_DEPRECATED,
} from 'src/utils/settings/settings.js'
import { shouldOfferTerminalSetup } from '../../commands/terminalSetup/terminalSetup.js'
import { getShortcutDisplay } from '../../keybindings/shortcutFormat.js'
import { countConcurrentSessions } from '../../utils/concurrentSessions.js'
import { getGlobalConfig } from '../../utils/config.js'
import { env } from '../../utils/env.js'
import { getWorktreeCount } from '../../utils/git.js'
import {
  detectRunningIDEsCached,
  getSortedIdeLockfiles,
  isCursorInstalled,
  isSupportedTerminal,
  isSupportedVSCodeTerminal,
  isVSCodeInstalled,
  isWindsurfInstalled,
} from '../../utils/ide.js'
import { getUserSpecifiedModelSetting } from '../../utils/model/model.js'
import { getPlatform } from '../../utils/platform.js'
import {
  getCurrentSessionAgentColor,
  isCustomTitleEnabled,
} from '../../utils/sessionStorage.js'
import { getSessionsSinceLastShown } from './tipHistory.js'
import type { Tip, TipContext } from './types.js'

const externalTips: Tip[] = [
  {
    id: 'new-user-warmup',
    content: async () =>
      `從小功能或修 bug 開始；請 Claude 先提方案，再驗證它建議的修改。`,
    cooldownSessions: 3,
    async isRelevant() {
      const config = getGlobalConfig()
      return config.numStartups < 10
    },
  },
  {
    id: 'plan-mode-for-complex-tasks',
    content: async () =>
      `處理複雜需求前先用 Plan Mode 規劃。按 ${getShortcutDisplay('chat:cycleMode', 'Chat', 'shift+tab')} 兩次啟用。`,
    cooldownSessions: 5,
    isRelevant: async () => {
      if (process.env.USER_TYPE === 'ant') return false
      const config = getGlobalConfig()
      const daysSinceLastUse = config.lastPlanModeUse
        ? (Date.now() - config.lastPlanModeUse) / (1000 * 60 * 60 * 24)
        : Infinity
      return daysSinceLastUse > 7
    },
  },
  {
    id: 'default-permission-mode-config',
    content: async () =>
      `用 /config 變更預設權限模式（包含 Plan Mode）。`,
    cooldownSessions: 10,
    isRelevant: async () => {
      try {
        const config = getGlobalConfig()
        const settings = getSettings_DEPRECATED()
        const hasUsedPlanMode = Boolean(config.lastPlanModeUse)
        const hasDefaultMode = Boolean(settings?.permissions?.defaultMode)
        return hasUsedPlanMode && !hasDefaultMode
      } catch (error) {
        logForDebugging(
          `Failed to check default-permission-mode-config tip relevance: ${error}`,
          { level: 'warn' },
        )
        return false
      }
    },
  },
  {
    id: 'git-worktrees',
    content: async () =>
      '用 git worktree 同時跑多個 Claude session 並行作業。',
    cooldownSessions: 10,
    isRelevant: async () => {
      try {
        const config = getGlobalConfig()
        const worktreeCount = await getWorktreeCount()
        return worktreeCount <= 1 && config.numStartups > 50
      } catch (_) {
        return false
      }
    },
  },
  {
    id: 'color-when-multi-clauding',
    content: async () =>
      '同時開多個 Claude session？用 /color 與 /rename 一眼分辨。',
    cooldownSessions: 10,
    isRelevant: async () => {
      if (getCurrentSessionAgentColor()) return false
      const count = await countConcurrentSessions()
      return count >= 2
    },
  },
  {
    id: 'terminal-setup',
    content: async () =>
      env.terminal === 'Apple_Terminal'
        ? '執行 /terminal-setup 啟用終端整合：Option + Enter 換行等便利功能'
        : '執行 /terminal-setup 啟用終端整合:Shift + Enter 換行等便利功能',
    cooldownSessions: 10,
    async isRelevant() {
      const config = getGlobalConfig()
      if (env.terminal === 'Apple_Terminal') {
        return !config.optionAsMetaKeyInstalled
      }
      return !config.shiftEnterKeyBindingInstalled
    },
  },
  {
    id: 'shift-enter',
    content: async () =>
      env.terminal === 'Apple_Terminal'
        ? '按 Option+Enter 送出多行訊息'
        : '按 Shift+Enter 送出多行訊息',
    cooldownSessions: 10,
    async isRelevant() {
      const config = getGlobalConfig()
      return Boolean(
        (env.terminal === 'Apple_Terminal'
          ? config.optionAsMetaKeyInstalled
          : config.shiftEnterKeyBindingInstalled) && config.numStartups > 3,
      )
    },
  },
  {
    id: 'shift-enter-setup',
    content: async () =>
      env.terminal === 'Apple_Terminal'
        ? '執行 /terminal-setup 啟用 Option+Enter 換行'
        : '執行 /terminal-setup 啟用 Shift+Enter 換行',
    cooldownSessions: 10,
    async isRelevant() {
      if (!shouldOfferTerminalSetup()) {
        return false
      }
      const config = getGlobalConfig()
      return !(env.terminal === 'Apple_Terminal'
        ? config.optionAsMetaKeyInstalled
        : config.shiftEnterKeyBindingInstalled)
    },
  },
  {
    id: 'memory-command',
    content: async () => '用 /memory 檢視與管理 Claude memory',
    cooldownSessions: 15,
    async isRelevant() {
      const config = getGlobalConfig()
      return config.memoryUsageCount <= 0
    },
  },
  {
    id: 'theme-command',
    content: async () => '用 /theme 變更色彩主題',
    cooldownSessions: 20,
    isRelevant: async () => true,
  },
  {
    id: 'colorterm-truecolor',
    content: async () =>
      '試試把環境變數設成 COLORTERM=truecolor，獲得更豐富的色彩',
    cooldownSessions: 30,
    isRelevant: async () => !process.env.COLORTERM && chalk.level < 3,
  },
  {
    id: 'powershell-tool-env',
    content: async () =>
      '設定 MY_AGENT_USE_POWERSHELL_TOOL=1 啟用 PowerShell 工具（preview）',
    cooldownSessions: 10,
    isRelevant: async () =>
      getPlatform() === 'windows' &&
      process.env.MY_AGENT_USE_POWERSHELL_TOOL === undefined,
  },
  {
    id: 'status-line',
    content: async () =>
      '用 /statusline 設定輸入框下方顯示的自訂狀態列',
    cooldownSessions: 25,
    isRelevant: async () => getSettings_DEPRECATED().statusLine === undefined,
  },
  {
    id: 'prompt-queue',
    content: async () =>
      'Claude 工作時按 Enter 把後續訊息排入佇列。',
    cooldownSessions: 5,
    async isRelevant() {
      const config = getGlobalConfig()
      return config.promptQueueUseCount <= 3
    },
  },
  {
    id: 'enter-to-steer-in-relatime',
    content: async () =>
      'Claude 工作中也能繼續送訊息，即時導向它的方向。',
    cooldownSessions: 20,
    isRelevant: async () => true,
  },
  {
    id: 'todo-list',
    content: async () =>
      '處理複雜任務時請 Claude 建立 todo list，追蹤進度並保持聚焦。',
    cooldownSessions: 20,
    isRelevant: async () => true,
  },
  {
    id: 'vscode-command-install',
    content: async () =>
      `開啟 Command Palette (Cmd+Shift+P) 執行 "Shell Command: Install '${env.terminal === 'vscode' ? 'code' : env.terminal}' command in PATH" 啟用 IDE 整合`,
    cooldownSessions: 0,
    async isRelevant() {
      if (!isSupportedVSCodeTerminal()) {
        return false
      }
      if (getPlatform() !== 'macos') {
        return false
      }

      switch (env.terminal) {
        case 'vscode':
          return !(await isVSCodeInstalled())
        case 'cursor':
          return !(await isCursorInstalled())
        case 'windsurf':
          return !(await isWindsurfInstalled())
        default:
          return false
      }
    },
  },
  {
    id: 'ide-upsell-external-terminal',
    content: async () => '把 Claude 連到你的 IDE · /ide',
    cooldownSessions: 4,
    async isRelevant() {
      if (isSupportedTerminal()) {
        return false
      }

      const lockfiles = await getSortedIdeLockfiles()
      if (lockfiles.length !== 0) {
        return false
      }

      const runningIDEs = await detectRunningIDEsCached()
      return runningIDEs.length > 0
    },
  },
  {
    id: 'permissions',
    content: async () =>
      '用 /permissions 預先核准或拒絕 bash、edit、MCP 工具',
    cooldownSessions: 10,
    async isRelevant() {
      const config = getGlobalConfig()
      return config.numStartups > 10
    },
  },
  {
    id: 'drag-and-drop-images',
    content: async () =>
      '你知道可以把圖片檔直接拖進終端機嗎？',
    cooldownSessions: 10,
    isRelevant: async () => !env.isSSH(),
  },
  {
    id: 'paste-images-mac',
    content: async () =>
      '在 my-agent 中用 control+v 貼上圖片（不是 cmd+v！）',
    cooldownSessions: 10,
    isRelevant: async () => getPlatform() === 'macos',
  },
  {
    id: 'double-esc',
    content: async () =>
      '連按兩次 esc 把對話倒回到先前的時間點',
    cooldownSessions: 10,
    isRelevant: async () => !fileHistoryEnabled(),
  },
  {
    id: 'double-esc-code-restore',
    content: async () =>
      '連按兩次 esc 把程式碼或對話倒回到先前的時間點',
    cooldownSessions: 10,
    isRelevant: async () => fileHistoryEnabled(),
  },
  {
    id: 'continue',
    content: async () =>
      '執行 my-agent --continue 或 my-agent --resume 恢復對話',
    cooldownSessions: 10,
    isRelevant: async () => true,
  },
  {
    id: 'rename-conversation',
    content: async () =>
      '用 /rename 為對話命名,方便日後在 /resume 中快速找回',
    cooldownSessions: 15,
    isRelevant: async () =>
      isCustomTitleEnabled() && getGlobalConfig().numStartups > 10,
  },
  {
    id: 'custom-commands',
    content: async () =>
      '在 .my-agent/skills/（專案）或 ~/.my-agent/skills/（全域）放 .md 檔即可建立 skill',
    cooldownSessions: 15,
    async isRelevant() {
      const config = getGlobalConfig()
      return config.numStartups > 10
    },
  },
  {
    id: 'shift-tab',
    content: async () =>
      process.env.USER_TYPE === 'ant'
        ? `按 ${getShortcutDisplay('chat:cycleMode', 'Chat', 'shift+tab')} 在預設模式與 auto 模式間切換`
        : `按 ${getShortcutDisplay('chat:cycleMode', 'Chat', 'shift+tab')} 在預設模式 / auto-accept edit 模式 / plan 模式間切換`,
    cooldownSessions: 10,
    isRelevant: async () => true,
  },
  {
    id: 'image-paste',
    content: async () =>
      `用 ${getShortcutDisplay('chat:imagePaste', 'Chat', 'ctrl+v')} 從剪貼簿貼上圖片`,
    cooldownSessions: 20,
    isRelevant: async () => true,
  },
  {
    id: 'custom-agents',
    content: async () =>
      '用 /agents 為特定任務最佳化。例如：軟體架構師、Code Writer、Code Reviewer',
    cooldownSessions: 15,
    async isRelevant() {
      const config = getGlobalConfig()
      return config.numStartups > 5
    },
  },
  {
    id: 'agent-flag',
    content: async () =>
      '用 --agent <agent_name> 直接和 subagent 開始對話',
    cooldownSessions: 15,
    async isRelevant() {
      const config = getGlobalConfig()
      return config.numStartups > 5
    },
  },
  {
    id: 'opusplan-mode-reminder',
    content: async () =>
      `你的預設模型設定是 Opus Plan Mode。按 ${getShortcutDisplay('chat:cycleMode', 'Chat', 'shift+tab')} 兩次啟用 Plan Mode，並用 Claude Opus 規劃。`,
    cooldownSessions: 2,
    async isRelevant() {
      if (process.env.USER_TYPE === 'ant') return false
      const config = getGlobalConfig()
      const modelSetting = getUserSpecifiedModelSetting()
      const hasOpusPlanMode = modelSetting === 'opusplan'
      const daysSinceLastUse = config.lastPlanModeUse
        ? (Date.now() - config.lastPlanModeUse) / (1000 * 60 * 60 * 24)
        : Infinity
      return hasOpusPlanMode && daysSinceLastUse > 3
    },
  },
]
const internalOnlyTips: Tip[] =
  process.env.USER_TYPE === 'ant'
    ? [
        {
          id: 'important-claudemd',
          content: async () =>
            '[ANT-ONLY] 必須遵守的 MY-AGENT.md 規則前面加 "IMPORTANT:" 標記',
          cooldownSessions: 30,
          isRelevant: async () => true,
        },
        {
          id: 'skillify',
          content: async () =>
            '[ANT-ONLY] 流程結束時用 /skillify 把它包成可重用的 skill',
          cooldownSessions: 15,
          isRelevant: async () => true,
        },
      ]
    : []

function getCustomTips(): Tip[] {
  const settings = getInitialSettings()
  const override = settings.spinnerTipsOverride
  if (!override?.tips?.length) return []

  return override.tips.map((content, i) => ({
    id: `custom-tip-${i}`,
    content: async () => content,
    cooldownSessions: 0,
    isRelevant: async () => true,
  }))
}

export async function getRelevantTips(context?: TipContext): Promise<Tip[]> {
  const settings = getInitialSettings()
  const override = settings.spinnerTipsOverride
  const customTips = getCustomTips()

  if (override?.excludeDefault && customTips.length > 0) {
    return customTips
  }

  const tips = [...externalTips, ...internalOnlyTips]
  const isRelevant = await Promise.all(tips.map(_ => _.isRelevant(context)))
  const filtered = tips
    .filter((_, index) => isRelevant[index])
    .filter(_ => getSessionsSinceLastShown(_.id) >= _.cooldownSessions)

  return [...filtered, ...customTips]
}
