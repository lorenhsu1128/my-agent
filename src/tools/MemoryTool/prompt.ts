export const MEMORY_TOOL_NAME = 'Memory'

export const DESCRIPTION = `Manage persistent memory files (add, replace, or remove).

When to use this tool:
- You need to save something the user asked you to remember
- You want to update or correct an existing memory
- You need to remove an outdated or wrong memory
- The user says "remember this", "forget that", "update the memory about…"

Actions:
- add: Create a new memory file with YAML frontmatter + update MEMORY.md index
  Required: filename, type, name, description, content
- replace: Update an existing memory file (merges with existing frontmatter)
  Required: filename. Provide any of: type, name, description, content (unchanged fields keep existing values)
- remove: Delete a memory file + remove its MEMORY.md index line
  Required: filename

Types: user, feedback, project, reference

Filename: must end with .md, no path separators. Example: "user_role.md", "feedback_testing.md"

Do NOT use this tool for:
- Reading memory files (use FileRead or Grep instead)
- Editing MEMORY.md directly (this tool manages it automatically)
- Storing code patterns, architecture, or git history (derivable from the codebase)`
