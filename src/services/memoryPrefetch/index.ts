/**
 * M2-09：Memory prefetch 模組 — 公開 API。
 *
 * 目前只有 FTS 歷史搜尋。memdir re-rank 由既有的
 * findRelevantMemories.ts（M2-09a 後走本地模型）處理。
 */
export { searchSessionHistory, type FtsSnippet } from './ftsSearch.js'
