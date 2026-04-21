/**
 * Tool names that cannot be disabled via the `/tools` picker.
 *
 * 這些是 agent 做 software engineering 最低限度依賴的 core tool。如果允許
 * 使用者關掉它們，agent 會連讀檔、改檔、跑 shell、搜尋都做不到。picker
 * 仍會顯示它們，但標記 `[core, locked]` 且不可切換。
 *
 * settings.json 裡若誤寫這些名字進 `disabledTools`，bootstrap 時會自動
 * filter 掉（不拋錯），以避免使用者誤鎖死自己。
 */
export const UNTOGGLEABLE_TOOLS: ReadonlySet<string> = new Set([
  'Read',
  'Write',
  'Edit',
  'Bash',
  'Glob',
  'Grep',
])
