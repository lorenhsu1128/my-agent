/**
 * M-DISCORD-AUTOBIND：per-project channel 命名。
 *
 * 規則：
 *   1. dirname（basename of cwd）嘗試 sanitize 為 Discord 合法名（小寫、a-z0-9_-）
 *      - ASCII 字母/數字：直接 kebab-case
 *      - 中文：走 pinyin-pro 轉拼音（無聲調，音節之間 `-`）
 *      - 其他（日文 / 韓文 / emoji / Cyrillic...）：放棄，用 fallback
 *   2. fallback = `proj`
 *   3. 最終名 = `<sanitized>-<shortHash6>`，shortHash 取 projectId 前 6 字
 *   4. 長度上限 Discord 官方 100 字元
 */
import { pinyin } from 'pinyin-pro'

const DISCORD_CHANNEL_NAME_MAX = 100
const HASH_LEN = 6

/**
 * 把 dirname sanitize 成 Discord 合法 segment。
 * 失敗（全是不支援字元）時回 null，呼叫端會用 `proj` fallback。
 */
export function sanitizeDirname(name: string): string | null {
  if (!name) return null

  // 判斷是否含 CJK 漢字 → 走 pinyin 整段轉換
  const hasHan = /[\u4e00-\u9fff]/.test(name)
  let converted = name
  if (hasHan) {
    try {
      // pinyin-pro：無聲調、音節空格分隔
      converted = pinyin(name, { toneType: 'none', separator: ' ' })
    } catch {
      // pinyin lib 異常 → 保留原字元，後面會被過濾光
      converted = name
    }
  }

  // 統一小寫、把空白/底線/點/斜線等 → `-`
  const lowered = converted
    .toLowerCase()
    .replace(/[\s_./\\]+/g, '-')

  // 只保留 a-z / 0-9 / `-`
  const filtered = lowered.replace(/[^a-z0-9-]/g, '')

  // 合併連續 `-`、去除首尾 `-`
  const collapsed = filtered.replace(/-+/g, '-').replace(/^-+|-+$/g, '')

  if (!collapsed) return null
  return collapsed
}

/**
 * projectId 前 HASH_LEN 字當 short hash。projectId 已經是 sanitized path hash
 * （由 `projectIdFromCwd` 產生），用它的前綴當 disambiguator 足夠。
 */
export function shortHash(projectId: string): string {
  // projectId 可能含 `-` / 字母 / 數字，抽前 HASH_LEN 個 [a-z0-9] 字元
  const filtered = projectId.toLowerCase().replace(/[^a-z0-9]/g, '')
  if (filtered.length >= HASH_LEN) return filtered.slice(0, HASH_LEN)
  // projectId 太短（罕見），pad 到 HASH_LEN
  return (filtered + '000000').slice(0, HASH_LEN)
}

/**
 * 組最終 channel name。
 * @param projectId - daemon 的 projectIdFromCwd 結果
 * @param dirname - cwd 的 basename（不含父路徑）
 */
export function computeChannelName(
  projectId: string,
  dirname: string,
): string {
  const sanitized = sanitizeDirname(dirname)
  const hash = shortHash(projectId)
  const base = sanitized ?? 'proj'
  const combined = `${base}-${hash}`
  if (combined.length <= DISCORD_CHANNEL_NAME_MAX) return combined
  // 超長（理論上 projectId 有常數 hash + 使用者超長 dirname 才會到）→ 裁 base
  const maxBaseLen = DISCORD_CHANNEL_NAME_MAX - hash.length - 1
  return `${base.slice(0, maxBaseLen)}-${hash}`
}
