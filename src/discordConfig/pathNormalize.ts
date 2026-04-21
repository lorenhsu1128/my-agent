/**
 * 把路徑 normalize 成跨 Windows/POSIX 一致的字串比對格式。
 *
 * - `path.resolve()` 吸收相對路徑、`.`、`..`
 * - Windows 驅動字母統一小寫（`C:` === `c:`，配合 NTFS case-insensitive）
 * - 分隔符一律轉 forward slash（/）— JSON 裡不需 escape，兩種 OS 都能比對
 *
 * 僅影響**字串比較**；Node `fs.*` 在 Windows 對兩種分隔符都能正常 open/read，
 * 所以 normalize 後的路徑仍可直接傳給 filesystem API。
 *
 * 應用點：
 *   - `channelBindings[channelId]` 的 value
 *   - `projects[].path`
 *   - `defaultProjectPath`
 */
import { resolve as pathResolve } from 'path'

export function normalizeProjectPath(p: string): string {
  if (!p) return p
  const resolved = pathResolve(p)
  const forward = resolved.replace(/\\/g, '/')
  if (process.platform === 'win32' && /^[A-Z]:/.test(forward)) {
    return forward[0]!.toLowerCase() + forward.slice(1)
  }
  return forward
}
