// 共用的 feature flag 清單。
//
// bun:bundle 的 feature('X') 是 build-time 巨集，bundler 會把它替換成布林常數
// 以便做 dead-code elimination（見 node_modules/bun-types/bundle.d.ts）。
// bun 同時在 `bun run` / `bun test` 的 JIT transpile 階段也做相同替換，
// 只要透過 CLI 傳 `--feature=FLAG`。
//
// - scripts/build.ts：bundle path（`bun build --feature=...`）
// - scripts/dev.ts：dev path（`bun run --feature=... entry.tsx`）
//
// 兩條路徑共用此清單，避免日後新增 flag 時漏掉其中一邊（經典案例：
// AGENT_TRIGGERS 沒傳進 dev path 導致 cron scheduler 靜默不 fire，見
// LESSONS.md）。

// ADR-003：新功能不使用 feature flag — 所有功能直接啟用。正式 build 預設把
// 整套 experimental flags 打開，對齊 my-agent「移除遙測、解鎖實驗功能」的方向。
// 否則 7 個 Cron 工具 + RemoteTriggerTool + daemon cronWiring 等會在 build
// 階段被死碼消除（見 src/tools.ts:34 的 `feature('AGENT_TRIGGERS')` gate）。
//
// NOTE：PROACTIVE / KAIROS / MONITOR_TOOL / KAIROS_PUSH_NOTIFICATION /
// KAIROS_GITHUB_WEBHOOKS 不能加進來，my-agent 移除遙測時連帶刪了
// src/proactive/、src/tools/MonitorTool/ 等目錄，打開這些 flag 會 bundle-time
// 解析失敗。需要恢復對應功能時要先把模組補回來。
export const fullExperimentalFeatures = [
  'AGENT_MEMORY_SNAPSHOT',
  'AGENT_TRIGGERS',
  'AGENT_TRIGGERS_REMOTE',
  'AWAY_SUMMARY',
  'BASH_CLASSIFIER',
  'BRIDGE_MODE',
  'BUILTIN_EXPLORE_PLAN_AGENTS',
  'CACHED_MICROCOMPACT',
  'CCR_AUTO_CONNECT',
  'CCR_MIRROR',
  'CCR_REMOTE_SETUP',
  'COMPACTION_REMINDERS',
  'CONNECTOR_TEXT',
  'EXTRACT_MEMORIES',
  'HISTORY_PICKER',
  'HOOK_PROMPTS',
  'KAIROS_BRIEF',
  'KAIROS_CHANNELS',
  'LODESTONE',
  'MCP_RICH_OUTPUT',
  'MESSAGE_ACTIONS',
  'NATIVE_CLIPBOARD_IMAGE',
  'NEW_INIT',
  'POWERSHELL_AUTO_MODE',
  'PROMPT_CACHE_BREAK_DETECTION',
  'QUICK_SEARCH',
  'SHOT_STATS',
  'TEAMMEM',
  'TOKEN_BUDGET',
  'TREE_SITTER_BASH',
  'TREE_SITTER_BASH_SHADOW',
  'ULTRAPLAN',
  'ULTRATHINK',
  'UNATTENDED_RETRY',
  'VERIFICATION_AGENT',
] as const

export type ExperimentalFeature = (typeof fullExperimentalFeatures)[number]
