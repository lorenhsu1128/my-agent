/**
 * memdir 寫入 helpers — M-MEMTUI Phase 2 抽出，讓 LLM (`MemoryTool`) 與
 * 人類介面 (`/memory` TUI) 共用同一套寫入路徑：filename validation /
 * frontmatter 組裝 / 注入掃描 / atomic write / advisory lock /
 * MEMORY.md 索引維護。
 *
 * 行為對齊原 MemoryTool.ts 的私有版本（M2-15 / M2-16）；任何政策變更
 * 應同時更新 INJECTION_PATTERNS 與兩條 caller 路徑。
 */
import {
  readFile as readFileAsync,
  rename as renameAsync,
  unlink as unlinkAsync,
  writeFile as writeFileAsync,
} from 'fs/promises'
import { join, normalize } from 'path'
import { lock } from '../utils/lockfile.js'
import { logForDebugging } from '../utils/debug.js'
import { ENTRYPOINT_NAME, MAX_ENTRYPOINT_LINES } from './memdir.js'

/**
 * 驗證 filename 安全性，回傳完整路徑或錯誤字串。
 */
export function validateMemoryFilename(
  filename: string,
  memDir: string,
): { ok: true; filePath: string } | { ok: false; error: string } {
  if (!filename.endsWith('.md')) {
    return { ok: false, error: '檔名必須以 .md 結尾' }
  }
  if (/[/\\]/.test(filename)) {
    return { ok: false, error: '檔名不可含路徑分隔符（/ 或 \\）' }
  }
  if (filename.includes('..')) {
    return { ok: false, error: '檔名不可含 ".."' }
  }
  if (filename.includes('\0')) {
    return { ok: false, error: '檔名不可含 null byte' }
  }
  if (filename === ENTRYPOINT_NAME) {
    return { ok: false, error: `不可直接操作索引檔 ${ENTRYPOINT_NAME}` }
  }

  const filePath = normalize(join(memDir, filename))
  const normalizedMemDir = normalize(memDir)
  if (!filePath.startsWith(normalizedMemDir)) {
    return { ok: false, error: '路徑穿越偵測：目標不在 memdir 內' }
  }

  return { ok: true, filePath }
}

/**
 * 組裝 YAML frontmatter + body 的完整檔案內容。
 */
export function buildFileContent(
  name: string,
  description: string,
  type: string,
  body: string,
): string {
  return `---\nname: ${name}\ndescription: ${description}\ntype: ${type}\n---\n\n${body}\n`
}

/**
 * M2-16 注入掃描 pattern 表。設計原則：寧可漏抓不誤殺。
 */
export const INJECTION_PATTERNS: Array<{ pattern: RegExp; description: string }> = [
  {
    pattern: /ignore\s+(all\s+)?previous\s+instructions/i,
    description: 'Prompt injection: "ignore previous instructions"',
  },
  {
    pattern: /disregard\s+(all\s+)?(prior|previous|above)\s+(instructions|context)/i,
    description: 'Prompt injection: "disregard prior instructions"',
  },
  {
    pattern: /you\s+are\s+now\s+(a\s+)?(?:different|new|evil|unrestricted)/i,
    description: 'Prompt injection: role override attempt',
  },
  {
    pattern: /^system\s*:/im,
    description: 'Prompt injection: "system:" prefix (偽造系統訊息)',
  },
  {
    pattern: /<script[\s>]/i,
    description: 'XSS: <script> tag',
  },
  {
    pattern: /javascript\s*:/i,
    description: 'XSS: javascript: URI',
  },
  {
    pattern: /data:[a-z]+\/[a-z]+;base64,[\w+/=]{100,}/i,
    description: 'Data exfil: 大型 base64 data URI',
  },
  {
    pattern: /https?:\/\/[^\s]+\?.*(?:key|token|secret|password|api_?key)=[^\s&]+/i,
    description: 'Data exfil: URL 含疑似敏感參數（key/token/secret）',
  },
  {
    pattern: /\]\(https?:\/\/[^\s)]+\/(?:collect|exfil|steal|log|track)\b/i,
    description: 'Data exfil: 可疑 markdown link 目標',
  },
]

