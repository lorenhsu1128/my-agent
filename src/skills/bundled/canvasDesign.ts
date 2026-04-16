import { registerBundledSkill } from '../bundledSkills.js'

// Lazy-load content and fonts (~7.2MB base64) only when skill is invoked.
let contentPromise:
  | Promise<typeof import('./canvasDesignContent.js')>
  | undefined

export function registerCanvasDesignSkill(): void {
  registerBundledSkill({
    name: 'canvas-design',
    description:
      'Create beautiful visual art in .png and .pdf documents using design philosophy. You should use this skill when the user asks to create a poster, piece of art, design, or other static piece. Create original visual designs, never copying existing artists\' work to avoid copyright violations.',
    userInvocable: true,
    // binaryFiles is set dynamically at invocation time to avoid loading
    // 7.2MB of base64 font data into memory at startup.
    async getPromptForCommand(args) {
      contentPromise ??= import('./canvasDesignContent.js')
      const content = await contentPromise

      // Register fonts as binaryFiles for on-demand extraction.
      // The registerBundledSkill wrapper handles extraction via the
      // binaryFiles property, but since we lazy-load, we handle it
      // manually here: check if fonts dir exists, extract if not.
      const { getBundledSkillExtractDir } = await import(
        '../bundledSkills.js'
      )
      const { existsSync } = await import('fs')
      const { join } = await import('path')
      const extractDir = getBundledSkillExtractDir('canvas-design')
      const fontsDir = join(extractDir, 'canvas-fonts')

      if (!existsSync(fontsDir)) {
        const { mkdir, writeFile } = await import('fs/promises')
        await mkdir(fontsDir, { recursive: true })
        const fonts = content.CANVAS_FONTS
        await Promise.all(
          Object.entries(fonts).map(async ([relPath, base64]) => {
            const target = join(extractDir, relPath)
            await writeFile(target, Buffer.from(base64, 'base64'))
          }),
        )
      }

      let prompt = `Base directory for this skill: ${extractDir}\n\n${content.SKILL_MD}`
      if (args) {
        prompt += `\n## User Request\n\n${args}`
      }
      return [{ type: 'text', text: prompt }]
    },
  })
}
