/**
 * system-prompt/ 目錄健康檢查（M-CONFIG-DOCTOR）。
 *
 * 檢查項目：
 *   - 目錄存在（缺 → ERROR autofix）
 *   - README.md 存在（缺 → WARNING autofix，會走 seed 補檔 P3 修復）
 *   - 各 externalized section 檔存在（缺 → WARNING autofix）
 */
import { existsSync } from 'fs'
import type { Issue } from '../types.js'
import {
  getSystemPromptGlobalDir,
  getSystemPromptGlobalFile,
} from '../../systemPromptFiles/paths.js'
import { SECTIONS } from '../../systemPromptFiles/sections.js'
import { BUNDLED_DEFAULTS } from '../../systemPromptFiles/bundledDefaults.js'

export async function checkSystemPrompt(): Promise<{
  issues: Issue[]
  paths: Record<string, string>
}> {
  const issues: Issue[] = []
  const dir = getSystemPromptGlobalDir()
  const paths = { systemPrompt: dir }

  if (!existsSync(dir)) {
    issues.push({
      code: 'systemPrompt.dir-missing',
      severity: 'error',
      module: 'systemPrompt',
      path: dir,
      summary: 'system-prompt/ 目錄不存在',
      detail: '會走 bundled fallback。--fix 會 mkdir + seed 全部 section。',
      autoFixable: true,
    })
    return { issues, paths }
  }

  const readme = getSystemPromptGlobalFile('README.md')
  if (!existsSync(readme)) {
    issues.push({
      code: 'systemPrompt.readme-missing',
      severity: 'warning',
      module: 'systemPrompt',
      path: readme,
      summary: 'system-prompt/README.md 不存在',
      detail: '--fix 會走 seed 補檔（P3 行為）。',
      autoFixable: true,
    })
  }

  const missingSections: string[] = []
  for (const section of SECTIONS) {
    if (!section.externalized) continue
    if (BUNDLED_DEFAULTS[section.id] == null) continue
    const target = getSystemPromptGlobalFile(section.filename)
    if (!existsSync(target)) {
      missingSections.push(section.filename)
    }
  }

  if (missingSections.length > 0) {
    issues.push({
      code: 'systemPrompt.sections-missing',
      severity: 'warning',
      module: 'systemPrompt',
      summary: `${missingSections.length} 個 section 檔缺失`,
      detail:
        `(${missingSections.slice(0, 5).join(', ')}${missingSections.length > 5 ? ', ...' : ''})\n` +
        '走 bundled fallback。--fix 會 seed 補檔。',
      autoFixable: true,
      fixHint: { missingSections },
    })
  }

  return { issues, paths }
}
