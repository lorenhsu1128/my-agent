export const SESSION_SEARCH_TOOL_NAME = 'SessionSearch'

export const DESCRIPTION = `Search past conversation sessions by keyword to recall what was discussed before.

When to use this tool:
- User asks "上次我們怎麼處理…", "remember when we discussed…", "我們之前有聊過…嗎"
- User references a past session topic ("那個天氣查詢的 session", "the one where we fixed the build")
- You need context from a previous conversation that is NOT in the current session

Input:
- query (required): keyword or phrase, ≥3 characters recommended. Examples: "weather", "天氣預報", "llama.cpp", "build error"
  - Short queries (<3 chars like "天氣") auto-fall-back to title search (less precise)
- limit (optional): max snippets to return, default 5
- summarize (optional): if true, generates an LLM summary of the matches (slower, needs running model)

Output: matched message snippets grouped by session, with session title, date, and model info.

Do NOT use this tool for:
- Searching the CURRENT conversation (that context is already available to you)
- Searching code files (use Grep or Glob instead)
- Searching the web (use WebSearch instead)`
