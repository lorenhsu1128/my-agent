/**
 * discord.jsonc 健康檢查（M-CONFIG-DOCTOR）。
 */
import { existsSync } from 'fs'
import { readFile } from 'fs/promises'
import type { Issue } from '../types.js'
import { getDiscordConfigPath } from '../../discordConfig/paths.js'
import { DiscordConfigSchema } from '../../discordConfig/schema.js'
import { parseJsonc, hasJsoncComments } from '../../utils/jsoncStore.js'

export async function checkDiscord(): Promise<{
  issues: Issue[]
  paths: Record<string, string>
}> {
  const issues: Issue[] = []
  const path = getDiscordConfigPath()
  const paths = { discord: path }

  if (!existsSync(path)) {
    issues.push({
      code: 'discord.missing',
      severity: 'warning',
      module: 'discord',
      path,
      summary: 'discord.jsonc 不存在',
      detail: '走 DEFAULT 設定（discord disabled）。--fix 會 seed 模板。',
      autoFixable: true,
    })
    return { issues, paths }
  }

  let raw: string
  try {
    raw = (await readFile(path, 'utf-8')).replace(/^﻿/, '')
  } catch (err) {
    issues.push({
      code: 'discord.read-failed',
      severity: 'error',
      module: 'discord',
      path,
      summary: `無法讀取：${err instanceof Error ? err.message : String(err)}`,
      autoFixable: false,
    })
    return { issues, paths }
  }

  let parsed: unknown
  try {
    parsed = parseJsonc(raw)
  } catch (err) {
    issues.push({
      code: 'discord.parse-failed',
      severity: 'error',
      module: 'discord',
      path,
      summary: 'JSONC 解析失敗',
      detail: err instanceof Error ? err.message : String(err),
      autoFixable: true,
    })
    return { issues, paths }
  }

  const validated = DiscordConfigSchema.safeParse(parsed)
  if (!validated.success) {
    issues.push({
      code: 'discord.schema-invalid',
      severity: 'error',
      module: 'discord',
      path,
      summary: 'Schema 驗證失敗',
      detail: validated.error.issues
        .slice(0, 5)
        .map(i => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('\n'),
      autoFixable: false,
    })
    return { issues, paths }
  }

  if (!hasJsoncComments(raw)) {
    issues.push({
      code: 'discord.strict-json',
      severity: 'warning',
      module: 'discord',
      path,
      summary: '檔案是 strict JSON（無註解）',
      detail: '--fix 會 migrate 到 JSONC（保留使用者值）。',
      autoFixable: true,
    })
  }

  const cfg = validated.data
  // bot token 在 jsonc 而非 env（安全建議）
  if (cfg.enabled && cfg.botToken && !process.env.DISCORD_BOT_TOKEN) {
    issues.push({
      code: 'discord.token-in-file',
      severity: 'info',
      module: 'discord',
      path,
      summary: 'discord botToken 寫在 jsonc 內',
      detail: '建議改用 env DISCORD_BOT_TOKEN（不會進 git）。',
      autoFixable: false,
    })
  }

  return { issues, paths }
}
