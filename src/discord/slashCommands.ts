/**
 * M-DISCORD-4：Slash command 定義 + 註冊 + dispatcher。
 *
 * 設計：
 *   - 8 個核心 slash command：/status /list /help /mode /clear /interrupt /allow /deny
 *   - 在 bot ready 時註冊到每個 guild（instant，dev friendly）；DM 用 global
 *     commands 需 global registration（propagation 可能慢）
 *   - 每個 interaction 自帶 channelType / channelId → 用現有 router 邏輯解析
 *     projectPath；DM 沒前綴走 defaultProjectPath；channel 走 channelBindings
 *   - 回應策略：ephemeral 回應（只有執行者看到）減少頻道噪音；狀態變更
 *     （/mode）視情況可開 public
 *
 * Permission 與 mode 整合：
 *   - /mode 變更 runtime.context.setAppState().toolPermissionContext.mode
 *   - daemon 端 broadcast permissionContextSync 給同 project 的 attached
 *     REPL clients → REPL 同步 mode
 *   - /allow /deny 透過 permissionRouter.handleResponse 回應最新 pending
 */
import {
  ApplicationCommandOptionType,
  MessageFlags,
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type Client,
  type Interaction,
} from 'discord.js'
import type { PermissionMode } from '../types/permissions.js'
import type { ProjectRegistry, ProjectRuntime } from '../daemon/projectRegistry.js'
import type { DiscordConfig } from '../discordConfig/schema.js'
import { routeMessage } from './router.js'

export const ALL_PERMISSION_MODES: ReadonlyArray<PermissionMode> = [
  'default',
  'acceptEdits',
  'plan',
  'bypassPermissions',
]

export function buildSlashCommands(): Array<
  ReturnType<SlashCommandBuilder['toJSON']>
> {
  return [
    new SlashCommandBuilder()
      .setName('status')
      .setDescription('顯示 daemon + 已 load projects 狀態')
      .setDMPermission(true)
      .toJSON(),
    new SlashCommandBuilder()
      .setName('list')
      .setDescription('列出所有設定的 projects 與 channel bindings')
      .setDMPermission(true)
      .toJSON(),
    new SlashCommandBuilder()
      .setName('help')
      .setDescription('顯示可用指令')
      .setDMPermission(true)
      .toJSON(),
    new SlashCommandBuilder()
      .setName('mode')
      .setDescription('切換當前 project 的 permission mode（雙向同步給 REPL）')
      .setDMPermission(true)
      .addStringOption(o =>
        o
          .setName('mode')
          .setDescription('要切換到的 mode')
          .setRequired(true)
          .addChoices(
            { name: 'default — destructive 會問', value: 'default' },
            { name: 'acceptEdits — Edit/Write 自動放行', value: 'acceptEdits' },
            { name: 'plan — 只讀、擋寫', value: 'plan' },
            { name: 'bypassPermissions — YOLO 全放行', value: 'bypassPermissions' },
          ),
      )
      .toJSON(),
    new SlashCommandBuilder()
      .setName('clear')
      .setDescription('清除當前 project session（下一條訊息開新 session）')
      .setDMPermission(true)
      .toJSON(),
    new SlashCommandBuilder()
      .setName('interrupt')
      .setDescription('中斷當前 turn（若有 in-flight）')
      .setDMPermission(true)
      .toJSON(),
    new SlashCommandBuilder()
      .setName('allow')
      .setDescription('放行最近一個待決的 tool permission 請求')
      .setDMPermission(true)
      .toJSON(),
    new SlashCommandBuilder()
      .setName('deny')
      .setDescription('拒絕最近一個待決的 tool permission 請求')
      .setDMPermission(true)
      .addStringOption(o =>
        o.setName('reason').setDescription('拒絕理由（可選）').setRequired(false),
      )
      .toJSON(),
  ]
}

export interface SlashRegistrationResult {
  /** 每個 guild 的註冊結果（成功 / 失敗）。 */
  guilds: Array<{ guildId: string; ok: boolean; error?: string }>
  /** global 註冊（DM 支援 — slow propagation 但必要）。 */
  global: { ok: boolean; error?: string }
}

/**
 * 把 slash command 註冊到所有 bot 可見 guild（instant）+ global（DM 需要，<1h 傳播）。
 * 幂等：Discord 用 name 當 key，重複 PUT 覆蓋同名。
 */
