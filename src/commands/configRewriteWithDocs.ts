/**
 * REPL slash command `/config-rewrite-with-docs`
 *
 * 強制把 ~/.my-agent/.my-agent.json 重寫為帶繁中註解的 JSONC 模板版本，
 * 保留使用者現有欄位值。寫前自動備份為 `*.pre-rewrite-<timestamp>`。
 *
 * 同時對 llamacpp.json / discord.json / scheduled_tasks.json 三個檔觸發
 * 相同的 template re-seed（若其目前為 strict JSON 或過時）。
 *
 * 用途：
 *   - 現有使用者首次升級到 JSONC 註解版本
 *   - 模板更新（新欄位 / 新說明）後手動取得最新版本
 */
import type { Command } from '../commands.js'
import type { LocalCommandCall } from '../types/command.js'
import { getGlobalClaudeFile } from '../utils/env.js'
import { forceRewriteGlobalConfigWithDocs } from '../globalConfig/index.js'
import { seedLlamaCppConfigIfMissing } from '../llamacppConfig/index.js'
import { seedDiscordConfigIfMissing } from '../discordConfig/index.js'

const call: LocalCommandCall = async () => {
  const messages: string[] = []

  // 1. 全域 config
  const globalPath = getGlobalClaudeFile()
  try {
    const { backupPath } = await forceRewriteGlobalConfigWithDocs(globalPath)
    messages.push(
      `✅ ${globalPath}\n` +
        (backupPath ? `   備份：${backupPath}\n` : '   （原檔不存在，直接建立）\n'),
    )
  } catch (err) {
    messages.push(
      `❌ ${globalPath} 重寫失敗：${err instanceof Error ? err.message : String(err)}\n`,
    )
  }

  // 2. llamacpp / discord — 各自的 seed 函式內建了「strict JSON → JSONC
  //    with comments」的 migration 邏輯。直接呼叫即可。
  try {
    await seedLlamaCppConfigIfMissing()
    messages.push(`✅ llamacpp.json（若為 strict JSON 已升級為 JSONC）\n`)
  } catch (err) {
    messages.push(
      `❌ llamacpp.json：${err instanceof Error ? err.message : String(err)}\n`,
    )
  }
  try {
    await seedDiscordConfigIfMissing()
    messages.push(`✅ discord.json（若為 strict JSON 已升級為 JSONC）\n`)
  } catch (err) {
    messages.push(
      `❌ discord.json：${err instanceof Error ? err.message : String(err)}\n`,
    )
  }

  // 3. scheduled_tasks.json — 由 writeCronTasks 已預設走 JSONC 保留註解路徑，
  //    此處無需特別動作；若使用者想強制重寫，可刪檔後新建任務。
  messages.push(
    `ℹ️ scheduled_tasks.json：writeCronTasks 已內建 JSONC 保留註解；下次 cron\n` +
      `   寫回自動生效。若要重置檔頭繁中模板，請刪除 .my-agent/scheduled_tasks.json\n` +
      `   後讓 CronCreate 建立新任務時自動重新落盤。\n`,
  )

  return {
    type: 'text',
    value:
      `已觸發設定檔重寫（帶繁中註解 JSONC 模板）\n\n` +
      messages.join('\n') +
      `\n✅ saveGlobalConfig / saveConfigWithLock 已改為偵測 JSONC 並保留註解\n` +
      `   （src/utils/config.ts 兩個寫入函式走 jsonc.modify）。後續 turn-end stats /\n` +
      `   skillUsage / projects 寫回時不會洗掉 // 註解。`,
  }
}

const command = {
  type: 'local',
  name: 'config-rewrite-with-docs',
  description: '將所有 my-agent 設定檔重寫為帶繁中註解的 JSONC 模板版本（保留既有值）',
  argumentHint: '',
  isEnabled: () => true,
  isHidden: false,
  supportsNonInteractive: false,
  load: () => Promise.resolve({ call }),
} satisfies Command

export default command
