/**
 * M-WEB-SLASH-D2：依命令名歸類，給 GenericLocalJsxModal 顯示對應 hint。
 *
 * 6 類對應 plan 的 D1-D6 切分；分類用「name 前綴 / 包含」純規則，新命令加入
 * 不需動程式碼。命中第一個規則為主；都不命中歸 'misc'。
 *
 * D-FULL 真 React port 之後此檔案保留 — categorize() 仍可拿來做歸類面板 / 文件
 * 分組。
 */

export type CommandCategory =
  | 'config'
  | 'session'
  | 'project'
  | 'memory'
  | 'agent-tool'
  | 'misc'

export interface CategoryHint {
  category: CommandCategory
  /** 中文短標題（Modal 顯示） */
  label: string
  /** 一句話 hint（Modal 描述「Web 端可暫時做什麼替代」） */
  hint: string
  /** 跳到右欄哪個 tab 可以看到相關資訊（可選） */
  relatedTab?: 'cron' | 'memory' | 'llamacpp' | 'discord' | 'permissions' | 'overview'
}

/**
 * 注意：rules 順序重要，先命中先贏。
 *   - 'memory' 類比 'session' 早，否則 /memory-search 會被 session 搶走
 *   - 'agent-tool' 類包含 plan/tasks/agent/tool/think，比 misc 早
 */
const RULES: Array<{
  match: (name: string) => boolean
  hint: CategoryHint
}> = [
  {
    match: n =>
      /^(config|model|permission|permissions|output-style|hooks|rate-limit-options|plugin|theme|color|vim|statusline|keybindings|terminalSetup)$/.test(
        n,
      ),
    hint: {
      category: 'config',
      label: '設定 / 偏好',
      hint: 'Web 端可在 ⚙ 右欄 Permissions tab 看 mode；其他細節改 ~/.my-agent/settings.json',
      relatedTab: 'permissions',
    },
  },
  {
    match: n =>
      /^(memory-debug|dream|recall|forget)$/.test(n) ||
      n.startsWith('memory-'),
    hint: {
      category: 'memory',
      label: 'Memory / Recall',
      hint: '右欄 Memory tab 已可瀏覽 / 編輯；本命令的進階互動需 TUI',
      relatedTab: 'memory',
    },
  },
  {
    match: n =>
      /^(sessions|resume|branch|fork|compact|save|export|import|rewind|share|session|copy|files|stats|context|cost|usage|usageReport|breakCache|teleport|backfillSessions)$/.test(
        n,
      ),
    hint: {
      category: 'session',
      label: 'Session / 歷史',
      hint: '左欄樹狀已列出 sessions；切舊 session 看 read-only 預覽',
      relatedTab: 'overview',
    },
  },
  {
    match: n =>
      /^(init|agents|skills|mcp|upgrade|release-notes|version|doctor|status|reloadPlugins|review|securityReview|bughunter|commit|commitPushPr|pr_comments|autofixPr|issue|btw|onboarding|effort|fast|tag|stickers|rename|insights|advisor|installSlackApp|ide|mobile)$/.test(
        n,
      ),
    hint: {
      category: 'project',
      label: '專案 / 工作流',
      hint: '此類命令多數 prompt 型，會直接注入 turn；jsx-handoff 的版本完整 UI 在 TUI',
    },
  },
  {
    match: n =>
      /^(plan|tasks|agent|tool|think|no-think|long-context|context-stats|toolsCommand|toolsCommand|exit|exportCommand|sandboxToggle|heapDump|ctx_viz|configRewriteWithDocs|tool|trash|sessionDelete|memoryDelete)$/.test(
        n,
      ),
    hint: {
      category: 'agent-tool',
      label: 'Agent / Tool',
      hint: '工具呼叫 / sub-agent / context 相關；Web 端 Agent 樹視圖規劃在 M-WEB-AGENT-VIEW',
    },
  },
]

const FALLBACK: CategoryHint = {
  category: 'misc',
  label: '雜項',
  hint: '此命令在 TUI 端有完整互動 UI；Web 端目前提供 metadata 預覽',
}

export function categorize(name: string): CategoryHint {
  for (const r of RULES) {
    if (r.match(name)) return r.hint
  }
  return FALLBACK
}
