/**
 * 手動觸發當前 project 的 session-index.db rebuild（M2-04 修 timestamp 後使用）。
 * 跑完會印 stats。之後可跑 query-session-index.ts 看內容。
 *
 * Usage: bun run scripts/poc/rebuild-session-index.ts
 */
import { reconcileProjectIndex } from '../../src/services/sessionIndex/index.js'

const projectRoot = process.cwd()
console.log(`projectRoot = ${projectRoot}`)
console.log('reconcile 開始...\n')

const stats = await reconcileProjectIndex(projectRoot)

console.log('\n=== stats ===')
console.log(stats)
