// Session Review Prompt — used by the Session Review Agent to analyze
// a session's tool usage patterns and extract reusable knowledge.

export function buildSessionReviewPrompt(
  memoryRoot: string,
  transcriptDir: string,
): string {
  return `# Session Review

You are reviewing this session's work to extract reusable knowledge.
Memory directory: \`${memoryRoot}\`
Session transcripts: \`${transcriptDir}\`

---

## Task 1 — Skill Drafts

Analyze the tool usage patterns in this session by searching the most recent transcript:
\`ls -t ${transcriptDir}/*.jsonl | head -1\` then grep for tool_use blocks.

Look for:
- Non-trivial workflows (5+ distinct steps) that required trial and error
- Approaches that changed mid-stream due to discoveries
- Patterns that would be useful to repeat in future sessions

For each candidate workflow, write a skill draft to \`${memoryRoot}/skill-drafts/<name>.md\`:
\`\`\`
---
name: <skill-name>
description: <one-line description>
observed-sessions: 1
first-seen: <today's date>
---

## Steps
1. <step description>
2. ...

## Why
<why this is worth becoming a skill>
\`\`\`

If no candidates are found, skip — do not create empty drafts.

## Task 2 — Trajectory Summary

Write a brief trajectory summary to \`${memoryRoot}/trajectories/<YYYY-MM-DD>.md\`:
- What was attempted in this session
- What succeeded and what failed
- Key tool sequences used (e.g., "Read → Edit → Bash(bun test)")
- Lessons learned

## Task 3 — Behavior Notes

If the user corrected the agent or expressed preferences during this session,
update \`${memoryRoot}/user-behavior-notes.md\` (create if it doesn't exist).

Only record corrections that generalize to future sessions.
Skip one-time task-specific feedback.

---

Return a brief summary of what you extracted. If nothing worth saving, say so.`
}
