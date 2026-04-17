// Extracted from dream.ts so auto-dream ships independently of KAIROS
// feature flags (dream.ts is behind a feature()-gated require).

import {
  DIR_EXISTS_GUIDANCE,
  ENTRYPOINT_NAME,
  MAX_ENTRYPOINT_LINES,
} from '../../memdir/memdir.js'

export function buildConsolidationPrompt(
  memoryRoot: string,
  transcriptDir: string,
  extra: string,
): string {
  return `# Dream: Memory Consolidation

You are performing a dream — a reflective pass over your memory files. Synthesize what you've learned recently into durable, well-organized memories so that future sessions can orient quickly.

Memory directory: \`${memoryRoot}\`
${DIR_EXISTS_GUIDANCE}

Session transcripts: \`${transcriptDir}\` (large JSONL files — grep narrowly, don't read whole files)

---

## Phase 1 — Orient

- \`ls\` the memory directory to see what already exists
- Read \`${ENTRYPOINT_NAME}\` to understand the current index
- Skim existing topic files so you improve them rather than creating duplicates
- If \`logs/\` or \`sessions/\` subdirectories exist (assistant-mode layout), review recent entries there

## Phase 2 — Gather recent signal

Look for new information worth persisting. Sources in rough priority order:

1. **Daily logs** (\`logs/YYYY/MM/YYYY-MM-DD.md\`) if present — these are the append-only stream
2. **Existing memories that drifted** — facts that contradict something you see in the codebase now
3. **Transcript search** — if you need specific context (e.g., "what was the error message from yesterday's build failure?"), grep the JSONL transcripts for narrow terms:
   \`grep -rn "<narrow term>" ${transcriptDir}/ --include="*.jsonl" | tail -50\`

Don't exhaustively read transcripts. Look only for things you already suspect matter.

## Phase 3 — Consolidate

For each thing worth remembering, write or update a memory file at the top level of the memory directory. Use the memory file format and type conventions from your system prompt's auto-memory section — it's the source of truth for what to save, how to structure it, and what NOT to save.

Focus on:
- Merging new signal into existing topic files rather than creating near-duplicates
- Converting relative dates ("yesterday", "last week") to absolute dates so they remain interpretable after time passes
- Deleting contradicted facts — if today's investigation disproves an old memory, fix it at the source

## Phase 4 — Prune and index

Update \`${ENTRYPOINT_NAME}\` so it stays under ${MAX_ENTRYPOINT_LINES} lines AND under ~25KB. It's an **index**, not a dump — each entry should be one line under ~150 characters: \`- [Title](file.md) — one-line hook\`. Never write memory content directly into it.

- Remove pointers to memories that are now stale, wrong, or superseded
- Demote verbose entries: if an index line is over ~200 chars, it's carrying content that belongs in the topic file — shorten the line, move the detail
- Add pointers to newly important memories
- Resolve contradictions — if two files disagree, fix the wrong one

---

## Phase 5 — Skill Audit

Scan the \`.my-agent/skills/\` directory (relative to the project root) to see what skills already exist:
\`ls .my-agent/skills/\`

Then search recent transcripts for repeated multi-step workflows:

- \`grep -rn "tool_use" ${transcriptDir}/ --include="*.jsonl" | tail -100\`
- Look for 5+ step tool sequences that appear across multiple sessions
- Check if any existing skill's instructions contradict what actually worked in recent sessions

Write your findings to \`skill-candidates.md\` in the memory directory using the standard memory file format:
\`\`\`
---
name: skill-candidates
description: Candidate workflows identified by Dream that could become reusable skills
type: project
---

- **Candidate name**: [name]
  - Observed pattern: [which sessions, which tool sequences]
  - Why it's worth becoming a skill: [rationale]
\`\`\`

If no candidates are found, skip this file — do not create an empty one.

## Phase 6 — Behavior Notes

Search recent transcripts for user corrections and preferences:

- \`grep -rn "don't\\|always\\|never\\|prefer\\|stop\\|不要\\|永遠\\|一律" ${transcriptDir}/ --include="*.jsonl" | tail -50\`
- Look for explicit rejections of proposed approaches
- Look for repeated steering toward specific methods or tools

If found, write or update \`user-behavior-notes.md\` in the memory directory:
\`\`\`
---
name: user-behavior-notes
description: User corrections and preferences observed across sessions
type: feedback
---

- [correction/preference]: [context]
\`\`\`

If nothing new is found, skip — do not create or update without substance.

## Phase 7 — Skill Draft Cleanup

Check \`${memoryRoot}/skill-drafts/\` for residual draft files. The Session Review Agent now creates skills directly via SkillManageTool (with code-level security scanning), so drafts here are leftovers from earlier runs. Clean up any remaining files.

## Phase 8 — Trajectory Pruning

Prune \`${memoryRoot}/trajectories/\` to keep only the last 30 days of entries.
Remove trajectory files whose date (from filename \`YYYY-MM-DD.md\`) is older than 30 days.

---

Return a brief summary of what you consolidated, updated, or pruned. If nothing changed (memories are already tight), say so.${extra ? `\n\n## Additional context\n\n${extra}` : ''}`
}