export async function registerSlashCommands(
  client: Client,
  opts: { token: string },
): Promise<SlashRegistrationResult> {
  const appId = client.application?.id ?? client.user?.id
  if (!appId) {
    throw new Error('client has no application id; wait for ready first')
  }
  const rest = new REST({ version: '10' }).setToken(opts.token)
  const commands = buildSlashCommands()

  const guildResults: Array<{ guildId: string; ok: boolean; error?: string }> = []
  for (const [guildId] of client.guilds.cache) {
    try {
      await rest.put(Routes.applicationGuildCommands(appId, guildId), {
        body: commands,
      })
      guildResults.push({ guildId, ok: true })
    } catch (e) {
      guildResults.push({
        guildId,
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      })
    }
  }

  let globalResult: { ok: boolean; error?: string }
  try {
    await rest.put(Routes.applicationCommands(appId), { body: commands })
    globalResult = { ok: true }
  } catch (e) {
    globalResult = {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    }
  }

  return { guilds: guildResults, global: globalResult }
}

export interface SlashHandlerContext {
  config: DiscordConfig
  registry: ProjectRegistry
  /** 回應 permission pending 的 latest tracker（per project）。
   * Map<projectId, toolUseID[]> — push 時加到尾，/allow /deny 取尾。 */
  pendingPermissions: Map<string, string[]>
  /** 取 server handle 做 broadcast（permission mode sync）。 */
  broadcastPermissionMode?: (projectId: string, mode: PermissionMode) => void
}

/**
 * 從 interaction 解析對應的 ProjectRuntime：同 messageAdapter 的 router 邏輯，
 * 但 interaction 沒 content → 只認 channel binding 與 defaultProjectPath。
 */
async function resolveRuntimeForInteraction(
  interaction: ChatInputCommandInteraction,
  ctx: SlashHandlerContext,
): Promise<ProjectRuntime | null> {
  const isDm = interaction.channel?.isDMBased() ?? false
  const routing = routeMessage(
    {
      channelType: isDm ? 'dm' : 'guild',
      channelId: interaction.channelId ?? '',
      authorId: interaction.user.id,
      content: '__slash__',
    },
    ctx.config,
  )
  if (!routing.ok) return null
  try {
    return await ctx.registry.loadProject(routing.projectPath)
  } catch {
    return null
  }
}

function formatProjectLine(r: ProjectRuntime): string {
  const mode = r.context.getAppState().toolPermissionContext.mode
  const replCount = r.attachedReplIds.size
  const qState = r.broker.queue.state
  return `• \`${r.projectId}\` — mode=\`${mode}\` queue=\`${qState}\` REPL=${replCount} cwd=\`${r.cwd}\``
}

