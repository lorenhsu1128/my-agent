/**
 * Config doctor 主入口（M-CONFIG-DOCTOR）。
 *
 * 對外 API：
 *   - runConfigDoctor({ mode: 'check' })：純讀，列 issue
 *   - runConfigDoctor({ mode: 'fix' })：跑 check + 自動修可修的
 *   - runConfigDoctor({ mode: 'rewrite-with-docs' })：強制套模板（保留使用者值）
 *
 * 為 session start 自動 check 設計：< 50ms 完成所有 check（純檔案讀 + schema validate）。
 */
import type {
  DoctorMode,
  DoctorResult,
  DoctorRunOptions,
  FixResult,
  Issue,
} from './types.js'
import { checkLlamaCpp } from './checks/llamacppCheck.js'
import { checkWeb } from './checks/webCheck.js'
import { checkDiscord } from './checks/discordCheck.js'
import { checkGlobal } from './checks/globalCheck.js'
import { checkSystemPrompt } from './checks/systemPromptCheck.js'
import { applyFixes } from './fixers/index.js'

export type { DoctorMode, DoctorResult, FixResult, Issue, IssueSeverity } from './types.js'
export { formatReport } from './report.js'

export async function runConfigDoctor(
  opts: DoctorRunOptions = { mode: 'check' },
): Promise<DoctorResult & { fixResult?: FixResult }> {
  const start = Date.now()
  const allIssues: Issue[] = []
  const modulePaths: Record<string, string> = {}

  const checkers = [
    checkLlamaCpp,
    checkWeb,
    checkDiscord,
    checkGlobal,
    checkSystemPrompt,
  ]
  for (const ck of checkers) {
    if (opts.onlyModule) {
      // skip if check is for different module（簡單 heuristic：name match）
      const m = ck.name.toLowerCase()
      if (!m.includes(opts.onlyModule.toLowerCase())) continue
    }
    const r = await ck()
    allIssues.push(...r.issues)
    Object.assign(modulePaths, r.paths)
  }

  const result: DoctorResult & { fixResult?: FixResult } = {
    issues: allIssues,
    modulePaths,
    durationMs: Date.now() - start,
  }

  if (opts.mode === 'fix' || opts.mode === 'rewrite-with-docs') {
    result.fixResult = await applyFixes(allIssues, opts.mode)
  }

  return result
}

export function hasErrors(result: DoctorResult): boolean {
  return result.issues.some(i => i.severity === 'error')
}

export function hasWarnings(result: DoctorResult): boolean {
  return result.issues.some(i => i.severity === 'warning')
}
