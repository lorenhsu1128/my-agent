/**
 * Daemon WS bearer token 生成 / 讀寫 / 驗證。
 *
 * Token 是 64 字元 hex（32 bytes 隨機），存於 `~/.my-agent/daemon.token`。
 * 權限 0600（POSIX 有效；Windows 無效但 %USERPROFILE% 本身已隔離）。
 *
 * 驗證走 timing-safe compare，避免 token leak via timing attack
 * （雖然是 localhost 但多一層保險）。
 */
import { randomBytes, timingSafeEqual } from 'crypto'
import { chmod, mkdir, readFile, writeFile } from 'fs/promises'
import { dirname } from 'path'
import { logForDebugging } from '../utils/debug.js'
import { getDaemonPaths } from './paths.js'

export const TOKEN_BYTES = 32
const TOKEN_HEX_LENGTH = TOKEN_BYTES * 2

export function generateToken(): string {
  return randomBytes(TOKEN_BYTES).toString('hex')
}

function isValidTokenShape(token: string): boolean {
  return (
    typeof token === 'string' &&
    token.length === TOKEN_HEX_LENGTH &&
    /^[0-9a-f]+$/.test(token)
  )
}

export async function readToken(baseDir?: string): Promise<string | null> {
  const { tokenPath } = getDaemonPaths(baseDir)
  try {
    const raw = (await readFile(tokenPath, 'utf-8')).trim()
    if (!isValidTokenShape(raw)) {
      logForDebugging(`[daemon:token] malformed token file at ${tokenPath}`, {
        level: 'warn',
      })
      return null
    }
    return raw
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code
    if (code === 'ENOENT') return null
    logForDebugging(`[daemon:token] read failed: ${err}`, { level: 'warn' })
    return null
  }
}

export async function writeToken(
  token: string,
  baseDir?: string,
): Promise<void> {
  if (!isValidTokenShape(token)) {
    throw new Error(`Invalid token shape: expected ${TOKEN_HEX_LENGTH} hex chars`)
  }
  const { tokenPath } = getDaemonPaths(baseDir)
  await mkdir(dirname(tokenPath), { recursive: true })
  await writeFile(tokenPath, token, { encoding: 'utf-8', mode: 0o600 })
  // writeFile 的 mode 在 Windows 是 no-op，也對既有檔案的 mode 無效；補一次 chmod。
  try {
    await chmod(tokenPath, 0o600)
  } catch {
    // Windows 上 chmod 效果有限；忽略錯誤（%USERPROFILE% 已是 per-user 隔離）。
  }
}

/**
 * 取得可用 token：檔案有效就讀出，否則生成新的寫入並回傳。
 * Daemon 啟動時呼叫；REPL attach 前呼叫 `readToken` 即可（沒有就代表 daemon 還沒跑）。
 */
export async function ensureToken(baseDir?: string): Promise<string> {
  const existing = await readToken(baseDir)
  if (existing) return existing
  const fresh = generateToken()
  await writeToken(fresh, baseDir)
  return fresh
}

/**
 * Timing-safe token 比對。長度不同直接回 false（不進 timingSafeEqual，因為它會丟）。
 */
export function compareTokens(provided: string, expected: string): boolean {
  if (
    typeof provided !== 'string' ||
    typeof expected !== 'string' ||
    provided.length !== expected.length
  ) {
    return false
  }
  try {
    return timingSafeEqual(Buffer.from(provided), Buffer.from(expected))
  } catch {
    return false
  }
}
