/**
 * Prompt templates for the background memory extraction agent.
 *
 * The extraction agent runs as a perfect fork of the main conversation — same
 * system prompt, same message prefix. The main agent's system prompt always
 * has full save instructions; when the main agent writes memories itself,
 * extractMemories.ts skips that turn (hasMemoryWritesSince). This prompt
 * fires only when the main agent didn't write, so the save-criteria here
 * overlap the system prompt's harmlessly.
 */

import { feature } from 'bun:bundle'
import {
  getMemoryFrontmatterExample,
  getTypesSectionCombined,
  getTypesSectionIndividual,
  getWhatNotToSaveSection,
} from '../../memdir/memoryTypes.js'
import {
  getUserModelGlobalPath,
  getUserModelProjectPath,
} from '../../userModel/paths.js'
import { BASH_TOOL_NAME } from '../../tools/BashTool/toolName.js'
import { FILE_EDIT_TOOL_NAME } from '../../tools/FileEditTool/constants.js'
import { FILE_READ_TOOL_NAME } from '../../tools/FileReadTool/prompt.js'
import { FILE_WRITE_TOOL_NAME } from '../../tools/FileWriteTool/prompt.js'
import { GLOB_TOOL_NAME } from '../../tools/GlobTool/prompt.js'
import { GREP_TOOL_NAME } from '../../tools/GrepTool/prompt.js'

/**
 * Persona-bullet guidance: short, durable facts about who the user is go into
 * USER.md (injected into the system prompt each turn as a frozen snapshot),
 * separate from typed memdir files. This agent writes USER.md directly via
 * FileEdit/FileWrite (it doesn't call the MemoryTool).
 */
function personaSection(): string[] {
  return [
    '## Persona bullets (USER.md)',
    '',
    'Short, durable, one-line facts about WHO the user is go into USER.md — a persona block injected into every system prompt. These are DIFFERENT from typed user_*.md files:',
    '',
    '- **USER.md**: 1-line bullets, ≤80 chars each, ≤1500 chars total. Loaded every turn. Example lines: "Primary shell: PowerShell", "Reply in 繁體中文", "Role: PM in this project".',
    '- **user_*.md typed file**: multi-line, has frontmatter, loaded on-demand. Example: a detailed user_collaboration_style.md explaining preferences.',
    '',
    'Rule: if the fact is a one-liner that should shape EVERY response (language, shell, OS, role, core preference) → write to USER.md. Otherwise use user_*.md.',
    '',
    'File locations (write via FileEdit/FileWrite directly):',
    `- **Global** (cross-project traits): \`${getUserModelGlobalPath()}\``,
    `- **Project** (this-project-only override): \`${getUserModelProjectPath()}\``,
    '',
    'Default to global. Only use the project path when the fact contradicts or narrows the global persona for this specific project.',
    '',
    'When appending, read the file first, add a new `- bullet` line, and write back. Keep the total under 1500 chars — consolidate if it grows.',
    '',
  ]
}

/**
 * Shared opener for both extract-prompt variants.
 */
function opener(newMessageCount: number, existingMemories: string): string {
  const manifest =
    existingMemories.length > 0
      ? `\n\n## Existing memory files\n\n${existingMemories}\n\nCheck this list before writing — update an existing file rather than creating a duplicate.`
      : ''
  return [
    `You are now acting as the memory extraction subagent. Analyze the most recent ~${newMessageCount} messages above and use them to update your persistent memory systems.`,
    '',
    `Available tools: ${FILE_READ_TOOL_NAME}, ${GREP_TOOL_NAME}, ${GLOB_TOOL_NAME}, read-only ${BASH_TOOL_NAME} (ls/find/cat/stat/wc/head/tail and similar), and ${FILE_EDIT_TOOL_NAME}/${FILE_WRITE_TOOL_NAME} for paths inside the memory directory only. ${BASH_TOOL_NAME} rm is not permitted. All other tools — MCP, Agent, write-capable ${BASH_TOOL_NAME}, etc — will be denied.`,
    '',
    `You have a limited turn budget. ${FILE_EDIT_TOOL_NAME} requires a prior ${FILE_READ_TOOL_NAME} of the same file, so the efficient strategy is: turn 1 — issue all ${FILE_READ_TOOL_NAME} calls in parallel for every file you might update; turn 2 — issue all ${FILE_WRITE_TOOL_NAME}/${FILE_EDIT_TOOL_NAME} calls in parallel. Do not interleave reads and writes across multiple turns.`,
    '',
    `You MUST only use content from the last ~${newMessageCount} messages to update your persistent memories. Do not waste any turns attempting to investigate or verify that content further — no grepping source files, no reading code to confirm a pattern exists, no git commands.` +
      manifest,
  ].join('\n')
}

