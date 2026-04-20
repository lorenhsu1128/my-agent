/**
 * M-DISCORD-3c：DiscordGateway — 一個訊息進來到跑起 turn 的全流程 orchestrator。
 *
 * Flow：
 *   1. discord.js Message → adaptIncoming（client.ts）
 *   2. routeMessage（whitelist + DM prefix / channel binding → projectPath + prompt）
 *   3. registry.loadProject(projectPath) → runtime
 *   4. adaptDiscordMessage（cache images + build prompt text）
 *   5. runtime.broker.queue.submit(promptText) → inputId
 *   6. 建 DiscordChannelSink (on msg.channel) + ReactionController + StreamOutputController
 *   7. Subscribe broker events filter by inputId：
 *      - turnStart → reactions.onTurnStart
 *      - runnerEvent.output → streamOutput.handleOutput
 *      - turnEnd → reactions.onTurnEnd + streamOutput.finalize → unsubscribe
 *
 * 不處理（後續 milestone）：
 *   - slash commands（/status /clear /mode 等 — M-DISCORD-4）
 *   - permission mode 雙向同步（M-DISCORD-4）
 *   - home channel 長任務通知（M-DISCORD-5）
 */
import { adaptDiscordMessage } from './messageAdapter.js'
import { createReactionController } from './reactions.js'
import {
  createStreamOutputController,
  extractAssistantText,
  type StreamReplyMode,
} from './streamOutput.js'
import { truncateForDiscord } from './truncate.js'
import { isUserWhitelisted, routeMessage } from './router.js'
import {
  handleInteraction,
  registerSlashCommands,
  type SlashHandlerContext,
} from './slashCommands.js'
import type { DiscordConfig } from '../discordConfig/schema.js'
import type { DiscordClientHandle } from './client.js'
import type {
  DiscordChannelSink,
  DiscordIncomingMessage,
  ReactionTarget,
} from './types.js'
import type { Interaction, Message, TextBasedChannel } from 'discord.js'
import type { ProjectRegistry, ProjectRuntime } from '../daemon/projectRegistry.js'
import type { PermissionMode } from '../types/permissions.js'
import type {
  RunnerEventWrapper,
  TurnEndEvent,
  TurnStartEvent,
} from '../daemon/inputQueue.js'
import { logForDebugging } from '../utils/debug.js'

export interface DiscordGatewayOptions {
  config: DiscordConfig
  client: DiscordClientHandle
  registry: ProjectRegistry
  /** llamacpp vision 是否啟用（決定 image attachment 進 agent 的格式）。 */
  visionEnabled: boolean
  /**
   * M-DISCORD-4：permission mode 雙向同步 — Discord `/mode` 變更後呼叫，
   * 由 daemonCli 注入（會透過 directConnectServer broadcast 同 project 的
   * attached REPL）。未注入則只改 runtime AppState，REPL 不會收到通知。
   */
  broadcastPermissionMode?: (projectId: string, mode: PermissionMode) => void
  /** Log handle（daemon logger）；nil 時走 logForDebugging。 */
  log?: {
    info: (msg: string, meta?: Record<string, unknown>) => Promise<void> | void
    warn: (msg: string, meta?: Record<string, unknown>) => Promise<void> | void
    error: (
      msg: string,
      meta?: Record<string, unknown>,
    ) => Promise<void> | void
  }
}

export interface DiscordGateway {
  dispose(): Promise<void>
}

