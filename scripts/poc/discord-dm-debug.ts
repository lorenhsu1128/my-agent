/**
 * Debug script：bot 連上、log 任何 MessageCreate / InteractionCreate / 一般 raw
 * gateway event；使用者 DM / slash 看 console 有沒有訊息。
 *
 * 用法（兩種皆可）：
 *   DISCORD_BOT_TOKEN=... bun run scripts/poc/discord-dm-debug.ts
 *   bun run scripts/poc/discord-dm-debug.ts   (讀 discord.json.botToken)
 *
 * 會 block 30 秒（讓你有時間 DM），然後自動退出。
 */
import {
  Client,
  Events,
  GatewayIntentBits,
  Partials,
} from 'discord.js'
import {
  getDiscordBotToken,
  loadDiscordConfigSnapshot,
} from '../../src/discordConfig/index.js'

async function main(): Promise<number> {
  await loadDiscordConfigSnapshot()
  const token = getDiscordBotToken()
  if (!token) {
    // eslint-disable-next-line no-console
    console.error('no token — set DISCORD_BOT_TOKEN or discord.json botToken')
    return 2
  }

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildMessageReactions,
      GatewayIntentBits.DirectMessageReactions,
    ],
    partials: [Partials.Channel, Partials.Message, Partials.User],
  })

  client.once(Events.ClientReady, () => {
    // eslint-disable-next-line no-console
    console.log(
      `[debug] ready as ${client.user?.tag} (id=${client.user?.id}); DM / slash 試試看`,
    )
  })

  client.on(Events.MessageCreate, msg => {
    // eslint-disable-next-line no-console
    console.log(
      `[debug] MessageCreate: authorId=${msg.author.id} bot=${msg.author.bot} channelType=${msg.channel?.type} channelId=${msg.channelId} content="${msg.content.slice(0, 80)}"`,
    )
  })

  client.on(Events.InteractionCreate, interaction => {
    // eslint-disable-next-line no-console
    console.log(
      `[debug] InteractionCreate: userId=${interaction.user.id} type=${interaction.type} name=${interaction.isChatInputCommand() ? interaction.commandName : '(non-slash)'}`,
    )
  })

  client.on(Events.Error, err => {
    // eslint-disable-next-line no-console
    console.error(`[debug] error: ${err instanceof Error ? err.message : String(err)}`)
  })
  client.on(Events.Warn, info => {
    // eslint-disable-next-line no-console
    console.warn(`[debug] warn: ${info}`)
  })
  client.on('debug' as never, info => {
    const s = String(info)
    // 只印重要的，避免每秒 heartbeat 洗版
    if (
      s.includes('MESSAGE') ||
      s.includes('DM') ||
      s.includes('Channel') ||
      s.includes('Failed') ||
      s.includes('error')
    ) {
      // eslint-disable-next-line no-console
      console.log(`[debug:raw] ${s}`)
    }
  })

  try {
    await client.login(token)
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(`login failed: ${e instanceof Error ? e.message : String(e)}`)
    return 1
  }

  // Prefetch DM channels for whitelist users (workaround for discord.js v14 DM partial bug)
  const cfg = await loadDiscordConfigSnapshot()
  for (const userId of cfg.whitelistUserIds) {
    try {
      const u = await client.users.fetch(userId)
      await u.createDM()
      // eslint-disable-next-line no-console
      console.log(`[debug] prefetched DM for user ${userId}`)
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(
        `[debug] prefetch DM failed for ${userId}: ${e instanceof Error ? e.message : String(e)}`,
      )
    }
  }

  // 跑 30 秒然後退出
  await new Promise(r => setTimeout(r, 30_000))
  // eslint-disable-next-line no-console
  console.log('[debug] 30s done, destroying')
  await client.destroy()
  return 0
}

void main().then(c => process.exit(c))
