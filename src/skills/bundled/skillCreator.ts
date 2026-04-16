import { registerBundledSkill } from '../bundledSkills.js'

let contentPromise:
  | Promise<typeof import('./skillCreatorContent.js')>
  | undefined

export function registerSkillCreatorSkill(): void {
  registerBundledSkill({
    name: 'skill-creator',
    description:
      'Create new skills, modify and improve existing skills, and measure skill performance. Use when users want to create a skill from scratch, edit, or optimize an existing skill, run evals to test a skill, benchmark skill performance with variance analysis, or optimize a skill\'s description for better triggering accuracy.',
    userInvocable: true,
    async getPromptForCommand(args) {
      contentPromise ??= import('./skillCreatorContent.js')
      const content = await contentPromise

      const { getBundledSkillExtractDir } = await import('../bundledSkills.js')
      const { existsSync } = await import('fs')
      const { mkdir, writeFile } = await import('fs/promises')
      const { join, dirname } = await import('path')

      const extractDir = getBundledSkillExtractDir('skill-creator')
      const marker = join(extractDir, 'scripts', 'run_eval.py')
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
