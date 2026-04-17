// Trajectory Store — persists session workflow summaries for cross-session
// pattern detection. Used by Session Review Agent (write) and AutoDream (read).
//
// Storage: memory/trajectories/YYYY-MM-DD.md (one file per day, append if exists)

import { join } from 'path'
import { readdir, readFile, writeFile, mkdir, unlink } from 'fs/promises'

export type TrajectoryEntry = {
  attempted: string
  succeeded?: string[]
  failed?: string[]
  toolSequences?: string[]
  lessons?: string[]
}

function formatTrajectory(date: string, entry: TrajectoryEntry): string {
  const lines: string[] = [`# Trajectory — ${date}`, '']

  lines.push(`## Attempted`)
  lines.push(entry.attempted)
  lines.push('')

  if (entry.succeeded && entry.succeeded.length > 0) {
    lines.push(`## Succeeded`)
    for (const s of entry.succeeded) lines.push(`- ${s}`)
    lines.push('')
  }

  if (entry.failed && entry.failed.length > 0) {
    lines.push(`## Failed`)
    for (const f of entry.failed) lines.push(`- ${f}`)
    lines.push('')
  }

  if (entry.toolSequences && entry.toolSequences.length > 0) {
    lines.push(`## Tool Sequences`)
    for (const t of entry.toolSequences) lines.push(`- ${t}`)
    lines.push('')
  }

  if (entry.lessons && entry.lessons.length > 0) {
    lines.push(`## Lessons`)
    for (const l of entry.lessons) lines.push(`- ${l}`)
    lines.push('')
  }

  return lines.join('\n')
}

function trajectoriesDir(memoryRoot: string): string {
  return join(memoryRoot, 'trajectories')
}

export async function writeTrajectory(
  memoryRoot: string,
  date: string,
  entry: TrajectoryEntry,
): Promise<void> {
  const dir = trajectoriesDir(memoryRoot)
  await mkdir(dir, { recursive: true })

  const filePath = join(dir, `${date}.md`)
  let existing = ''
  try {
    existing = await readFile(filePath, 'utf-8')
  } catch {
    // file doesn't exist yet
  }

  const formatted = formatTrajectory(date, entry)
  const content = existing
    ? `${existing}\n---\n\n${formatted}`
    : formatted

  await writeFile(filePath, content, 'utf-8')
}

export async function readTrajectories(
  memoryRoot: string,
  days: number,
): Promise<string[]> {
  const dir = trajectoriesDir(memoryRoot)
  let files: string[]
  try {
    files = await readdir(dir)
  } catch {
    return []
  }

  // Sort descending by filename (date), take last N days
  const mdFiles = files
    .filter(f => f.endsWith('.md'))
    .sort()
    .reverse()
    .slice(0, days)

  const results: string[] = []
  for (const file of mdFiles) {
    try {
      const content = await readFile(join(dir, file), 'utf-8')
      results.push(content)
    } catch {
      // skip unreadable files
    }
  }

  return results
}

export async function pruneTrajectories(
  memoryRoot: string,
  maxDays: number,
): Promise<number> {
  const dir = trajectoriesDir(memoryRoot)
  let files: string[]
  try {
    files = await readdir(dir)
  } catch {
    return 0
  }

  const mdFiles = files.filter(f => f.endsWith('.md')).sort()

  // Keep only the last maxDays files
  const toRemove = mdFiles.slice(0, Math.max(0, mdFiles.length - maxDays))

  let removed = 0
  for (const file of toRemove) {
    try {
      await unlink(join(dir, file))
      removed++
    } catch {
      // skip
    }
  }

  return removed
}

export async function countSkillObservations(
  memoryRoot: string,
  skillName: string,
): Promise<number> {
  const dir = trajectoriesDir(memoryRoot)
  let files: string[]
  try {
    files = await readdir(dir)
  } catch {
    return 0
  }

  let count = 0
  for (const file of files.filter(f => f.endsWith('.md'))) {
    try {
      const content = await readFile(join(dir, file), 'utf-8')
      if (content.includes(skillName)) count++
    } catch {
      // skip
    }
  }

  return count
}
