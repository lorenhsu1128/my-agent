/**
 * 格式化 doctor 結果（M-CONFIG-DOCTOR）。
 *
 * 兩種輸出：
 *   - plain：人類閱讀，依嚴重度分組 + 顏色（chalk）
 *   - json：CI / 自動化，結構化 issue 列表
 */
import chalk from 'chalk'
import type { DoctorResult, FixResult, Issue } from './types.js'

const SEVERITY_ORDER: Issue['severity'][] = ['error', 'warning', 'info']

const SEVERITY_LABEL: Record<Issue['severity'], string> = {
  error: 'ERROR',
  warning: 'WARN ',
  info: 'INFO ',
}

function colorize(severity: Issue['severity'], text: string): string {
  switch (severity) {
    case 'error':
      return chalk.red(text)
    case 'warning':
      return chalk.yellow(text)
    case 'info':
      return chalk.gray(text)
  }
}

export function formatReport(
  result: DoctorResult & { fixResult?: FixResult },
  json = false,
): string {
  if (json) {
    return JSON.stringify(
      {
        issues: result.issues,
        modulePaths: result.modulePaths,
        durationMs: result.durationMs,
        fixResult: result.fixResult,
      },
      null,
      2,
    )
  }

  const lines: string[] = []
  lines.push(chalk.bold('Config Doctor 報告'))
  lines.push('')

  // 模組路徑
  lines.push(chalk.dim('模組載入路徑：'))
  for (const [m, p] of Object.entries(result.modulePaths)) {
    lines.push(chalk.dim(`  ${m.padEnd(14)} ${p}`))
  }
  lines.push('')

  // Issue summary
  const counts = { error: 0, warning: 0, info: 0 }
  for (const i of result.issues) counts[i.severity]++
  const summary =
    `${chalk.red(counts.error + ' error')}, ` +
    `${chalk.yellow(counts.warning + ' warning')}, ` +
    `${chalk.gray(counts.info + ' info')} ` +
    chalk.dim(`(check 耗時 ${result.durationMs}ms)`)
  lines.push('狀態: ' + summary)
  lines.push('')

  if (result.issues.length === 0) {
    lines.push(chalk.green('  ✓ 全綠'))
  } else {
    for (const sev of SEVERITY_ORDER) {
      const subset = result.issues.filter(i => i.severity === sev)
      if (subset.length === 0) continue
      for (const issue of subset) {
        lines.push(
          colorize(sev, `[${SEVERITY_LABEL[sev]}] ${issue.code}`) +
            chalk.dim(` (${issue.module})`),
        )
        lines.push('  ' + issue.summary)
        if (issue.detail) {
          for (const dl of issue.detail.split('\n')) {
            lines.push(chalk.dim('    ' + dl))
          }
        }
        if (issue.path) lines.push(chalk.dim('    path: ' + issue.path))
        if (issue.autoFixable) {
          lines.push(chalk.green('    ✓ 可由 --fix 自動修復'))
        }
        lines.push('')
      }
    }
  }

  // Fix 結果
  if (result.fixResult) {
    lines.push(chalk.bold('--fix 執行結果'))
    lines.push(
      '  fixed: ' + chalk.green(result.fixResult.fixed.length.toString()) +
        '  remaining: ' +
        chalk.yellow(result.fixResult.remaining.length.toString()),
    )
    if (result.fixResult.fixed.length > 0) {
      lines.push(chalk.dim('  fixed 項：'))
      for (const c of result.fixResult.fixed) lines.push(chalk.dim('    - ' + c))
    }
    if (result.fixResult.remaining.length > 0) {
      lines.push(chalk.dim('  remaining（需手動處理）：'))
      for (const c of result.fixResult.remaining) lines.push(chalk.dim('    - ' + c))
    }
    if (result.fixResult.sideEffects.length > 0) {
      lines.push(chalk.dim('  side effects：'))
      for (const s of result.fixResult.sideEffects) lines.push(chalk.dim('    - ' + s))
    }
  }

  return lines.join('\n')
}
