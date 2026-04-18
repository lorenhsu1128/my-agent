/**
 * User Modeling — 讀寫、session 快照、雙層合併
 *
 * 設計重點：
 *   - Session 啟動時 loadSnapshot() 讀一次並凍結 → system prompt 用凍結版
 *     （穩定、prefix cache 友善，沿用 Hermes 設計）
 *   - MemoryTool 寫入後呼叫 invalidate() 不改 snapshot；但回傳 live content
 *     讓 LLM 看到剛寫入的內容
 *   - 雙層合併：global + per-project，project 以 "### Project-specific" 標題分隔
 */
import {
  readFile as readFileAsync,
  rename as renameAsync,
  unlink as unlinkAsync,
  writeFile as writeFileAsync,
} from 'fs/promises'
import { mkdir } from 'fs/promises'
import { dirname } from 'path'
import { lock } from '../utils/lockfile.js'
import { logForDebugging } from '../utils/debug.js'
import {
  getUserModelGlobalPath,
  getUserModelProjectPath,
} from './paths.js'

export type UserModelScope = 'global' | 'project'

export interface UserModelSnapshot {
  global: string
  project: string
  /** 注入用的合併文字（含分隔標題），可直接塞進 fence */
  combined: string
  /** 字元計數（global + project 合計，含分隔） */
  totalChars: number
}

const EMPTY_SNAPSHOT: UserModelSnapshot = {
  global: '',
  project: '',
  combined: '',
  totalChars: 0,
}

let cachedSnapshot: UserModelSnapshot | null = null

async function readFileSafe(path: string): Promise<string> {
  try {
    return (await readFileAsync(path, 'utf-8')).trim()
  } catch {
    return ''
  }
}

function buildCombined(global: string, project: string): string {
  const blocks: string[] = []
  if (global) blocks.push(global)
  if (project) blocks.push(`### Project-specific\n\n${project}`)
  return blocks.join('\n\n')
}

/**
 * 讀取 global + project 兩檔並組合為快照。
 * 不快取 disk 結果；由呼叫端決定是否用 cachedSnapshot。
 */
export async function readLive(): Promise<UserModelSnapshot> {
  const [globalText, projectText] = await Promise.all([
    readFileSafe(getUserModelGlobalPath()),
    readFileSafe(getUserModelProjectPath()),
  ])
  const combined = buildCombined(globalText, projectText)
  return {
    global: globalText,
    project: projectText,
    combined,
    totalChars: combined.length,
  }
}

/**
 * Session 啟動時呼叫，讀一次並凍結。之後 getSnapshot() 都拿這份。
 * 重複呼叫會覆蓋快照（測試用）。
 */
export async function loadSnapshot(): Promise<UserModelSnapshot> {
  cachedSnapshot = await readLive()
  return cachedSnapshot
}

/**
 * 取得已凍結的快照。若尚未載入則回傳空快照（呼叫端應先 loadSnapshot）。
 */
export function getSnapshot(): UserModelSnapshot {
  return cachedSnapshot ?? EMPTY_SNAPSHOT
}

/** 測試用：清除快取 */
export function _resetSnapshotForTests(): void {
  cachedSnapshot = null
}

// ---------------------------------------------------------------------------
// 寫入
// ---------------------------------------------------------------------------

async function atomicWrite(targetPath: string, content: string): Promise<void> {
  await mkdir(dirname(targetPath), { recursive: true })
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

function resolvePath(scope: UserModelScope): string {
  return scope === 'global'
    ? getUserModelGlobalPath()
    : getUserModelProjectPath()
}

async function acquireLock(
  target: string,
): Promise<(() => Promise<void>) | null> {
  try {
    // 鎖定目標的父目錄（檔案本身可能不存在，proper-lockfile 會報錯）
    return await lock(dirname(target), {
      stale: 10_000,
      retries: { retries: 3, minTimeout: 200, maxTimeout: 1000 },
    })
  } catch (err) {
    logForDebugging(
      `USER.md lock 取得失敗，無鎖繼續：${err instanceof Error ? err.message : String(err)}`,
      { level: 'warn' },
    )
    return null
  }
}

export type WriteAction = 'add' | 'replace' | 'remove'

/**
 * 寫入 USER.md。
 *   - add：追加一條新 entry（以 `- ` bullet 起頭，若 content 未含則自動加）
 *   - replace：整檔覆蓋為 content
 *   - remove：若 content 為空字串 → 清空整檔；否則移除第一個含 content 子字串的 entry
 */
export async function writeUserModel(params: {
  action: WriteAction
  scope: UserModelScope
  content?: string
}): Promise<{ success: boolean; message: string; filePath: string }> {
  const { action, scope } = params
  const content = params.content ?? ''
  const filePath = resolvePath(scope)

  const release = await acquireLock(filePath)
  try {
    const existing = await readFileSafe(filePath)

    let next: string
    let msg: string
    switch (action) {
      case 'add': {
        if (!content.trim()) {
          return { success: false, message: 'add 動作必須提供 content', filePath }
        }
        const line = content.trim().startsWith('- ')
          ? content.trim()
          : `- ${content.trim()}`
        next = existing ? `${existing}\n${line}` : line
        msg = `已新增使用者檔案條目（${scope}）`
        break
      }
      case 'replace': {
        next = content.trim()
        msg = `已替換使用者檔案內容（${scope}）`
        break
      }
      case 'remove': {
        if (!content.trim()) {
          next = ''
          msg = `已清空使用者檔案（${scope}）`
        } else {
          const needle = content.trim()
          const lines = existing.split('\n')
          const idx = lines.findIndex(l => l.includes(needle))
          if (idx === -1) {
            return {
              success: false,
              message: `找不到包含 "${needle}" 的條目`,
              filePath,
            }
          }
          lines.splice(idx, 1)
          next = lines.join('\n').trim()
          msg = `已移除使用者檔案條目（${scope}）`
        }
        break
      }
      default:
        return { success: false, message: `未知 action: ${action}`, filePath }
    }

    if (next) {
      await atomicWrite(filePath, next + '\n')
    } else {
      // 清空檔案（而非刪除，避免下次讀取判斷混亂）
      await atomicWrite(filePath, '')
    }
    return { success: true, message: msg, filePath }
  } finally {
    if (release) {
      try {
        await release()
      } catch {
        // ignore
      }
    }
  }
}
