/**
 * M-DISCORD-3：訊息 → project 路由。
 *
 * 使用者決策（Q1=混合）：
 *   - DM：訊息前綴 `#<projectId|alias> <rest>` 指定 project；沒前綴 → defaultProjectPath
 *   - Server channel：`channelBindings[channelId]` 查到就綁，沒綁就忽略
 *
 * 只做純函式解析；不碰 discord.js Client。輸入是 "已抽象化的訊息脈絡"
 * （channelId / type / content / authorId），輸出是 routing 結果。
 */
import type { DiscordConfig, DiscordProject } from '../discordConfig/schema.js'

export type MessageChannelType = 'dm' | 'guild'

export interface DiscordMessageContext {
  channelType: MessageChannelType
  channelId: string
  authorId: string
  content: string
}

export type RoutingResult =
  | {
      ok: true
      /** 目標 project 的絕對 cwd 路徑（要送到 registry.loadProject）。 */
      projectPath: string
      /** 去前綴後要送給 agent 的 prompt 內容。 */
      prompt: string
      /** 哪條規則命中：方便 /list 等 debug。 */
      via: 'prefix' | 'default' | 'channel-binding'
      /** DM prefix 命中時原本的 projectId（for log）。 */
      matchedId?: string
    }
  | {
      ok: false
      reason:
        | 'whitelist'
        | 'no-default'
        | 'no-binding'
        | 'prefix-unknown'
        | 'empty'
      /** 幫 UX：回饋給使用者的人話（可選）。 */
      hint?: string
    }

const PREFIX_REGEX = /^#([\p{L}\p{N}_\-.]+)(?:\s+|$)/u

/**
 * 嘗試從 DM content 解析 `#project-id rest...` 前綴。
 * 命中回傳 { projectKey, stripped }；沒命中回傳 null。
 * projectKey 會與 projects[].id 和 aliases 做 case-sensitive 比對（aliases 定義時就該寫死大小寫）。
 */
export function parseProjectPrefix(
  content: string,
): { projectKey: string; stripped: string } | null {
  const trimmed = content.trimStart()
  const m = PREFIX_REGEX.exec(trimmed)
  if (!m) return null
  const key = m[1]!
  const stripped = trimmed.slice(m[0].length)
  return { projectKey: key, stripped }
}

function findProjectByKey(
  key: string,
  projects: ReadonlyArray<DiscordProject>,
): DiscordProject | null {
  for (const p of projects) {
    if (p.id === key) return p
    if (p.aliases.includes(key)) return p
  }
  return null
}

export function isUserWhitelisted(
  userId: string,
  config: DiscordConfig,
): boolean {
  return config.whitelistUserIds.includes(userId)
}

export function routeMessage(
  msg: DiscordMessageContext,
  config: DiscordConfig,
): RoutingResult {
  // 1. 白名單檢查
  if (!isUserWhitelisted(msg.authorId, config)) {
    return { ok: false, reason: 'whitelist' }
  }

  // 2. Guild channel：只有 binding 命中才處理
  if (msg.channelType === 'guild') {
    const projectPath = config.channelBindings[msg.channelId]
    if (!projectPath) {
      return { ok: false, reason: 'no-binding' }
    }
    if (msg.content.trim().length === 0) {
      return { ok: false, reason: 'empty' }
    }
    return {
      ok: true,
      projectPath,
      prompt: msg.content,
      via: 'channel-binding',
    }
  }

  // 3. DM：解析前綴，否則 fallback defaultProjectPath
  const parsed = parseProjectPrefix(msg.content)
  if (parsed) {
    const found = findProjectByKey(parsed.projectKey, config.projects)
    if (!found) {
      return {
        ok: false,
        reason: 'prefix-unknown',
        hint: `Unknown project \`#${parsed.projectKey}\`. 可用：${config.projects
          .map(p => `#${p.id}`)
          .join(' / ') || '(尚未設定)'}`,
      }
    }
    if (parsed.stripped.trim().length === 0) {
      return { ok: false, reason: 'empty' }
    }
    return {
      ok: true,
      projectPath: found.path,
      prompt: parsed.stripped,
      via: 'prefix',
      matchedId: found.id,
    }
  }

  if (!config.defaultProjectPath) {
    return {
      ok: false,
      reason: 'no-default',
      hint: `請用 \`#<project> ...\` 前綴，或在 discord.json 設 defaultProjectPath。可用：${config.projects
        .map(p => `#${p.id}`)
        .join(' / ') || '(無)'}`,
    }
  }
  if (msg.content.trim().length === 0) {
    return { ok: false, reason: 'empty' }
  }
  return {
    ok: true,
    projectPath: config.defaultProjectPath,
    prompt: msg.content,
    via: 'default',
  }
}
