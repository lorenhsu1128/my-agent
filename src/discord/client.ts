/**
 * M-DISCORD-3c：discord.js Client 薄封裝。
 *
 * 職責：
 *   - login / destroy 生命週期
 *   - 把 discord.js Message event 轉成 DiscordIncomingMessage（標準化）
 *   - 把 ChannelMessageSink 封裝成 DiscordChannelSink（隔離 discord.js API）
 *
 * 不處理：
 *   - whitelist / 路由（gateway.ts 做）
 *   - Slash commands（M-DISCORD-4）
 */
import {
  AttachmentBuilder,
  Client,
  Events,
  GatewayIntentBits,
  type ChannelType,
  type Interaction,
  type Message,
  type TextBasedChannel,
  ChannelType as ChannelTypeEnum,
} from 'discord.js'
import type {
  DiscordAttachment,
  DiscordChannelSink,
  DiscordIncomingMessage,
} from './types.js'

export interface DiscordClientOptions {
  /** Bot token — 來源是 process.env.DISCORD_BOT_TOKEN，caller 讀取後傳入。 */
  token: string
  /** Message handler — whitelist / 路由在上層做。 */
  onMessage?: (msg: DiscordIncomingMessage, raw: Message) => void
  /** Slash command / button interaction。whitelist 在上層做。 */
  onInteraction?: (interaction: Interaction) => void
  /** 連線 ready 後的 callback（拿到 bot user 資訊）。 */
  onReady?: (info: { botId: string; botTag: string }) => void
  /** 連線錯誤（disconnect / 重連失敗等）。 */
  onError?: (err: unknown) => void
}

export interface DiscordClientHandle {
  /** 啟動連線；resolve = Ready；reject = login 失敗。 */
  connect(): Promise<void>
  /** 關閉連線 + 清資源（冪等）。 */
  destroy(): Promise<void>
  /** 對當前 raw Message 建 sink（供 gateway 綁定每則訊息的輸出）。 */
  sinkForChannel(channel: TextBasedChannel): DiscordChannelSink
  /** 給 gateway 用：直接對 home channel 送訊息（cron / 長任務通知等）。 */
  sinkForChannelId(channelId: string): DiscordChannelSink
  /** 原始 discord.js Client（給 slash commands 註冊等 low-level 操作用）。 */
  readonly raw: Client
  readonly state: 'idle' | 'connecting' | 'ready' | 'closed'
}

function adaptAttachments(msg: Message): DiscordAttachment[] {
  const out: DiscordAttachment[] = []
  for (const [, att] of msg.attachments) {
    out.push({
      id: att.id,
      filename: att.name,
      url: att.url,
      contentType: att.contentType ?? undefined,
      size: att.size,
    })
  }
  return out
}

function adaptIncoming(msg: Message): DiscordIncomingMessage {
  const isDm = msg.channel.type === ChannelTypeEnum.DM
  return {
    id: msg.id,
    channelId: msg.channelId,
    channelType: isDm ? 'dm' : 'guild',
    guildId: msg.guildId ?? undefined,
    authorId: msg.author.id,
    authorUsername: msg.author.username,
    content: msg.content,
    attachments: adaptAttachments(msg),
    receivedAt: Date.now(),
  }
}

export function createDiscordClient(
  opts: DiscordClientOptions,
): DiscordClientHandle {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildMessageReactions,
      GatewayIntentBits.DirectMessageReactions,
    ],
    // DM 在 discord.js v14 需要 Partials.Channel 才會收到
    partials: ['CHANNEL' as never, 'MESSAGE' as never],
  })

  let state: 'idle' | 'connecting' | 'ready' | 'closed' = 'idle'

  client.on(Events.MessageCreate, rawMsg => {
    // 忽略 bot 自己的訊息 + 其他 bot 的訊息（避免迴圈）
    if (rawMsg.author?.bot) return
    try {
      const adapted = adaptIncoming(rawMsg)
      opts.onMessage?.(adapted, rawMsg)
    } catch (e) {
      opts.onError?.(e)
    }
  })

  client.on(Events.InteractionCreate, interaction => {
    try {
      opts.onInteraction?.(interaction)
    } catch (e) {
      opts.onError?.(e)
    }
  })

  client.on(Events.Error, err => {
    opts.onError?.(err)
  })
  client.on(Events.Warn, info => {
    opts.onError?.(new Error(`discord.js warn: ${info}`))
  })

  const sinkFor = (
    channel: TextBasedChannel | null | undefined,
    fallbackChannelId?: string,
  ): DiscordChannelSink => {
    const resolve = async (): Promise<TextBasedChannel | null> => {
      if (channel) return channel
      if (!fallbackChannelId) return null
      try {
        const c = await client.channels.fetch(fallbackChannelId)
        if (c && c.isTextBased()) return c as TextBasedChannel
      } catch {
        // ignore
      }
      return null
    }
    return {
      async send(params) {
        const ch = await resolve()
        if (!ch || !('send' in ch)) {
          throw new Error(
            `channel ${fallbackChannelId ?? '(unknown)'} not text-based or not fetchable`,
          )
        }
        const files = params.files
          ? params.files.map(p => new AttachmentBuilder(p))
          : undefined
        const sent = await ch.send({
          content: params.content,
          reply: params.replyToId
            ? { messageReference: params.replyToId, failIfNotExists: false }
            : undefined,
          files,
        })
        return { messageId: sent.id }
      },
      async addReaction(messageId, emoji) {
        const ch = await resolve()
        if (!ch) return
        try {
          const m = await ch.messages.fetch(messageId)
          await m.react(emoji)
        } catch {
          // Reaction 失敗吞掉（訊息被刪 / 權限不足）
        }
      },
      async removeReaction(messageId, emoji) {
        const ch = await resolve()
        if (!ch) return
        try {
          const m = await ch.messages.fetch(messageId)
          const botId = client.user?.id
          if (!botId) return
          const reaction = m.reactions.cache.get(emoji)
          if (reaction) {
            await reaction.users.remove(botId)
          }
        } catch {
          // ignore
        }
      },
      async sendTyping() {
        const ch = await resolve()
        if (!ch) return
        if ('sendTyping' in ch && typeof ch.sendTyping === 'function') {
          try {
            await ch.sendTyping()
          } catch {
            // ignore
          }
        }
      },
    }
  }

  return {
    get raw() {
      return client
    },
    get state() {
      return state
    },
    async connect() {
      if (state !== 'idle') {
        throw new Error(`client already ${state}`)
      }
      state = 'connecting'
      await new Promise<void>((resolve, reject) => {
        const onReady = (): void => {
          state = 'ready'
          opts.onReady?.({
            botId: client.user?.id ?? '(unknown)',
            botTag: client.user?.tag ?? '(unknown)',
          })
          resolve()
        }
        client.once(Events.ClientReady, onReady)
        client.login(opts.token).catch((e: unknown) => {
          state = 'closed'
          client.off(Events.ClientReady, onReady)
          reject(e instanceof Error ? e : new Error(String(e)))
        })
      })
    },
    async destroy() {
      if (state === 'closed') return
      state = 'closed'
      try {
        await client.destroy()
      } catch {
        // ignore
      }
    },
    sinkForChannel(channel) {
      return sinkFor(channel)
    },
    sinkForChannelId(channelId) {
      return sinkFor(null, channelId)
    },
  }
}

// Re-export the discord.js channel type enum for gateway convenience.
export { ChannelType, type Message, type TextBasedChannel }
