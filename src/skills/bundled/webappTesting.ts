import { registerBundledSkill } from '../bundledSkills.js'

const SKILL_PROMPT = `# Web Application Testing

To test local web applications, write Playwright scripts (Python or TypeScript).

**Helper Scripts Available**:
- \`scripts/with-server.ts\` - Manages server lifecycle (supports multiple servers)

**Always run scripts with \`--help\` first** to see usage. DO NOT read the source until you try running the script first and find that a customized solution is absolutely necessary.

## Decision Tree: Choosing Your Approach

\`\`\`
User task → Is it static HTML?
    ├─ Yes → Read HTML file directly to identify selectors
    │         ├─ Success → Write Playwright script using selectors
    │         └─ Fails/Incomplete → Treat as dynamic (below)
    │
    └─ No (dynamic webapp) → Is the server already running?
        ├─ No → Run: bun scripts/with-server.ts --help
        │        Then use the helper + write simplified Playwright script
        │
        └─ Yes → Reconnaissance-then-action:
            1. Navigate and wait for networkidle
            2. Take screenshot or inspect DOM
            3. Identify selectors from rendered state
            4. Execute actions with discovered selectors
\`\`\`

## Example: Using with-server.ts

**Single server:**
\`\`\`bash
bun scripts/with-server.ts --server "npm run dev" --port 5173 -- python your_automation.py
\`\`\`

**Multiple servers (e.g., backend + frontend):**
\`\`\`bash
bun scripts/with-server.ts \\
  --server "cd backend && python server.py" --port 3000 \\
  --server "cd frontend && npm run dev" --port 5173 \\
  -- python test.py
\`\`\`

## Reconnaissance-Then-Action Pattern

1. **Inspect rendered DOM**:
   \`\`\`python
   page.screenshot(path='/tmp/inspect.png', full_page=True)
   content = page.content()
   page.locator('button').all()
   \`\`\`

2. **Identify selectors** from inspection results

3. **Execute actions** using discovered selectors

## Common Pitfall

- **Don't** inspect the DOM before waiting for \`networkidle\` on dynamic apps
- **Do** wait for \`page.wait_for_load_state('networkidle')\` before inspection

## Best Practices

- Use bundled scripts as black boxes — run with \`--help\`, then invoke directly
- Use \`sync_playwright()\` for synchronous scripts
- Always close the browser when done
- Use descriptive selectors: \`text=\`, \`role=\`, CSS selectors, or IDs
- Add appropriate waits: \`page.wait_for_selector()\` or \`page.wait_for_timeout()\`

## Reference Files

- **examples/** - Examples showing common Playwright patterns:
  - \`console_logging.py\` - Capturing console logs during automation
  - \`element_discovery.py\` - Discovering buttons, links, and inputs on a page
  - \`static_html_automation.py\` - Using file:// URLs for local HTML
`

// Lazy-load content only when skill is invoked
let contentPromise:
  | Promise<typeof import('./webappTestingContent.js')>
  | undefined

export function registerWebappTestingSkill(): void {
  registerBundledSkill({
    name: 'webapp-testing',
    description:
      'Toolkit for interacting with and testing local web applications using Playwright. Supports verifying frontend functionality, debugging UI behavior, capturing browser screenshots, and viewing browser logs.',
    userInvocable: true,
    async getPromptForCommand(args) {
      contentPromise ??= import('./webappTestingContent.js')
      const content = await contentPromise

      // Extract scripts and examples to disk on first invocation
      const { getBundledSkillExtractDir } = await import('../bundledSkills.js')
      const { existsSync } = await import('fs')
      const { mkdir, writeFile } = await import('fs/promises')
      const { join } = await import('path')

      const extractDir = getBundledSkillExtractDir('webapp-testing')
      const marker = join(extractDir, 'scripts', 'with-server.ts')
      if (!existsSync(marker)) {
        await mkdir(join(extractDir, 'scripts'), { recursive: true })
        await mkdir(join(extractDir, 'examples'), { recursive: true })
        await writeFile(
          join(extractDir, 'scripts', 'with-server.ts'),
          content.WITH_SERVER_SCRIPT,
          'utf8',
        )
        await writeFile(
          join(extractDir, 'examples', 'console_logging.py'),
          content.EXAMPLE_CONSOLE_LOGGING,
          'utf8',
        )
        await writeFile(
          join(extractDir, 'examples', 'element_discovery.py'),
          content.EXAMPLE_ELEMENT_DISCOVERY,
          'utf8',
        )
        await writeFile(
          join(extractDir, 'examples', 'static_html_automation.py'),
          content.EXAMPLE_STATIC_HTML,
          'utf8',
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
