import { registerBundledSkill } from '../bundledSkills.js'

// Template files are extracted to disk on first invocation so the model can Read them.
// Lazy-loaded to avoid pulling ~50KB into memory at startup.
let contentPromise: Promise<typeof import('./algorithmicArtContent.js')> | undefined

export function registerAlgorithmicArtSkill(): void {
  registerBundledSkill({
    name: 'algorithmic-art',
    description:
      'Creating algorithmic art using p5.js with seeded randomness and interactive parameter exploration. Use this when users request creating art using code, generative art, algorithmic art, flow fields, or particle systems. Create original algorithmic art rather than copying existing artists\' work to avoid copyright violations.',
    userInvocable: true,
    async getPromptForCommand(args) {
      contentPromise ??= import('./algorithmicArtContent.js')
      const content = await contentPromise
      let prompt = content.SKILL_MD
      if (args) {
        prompt += `\n## User Request\n\n${args}`
      }
      return [{ type: 'text', text: prompt }]
    },
  })
}
