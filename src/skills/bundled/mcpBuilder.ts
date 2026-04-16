import { registerBundledSkill } from '../bundledSkills.js'

let contentPromise:
  | Promise<typeof import('./mcpBuilderContent.js')>
  | undefined

export function registerMcpBuilderSkill(): void {
  registerBundledSkill({
    name: 'mcp-builder',
    description:
      'Guide for creating high-quality MCP (Model Context Protocol) servers that enable LLMs to interact with external services through well-designed tools. Use when building MCP servers to integrate external APIs or services, whether in Python (FastMCP) or Node/TypeScript (MCP SDK).',
    userInvocable: true,
    async getPromptForCommand(args) {
      contentPromise ??= import('./mcpBuilderContent.js')
      const content = await contentPromise

      // Extract reference files and scripts to disk
      const { getBundledSkillExtractDir } = await import('../bundledSkills.js')
      const { existsSync } = await import('fs')
      const { mkdir, writeFile } = await import('fs/promises')
      const { join, dirname } = await import('path')

      const extractDir = getBundledSkillExtractDir('mcp-builder')
      const marker = join(extractDir, 'reference', 'evaluation.md')
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
