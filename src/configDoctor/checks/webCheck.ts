/**
 * web.jsonc 健康檢查（M-CONFIG-DOCTOR）。
 */
import { existsSync } from 'fs'
import { readFile } from 'fs/promises'
import type { Issue } from '../types.js'
import { getWebConfigPath } from '../../webConfig/paths.js'
import { WebConfigSchema } from '../../webConfig/schema.js'
import { parseJsonc, hasJsoncComments } from '../../utils/jsoncStore.js'

export async function checkWeb(): Promise<{
  issues: Issue[]
  paths: Record<string, string>
}> {
  const issues: Issue[] = []
  const path = getWebConfigPath()
  const paths = { web: path }

  if (!existsSync(path)) {
    issues.push({
      code: 'web.missing',
      severity: 'warning',
      module: 'web',
      path,
      summary: 'web.jsonc 不存在',
      detail: '走 DEFAULT 設定（web disabled）。--fix 會 seed 模板。',
      autoFixable: true,
    })
    return { issues, paths }
  }

  let raw: string
  try {
    raw = (await readFile(path, 'utf-8')).replace(/^﻿/, '')
  } catch (err) {
    issues.push({
      code: 'web.read-failed',
      severity: 'error',
      module: 'web',
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
      code: 'web.parse-failed',
      severity: 'error',
      module: 'web',
      path,
      summary: 'JSONC 解析失敗',
      detail: err instanceof Error ? err.message : String(err),
      autoFixable: true,
    })
    return { issues, paths }
  }

  const validated = WebConfigSchema.safeParse(parsed)
  if (!validated.success) {
    issues.push({
      code: 'web.schema-invalid',
      severity: 'error',
      module: 'web',
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
      code: 'web.strict-json',
      severity: 'warning',
      module: 'web',
      path,
      summary: '檔案是 strict JSON（無註解）',
      detail: '--fix 會 migrate 到 JSONC（保留使用者值）。',
      autoFixable: true,
    })
  }

  const cfg = validated.data
  // 0.0.0.0 安全提醒
  if (cfg.enabled && cfg.bindHost === '0.0.0.0') {
    issues.push({
      code: 'web.exposed-bind',
      severity: 'warning',
      module: 'web',
      path,
      summary: 'web bindHost=0.0.0.0 但無認證',
      detail: 'LAN 內任何人能控制 my-agent。建議改 127.0.0.1 或等 M-WEB-AUTH。',
      autoFixable: false,
    })
  }

  // env override
  if (process.env.MYAGENT_WEB_CONFIG_PATH) {
    issues.push({
      code: 'web.env-override',
      severity: 'info',
      module: 'web',
      summary: `env MYAGENT_WEB_CONFIG_PATH 覆蓋了 path`,
      autoFixable: false,
    })
  }

  return { issues, paths }
}