/**
 * Build the extraction prompt for auto-only memory (no team memory).
 * Four-type taxonomy, no scope guidance (single directory).
 */
export function buildExtractAutoOnlyPrompt(
  newMessageCount: number,
  existingMemories: string,
  skipIndex = false,
): string {
  const howToSave = skipIndex
    ? [
        '## How to save memories',
        '',
        'Write each memory to its own file (e.g., `user_role.md`, `feedback_testing.md`) using this frontmatter format:',
        '',
        ...getMemoryFrontmatterExample(),
        '',
        '- Organize memory semantically by topic, not chronologically',
        '- Update or remove memories that turn out to be wrong or outdated',
        '- Do not write duplicate memories. First check if there is an existing memory you can update before writing a new one.',
      ]
    : [
        '## How to save memories',
        '',
        'Saving a memory is a two-step process:',
        '',
        '**Step 1** — write the memory to its own file (e.g., `user_role.md`, `feedback_testing.md`) using this frontmatter format:',
        '',
        ...getMemoryFrontmatterExample(),
        '',
        '**Step 2** — add a pointer to that file in `MEMORY.md`. `MEMORY.md` is an index, not a memory — each entry should be one line, under ~150 characters: `- [Title](file.md) — one-line hook`. It has no frontmatter. Never write memory content directly into `MEMORY.md`.',
        '',
        '- `MEMORY.md` is always loaded into your system prompt — lines after 200 will be truncated, so keep the index concise',
        '- Organize memory semantically by topic, not chronologically',
        '- Update or remove memories that turn out to be wrong or outdated',
        '- Do not write duplicate memories. First check if there is an existing memory you can update before writing a new one.',
      ]

  return [
    opener(newMessageCount, existingMemories),
    '',
    'If the user explicitly asks you to remember something, save it immediately as whichever type fits best. If they ask you to forget something, find and remove the relevant entry.',
    '',
    ...getTypesSectionIndividual(),
    ...getWhatNotToSaveSection(),
    '',
    ...personaSection(),
    ...howToSave,
  ].join('\n')
}

/**
 * Build the extraction prompt for combined auto + team memory.
 * Four-type taxonomy with per-type <scope> guidance (directory choice
 * is baked into each type block, no separate routing section needed).
 */
export function buildExtractCombinedPrompt(
  newMessageCount: number,
  existingMemories: string,
  skipIndex = false,
): string {
  if (!feature('TEAMMEM')) {
    return buildExtractAutoOnlyPrompt(
      newMessageCount,
      existingMemories,
      skipIndex,
    )
  }

  const howToSave = skipIndex
    ? [
        '## How to save memories',
        '',
        "Write each memory to its own file in the chosen directory (private or team, per the type's scope guidance) using this frontmatter format:",
        '',
        ...getMemoryFrontmatterExample(),
        '',
        '- Organize memory semantically by topic, not chronologically',
        '- Update or remove memories that turn out to be wrong or outdated',
        '- Do not write duplicate memories. First check if there is an existing memory you can update before writing a new one.',
      ]
    : [
        '## How to save memories',
        '',
        'Saving a memory is a two-step process:',
        '',
        "**Step 1** — write the memory to its own file in the chosen directory (private or team, per the type's scope guidance) using this frontmatter format:",
        '',
        ...getMemoryFrontmatterExample(),
        '',
        "**Step 2** — add a pointer to that file in the same directory's `MEMORY.md`. Each directory (private and team) has its own `MEMORY.md` index — each entry should be one line, under ~150 characters: `- [Title](file.md) — one-line hook`. They have no frontmatter. Never write memory content directly into a `MEMORY.md`.",
        '',
        '- Both `MEMORY.md` indexes are loaded into your system prompt — lines after 200 will be truncated, so keep them concise',
        '- Organize memory semantically by topic, not chronologically',
        '- Update or remove memories that turn out to be wrong or outdated',
        '- Do not write duplicate memories. First check if there is an existing memory you can update before writing a new one.',
      ]

  return [
    opener(newMessageCount, existingMemories),
    '',
    'If the user explicitly asks you to remember something, save it immediately as whichever type fits best. If they ask you to forget something, find and remove the relevant entry.',
    '',
    ...getTypesSectionCombined(),
    ...getWhatNotToSaveSection(),
    '- You MUST avoid saving sensitive data within shared team memories. For example, never save API keys or user credentials.',
    '',
    ...personaSection(),
    ...howToSave,
  ].join('\n')
}
