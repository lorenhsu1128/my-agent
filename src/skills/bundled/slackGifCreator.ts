import { registerBundledSkill } from '../bundledSkills.js'

let contentPromise:
  | Promise<typeof import('./slackGifCreatorContent.js')>
  | undefined

export function registerSlackGifCreatorSkill(): void {
  registerBundledSkill({
    name: 'slack-gif-creator',
    description:
      'Knowledge and utilities for creating animated GIFs optimized for Slack. Provides constraints, validation tools, and animation concepts. Use when users request animated GIFs for Slack like "make me a GIF of X doing Y for Slack."',
    userInvocable: true,
    async getPromptForCommand(args) {
      contentPromise ??= import('./slackGifCreatorContent.js')
      const content = await contentPromise

      const { getBundledSkillExtractDir } = await import('../bundledSkills.js')
      const { existsSync } = await import('fs')
      const { mkdir, writeFile } = await import('fs/promises')
      const { join, dirname } = await import('path')

      const extractDir = getBundledSkillExtractDir('slack-gif-creator')
      const marker = join(extractDir, 'core', 'gif_builder.py')
      if (!existsSync(marker)) {
        for (const [relPath, text] of Object.entries(content.SCRIPT_FILES)) {
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
