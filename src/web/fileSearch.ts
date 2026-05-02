/**
 * M-WEB-PARITY-4：給 Web `@file` typeahead 用的輕量檔案搜尋。
 *
 * 設計：
 *   - 同步走訪 cwd（最多 8 層、最多 5000 entry，達上限就截）
 *   - 跳過常見 ignore dir（node_modules / .git / dist / build / .next / .turbo / target）
 *   - 結果按 score 排序：完全包含 q（在 basename）> 包含 q（在路徑）> fuzzy
 *   - q 為空時回前 N 個（無排序，純 listing）
 */
import { readdirSync, statSync } from 'fs'
import { join, relative, sep } from 'path'

const IGNORE_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  '.turbo',
  'target',
  '.cache',
  '.idea',
  '.vscode',
  'coverage',
])
const MAX_DEPTH = 8
const MAX_ENTRIES = 5000

export interface ProjectFileMatch {
  path: string // posix-normalized relative path
  type: 'file' | 'dir'
  score?: number
}

function normalize(p: string): string {
  return p.split(sep).join('/')
}

function scoreMatch(rel: string, q: string): number {
  if (!q) return 0
  const lower = rel.toLowerCase()
  const ql = q.toLowerCase()
  const basename = lower.split('/').pop() ?? lower
  if (basename === ql) return 100
  if (basename.startsWith(ql)) return 80
  if (basename.includes(ql)) return 60
  if (lower.includes(ql)) return 40
  // fuzzy：每個字元順序出現算 1 分
  let pi = 0
  for (let i = 0; i < lower.length && pi < ql.length; i++) {
    if (lower[i] === ql[pi]) pi++
  }
  return pi === ql.length ? 20 : 0
}

export async function searchProjectFiles(
  cwd: string,
  q: string,
  limit: number,
): Promise<ProjectFileMatch[]> {
  const all: ProjectFileMatch[] = []
  let entryCount = 0

  function walk(dir: string, depth: number): void {
    if (depth > MAX_DEPTH || entryCount >= MAX_ENTRIES) return
    let entries: import('fs').Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (entryCount >= MAX_ENTRIES) return
      const full = join(dir, e.name)
      const rel = normalize(relative(cwd, full))
      if (e.isDirectory()) {
        if (IGNORE_DIRS.has(e.name)) continue
        if (e.name.startsWith('.') && depth === 0) continue
        all.push({ path: rel, type: 'dir' })
        entryCount++
        walk(full, depth + 1)
      } else if (e.isFile()) {
        all.push({ path: rel, type: 'file' })
        entryCount++
      }
    }
  }
  walk(cwd, 0)

  if (!q) {
    return all.slice(0, limit)
  }
  const scored = all
    .map(m => ({ ...m, score: scoreMatch(m.path, q) }))
    .filter(m => (m.score ?? 0) > 0)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
  return scored.slice(0, limit)
}
