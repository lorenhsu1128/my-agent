/**
 * .my-agent.jsonc（global config）健康檢查（M-CONFIG-DOCTOR）。
 *
 * GlobalConfig 沒走 zod，型別由 src/utils/config.ts:184 GlobalConfig type 定義。
 * 此檢查只能做：JSONC parse / 註解保留 / 模板新欄位偵測。
 */
import { existsSync } from 'fs'
import { readFile } from 'fs/promises'
import type { Issue } from '../types.js'
import { getGlobalClaudeFile } from '../../utils/env.js'
import { parseJsonc, hasJsoncComments } from '../../utils/jsoncStore.js'
import { GLOBAL_CONFIG_JSONC_TEMPLATE } from '../../globalConfig/bundledTemplate.js'

export async function checkGlobal(): Promise<{
  issues: Issue[]
  paths: Record<string, string>
}> {
  const issues: Issue[] = []
  const path = getGlobalClaudeFile()
  const paths = { global: path }

  if (!existsSync(path)) {
    issues.push({
      code: 'global.missing',
      severity: 'error',
      module: 'global',
      path,
      summary: '.my-agent.jsonc 不存在',
      detail: 'main.tsx 啟動時會自動 seed；若仍缺檔表示 seed 失敗（權限？）',
      autoFixable: true,
    })
    return { issues, paths }
  }

  let raw: string
  try {
    raw = (await readFile(path, 'utf-8')).replace(/^﻿/, '')
  } catch (err) {
    issues.push({
      code: 'global.read-failed',
      severity: 'error',
      module: 'global',
      path,
      summary: `無法讀取：${err instanceof Error ? err.message : String(err)}`,
      autoFixable: false,
    })
    return { issues, paths }
  }

  let parsed: Record<string, unknown>
  try {
    parsed = parseJsonc<Record<string, unknown>>(raw)
  } catch (err) {
    issues.push({
      code: 'global.parse-failed',
      severity: 'error',
      module: 'global',
      path,
      summary: 'JSONC 解析失敗',
      detail: err instanceof Error ? err.message : String(err),
      autoFixable: false, // 不自動 fix（內含使用者重要狀態，例如 OAuth token）
    })
    return { issues, paths }
  }

  if (!hasJsoncComments(raw)) {
    issues.push({
      code: 'global.strict-json',
      severity: 'warning',
      module: 'global',
      path,
      summary: '.my-agent.jsonc 是 strict JSON（無註解）',
      detail:
        '--rewrite-with-docs 會套最新模板（保留使用者值，補回註解）。',
      autoFixable: false, // 不在 --fix 範圍，需要 --rewrite-with-docs 才會改
    })
  }

  // 模板新欄位偵測
  try {
    const templateKeys = Object.keys(parseJsonc<Record<string, unknown>>(GLOBAL_CONFIG_JSONC_TEMPLATE))
    const userKeys = new Set(Object.keys(parsed))
    const missingFromUser = templateKeys.filter(k => !userKeys.has(k))
    if (missingFromUser.length > 0 && missingFromUser.length < 30) {
      issues.push({
        code: 'global.template-new-fields',
        severity: 'info',
        module: 'global',
        path,
        summary: `模板有 ${missingFromUser.length} 個欄位使用者檔沒有`,
        detail:
          `(${missingFromUser.slice(0, 8).join(', ')}${missingFromUser.length > 8 ? ', ...' : ''})\n` +
          '通常是 schema 加新欄位後的正常情況；--rewrite-with-docs 會補回（保留使用者值）。',
        autoFixable: false,
      })
    }
  } catch {
    // 模板自己壞了不應該發生，silent
  }

  return { issues, paths }
}