export async function handleInteraction(
  interaction: Interaction,
  ctx: SlashHandlerContext,
): Promise<void> {
  if (!interaction.isChatInputCommand()) return

  // 白名單 — slash command 也要檢查
  if (!ctx.config.whitelistUserIds.includes(interaction.user.id)) {
    try {
      await interaction.reply({
        content: '🚫 你不在白名單內',
        flags: MessageFlags.Ephemeral,
      })
    } catch {
      // ignore
    }
    return
  }

  const name = interaction.commandName

  if (name === 'help') {
    const lines = [
      '**My Agent Discord Commands**',
      '`/status` — daemon 狀態 + 已 load projects',
      '`/list` — 設定的 projects + channel bindings',
      '`/mode <mode>` — 切 permission mode（雙向同步 REPL）',
      '`/clear` — 清除當前 project session',
      '`/interrupt` — 中斷當前 turn',
      '`/allow` / `/deny` — 回應待決的 tool permission',
      '`/help` — 本說明',
      '',
      '**訊息路由**：DM 前綴 `#<projectId|alias> ...` 指定 project（沒前綴走 `defaultProjectPath`）；channel 按 `channelBindings` 綁定。',
    ].join('\n')
    await interaction.reply({
      content: lines,
      flags: MessageFlags.Ephemeral,
    })
    return
  }

  if (name === 'list') {
    const projects = ctx.config.projects
    const lines: string[] = ['**Configured projects:**']
    if (projects.length === 0) {
      lines.push('_(none — edit `~/.my-agent/discord.json`)_')
    }
    for (const p of projects) {
      const loaded = ctx.registry.getProjectByCwd(p.path) ? ' 🟢' : ' ⚪'
      const aliases =
        p.aliases.length > 0 ? ` (aliases: ${p.aliases.join(', ')})` : ''
      lines.push(`• \`#${p.id}\`${loaded} — ${p.name}${aliases}`)
      lines.push(`  \`${p.path}\``)
    }
    const bindings = Object.entries(ctx.config.channelBindings)
    if (bindings.length > 0) {
      lines.push('', '**Channel bindings:**')
      for (const [chId, path] of bindings) {
        lines.push(`• <#${chId}> → \`${path}\``)
      }
    }
    if (ctx.config.defaultProjectPath) {
      lines.push('', `**Default** (DM 無前綴): \`${ctx.config.defaultProjectPath}\``)
    }
    await interaction.reply({
      content: lines.join('\n'),
      flags: MessageFlags.Ephemeral,
    })
    return
  }

  if (name === 'status') {
    const runtimes = ctx.registry.listProjects()
    const lines: string[] = [
      `**Daemon status** — ${runtimes.length} project(s) loaded`,
    ]
    if (runtimes.length === 0) {
      lines.push('_(none loaded — 傳訊息或 `/list` 看可用 projects)_')
    }
    for (const r of runtimes) {
      lines.push(formatProjectLine(r))
    }
    await interaction.reply({
      content: lines.join('\n'),
      flags: MessageFlags.Ephemeral,
    })
    return
  }

  // 以下命令都需要解析出 project runtime
  const runtime = await resolveRuntimeForInteraction(interaction, ctx)
  if (!runtime) {
    await interaction.reply({
      content:
        '❓ 這個 channel / DM 無法解析 project（channel 未 binding、或 DM 無 `defaultProjectPath`）— 用 `/list` 查看設定',
      flags: MessageFlags.Ephemeral,
    })
    return
  }

  if (name === 'mode') {
    const newMode = interaction.options.getString('mode', true) as PermissionMode
    if (!ALL_PERMISSION_MODES.includes(newMode)) {
      await interaction.reply({
        content: `❌ 未知 mode: \`${newMode}\``,
        flags: MessageFlags.Ephemeral,
      })
      return
    }
    const prev = runtime.context.getAppState().toolPermissionContext.mode
    runtime.context.setAppState(p => ({
      ...p,
      toolPermissionContext: { ...p.toolPermissionContext, mode: newMode },
    }))
    ctx.broadcastPermissionMode?.(runtime.projectId, newMode)
    await interaction.reply({
      content: `🔀 \`${runtime.projectId}\` mode: \`${prev}\` → \`${newMode}\`（已廣播給 attached REPL）`,
    })
    return
  }

  if (name === 'clear') {
    // 送一條 slash-intent 訊息進 broker，讓 QueryEngine 開新 session
    runtime.broker.queue.submit('/clear', {
      clientId: `discord:${interaction.user.id}:slash`,
      source: 'discord',
      intent: 'slash',
    })
    await interaction.reply({
      content: `🧹 \`${runtime.projectId}\`：已送 /clear — 下一條訊息會開新 session`,
      flags: MessageFlags.Ephemeral,
    })
    return
  }

  if (name === 'interrupt') {
    const curInput = runtime.broker.queue.currentInput
    if (!curInput) {
      await interaction.reply({
        content: `💤 \`${runtime.projectId}\` 沒有 in-flight turn`,
        flags: MessageFlags.Ephemeral,
      })
      return
    }
    // submit 一個空 interactive → 觸發 currentController.abort()（queue 的混合策略）
    runtime.broker.queue.submit('', {
      clientId: `discord:${interaction.user.id}:interrupt`,
      source: 'discord',
      intent: 'interactive',
    })
    await interaction.reply({
      content: `⏹️ \`${runtime.projectId}\`：已發送中斷 (turn \`${curInput.id.slice(0, 8)}…\`)`,
      flags: MessageFlags.Ephemeral,
    })
    return
  }

  if (name === 'allow' || name === 'deny') {
    const queue = ctx.pendingPermissions.get(runtime.projectId)
    if (!queue || queue.length === 0) {
      await interaction.reply({
        content: `💤 \`${runtime.projectId}\` 沒有待決的 permission request`,
        flags: MessageFlags.Ephemeral,
      })
      return
    }
    const toolUseID = queue[queue.length - 1]!
    // 透過 permissionRouter 的 handleResponse 介面送回
    const frame = {
      type: 'permissionResponse',
      toolUseID,
      decision: name === 'allow' ? ('allow' as const) : ('deny' as const),
      message:
        name === 'deny'
          ? (interaction.options.getString('reason') ?? 'denied via Discord')
          : undefined,
    }
    const clientId = `discord:${interaction.user.id}:slash`
    const handled = runtime.permissionRouter.handleResponse(clientId, frame)
    if (handled) {
      // 從 queue 移除
      const idx = queue.indexOf(toolUseID)
      if (idx >= 0) queue.splice(idx, 1)
    }
    await interaction.reply({
      content: handled
        ? `${name === 'allow' ? '✅' : '❌'} \`${runtime.projectId}\` 權限請求 ${toolUseID.slice(0, 8)}… ${name}`
        : `⚠ 無法處理 permission response（router 未認可 clientId / toolUseID）`,
      flags: MessageFlags.Ephemeral,
    })
    return
  }

  // Unknown
  await interaction.reply({
    content: `❓ Unknown command: \`/${name}\``,
    flags: MessageFlags.Ephemeral,
  })
}

// Needed so TS doesn't warn about unused imports when discord.js internals change
void ApplicationCommandOptionType
void PermissionFlagsBits
