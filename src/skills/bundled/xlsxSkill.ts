import { registerBundledSkill } from '../bundledSkills.js'

let contentPromise:
  | Promise<typeof import('./xlsxContent.js')>
  | undefined

export function registerXlsxSkill(): void {
  registerBundledSkill({
    name: 'xlsx',
    description:
      'Use this skill any time a spreadsheet file is the primary input or output. This means any task where the user wants to: open, read, edit, or fix an existing .xlsx, .xlsm, .csv, or .tsv file; create a new spreadsheet from scratch or from other data sources; or convert between tabular file formats.',
    userInvocable: true,
    async getPromptForCommand(args) {
      contentPromise ??= import('./xlsxContent.js')
      const content = await contentPromise

      const { getBundledSkillExtractDir } = await import('../bundledSkills.js')
      const { existsSync } = await import('fs')
      const { mkdir, writeFile } = await import('fs/promises')
      const { join, dirname } = await import('path')

      const extractDir = getBundledSkillExtractDir('xlsx')
      const marker = join(extractDir, 'scripts', 'recalc.py')
      if (!existsSync(marker)) {
        for (const [relPath, text] of Object.entries(
          content.REFERENCE_FILES,
        )) {
          const target = join(extractDir, relPath)
          await mkdir(dirname(target), { recursive: true })
          await writeFile(target, text, 'utf8')
        }
      }

      let prompt = `Base directory for this skill: ${extractDir}\n\n${content.SKILL_PROMPT}`
      if (args) {
        prompt += `\n## User Request\n\n${args}`
      }
      return [{ type: 'text', text: prompt }]
    },
  })
}
