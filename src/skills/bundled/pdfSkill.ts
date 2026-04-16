import { registerBundledSkill } from '../bundledSkills.js'

let contentPromise:
  | Promise<typeof import('./pdfContent.js')>
  | undefined

export function registerPdfSkill(): void {
  registerBundledSkill({
    name: 'pdf',
    description:
      'Use this skill whenever the user wants to do anything with PDF files. This includes reading or extracting text/tables from PDFs, combining or merging multiple PDFs into one, splitting PDFs apart, rotating pages, adding watermarks, creating new PDFs, filling PDF forms, encrypting/decrypting PDFs, extracting images, and OCR on scanned PDFs.',
    userInvocable: true,
    async getPromptForCommand(args) {
      contentPromise ??= import('./pdfContent.js')
      const content = await contentPromise

      const { getBundledSkillExtractDir } = await import('../bundledSkills.js')
      const { existsSync } = await import('fs')
      const { mkdir, writeFile } = await import('fs/promises')
      const { join, dirname } = await import('path')

      const extractDir = getBundledSkillExtractDir('pdf')
      const marker = join(extractDir, 'scripts', 'check_fillable_fields.py')
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
