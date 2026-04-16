import { registerBundledSkill } from '../bundledSkills.js'

const SKILL_PROMPT = `# Web Artifacts Builder

To build powerful frontend artifacts, follow these steps:
1. Initialize the frontend repo using \`scripts/init-artifact.sh\`
2. Develop your artifact by editing the generated code
3. Bundle all code into a single HTML file using \`scripts/bundle-artifact.sh\`
4. Display artifact to user
5. (Optional) Test the artifact

**Stack**: React 18 + TypeScript + Vite + Parcel (bundling) + Tailwind CSS + shadcn/ui

## Design & Style Guidelines

VERY IMPORTANT: To avoid what is often referred to as "AI slop", avoid using excessive centered layouts, purple gradients, uniform rounded corners, and Inter font.

## Quick Start

### Step 1: Initialize Project

Run the initialization script to create a new React project:
\`\`\`bash
bash scripts/init-artifact.sh <project-name>
cd <project-name>
\`\`\`

This creates a fully configured project with:
- React + TypeScript (via Vite)
- Tailwind CSS 3.4.1 with shadcn/ui theming system
- Path aliases (\`@/\`) configured
- 40+ shadcn/ui components pre-installed
- All Radix UI dependencies included
- Parcel configured for bundling (via .parcelrc)
- Node 18+ compatibility (auto-detects and pins Vite version)

### Step 2: Develop Your Artifact

Edit the generated files. The project structure follows standard Vite conventions.

### Step 3: Bundle to Single HTML File

\`\`\`bash
bash scripts/bundle-artifact.sh
\`\`\`

Creates \`bundle.html\` — a self-contained artifact with all JavaScript, CSS, and dependencies inlined.

**Requirements**: Your project must have an \`index.html\` in the root directory.

### Step 4: Share Artifact

Share the bundled HTML file with the user.

### Step 5: Testing (Optional)

Test later, after presenting the artifact, if requested or if issues arise.

## Reference

- **shadcn/ui components**: https://ui.shadcn.com/docs/components
`

// Lazy-load script content (~40KB) only when invoked.
let contentPromise:
  | Promise<typeof import('./webArtifactsBuilderContent.js')>
  | undefined

export function registerWebArtifactsBuilderSkill(): void {
  registerBundledSkill({
    name: 'web-artifacts-builder',
    description:
      'Suite of tools for creating elaborate, multi-component HTML artifacts using modern frontend web technologies (React, Tailwind CSS, shadcn/ui). Use for complex artifacts requiring state management, routing, or shadcn/ui components - not for simple single-file HTML/JSX artifacts.',
    userInvocable: true,
    async getPromptForCommand(args) {
      contentPromise ??= import('./webArtifactsBuilderContent.js')
      const content = await contentPromise

      // Extract scripts to disk on first invocation
      const { getBundledSkillExtractDir } = await import('../bundledSkills.js')
      const { existsSync } = await import('fs')
      const { mkdir, writeFile } = await import('fs/promises')
      const { join, dirname } = await import('path')

      const extractDir = getBundledSkillExtractDir('web-artifacts-builder')
      const marker = join(extractDir, 'scripts', 'init-artifact.sh')
      if (!existsSync(marker)) {
        const scriptsDir = join(extractDir, 'scripts')
        await mkdir(scriptsDir, { recursive: true })
        await writeFile(
          join(scriptsDir, 'init-artifact.sh'),
          content.INIT_SCRIPT,
          'utf8',
        )
        await writeFile(
          join(scriptsDir, 'bundle-artifact.sh'),
          content.BUNDLE_SCRIPT,
          'utf8',
        )
        await writeFile(
          join(scriptsDir, 'shadcn-components.tar.gz'),
          Buffer.from(content.SHADCN_TAR_B64, 'base64'),
        )
      }

      let prompt = `Base directory for this skill: ${extractDir}\n\n${SKILL_PROMPT}`
      if (args) {
        prompt += `\n## User Request\n\n${args}`
      }
      return [{ type: 'text', text: prompt }]
    },
  })
}
