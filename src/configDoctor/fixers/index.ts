/**
 * Fix dispatchers（M-CONFIG-DOCTOR）。
 *
 * 收 Issue[]，依 code 派給對應 fixer；每個 fixer 自己負責備份 + atomic 寫入。
 * 安全策略：所有 destructive 動作前都備份原檔到 ~/.my-agent/backups/<file>.<ts>。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { basename, join } from 'path'
import type { FixResult, Issue } from '../types.js'
import { getMyAgentConfigHomeDir } from '../../utils/envUtils.js'
import { logForDebugging } from '../../utils/debug.js'

import { seedLlamaCppConfigIfMissing } from '../../llamacppConfig/seed.js'
import { seedWebConfigIfMissing } from '../../webConfig/seed.js'
import { seedDiscordConfigIfMissing } from '../../discordConfig/seed.js'
import { seedSystemPromptDirIfMissing } from '../../systemPromptFiles/seed.js'
import { seedGlobalConfigIfMissing } from '../../globalConfig/seed.js'
import { getGlobalClaudeFile } from '../../utils/env.js'
import { forceRewriteGlobalConfigWithDocs } from '../../globalConfig/seed.js'

function getBackupDir(): string {
  return join(getMyAgentConfigHomeDir(), 'backups')
}

function backupFile(path: string, sideEffects: string[]): void {
  if (!existsSync(path)) return
  const dir = getBackupDir()
  mkdirSync(dir, { recursive: true })
  const backupPath = join(dir, `${basename(path)}.backup.${Date.now()}`)
  copyFileSync(path, backupPath)
  sideEffects.push(`backed up ${path} → ${backupPath}`)
}

function patchBinaryPath(
  path: string,
  current: string,
  suggested: string,
  sideEffects: string[],
): void {
  backupFile(path, sideEffects)
  const text = readFileSync(path, 'utf-8')
  // 用最簡單的字串取代；jsonc.modify 在這個 case 太重
  const updated = text.replace(JSON.stringify(current), JSON.stringify(suggested))
  if (updated === text) {
    throw new Error(
      `binaryPath 字串取代失敗（找不到 "${current}" 在檔案中）`,
    )
  }
  writeFileSync(path, updated, 'utf-8')
  sideEffects.push(`patched binaryPath: ${current} → ${suggested}`)
}

async function repairCorruptJsonc(
  path: string,
  seedFn: () => Promise<void>,
  sideEffects: string[],
): Promise<void> {
  // 把壞檔搬到 .corrupt.<ts>，再讓 seed 重寫
  if (existsSync(path)) {
    const corruptPath = `${path}.corrupt.${Date.now()}`
    renameSync(path, corruptPath)
    sideEffects.push(`moved corrupt file → ${corruptPath}`)
  }
  await seedFn()
  sideEffects.push(`re-seeded ${path}`)
}

export async function applyFixes(
  issues: Issue[],
  mode: 'fix' | 'rewrite-with-docs',
): Promise<FixResult> {
  const fixed: string[] = []
  const remaining: string[] = []
  const sideEffects: string[] = []

  for (const issue of issues) {
    if (!issue.autoFixable) {
      remaining.push(issue.code)
      continue
    }

    try {
      switch (issue.code) {
        case 'llamacpp.missing':
          await seedLlamaCppConfigIfMissing()
          fixed.push(issue.code)
          break
        case 'llamacpp.parse-failed':
          if (issue.path) {
            await repairCorruptJsonc(
              issue.path,
              seedLlamaCppConfigIfMissing,
              sideEffects,
            )
            fixed.push(issue.code)
          } else {
            remaining.push(issue.code)
          }
          break
        case 'llamacpp.binary-path-platform': {
          const hint = issue.fixHint as
            | { current: string; suggested: string }
            | undefined
          if (hint && issue.path) {
            patchBinaryPath(issue.path, hint.current, hint.suggested, sideEffects)
            fixed.push(issue.code)
          } else {
            remaining.push(issue.code)
          }
          break
        }
        case 'llamacpp.strict-json':
          // seed 會自動偵測 strict JSON 並 migrate
          if (issue.path) backupFile(issue.path, sideEffects)
          await seedLlamaCppConfigIfMissing()
          fixed.push(issue.code)
          break

        case 'web.missing':
          await seedWebConfigIfMissing()
          fixed.push(issue.code)
          break
        case 'web.parse-failed':
          if (issue.path) {
            await repairCorruptJsonc(
              issue.path,
              seedWebConfigIfMissing,
              sideEffects,
            )
            fixed.push(issue.code)
          } else {
            remaining.push(issue.code)
          }
          break
        case 'web.strict-json':
          if (issue.path) backupFile(issue.path, sideEffects)
          await seedWebConfigIfMissing()
          fixed.push(issue.code)
          break

        case 'discord.missing':
          await seedDiscordConfigIfMissing()
          fixed.push(issue.code)
          break
        case 'discord.parse-failed':
          if (issue.path) {
            await repairCorruptJsonc(
              issue.path,
              seedDiscordConfigIfMissing,
              sideEffects,
            )
            fixed.push(issue.code)
          } else {
            remaining.push(issue.code)
          }
          break
        case 'discord.strict-json':
          if (issue.path) backupFile(issue.path, sideEffects)
          await seedDiscordConfigIfMissing()
          fixed.push(issue.code)
          break

        case 'global.missing':
          await seedGlobalConfigIfMissing(getGlobalClaudeFile())
          fixed.push(issue.code)
          break

        case 'systemPrompt.dir-missing':
        case 'systemPrompt.readme-missing':
        case 'systemPrompt.sections-missing':
          await seedSystemPromptDirIfMissing()
          fixed.push(issue.code)
          break

        default:
          remaining.push(issue.code)
      }
    } catch (err) {
      logForDebugging(
        `[config-doctor] fix ${issue.code} 失敗：${err instanceof Error ? err.message : String(err)}`,
        { level: 'warn' },
      )
      remaining.push(issue.code)
    }
  }

  // rewrite-with-docs：強制套全域模板（包含 strict JSON warning 也修）
  if (mode === 'rewrite-with-docs') {
    try {
      const r = await forceRewriteGlobalConfigWithDocs(getGlobalClaudeFile())
      if (r.backupPath) sideEffects.push(`global config 已備份 → ${r.backupPath}`)
      if (r.droppedKeys.length > 0) {
        sideEffects.push(
          `global config 剔除非 schema keys: ${r.droppedKeys.join(', ')}`,
        )
      }
      // 把 global.strict-json 從 remaining 移到 fixed
      const idx = remaining.indexOf('global.strict-json')
      if (idx >= 0) {
        remaining.splice(idx, 1)
        fixed.push('global.strict-json')
      }
    } catch (err) {
      sideEffects.push(
        `forceRewriteGlobalConfigWithDocs 失敗：${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  return { fixed, remaining, sideEffects }
}
