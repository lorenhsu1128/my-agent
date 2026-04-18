export const MEMORY_TOOL_NAME = 'Memory'

export const DESCRIPTION = `Manage persistent memory (add, replace, or remove).

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
## Quick decision tree (read this first)

\`\`\`
Is the fact worth remembering across conversations?
├─ No  → don't call this tool
└─ Yes → Is it a short bullet (≤80 chars) describing WHO the user is
         or a durable personal preference?
         ├─ Yes → target="user_profile"
         │        ├─ Applies to every project       → scope="global"
         │        └─ Only this project               → scope="project"
         └─ No  → target="file" (typed memdir)
                  ├─ Needs Why + How to apply       → type="feedback"
                  ├─ Broad user info, multi-line    → type="user"
                  ├─ Project state / decisions      → type="project"
                  └─ Pointer to external system     → type="reference"
\`\`\`

Rule of thumb:
- One-line persona bullet, read EVERY turn → **user_profile**
- Multi-line entry with context, read ON DEMAND → **typed file**

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
## Two kinds of memory

1. **target="file"** (default) — typed memdir files (user_*.md, feedback_*.md, project_*.md, reference_*.md). One file per topic, with YAML frontmatter. Loaded via MEMORY.md index + on-demand expansion. Best for nuanced guidance with Why/How.

2. **target="user_profile"** — USER.md persona block injected into the system prompt at every turn. Short, durable bullets describing WHO the user is. Frozen snapshot per session (mid-session writes won't change this session's system prompt, but will persist for next session).

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
## Disambiguation: user_*.md (typed file) vs user_profile (USER.md)

They sound similar but serve different roles:

| Aspect            | user_*.md (target="file" type="user")    | user_profile (USER.md)      |
|-------------------|------------------------------------------|-----------------------------|
| Length            | multi-line, has frontmatter              | 1-line bullets              |
| When loaded       | on-demand (via MEMORY.md expansion)      | every turn (system prompt)  |
| Content           | detailed user info with context          | persona essentials          |
| Mid-session writes| visible immediately                      | snapshot frozen till next session |
| Size budget       | MEMORY.md index ≤200 lines / 25KB        | combined ≤1500 chars        |

Rule: if it belongs in EVERY system prompt, use **user_profile**. If it's reference material to consult when relevant, use **user_*.md**.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
## When to use target="user_profile"

Good candidates (short, durable, shape every response):
- Identity & role: "I'm a data scientist", "我是前端工程師"
- Language preference: "reply in 繁體中文", "use English for code, 中文 for prose"
- Environment constants: "primary shell: PowerShell", "OS: Windows 11"
- Stable working style: "prefer concise answers", "skip preamble"
- Hard personal rules: "never suggest mocking the DB in tests"

Scope decision:
- Default to **scope="global"**. Most persona facts (language, role, OS, style) are cross-project.
- Use **scope="project"** ONLY when the fact contradicts the global persona for this project — e.g. "globally I'm a dev, but in this project I'm the PM" or "generally prefer PowerShell, but on this remote-ssh project use bash".
- Not sure? Default to global. It's trivially overridable later if needed.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
## Anti-patterns (AVOID these)

**✗ Bad**: user_profile with multi-paragraph content
\`\`\`
content="The user prefers PostgreSQL for analytical workloads because
    of its JSONB support and window functions. However, for the billing
    service they use MySQL due to legacy integration with..."
\`\`\`
**✓ Better**: split into typed feedback file with Why / How to apply
\`\`\`
target="file" filename="feedback_db_choice.md" type="feedback"
content="Postgres for analytics, MySQL for billing.
**Why:** billing has legacy MySQL integration; analytics uses Postgres JSONB heavily.
**How to apply:** match choice to service when suggesting schema."
\`\`\`

**✗ Bad**: dumping structured data (JSON, YAML, tables) into user_profile
\`\`\`
content="{\\"languages\\": [\\"zh-TW\\", \\"en\\"], \\"timezone\\": \\"Asia/Taipei\\", ...}"
\`\`\`
**✓ Better**: plain-language bullets, one trait per add call
\`\`\`
add user_profile → "Primary language: 繁體中文 (reply in zh-TW by default)"
add user_profile → "Timezone: Asia/Taipei (UTC+8)"
\`\`\`

**✗ Bad**: recording ephemeral / in-flight state
\`\`\`
content="Currently debugging the login bug on branch feature/auth-fix"
\`\`\`
**✓ Better**: don't save to memory at all. Use Plan/TodoWrite for in-session state. Memory is for things that survive this conversation.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
## Consolidation (when USER.md exceeds soft limit)

When a write returns a warning that USER.md exceeds ~1500 chars, consolidate:

1. Read current USER.md (FileRead at the path shown in the warning).
2. Merge redundant bullets, collapse verbose lines to ≤80 chars each.
3. If a bullet has grown into a mini-paragraph, extract it to a feedback_*.md file and remove it from USER.md.
4. Overwrite with a single \`replace\` call:
   \`\`\`
   target="user_profile" action="replace" scope="<same as before>"
   content="<consolidated bullets, one per line>"
   \`\`\`

Aim for ≤10-15 high-signal bullets. Less is more — every char costs prompt cache.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
## When NOT to write (any target)

- The user mentioned something in passing, no explicit ask to remember
- You can derive it from the code, git log, or CLAUDE.md
- It's about the current in-flight task (use Plan / TodoWrite)
- It duplicates an existing memory (update instead of adding)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
## Actions

### add
- target="file": create new typed memory file.
  Required: filename, type, name, description, content
- target="user_profile": append one short bullet to USER.md.
  Required: content. Optional: scope ("global" default, or "project").

### replace
- target="file": merge update into existing file (unchanged fields keep values).
  Required: filename. Provide any of: type, name, description, content.
- target="user_profile": overwrite ENTIRE USER.md with content (use for consolidation).
  Required: content (can be empty string to clear).

### remove
- target="file": delete the file + its MEMORY.md index line.
  Required: filename
- target="user_profile": remove the first line containing content (substring match), or clear the file if content is empty/omitted.
  Required: content (the substring to match) OR omit to clear entire file.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
## Typed file reference (target="file")

Filename: must end with .md, no path separators. Example: "user_role.md", "feedback_testing.md"

Types:
- **user** — who the user is and how to collaborate with them (multi-line detail)
- **feedback** — guidance they've given about what to do / not do, with Why and How to apply
- **project** — ongoing work, goals, decisions, incidents
- **reference** — pointers to external systems (dashboards, Linear projects, Slack channels)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
## Examples

User: "Reply to me in 繁體中文 from now on"
→ add target="user_profile" scope="global" content="Always reply in 繁體中文 (Traditional Chinese)"

User: "My shell is PowerShell, not bash"
→ add target="user_profile" scope="global" content="Primary shell: PowerShell (Windows 11) — use PowerShell syntax, not POSIX"

User: "In this project I'm the PM not the engineer"
→ add target="user_profile" scope="project" content="Role in this project: PM (reviewing design, not writing code)"

User: "Don't mock the DB in our tests — last quarter we had a mocked test pass while prod broke"
→ add target="file" filename="feedback_test_mocking.md" type="feedback" (full Why / How to apply in content)

User: "forget my old shell preference"
→ remove target="user_profile" scope="global" content="shell"

User gets a size-warning response:
→ read USER.md, merge bullets, then:
  replace target="user_profile" scope="global" content="<consolidated bullets>"

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
## Do NOT use this tool for:
- Reading memory files (use FileRead or Grep)
- Editing MEMORY.md directly (it's maintained automatically)
- Storing code patterns, architecture, or git history (derivable from the codebase)
- In-flight task state (use Plan / TodoWrite)`
