/**
 * M-DISCORD-4：Slash command — 統一 `/discord <subcommand>` 命名空間。
 *
 * 設計：
 *   - 單一 top-level `/discord`，下掛 14 個 subcommand
 *   - 在 bot ready 時註冊到每個 guild（instant，dev friendly）+ global（DM 支援，
 *     propagation <1h）
 *   - 每個 interaction 自帶 channelType / channelId → 用現有 router 邏輯解析
 *     projectPath；DM 沒前綴走 defaultProjectPath；channel 走 channelBindings
 *   - 回應策略：ephemeral 回應（只有執行者看到）減少頻道噪音；狀態變更
 *     （mode）視情況可開 public
 *
 * 白名單檢查：handleInteraction 最外層擋；所有 subcommand（含 whitelist-add）
 * 都必須先過。首個 whitelist 仍要手動編 ~/.my-agent/discord.json。
 */
import {
  ApplicationCommandOptionType,
  ChannelType,
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
import {
  addChannelBinding,
  addWhitelistUser,
  removeChannelBinding,
  removeWhitelistUser,
} from '../discordConfig/loader.js'
import { routeMessage } from './router.js'

export const ALL_PERMISSION_MODES: ReadonlyArray<PermissionMode> = [
  'default',
  'acceptEdits',
  'plan',
  'bypassPermissions',
]

/** Invite URL 用的預設權限 bits（ViewChannel + SendMessages + ReadMessageHistory + AttachFiles）。 */
const INVITE_PERMISSION_BITS =
  PermissionFlagsBits.ViewChannel |
  PermissionFlagsBits.SendMessages |
  PermissionFlagsBits.ReadMessageHistory |
  PermissionFlagsBits.AttachFiles

export function buildSlashCommands(): Array<
  ReturnType<SlashCommandBuilder['toJSON']>
> {
  const discord = new SlashCommandBuilder()
    .setName('discord')
    .setDescription('my-agent Discord gateway 控制指令')
    .setDMPermission(true)

  discord.addSubcommand(s =>
    s.setName('status').setDescription('顯示 daemon + 已 load projects 狀態'),
  )
  discord.addSubcommand(s =>
    s.setName('list').setDescription('列出設定的 projects 與 channel bindings'),
  )
  discord.addSubcommand(s => s.setName('help').setDescription('顯示可用子命令'))

  discord.addSubcommand(s =>
    s
      .setName('mode')
      .setDescription('切換當前 project 的 permission mode（雙向同步 REPL）')
      .addStringOption(o =>
        o
          .setName('mode')
          .setDescription('要切換到的 mode')
          .setRequired(true)
          .addChoices(
            { name: 'default — destructive 會問', value: 'default' },
            { name: 'acceptEdits — Edit/Write 自動放行', value: 'acceptEdits' },
            { name: 'plan — 只讀、擋寫', value: 'plan' },
            {
              name: 'bypassPermissions — YOLO 全放行',
              value: 'bypassPermissions',
            },
          ),
      ),
  )

  discord.addSubcommand(s =>
    s
      .setName('clear')
      .setDescription('清除當前 project session（下一條訊息開新 session）'),
  )
  discord.addSubcommand(s =>
    s.setName('interrupt').setDescription('中斷當前 turn'),
  )
  discord.addSubcommand(s =>
    s.setName('allow').setDescription('放行最近一個待決的 tool permission'),
  )
  discord.addSubcommand(s =>
    s
      .setName('deny')
      .setDescription('拒絕最近一個待決的 tool permission')
      .addStringOption(o =>
        o.setName('reason').setDescription('拒絕理由（可選）').setRequired(false),
      ),
  )

  discord.addSubcommand(s =>
    s
      .setName('bind')
      .setDescription('把 channel 綁到 project（可跨 guild 指定 channel）')
      .addStringOption(o =>
        o
          .setName('project')
          .setDescription('Project id 或 alias（見 /discord list）')
          .setRequired(true),
      )
      .addChannelOption(o =>
        o
          .setName('channel')
          .setDescription('要綁的頻道（省略則綁當前 channel）')
          .addChannelTypes(ChannelType.GuildText)
          .setRequired(false),
      ),
  )
  discord.addSubcommand(s =>
    s
      .setName('unbind')
      .setDescription('解綁 channel（省略 channel 時解綁當前 channel）')
      .addChannelOption(o =>
        o
          .setName('channel')
          .setDescription('要解綁的頻道')
          .addChannelTypes(ChannelType.GuildText)
          .setRequired(false),
      ),
  )

  discord.addSubcommand(s =>
    s
      .setName('whitelist-add')
      .setDescription('把 user 加進白名單（允許觸發 turn）')
      .addUserOption(o =>
        o.setName('user').setDescription('要授權的 Discord user').setRequired(true),
      ),
  )
  discord.addSubcommand(s =>
    s
      .setName('whitelist-remove')
      .setDescription('把 user 從白名單移除')
      .addUserOption(o =>
        o.setName('user').setDescription('要撤銷的 Discord user').setRequired(true),
      ),
  )

  discord.addSubcommand(s =>
    s
      .setName('invite')
      .setDescription('產生 bot 的 OAuth invite URL（給對方 admin 邀進他們 server）'),
  )
  discord.addSubcommand(s =>
    s.setName('guilds').setDescription('列出 bot 目前所在的 guild'),
  )

  return [discord.toJSON()]
}

export interface SlashRegistrationResult {
  guilds: Array<{ guildId: string; ok: boolean; error?: string }>
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
  pendingPermissions: Map<string, string[]>
  broadcastPermissionMode?: (projectId: string, mode: PermissionMode) => void
  /** discord client — 取 application id + guild 清單；invite / guilds 指令用。 */
  client?: Client
}

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

/** 找 project by id or alias。回 null 表示找不到。 */
function findProject(
  cfg: DiscordConfig,
  key: string,
): { id: string; path: string; name: string } | null {
  const lower = key.toLowerCase()
  for (const p of cfg.projects) {
    if (p.id.toLowerCase() === lower) return p
    if (p.aliases.some(a => a.toLowerCase() === lower)) return p
  }
  return null
}

export async function handleInteraction(
  interaction: Interaction,
  ctx: SlashHandlerContext,
): Promise<void> {
  if (!interaction.isChatInputCommand()) return

  // 只認 /discord；其他（舊 flat commands 尚未替換完成時的 residue）忽略
  if (interaction.commandName !== 'discord') return

  // 白名單檢查 — 所有 subcommand 都要先過
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

  const sub = interaction.options.getSubcommand(true)

  // ── 資訊類 ────────────────────────────────────────────────────────

  if (sub === 'help') {
    const lines = [
      '**My Agent Discord Commands**',
      '`/discord status` — daemon 狀態 + 已 load projects',
      '`/discord list` — 設定的 projects + channel bindings',
      '`/discord mode <mode>` — 切 permission mode（雙向同步 REPL）',
      '`/discord clear` — 清除當前 project session',
      '`/discord interrupt` — 中斷當前 turn',
      '`/discord allow` / `/discord deny` — 回應待決的 tool permission',
      '`/discord bind project:<id> [channel:<ch>]` — 把 channel 綁到 project',
      '`/discord unbind [channel:<ch>]` — 解綁 channel',
      '`/discord whitelist-add user:<user>` / `whitelist-remove user:<user>` — 管理白名單',
      '`/discord invite` — 產生 bot 邀請連結',
      '`/discord guilds` — 列出 bot 所在的 guild',
      '`/discord help` — 本說明',
      '',
      '**訊息路由**：DM 前綴 `#<projectId|alias> ...` 指定 project（沒前綴走 `defaultProjectPath`）；channel 按 `channelBindings` 綁定。',
    ].join('\n')
    await interaction.reply({
      content: lines,
      flags: MessageFlags.Ephemeral,
    })
    return
  }

  if (sub === 'list') {
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
      lines.push(
        '',
        `**Default** (DM 無前綴): \`${ctx.config.defaultProjectPath}\``,
      )
    }
    await interaction.reply({
      content: lines.join('\n'),
      flags: MessageFlags.Ephemeral,
    })
    return
  }

  if (sub === 'status') {
    const runtimes = ctx.registry.listProjects()
    const lines: string[] = [
      `**Daemon status** — ${runtimes.length} project(s) loaded`,
    ]
    if (runtimes.length === 0) {
      lines.push('_(none loaded — 傳訊息或 `/discord list` 看可用 projects)_')
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

  if (sub === 'invite') {
    const appId = ctx.client?.application?.id ?? ctx.client?.user?.id
    if (!appId) {
      await interaction.reply({
        content: '❌ 無法取得 bot application id（client 尚未 ready）',
        flags: MessageFlags.Ephemeral,
      })
      return
    }
    const perms = INVITE_PERMISSION_BITS.toString()
    const url =
      `https://discord.com/api/oauth2/authorize` +
      `?client_id=${appId}` +
      `&permissions=${perms}` +
      `&scope=bot%20applications.commands`
    await interaction.reply({
      content:
        `🔗 Bot invite URL（轉給目標 server admin，由他在該 server 授權 bot）：\n` +
        `\`${url}\`\n\n` +
        `預設權限：ViewChannel + SendMessages + ReadMessageHistory + AttachFiles`,
      flags: MessageFlags.Ephemeral,
    })
    return
  }

  if (sub === 'guilds') {
    const guilds = ctx.client?.guilds.cache
    if (!guilds || guilds.size === 0) {
      await interaction.reply({
        content: '_(bot 目前不在任何 guild — 用 `/discord invite` 取邀請連結)_',
        flags: MessageFlags.Ephemeral,
      })
      return
    }
    const lines: string[] = [`**Bot 所在 guild** — ${guilds.size} 個`]
    for (const g of guilds.values()) {
      lines.push(`• **${g.name}** — \`${g.id}\` (members: ${g.memberCount})`)
    }
    await interaction.reply({
      content: lines.join('\n'),
      flags: MessageFlags.Ephemeral,
    })
    return
  }

  // ── 白名單 / 頻道綁定（不需 project runtime）───────────────────────

  if (sub === 'whitelist-add') {
    const user = interaction.options.getUser('user', true)
    try {
      const added = await addWhitelistUser(user.id)
      await interaction.reply({
        content: added
          ? `✅ 已把 <@${user.id}> (\`${user.id}\`) 加進白名單`
          : `ℹ️ <@${user.id}> 已在白名單中`,
        flags: MessageFlags.Ephemeral,
      })
    } catch (e) {
      await interaction.reply({
        content: `❌ 寫入失敗：${e instanceof Error ? e.message : String(e)}`,
        flags: MessageFlags.Ephemeral,
      })
    }
    return
  }

  if (sub === 'whitelist-remove') {
    const user = interaction.options.getUser('user', true)
    // 保護：不允許移除自己（避免鎖死）
    if (user.id === interaction.user.id) {
      await interaction.reply({
        content: '🚫 不能把自己從白名單移除（會鎖死 slash command）',
        flags: MessageFlags.Ephemeral,
      })
      return
    }
    try {
      const removed = await removeWhitelistUser(user.id)
      await interaction.reply({
        content: removed
          ? `✅ 已把 <@${user.id}> 從白名單移除`
          : `ℹ️ <@${user.id}> 本來就不在白名單`,
        flags: MessageFlags.Ephemeral,
      })
    } catch (e) {
      await interaction.reply({
        content: `❌ 寫入失敗：${e instanceof Error ? e.message : String(e)}`,
        flags: MessageFlags.Ephemeral,
      })
    }
    return
  }

  if (sub === 'bind') {
    const projectKey = interaction.options.getString('project', true)
    const channel = interaction.options.getChannel('channel')
    const targetChannelId = channel?.id ?? interaction.channelId
    if (!targetChannelId) {
      await interaction.reply({
        content: '❌ 無法解析目標 channel（DM 不支援 bind；指定 `channel:` 參數或到 guild channel 執行）',
        flags: MessageFlags.Ephemeral,
      })
      return
    }
    const project = findProject(ctx.config, projectKey)
    if (!project) {
      await interaction.reply({
        content:
          `❌ 找不到 project \`${projectKey}\`。\n` +
          `用 \`/discord list\` 看可用的 id / aliases。`,
        flags: MessageFlags.Ephemeral,
      })
      return
    }
    try {
      await addChannelBinding(targetChannelId, project.path)
      await interaction.reply({
        content:
          `✅ 已綁定 <#${targetChannelId}> → \`${project.id}\`\n` +
          `  path: \`${project.path}\`\n` +
          `該頻道的訊息會路由到本 project（running daemon 立即生效）`,
        flags: MessageFlags.Ephemeral,
      })
    } catch (e) {
      await interaction.reply({
        content: `❌ 寫入失敗：${e instanceof Error ? e.message : String(e)}`,
        flags: MessageFlags.Ephemeral,
      })
    }
    return
  }

  if (sub === 'unbind') {
    const channel = interaction.options.getChannel('channel')
    const targetChannelId = channel?.id ?? interaction.channelId
    if (!targetChannelId) {
      await interaction.reply({
        content: '❌ 無法解析目標 channel',
        flags: MessageFlags.Ephemeral,
      })
      return
    }
    const existed = Boolean(ctx.config.channelBindings[targetChannelId])
    try {
      await removeChannelBinding(targetChannelId)
      await interaction.reply({
        content: existed
          ? `✅ 已解綁 <#${targetChannelId}>`
          : `ℹ️ <#${targetChannelId}> 本來就沒綁`,
        flags: MessageFlags.Ephemeral,
      })
    } catch (e) {
      await interaction.reply({
        content: `❌ 寫入失敗：${e instanceof Error ? e.message : String(e)}`,
        flags: MessageFlags.Ephemeral,
      })
    }
    return
  }

  // ── 以下 subcommand 需要 project runtime ─────────────────────────

  const runtime = await resolveRuntimeForInteraction(interaction, ctx)
  if (!runtime) {
    await interaction.reply({
      content:
        '❓ 這個 channel / DM 無法解析 project（channel 未 binding、或 DM 無 `defaultProjectPath`）— 用 `/discord list` 查看設定',
      flags: MessageFlags.Ephemeral,
    })
    return
  }

  if (sub === 'mode') {
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

  if (sub === 'clear') {
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

  if (sub === 'interrupt') {
    const curInput = runtime.broker.queue.currentInput
    if (!curInput) {
      await interaction.reply({
        content: `💤 \`${runtime.projectId}\` 沒有 in-flight turn`,
        flags: MessageFlags.Ephemeral,
      })
      return
    }
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

  if (sub === 'allow' || sub === 'deny') {
    const queue = ctx.pendingPermissions.get(runtime.projectId)
    if (!queue || queue.length === 0) {
      await interaction.reply({
        content: `💤 \`${runtime.projectId}\` 沒有待決的 permission request`,
        flags: MessageFlags.Ephemeral,
      })
      return
    }
    const toolUseID = queue[queue.length - 1]!
    const frame = {
      type: 'permissionResponse',
      toolUseID,
      decision: sub === 'allow' ? ('allow' as const) : ('deny' as const),
      message:
        sub === 'deny'
          ? (interaction.options.getString('reason') ?? 'denied via Discord')
          : undefined,
    }
    const clientId = `discord:${interaction.user.id}:slash`
    const handled = runtime.permissionRouter.handleResponse(clientId, frame)
    if (handled) {
      const idx = queue.indexOf(toolUseID)
      if (idx >= 0) queue.splice(idx, 1)
    }
    await interaction.reply({
      content: handled
        ? `${sub === 'allow' ? '✅' : '❌'} \`${runtime.projectId}\` 權限請求 ${toolUseID.slice(0, 8)}… ${sub}`
        : `⚠ 無法處理 permission response（router 未認可 clientId / toolUseID）`,
      flags: MessageFlags.Ephemeral,
    })
    return
  }

  await interaction.reply({
    content: `❓ Unknown subcommand: \`/discord ${sub}\``,
    flags: MessageFlags.Ephemeral,
  })
}

// Needed so TS doesn't warn about unused imports when discord.js internals change
void ApplicationCommandOptionType
