import { registerBundledSkill } from '../bundledSkills.js'

let contentPromise:
  | Promise<typeof import('./docxContent.js')>
  | undefined

export function registerDocxSkill(): void {
  registerBundledSkill({
    name: 'docx',
    description:
      'Use this skill whenever the user wants to create, read, edit, or manipulate Word documents (.docx files). Triggers include: any mention of "Word doc", "word document", ".docx", or requests to produce professional documents with formatting like tables of contents, headings, page numbers, or letterheads.',
    userInvocable: true,
    async getPromptForCommand(args) {
      contentPromise ??= import('./docxContent.js')
      const content = await contentPromise

      const { getBundledSkillExtractDir } = await import('../bundledSkills.js')
      const { existsSync } = await import('fs')
      const { mkdir, writeFile } = await import('fs/promises')
      const { join, dirname } = await import('path')

      const extractDir = getBundledSkillExtractDir('docx')
      const marker = join(extractDir, 'scripts', 'comment.py')
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
