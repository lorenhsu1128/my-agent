export const SESSION_SEARCH_TOOL_NAME = 'SessionSearch'

export const DESCRIPTION = `- Search past conversation sessions by keyword or phrase.
- Uses the FTS5 index of JSONL transcripts at {CLAUDE_CONFIG_HOME}/projects/{slug}/session-index.db.
- Returns up to \`limit\` matches grouped by session, with each session's title (first user message), start time, model, and matching message snippets (role, tool name, content).
- **Query must be ≥3 characters** (FTS5 trigram tokenizer limit). Short CJK words like "天氣" (2 chars) won't match; expand to "天氣預報" (3+ chars) or a complete phrase.
- Use this tool when the user asks "what did we discuss about X", "上次我們怎麼處理 Y", "remember when we debugged Z", or any recall-oriented request spanning past sessions.
- Do NOT use for searching current session's transcript — that's already in context.
- When in doubt between SessionSearch and a code/file search (Grep/Glob), prefer SessionSearch only for conversation recall; use Grep/Glob for code content.
- \`summarize: true\` is accepted but currently returns the raw matches with a \`summaryPending\` flag. Full summarization arrives in a later milestone.`
