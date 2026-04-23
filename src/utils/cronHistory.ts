// Append-only run history index for cron fires.
//
// Layout:  <project>/.my-agent/cron/history/{taskId}.jsonl
// Each line is one fire entry — ts / status / error / optional metadata.
// Truncation: when entry count exceeds CronTask.history.keepRuns (default 50),
// the oldest entries are dropped via read-slice-atomic-write.
//
// Intentional design choice: separate from saveJobOutput()'s per-fire .md
// files. Those store full output (large); this index is metadata-only so
// tools / UI can list "last N fires" without reading large bodies.

import { mkdir, readFile, rename, writeFile } from 'fs/promises'
import { randomUUID } from 'crypto'
import { join } from 'path'
import { getProjectRoot } from '../bootstrap/state.js'
import { logForDebugging } from './debug.js'
import { isFsInaccessible } from './errors.js'

const HISTORY_DIR_REL = join('.my-agent', 'cron', 'history')

/** One row in the history JSONL. All fields except `ts` and `status` are optional. */
export type CronHistoryEntry = {
  /** Epoch ms when the fire happened. */
  ts: number
  status: 'ok' | 'error' | 'skipped' | 'retrying'
  /** Wall-clock duration of the fire in ms. Populated when known. */
  durationMs?: number
  /** Retry attempt number (1 = first fire, 2 = first retry, ...). */
  attempt?: number
  /** Filename (basename) of the corresponding saveJobOutput .md, if any. */
  outputFile?: string
  /** Truncated error message; absent when status === 'ok'. */
  errorMsg?: string
}

const DEFAULT_KEEP_RUNS = 50
const MAX_KEEP_RUNS = 1000
const MAX_LINE_BYTES = 8 * 1024 // skip absurdly large lines on read

export function getHistoryDir(dir?: string): string {
  return join(dir ?? getProjectRoot(), HISTORY_DIR_REL)
}

export function getHistoryFilePath(taskId: string, dir?: string): string {
  return join(getHistoryDir(dir), `${taskId}.jsonl`)
}

/** Append one entry. Creates dir/file as needed. EEXIST on mkdir is ignored (bun/Windows quirk, mirrors writeCronTasks). */
export async function appendHistoryEntry(
  taskId: string,
  entry: CronHistoryEntry,
  opts?: { keepRuns?: number; dir?: string },
): Promise<void> {
  const dir = opts?.dir
  const keepRuns = clampKeepRuns(opts?.keepRuns)
  const filePath = getHistoryFilePath(taskId, dir)
  try {
    await mkdir(getHistoryDir(dir), { recursive: true })
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code !== 'EEXIST') throw e
  }
  // Always use \n (cross-platform — git autocrlf shouldn't touch .jsonl runtime artifact).
  const line = JSON.stringify(entry) + '\n'
  try {
    await writeFile(filePath, line, { flag: 'a', encoding: 'utf-8' })
  } catch (e) {
    logForDebugging(
      `[cronHistory] append failed for ${taskId}: ${(e as Error).message}`,
    )
    return
  }
  // Cheap line count via stat would lie about content. Read + maybe truncate.
  // To avoid doing this on every append, only check periodically:
  // re-read every ~10th append (probabilistic).
  if (Math.random() < 0.1) {
    await truncateHistory(taskId, keepRuns, dir).catch(() => {})
  }
}

/** Read all entries for a task. Bad lines are skipped (logged at debug). */
export async function readHistory(
  taskId: string,
  dir?: string,
): Promise<CronHistoryEntry[]> {
  const filePath = getHistoryFilePath(taskId, dir)
  let raw: string
  try {
    raw = await readFile(filePath, 'utf-8')
  } catch (e) {
    if (isFsInaccessible(e)) return []
    throw e
  }
  const out: CronHistoryEntry[] = []
  for (const line of raw.split('\n')) {
    if (!line) continue
    if (line.length > MAX_LINE_BYTES) continue
    try {
      const parsed = JSON.parse(line) as CronHistoryEntry
      if (
        typeof parsed?.ts === 'number' &&
        typeof parsed?.status === 'string'
      ) {
        out.push(parsed)
      }
    } catch {
      // skip malformed
    }
  }
  return out
}

/** Drop oldest entries when count exceeds keepRuns. Atomic rewrite via .tmp. */
export async function truncateHistory(
  taskId: string,
  keepRuns?: number,
  dir?: string,
): Promise<void> {
  const limit = clampKeepRuns(keepRuns)
  const entries = await readHistory(taskId, dir)
  if (entries.length <= limit) return
  const kept = entries.slice(entries.length - limit)
  const filePath = getHistoryFilePath(taskId, dir)
  const tmp = `${filePath}.${randomUUID().slice(0, 8)}.tmp`
  const body = kept.map(e => JSON.stringify(e)).join('\n') + '\n'
  await writeFile(tmp, body, 'utf-8')
  await rename(tmp, filePath)
}

function clampKeepRuns(n?: number): number {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 1)
    return DEFAULT_KEEP_RUNS
  return Math.min(Math.floor(n), MAX_KEEP_RUNS)
}
