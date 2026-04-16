/**
 * Memory prefetch 模組 — 公開 API。
 *
 * - FTS 歷史搜尋（M2-09）
 * - 預算控制 + fence 組裝（M2-10）
 * - memdir re-rank 由既有 findRelevantMemories.ts（M2-09a 走本地模型）處理
 */
export { searchSessionHistory, type FtsSnippet } from './ftsSearch.js'
export {
  buildMemoryContextFence,
  CHAR_BUDGET,
  MAX_FTS_SNIPPETS,
  TOKEN_BUDGET,
} from './budget.js'
