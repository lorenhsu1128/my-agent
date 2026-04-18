export const MEMORY_TOOL_NAME = 'Memory'

export const DESCRIPTION = `Manage persistent memory (add, replace, or remove).

This tool writes to two kinds of memory:

1. **target="file"** (default) — typed memdir files (user_*.md, feedback_*.md, project_*.md, reference_*.md). One file per topic, with YAML frontmatter. Best for nuanced guidance with a "why" explanation.
2. **target="user_profile"** — USER.md persona block injected into the system prompt at every turn. Short, durable bullets describing WHO the user is. Kept stable across sessions (frozen snapshot per session).

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
## When to use target="user_profile"

Write to user_profile when you learn a **short, durable fact about the user** that should shape every future response. The block is injected into the system prompt each turn, so keep entries terse (1-line bullets).

Good candidates:
- Identity & role: "I'm a data scientist", "我是前端工程師"
- Language preference: "reply in 繁體中文", "use English for code, 中文 for prose"
- Environment constants: "primary shell: PowerShell", "OS: Windows 11"
- Stable working style: "prefer concise answers", "skip preamble"
- Hard personal rules: "never suggest mocking the DB in tests"

Scope:
- **scope="global"** (default) — cross-project traits (language, role, OS, communication style). Stored at ~/.my-agent/USER.md.
- **scope="project"** — project-specific persona overrides (e.g. "in this project I'm the PM, not the dev"). Stored per-project.

Size budget: keep combined USER.md under ~1500 chars. When it grows past the limit, consolidate or move detail into feedback_*.md files.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
## When to use target="file" (typed memdir) instead

Prefer a typed file when the memory needs a **Why** and **How to apply**, or when it's too long for a 1-line persona bullet. Typed files are loaded on-demand (MEMORY.md index + expansion), so they can be verbose.

Examples that belong in feedback_*.md, not user_profile:
- "Don't mock DB in integration tests — Why: prior incident where mocked tests passed but prod migration failed. How to apply: always use a real test DB container for migration-touching tests."
- Multi-paragraph architectural preferences
- Rules with edge cases and exceptions

Rule of thumb:
- Fits in one short bullet + applies to every conversation → **user_profile**
- Needs explanation, context, or scoped conditions → **feedback_*.md file**
- One-off project fact → **project_*.md file**
- External resource pointer → **reference_*.md file**

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
## Deciding when NOT to write

Do not write to memory just because the user mentioned something in passing. Save when ANY of these apply:
- The user explicitly asks ("remember this", "記住…", "從現在開始…")
- The user corrects you with a durable rule (not a one-off)
- You observe a stable preference that will shape future turns
- You learn a fact that survives after this conversation ends

Do NOT save:
- Code patterns, architecture, file paths (derivable from the code)
- Git history or who-changed-what (git log is authoritative)
- Current-task state or in-flight work (use TodoWrite)
- Things already in CLAUDE.md or MEMORY.md

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
- **user** — who the user is and how to collaborate with them
- **feedback** — guidance they've given about what to do / not do, with Why and How to apply
- **project** — ongoing work, goals, decisions, incidents
- **reference** — pointers to external systems (dashboards, Linear projects, Slack channels)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
## Examples

User says: "Reply to me in 繁體中文 from now on"
→ \`add\` target="user_profile" scope="global" content="Always reply in 繁體中文 (Traditional Chinese)"

User says: "My shell is PowerShell, not bash"
→ \`add\` target="user_profile" scope="global" content="Primary shell: PowerShell (Windows 11) — use PowerShell syntax, not POSIX"

User says: "Don't mock the DB in our tests — last quarter we had a mocked test pass while prod broke"
→ \`add\` target="file" filename="feedback_test_mocking.md" type="feedback" (with full Why / How to apply in content)

User says: "In this project I'm the PM not the engineer"
→ \`add\` target="user_profile" scope="project" content="Role in this project: PM (reviewing design, not writing code)"

User says: "forget my old shell preference"
→ \`remove\` target="user_profile" scope="global" content="shell"

Do NOT use this tool for:
- Reading memory files (use FileRead or Grep)
- Editing MEMORY.md directly (it's maintained automatically)
- Storing code patterns, architecture, or git history`