export function createDiscordGateway(
  opts: DiscordGatewayOptions,
): DiscordGateway {
  const { config, client, registry, visionEnabled } = opts
  const log = opts.log

  // M-DISCORD-4：per-project pending permission 追蹤，供 /allow /deny 找
  // 最近一個 pending toolUseID。ProjectRuntime 第一次被 load 時掛 onPending /
  // onResolved 監聽器。
  const pendingPermissions = new Map<string, string[]>()
  const permissionUnsubs = new Map<string, Array<() => void>>()
  const ensurePermissionTracking = (runtime: ProjectRuntime): void => {
    if (permissionUnsubs.has(runtime.projectId)) return
    const queue: string[] = []
    pendingPermissions.set(runtime.projectId, queue)
    const unsubPending = runtime.permissionRouter.onPending(info => {
      queue.push(info.toolUseID)
    })
    const unsubResolved = runtime.permissionRouter.onResolved(info => {
      const idx = queue.indexOf(info.toolUseID)
      if (idx >= 0) queue.splice(idx, 1)
    })
    permissionUnsubs.set(runtime.projectId, [unsubPending, unsubResolved])
  }

  // M-DISCORD-5：Home channel mirror — REPL / cron 發起的 turn 輸出鏡到
  // homeChannelId（discord.json 可設）。Discord source 的 turn 略過，避免
  // 跟 streamOutput 的 reply 雙貼。每個 runtime 第一次 load 時掛一份 listener。
  const homeMirrorUnsubs = new Map<string, () => void>()
  const ensureHomeMirror = (runtime: ProjectRuntime): void => {
    if (homeMirrorUnsubs.has(runtime.projectId)) return
    if (!config.homeChannelId) return // 沒設 home channel 就不做
    // 累積每個 turn 的輸出（by inputId）— 對應 onOutput；turnEnd 時 post
    const turnBuffers = new Map<
      string,
      { source: string; text: string; startedAt: number }
    >()
    const onTurnStart = (e: TurnStartEvent): void => {
      // 只鏡 REPL / cron / slash / unknown；Discord source 由 streamOutput 專送
      if (e.input.source === 'discord') return
      turnBuffers.set(e.input.id, {
        source: e.input.source,
        text: '',
        startedAt: e.startedAt,
      })
    }
    const onRunnerEvent = (w: RunnerEventWrapper): void => {
      const buf = turnBuffers.get(w.input.id)
      if (!buf) return
      if (w.event.type !== 'output') return
      const chunk = extractAssistantText(w.event.payload)
      if (chunk) buf.text += chunk
    }
    const onTurnEnd = (e: TurnEndEvent): void => {
      const buf = turnBuffers.get(e.input.id)
      if (!buf) return
      turnBuffers.delete(e.input.id)
      void postHomeMirror(runtime, buf, e)
    }
    runtime.broker.queue.on('turnStart', onTurnStart)
    runtime.broker.queue.on('runnerEvent', onRunnerEvent)
    runtime.broker.queue.on('turnEnd', onTurnEnd)
    homeMirrorUnsubs.set(runtime.projectId, () => {
      runtime.broker.queue.off('turnStart', onTurnStart as never)
      runtime.broker.queue.off('runnerEvent', onRunnerEvent as never)
      runtime.broker.queue.off('turnEnd', onTurnEnd as never)
      turnBuffers.clear()
    })
  }

  const postHomeMirror = async (
    runtime: ProjectRuntime,
    buf: { source: string; text: string; startedAt: number },
    turnEnd: TurnEndEvent,
  ): Promise<void> => {
    if (!config.homeChannelId) return
    try {
      const sink = client.sinkForChannelId(config.homeChannelId)
      const durationMs = turnEnd.endedAt - buf.startedAt
      const durationStr =
        durationMs > 60_000
          ? `${(durationMs / 60_000).toFixed(1)}min`
          : `${(durationMs / 1000).toFixed(1)}s`
      const icon =
        turnEnd.reason === 'done'
          ? '✅'
          : turnEnd.reason === 'error'
            ? '❌'
            : '⏹️'
      const header =
        `${icon} \`${runtime.projectId.slice(0, 28)}\` ` +
        `${buf.source} turn · ${durationStr}` +
        (turnEnd.reason === 'error' && turnEnd.error
          ? ` · error: ${turnEnd.error.slice(0, 80)}`
          : '')
      const body = buf.text.trim()
      const full = body ? `${header}\n${body}` : header
      const chunks = truncateForDiscord(full)
      for (let i = 0; i < chunks.length; i++) {
        await sink.send({ content: chunks[i]! })
      }
    } catch (e) {
      void log?.warn?.('home mirror post failed', {
        projectId: runtime.projectId,
        err: e instanceof Error ? e.message : String(e),
      })
    }
  }

  // M-DISCORD-5：監聽 registry load 事件，新 runtime 一建好就自動掛 permission
  // tracking + home mirror；現有 runtime（gateway 啟動前就 load 的）也補掛一次。
  // 放在 ensureHomeMirror / postHomeMirror 宣告之後以避免 TDZ。
  const unsubRegistryLoad = registry.onLoad(r => {
    ensurePermissionTracking(r)
    ensureHomeMirror(r)
  })
  for (const existing of registry.listProjects()) {
    ensurePermissionTracking(existing)
    ensureHomeMirror(existing)
  }

  const handleIncoming = async (
    adapted: DiscordIncomingMessage,
    raw: Message,
  ): Promise<void> => {
    // 1. 路由判斷
    const routing = routeMessage(
      {
        channelType: adapted.channelType,
        channelId: adapted.channelId,
        authorId: adapted.authorId,
        content: adapted.content,
      },
      config,
    )
    if (!routing.ok) {
      // whitelist 拒絕 → 靜默丟
      if (routing.reason === 'whitelist') return
      // no-binding / empty → 靜默丟（guild 訊息不想吵）
      if (routing.reason === 'no-binding') return
      if (routing.reason === 'empty') return
      // DM 裡的錯誤有 hint 時回給使用者
      if (routing.hint) {
        try {
          if (raw.channel.isTextBased() && 'send' in raw.channel) {
            await (raw.channel as TextBasedChannel & {
              send: (s: string) => Promise<Message>
            }).send(`❓ ${routing.hint}`)
          }
        } catch (e) {
          void log?.warn('failed to send routing hint', {
            err: e instanceof Error ? e.message : String(e),
          })
        }
      }
      return
    }

    // 2. Load project runtime
    let runtime: Awaited<ReturnType<typeof registry.loadProject>>
    try {
      runtime = await registry.loadProject(routing.projectPath)
      ensurePermissionTracking(runtime)
      ensureHomeMirror(runtime)
    } catch (e) {
      void log?.error('failed to load project', {
        projectPath: routing.projectPath,
        err: e instanceof Error ? e.message : String(e),
      })
      try {
        if (raw.channel.isTextBased() && 'send' in raw.channel) {
          await (raw.channel as TextBasedChannel & {
            send: (s: string) => Promise<Message>
          }).send(
            `❌ 無法 load project \`${routing.projectPath}\`: ${e instanceof Error ? e.message : String(e)}`,
          )
        }
      } catch {
        // ignore
      }
      return
    }
    runtime.touch()

    // 3. 準備 image / attachment
    const adapt = await adaptDiscordMessage(adapted, {
      promptText: routing.prompt,
      visionEnabled,
    })

    // 4. Submit input → 拿到 inputId
    //    注意：目前 InputQueue.submit 只吃 string / unknown payload；image blocks
    //    的傳遞還沒打通到 QueryEngine（adapt.imageBlocks 預留未來 provider
    //    送 image block 時用；此版先靠 `[Image attachment: name]` 字串注入）。
    const inputId = runtime.broker.queue.submit(adapt.text, {
      clientId: `discord:${adapted.authorId}:${adapted.id}`,
      source: 'discord',
      intent: 'interactive',
    })

    // 5. 綁 sink / reactions / streamOutput；filter events by inputId
    const sink: DiscordChannelSink = client.sinkForChannel(
      raw.channel as TextBasedChannel,
    )
    const reactions = createReactionController(sink)
    const streamOut = createStreamOutputController({
      sink,
      sourceMessageId: adapted.id,
      replyMode: config.replyMode as StreamReplyMode,
    })
    const reactionTarget: ReactionTarget = {
      channelId: adapted.channelId,
      messageId: adapted.id,
    }

    const onTurnStart = (e: TurnStartEvent): void => {
      if (e.input.id !== inputId) return
      void reactions.onTurnStart(reactionTarget)
    }
    const onRunnerEvent = (w: RunnerEventWrapper): void => {
      if (w.input.id !== inputId) return
      if (w.event.type === 'output') {
        streamOut.handleOutput(w.event.payload)
      }
    }
    const onTurnEnd = async (e: TurnEndEvent): Promise<void> => {
      if (e.input.id !== inputId) return
      try {
        await streamOut.finalize(e.reason, e.error)
      } catch (err) {
        void log?.error('stream finalize failed', {
          inputId,
          err: err instanceof Error ? err.message : String(err),
        })
      }
      try {
        await reactions.onTurnEnd(reactionTarget, e.reason)
      } catch {
        // reaction failure 吞
      }
      // 用完就移除 listener（InputQueue 設計上不會自動清 per-turn listener）
      runtime.broker.queue.off('turnStart', onTurnStart as never)
      runtime.broker.queue.off('runnerEvent', onRunnerEvent as never)
      runtime.broker.queue.off('turnEnd', onTurnEnd as never)
    }

    runtime.broker.queue.on('turnStart', onTurnStart)
    runtime.broker.queue.on('runnerEvent', onRunnerEvent)
    runtime.broker.queue.on('turnEnd', onTurnEnd)

    void log?.info('discord input submitted', {
      inputId,
      projectId: runtime.projectId,
      via: routing.via,
      authorId: adapted.authorId,
      channelId: adapted.channelId,
      imageCount: adapt.images.length,
    })
  }

  // discord.js client 的 onMessage hook 在 client.ts 註冊；這邊只訂閱轉發
  // 的那一層 — 但 client.ts 是 per-DiscordClient 單一 onMessage，gateway 建構
  // 時由 caller 把 onMessage 串起來。為了讓 caller 能用 createDiscordClient
  // 一次建好 client，我們在這裡把 handler 附加：
  const bindOnClient = (): void => {
    // createDiscordClient 已經在 client.ts 裡處理 onMessage；我們需要 override
    // 它。但 client 已建 → 用 raw.on(Events.MessageCreate, ...) 加第二個 listener
    // 會與既有 gateway 需求衝突。簡單起見：caller **不**給 createDiscordClient
    // 傳 onMessage，而是在這裡自己掛一個（見 daemon wiring）。
  }

  // 判斷是否已經有 onMessage 綁上 — 未綁就主動掛到 raw client
  const raw = client.raw
  const rawOnMessage = async (
    adapted: DiscordIncomingMessage,
    rawMsg: Message,
  ): Promise<void> => {
    try {
      await handleIncoming(adapted, rawMsg)
    } catch (e) {
      void log?.error('gateway handleIncoming threw', {
        err: e instanceof Error ? e.message : String(e),
      })
    }
  }

  // Gateway 接手 onMessage — caller 必須傳 client 但 onMessage 留空；這裡掛一個。
  if (raw && !raw.listenerCount('messageCreate')) {
    bindOnClient() // no-op placeholder；真實綁在 createDiscordClient 傳入的 onMessage
  }

  // M-DISCORD-4：Interaction（slash command）handler。
  const rawOnInteraction = async (interaction: Interaction): Promise<void> => {
    try {
      // 先確保對應 runtime 的 pending tracking 已設好（lazy，用戶可能先下 /allow）
      const ctx: SlashHandlerContext = {
        config,
        registry,
        pendingPermissions,
        broadcastPermissionMode: opts.broadcastPermissionMode,
      }
      // 先對 chatInputCommand 跑 routing，讓 runtime onPending hook 綁上
      if (interaction.isChatInputCommand()) {
        const isDm = interaction.channel?.isDMBased() ?? false
        if (!isDm && interaction.channelId) {
          const bound = config.channelBindings[interaction.channelId]
          if (bound) {
            try {
              const r = await registry.loadProject(bound)
              ensurePermissionTracking(r)
              ensureHomeMirror(r)
            } catch {
              // ignore
            }
          }
        } else if (isDm && config.defaultProjectPath) {
          try {
            const r = await registry.loadProject(config.defaultProjectPath)
            ensurePermissionTracking(r)
            ensureHomeMirror(r)
          } catch {
            // ignore
          }
        }
      }
      await handleInteraction(interaction, ctx)
    } catch (e) {
      void log?.error('interaction handler threw', {
        err: e instanceof Error ? e.message : String(e),
      })
    }
  }

  // 導出 dispose：清 pending permission + home mirror listeners。
  return {
    async dispose() {
      for (const unsubs of permissionUnsubs.values()) {
        for (const u of unsubs) {
          try {
            u()
          } catch {
            // ignore
          }
        }
      }
      permissionUnsubs.clear()
      pendingPermissions.clear()
      for (const u of homeMirrorUnsubs.values()) {
        try {
          u()
        } catch {
          // ignore
        }
      }
      homeMirrorUnsubs.clear()
      try {
        unsubRegistryLoad()
      } catch {
        // ignore
      }
    },
    // caller 用來串到 createDiscordClient 的 onMessage / onInteraction
    handleIncoming: rawOnMessage,
    handleInteraction: rawOnInteraction,
  } as DiscordGateway & {
    handleIncoming: (
      m: DiscordIncomingMessage,
      raw: Message,
    ) => Promise<void>
    handleInteraction: (i: Interaction) => Promise<void>
  }
}

