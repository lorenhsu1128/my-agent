/**
 * M-DISCORD-AUTOBIND：per-project channel 生命週期操作（discord.js 薄封裝）。
 *
 * 所有 API 都要傳 raw discord.js Client（由 DiscordClientHandle.raw 拿）；
 * 不直接依賴 client.ts（避免循環）。
 */
import { ChannelType, type Client, type Guild, type TextChannel } from 'discord.js'

export interface CreateChannelResult {
  channelId: string
  name: string
  url: string
}

/**
 * 在指定 guild 建一個 text channel；caller 應先以 `computeChannelName` 算好名字。
 * @throws 若 guild 找不到、bot 缺 Manage Channels 權限、或 Discord API 錯誤。
 */
export async function createProjectChannel(
  client: Client,
  guildId: string,
  name: string,
  topic: string,
): Promise<CreateChannelResult> {
  const guild = await fetchGuild(client, guildId)
  const created = await guild.channels.create({
    name,
    type: ChannelType.GuildText,
    topic,
  })
  return {
    channelId: created.id,
    name: created.name,
    url: `https://discord.com/channels/${guildId}/${created.id}`,
  }
}

/**
 * 把一個 channel 移到 archive category（若 categoryId 設定）+ 改名加 `stale-` 前綴。
 * 若 category 不存在或搬移失敗 → 只改名（不 throw），回傳是否實際搬移成功。
 */
export async function archiveProjectChannel(
  client: Client,
  guildId: string,
  channelId: string,
  archiveCategoryId: string | undefined,
): Promise<{ moved: boolean; renamed: boolean }> {
  const guild = await fetchGuild(client, guildId)
  const channel = await guild.channels.fetch(channelId).catch(() => null)
  if (!channel || channel.type !== ChannelType.GuildText) {
    return { moved: false, renamed: false }
  }
  const textCh = channel as TextChannel
  let renamed = false
  let moved = false
  const currentName = textCh.name
  if (!currentName.startsWith('stale-')) {
    const next = `stale-${currentName}`.slice(0, 100)
    try {
      await textCh.setName(next)
      renamed = true
    } catch {
      // ignore
    }
  }
  if (archiveCategoryId) {
    try {
      await textCh.setParent(archiveCategoryId, { lockPermissions: false })
      moved = true
    } catch {
      // ignore
    }
  }
  return { moved, renamed }
}

/**
 * 改 channel 名。`/discord-unbind` 用，為 `unbound-<original>` 前綴。
 */
export async function renameChannel(
  client: Client,
  guildId: string,
  channelId: string,
  newName: string,
): Promise<boolean> {
  const guild = await fetchGuild(client, guildId)
  const channel = await guild.channels.fetch(channelId).catch(() => null)
  if (!channel || channel.type !== ChannelType.GuildText) return false
  try {
    await (channel as TextChannel).setName(newName.slice(0, 100))
    return true
  } catch {
    return false
  }
}

/**
 * 檢查 channel 是否還存在且 bot 可見（跨所有 guild — 支援 foreign-guild
 * 綁定，即 `/discord-bind-other-channel` 寫的 binding）。
 *
 * 以前用 `guild.channels.fetch(channelId)` 只在自家 `config.guildId` 找，
 * 導致對方 guild 的 channel 被當成 stale → 每次重啟 daemon 都會清掉 foreign
 * bindings。改為 `client.channels.fetch(channelId)`（client 層級跨 guild）。
 *
 * `guildId` 參數保留給舊 caller 相容；新邏輯不使用它。
 */
export async function channelExists(
  client: Client,
  _guildId: string,
  channelId: string,
): Promise<boolean> {
  try {
    const ch = await client.channels.fetch(channelId).catch(() => null)
    return ch !== null
  } catch {
    return false
  }
}

/**
 * 發送 welcome 訊息到新建的 project channel。
 */
export async function sendWelcomeMessage(
  client: Client,
  channelId: string,
  params: {
    projectName: string
    projectPath: string
    projectId: string
  },
): Promise<void> {
  const ch = await client.channels.fetch(channelId)
  if (!ch || !ch.isTextBased() || !('send' in ch)) return
  const content =
    `🚀 **Project bound**: \`${params.projectName}\`\n` +
    `Path: \`${params.projectPath}\`\n` +
    `Project ID: \`${params.projectId}\`\n\n` +
    `在此頻道發訊息會觸發此專案的 turn。\n` +
    `Slash commands: \`/status\` \`/help\` \`/mode\` \`/clear\` \`/interrupt\``
  await ch.send({ content })
}

async function fetchGuild(client: Client, guildId: string): Promise<Guild> {
  const cached = client.guilds.cache.get(guildId)
  if (cached) return cached
  const fetched = await client.guilds.fetch(guildId)
  return fetched
}
