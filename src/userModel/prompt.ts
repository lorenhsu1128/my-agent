/**
 * User Modeling — system prompt 注入格式
 *
 * <user-profile> fence 放在 system prompt 頂部。設計為簡短、穩定、可快取。
 * 超過 SOFT_LIMIT 只告警不截斷；真正超大才會影響 prefix cache 效率，
 * 由使用者自行精煉（或未來加 auto-summarize）。
 */
import { isUserModelEnabled } from './paths.js'
import { loadSnapshot, type UserModelSnapshot } from './userModel.js'
import { getSection as getExternalSection } from '../systemPromptFiles/index.js'

export const USER_PROFILE_SOFT_LIMIT = 1500

/**
 * 產生 <user-profile> 區塊。snapshot 為空時回 null（呼叫端決定略過注入）。
 */
// M-SP-3: 外框 header 已外部化至 ~/.my-agent/system-prompt/user-profile-frame.md
// .md 內容為 header 段（`<user-profile>\n# About...\n\n...指示文字...\n`）；
// snapshot.combined 由程式插入於末尾，`</user-profile>` 為固定尾框。
const USER_PROFILE_FRAME_FALLBACK = `<user-profile>
# About the user

The following is a curated profile of the user you are talking to. Treat it as durable context that applies throughout the session.
`

export function formatUserProfileBlock(
  snapshot: UserModelSnapshot,
): string | null {
  if (!snapshot.combined.trim()) {
    return null
  }
  const warning =
    snapshot.totalChars > USER_PROFILE_SOFT_LIMIT
      ? `\n<!-- user profile 大小 ${snapshot.totalChars} chars，建議收斂至 ${USER_PROFILE_SOFT_LIMIT} 內 -->`
      : ''
  const header =
    getExternalSection('user-profile-frame') ?? USER_PROFILE_FRAME_FALLBACK
  return [
    header.trimEnd(),
    '',
    snapshot.combined.trim(),
    '</user-profile>' + warning,
  ].join('\n')
}

/**
 * system prompt 入口：載入 snapshot（session 首次）並格式化。
 * 開關關閉或 snapshot 為空時回傳 null。
 */
export async function loadUserProfilePrompt(): Promise<string | null> {
  if (!isUserModelEnabled()) {
    return null
  }
  try {
    const snapshot = await loadSnapshot()
    return formatUserProfileBlock(snapshot)
  } catch {
    return null
  }
}