/** 幫 caller：一次建 client + gateway + 綁 onMessage/onInteraction + 註冊 slash commands 的 facade。 */
export async function startDiscordGateway(opts: {
  config: DiscordConfig
  token: string
  registry: ProjectRegistry
  visionEnabled: boolean
  broadcastPermissionMode?: DiscordGatewayOptions['broadcastPermissionMode']
  log?: DiscordGatewayOptions['log']
}): Promise<{
  client: DiscordClientHandle
  gateway: DiscordGateway
  dispose: () => Promise<void>
}> {
  const { createDiscordClient } = await import('./client.js')

  let gatewayRef:
    | (DiscordGateway & {
        handleIncoming?: (
          m: DiscordIncomingMessage,
          raw: Message,
        ) => Promise<void>
        handleInteraction?: (i: Interaction) => Promise<void>
      })
    | null = null

  const client = createDiscordClient({
    token: opts.token,
    onMessage: (adapted, raw) => {
      void gatewayRef?.handleIncoming?.(adapted, raw)
    },
    onInteraction: interaction => {
      void gatewayRef?.handleInteraction?.(interaction)
    },
    onReady: info => {
      void opts.log?.info('discord ready', info) ??
        logForDebugging(
          `[discord:gateway] ready as ${info.botTag} (${info.botId})`,
        )
    },
    onError: err => {
      void opts.log?.warn?.('discord client error', {
        err: err instanceof Error ? err.message : String(err),
      })
    },
  })

  const gateway = createDiscordGateway({
    config: opts.config,
    client,
    registry: opts.registry,
    visionEnabled: opts.visionEnabled,
    broadcastPermissionMode: opts.broadcastPermissionMode,
    log: opts.log,
  })
  gatewayRef = gateway as typeof gatewayRef

  await client.connect()

  // M-DISCORD-AUTOBIND：binding 健康檢查 — guild / channel / cwd 三層 stale 清理。
  try {
    const { verifyBindings } = await import('./bindingHealthCheck.js')
    const report = await verifyBindings(client.raw, opts.config)
    if (!report.guildAccessible) {
      void opts.log?.warn?.('discord guild not accessible; bindings unchecked', {
        guildId: opts.config.guildId,
      })
    } else {
      void opts.log?.info?.('binding health check', {
        healthy: report.healthy,
        staleChannels: report.staleChannels.length,
        staleCwds: report.staleCwds.length,
      })
    }
  } catch (e) {
    void opts.log?.warn?.('binding health check failed', {
      err: e instanceof Error ? e.message : String(e),
    })
  }

  // M-DISCORD-5：啟動完成通知 home channel（讓使用者從 Discord 就能看到 daemon 活了）
  if (opts.config.homeChannelId) {
    try {
      const sink = client.sinkForChannelId(opts.config.homeChannelId)
      const ts = new Date().toISOString().replace('T', ' ').replace(/\..*/, '')
      await sink.send({
        content: `🟢 my-agent daemon up · bot connected · ${ts}`,
      })
    } catch (e) {
      void opts.log?.warn?.('home channel startup notification failed', {
        err: e instanceof Error ? e.message : String(e),
      })
    }
  }

  // discord.js v14 DM 坑 workaround：MESSAGE_CREATE payload 不帶 channel.type，
  // Partials.Channel 無法幫 DMChannel 建構（Channel.create 因 type 不符回 null）
  // → MessageCreate event 不 emit，DM 訊息被丟。
  // 解法：連上後預先對 whitelist users 做 user.createDM()，DM channel 寫進 cache。
  // 之後收到 MESSAGE_CREATE 時 channels.cache 命中 → 不再走 partial 路徑 → 正常 dispatch。
  for (const userId of opts.config.whitelistUserIds) {
    try {
      const u = await client.raw.users.fetch(userId)
      await u.createDM()
      void opts.log?.info('prefetched DM channel', { userId })
    } catch (e) {
      void opts.log?.warn?.('failed to prefetch DM channel', {
        userId,
        err: e instanceof Error ? e.message : String(e),
      })
    }
  }

  // 註冊 slash commands（連上後立刻註冊 — guild 級 instant，global 慢傳播）。
  try {
    const result = await registerSlashCommands(client.raw, { token: opts.token })
    const guildOk = result.guilds.filter(g => g.ok).length
    const guildFail = result.guilds.filter(g => !g.ok).length
    void opts.log?.info('slash commands registered', {
      guildOk,
      guildFail,
      global: result.global.ok,
    })
  } catch (e) {
    void opts.log?.warn?.('slash command registration failed', {
      err: e instanceof Error ? e.message : String(e),
    })
  }

  return {
    client,
    gateway,
    async dispose() {
      // M-DISCORD-5：關機前通知 home channel（best-effort；destroy 後就連不上了）
      if (opts.config.homeChannelId) {
        try {
          const sink = client.sinkForChannelId(opts.config.homeChannelId)
          await sink.send({ content: `🔴 my-agent daemon shutting down` })
        } catch {
          // ignore — shutdown path 不該 crash
        }
      }
      await gateway.dispose()
      await client.destroy()
    },
  }
}