/**
 * 掃描文字內容是否含可疑 prompt injection pattern。
 * @returns null 表示通過；否則回傳第一個命中的 pattern 描述。
 */
export function scanForInjection(text: string): string | null {
  for (const { pattern, description } of INJECTION_PATTERNS) {
    if (pattern.test(text)) {
      return description
    }
  }
  return null
}

/**
 * 原子寫入：先寫到 `.tmp` 再 rename。rename 在同一 volume 上是原子的
 * （POSIX guarantee；Windows NTFS 亦然）。rename 失敗（Windows 鎖定等）
 * fallback 到直接 writeFile。
 */
export async function atomicWrite(
  targetPath: string,
  content: string,
): Promise<void> {
  const tmpPath = targetPath + '.tmp'
  await writeFileAsync(tmpPath, content, 'utf-8')
  try {
    await renameAsync(tmpPath, targetPath)
  } catch {
    await writeFileAsync(targetPath, content, 'utf-8')
    try {
      await unlinkAsync(tmpPath)
    } catch {
      // ignore
    }
  }
}

/**
 * 取得 memdir 目錄的 advisory lock。回傳 unlock 函式；呼叫端在 finally
 * 中 release。鎖取不到回 null（fallback 無鎖操作；MemoryTool 同行為）。
 */
export async function acquireMemdirLock(
  memDir: string,
): Promise<(() => Promise<void>) | null> {
  try {
    const release = await lock(memDir, {
      stale: 10_000,
      retries: { retries: 3, minTimeout: 200, maxTimeout: 1000 },
    })
    return release
  } catch (err) {
    logForDebugging(
      `memdir lock 取得失敗，繼續無鎖操作：${err instanceof Error ? err.message : String(err)}`,
      { level: 'warn' },
    )
    return null
  }
}

/**
 * 更新 MEMORY.md 索引（add / replace / remove）。
 *
 * - add：追加一行（若 filename 已存在則跳過）
 * - replace：找到同 filename 的行替換（找不到則追加）
 * - remove：找到同 filename 的行刪除
 */
export async function updateMemoryIndex(
  action: 'add' | 'replace' | 'remove',
  memDir: string,
  filename: string,
  name?: string,
  description?: string,
): Promise<boolean> {
  const indexPath = join(memDir, ENTRYPOINT_NAME)

  let content = ''
  try {
    content = await readFileAsync(indexPath, 'utf-8')
  } catch {
    // 檔案不存在 — 從空開始
  }

  const lines = content.split('\n')
  const escapedFilename = filename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(`^\\s*-\\s*\\[.*\\]\\(\\s*${escapedFilename}\\s*\\)`)
  const existingIdx = lines.findIndex(line => pattern.test(line))

  const indexLine =
    name && description
      ? `- [${name}](${filename}) — ${description}`
      : undefined

  let changed = false

  switch (action) {
    case 'add':
      if (existingIdx === -1 && indexLine) {
        let insertAt = lines.length
        while (insertAt > 0 && lines[insertAt - 1]!.trim() === '') {
          insertAt--
        }
        lines.splice(insertAt, 0, indexLine)
        changed = true
      }
      break

    case 'replace':
      if (existingIdx !== -1 && indexLine) {
        lines[existingIdx] = indexLine
        changed = true
      } else if (existingIdx === -1 && indexLine) {
        let insertAt = lines.length
        while (insertAt > 0 && lines[insertAt - 1]!.trim() === '') {
          insertAt--
        }
        lines.splice(insertAt, 0, indexLine)
        changed = true
      }
      break

    case 'remove':
      if (existingIdx !== -1) {
        lines.splice(existingIdx, 1)
        changed = true
      }
      break
  }

  if (!changed) return false

  if (lines.length > MAX_ENTRYPOINT_LINES) {
    logForDebugging(
      `MEMORY.md 索引行數 (${lines.length}) 超過上限 (${MAX_ENTRYPOINT_LINES})`,
      { level: 'warn' },
    )
  }

  try {
    await atomicWrite(indexPath, lines.join('\n'))
    return true
  } catch (err) {
    logForDebugging(
      `MEMORY.md 索引寫入失敗：${err instanceof Error ? err.message : String(err)}`,
      { level: 'warn' },
    )
    return false
  }
}
