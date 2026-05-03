/**
 * `/discord` 整合 TUI — 4 個 tab：Bindings / Whitelist / Guilds / Invite。
 * 仿 /memory 的 tab header + /cron 的 list/detail/confirmDelete 狀態機。
 *
 * 所有 mutation 走 daemon RPC（mgr.discordBind / mgr.discordUnbind / mgr.discordAdmin）；
 * 整合前由 8 個 /discord-* 文字指令各自呼叫，現由本元件統一處理 daemon 檢查。
 */
import figures from 'figures'
import * as React from 'react'
import { useEffect, useMemo, useState } from 'react'
import { Box, Text, useInput } from '../../ink.js'
import { isDaemonAliveSync } from '../../daemon/pidFile.js'
import { getCurrentDaemonManager } from '../../hooks/useDaemonMode.js'
import {
  buildBindings,
  type BindingRow,
  isValidSnowflake,
  readDiscordConfigFresh,
  truncate,
} from './discordManagerLogic.js'
import {
  DiscordBindWizard,
  type DiscordBindWizardSubmit,
} from './DiscordBindWizard.js'

type Tab = 'bindings' | 'whitelist' | 'guilds' | 'invite'

const TABS: ReadonlyArray<{ id: Tab; label: string }> = [
  { id: 'bindings', label: 'Bindings' },
  { id: 'whitelist', label: 'Whitelist' },
  { id: 'guilds', label: 'Guilds' },
  { id: 'invite', label: 'Invite' },
]

type Mode =
  | 'list'
  | 'detail'
  | 'confirmDelete'
  | 'wizard-bind-other'
  | 'wizard-whitelist-add'

type Flash = { text: string; tone: 'info' | 'error' }

interface GuildInfo {
  id: string
  name: string
  memberCount: number
}

interface Props {
  onExit: (summary: string) => void
}

function nextTab(t: Tab): Tab {
  const i = TABS.findIndex(x => x.id === t)
  return TABS[(i + 1) % TABS.length]!.id
}
function prevTab(t: Tab): Tab {
  const i = TABS.findIndex(x => x.id === t)
  return TABS[(i - 1 + TABS.length) % TABS.length]!.id
}

export function DiscordManager({ onExit }: Props): React.ReactNode {
  const [tab, setTab] = useState<Tab>('bindings')
  const [mode, setMode] = useState<Mode>('list')
  const [cursor, setCursor] = useState(0)
  const [flash, setFlash] = useState<Flash | null>(null)

  // 共用：channelBindings + whitelist 來源
  const [bindings, setBindings] = useState<BindingRow[]>([])
  const [whitelist, setWhitelist] = useState<string[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)

  // Guilds tab 用
  const [guilds, setGuilds] = useState<GuildInfo[] | null>(null)
  const [guildsErr, setGuildsErr] = useState<string | null>(null)

  // Invite tab 用
  const [invite, setInvite] = useState<{ url: string; appId: string } | null>(null)
  const [inviteErr, setInviteErr] = useState<string | null>(null)

  // wizard-whitelist-add 的輸入 buffer
  const [inputBuffer, setInputBuffer] = useState('')
  const [inputErr, setInputErr] = useState<string | null>(null)

  const [reloadToken, setReloadToken] = useState(0)
  const reload = (): void => setReloadToken(n => n + 1)

  // 載入 channelBindings + whitelist（fresh disk read）+ 5s 輪詢
  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const cfg = await readDiscordConfigFresh()
        if (cancelled) return
        setBindings(buildBindings(cfg, process.cwd()))
        setWhitelist([...cfg.whitelistUserIds])
        setLoadError(null)
      } catch (err) {
        if (!cancelled) setLoadError((err as Error).message)
      }
    }
    void load()
    const t = setInterval(load, 5000)
    return () => {
      cancelled = true
      clearInterval(t)
    }
  }, [reloadToken])

  // Guilds tab 進入時拉一次
  useEffect(() => {
    if (tab !== 'guilds') return
    void refreshGuilds()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, reloadToken])

  // Invite tab 進入時拉一次
  useEffect(() => {
    if (tab !== 'invite') return
    void refreshInvite()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, reloadToken])

  // Auto-clear flash
  useEffect(() => {
    if (!flash) return
    const t = setTimeout(() => setFlash(null), 2500)
    return () => clearTimeout(t)
  }, [flash])

  // 切 tab 時 reset cursor + mode
  useEffect(() => {
    setCursor(0)
    setMode('list')
  }, [tab])

  function getMgrOrFlash(): ReturnType<typeof getCurrentDaemonManager> | null {
    if (!isDaemonAliveSync()) {
      setFlash({ text: 'daemon 未啟動 — 先 `my-agent daemon start`', tone: 'error' })
      return null
    }
    const mgr = getCurrentDaemonManager()
    if (!mgr || mgr.state.mode !== 'attached') {
      setFlash({
        text: `REPL 未 attached（mode=${mgr?.state.mode ?? 'unknown'}）— 先 \`/daemon attach\``,
        tone: 'error',
      })
      return null
    }
    return mgr
  }

  async function refreshGuilds(): Promise<void> {
    setGuilds(null)
    setGuildsErr(null)
    const mgr = getMgrOrFlash()
    if (!mgr) {
      setGuildsErr('daemon 未 attached')
      return
    }
    const res = await mgr.discordAdmin({ op: 'guilds' }, 10_000)
    if (res === null) {
      setGuildsErr('逾時（10s）— Discord gateway 可能未啟動')
      return
    }
    if (!res.ok) {
      setGuildsErr(res.error)
      return
    }
    if (res.op !== 'guilds') {
      setGuildsErr('非預期回應')
      return
    }
    setGuilds(res.guilds)
  }

  async function refreshInvite(): Promise<void> {
    setInvite(null)
    setInviteErr(null)
    const mgr = getMgrOrFlash()
    if (!mgr) {
      setInviteErr('daemon 未 attached')
      return
    }
    const res = await mgr.discordAdmin({ op: 'invite' }, 10_000)
    if (res === null) {
      setInviteErr('逾時（10s）— Discord gateway 可能未啟動')
      return
    }
    if (!res.ok) {
      setInviteErr(res.error)
      return
    }
    if (res.op !== 'invite') {
      setInviteErr('非預期回應')
      return
    }
    setInvite({ url: res.inviteUrl, appId: res.appId })
  }

  // ─── Bindings 操作 ───────────────────────────────────────────────────

  async function bindCurrentCwd(): Promise<void> {
    const mgr = getMgrOrFlash()
    if (!mgr) return
    const res = await mgr.discordBind(process.cwd(), 15_000)
    if (res === null) {
      setFlash({ text: '逾時（15s）— gateway 可能未啟動', tone: 'error' })
      return
    }
    if (!res.ok) {
      setFlash({ text: `bind 失敗：${res.error}`, tone: 'error' })
      return
    }
    if (res.alreadyBound) {
      setFlash({
        text: `此 cwd 已綁定 #${res.channelName ?? '?'} (${res.channelId})`,
        tone: 'info',
      })
    } else {
      setFlash({
        text: `✅ 已建立並綁定 #${res.channelName ?? '?'} (${res.channelId})`,
        tone: 'info',
      })
    }
    reload()
  }

  async function bindOtherChannel(submit: DiscordBindWizardSubmit): Promise<void> {
    setMode('list')
    const mgr = getMgrOrFlash()
    if (!mgr) return

    let projectPath: string
    let autoRegister = false
    if (submit.projectKey) {
      // 解析 projectKey → path（讀 fresh config）
      const cfg = await readDiscordConfigFresh()
      const found = cfg.projects.find(
        p =>
          p.id.toLowerCase() === submit.projectKey!.toLowerCase() ||
          p.aliases.some(a => a.toLowerCase() === submit.projectKey!.toLowerCase()),
      )
      if (!found) {
        setFlash({ text: `找不到 project \`${submit.projectKey}\``, tone: 'error' })
        return
      }
      projectPath = found.path
    } else {
      projectPath = process.cwd()
      autoRegister = true
    }

    const res = await mgr.discordAdmin(
      { op: 'bindChannel', channelId: submit.channelId, projectPath, autoRegister },
      15_000,
    )
    if (res === null) {
      setFlash({ text: '逾時（15s）', tone: 'error' })
      return
    }
    if (!res.ok) {
      setFlash({ text: `bind 失敗：${res.error}`, tone: 'error' })
      return
    }
    if (res.op !== 'bindChannel') return
    setFlash({
      text: `✅ 已綁定 #${res.channelName} (${res.guildName})${res.autoRegistered ? ' [auto-register]' : ''}`,
      tone: 'info',
    })
    reload()
  }

  async function unbindSelectedBinding(): Promise<void> {
    setMode('list')
    const row = bindings[cursor]
    if (!row) return
    const mgr = getMgrOrFlash()
    if (!mgr) return

    // 若是 cwd 對應的 binding，走 discordUnbind（會 rename channel 為 unbound-*）
    if (row.isCwd) {
      const res = await mgr.discordUnbind(process.cwd(), 10_000)
      if (res === null) {
        setFlash({ text: '逾時（10s）', tone: 'error' })
        return
      }
      if (!res.ok) {
        setFlash({ text: `unbind 失敗：${res.error}`, tone: 'error' })
        return
      }
      setFlash({ text: `✓ 已解綁 cwd 對應的頻道`, tone: 'info' })
      reload()
      return
    }
    // 其他：走 admin unbindChannel（config-only，不 rename）
    const res = await mgr.discordAdmin(
      { op: 'unbindChannel', channelId: row.channelId },
      10_000,
    )
    if (res === null) {
      setFlash({ text: '逾時（10s）', tone: 'error' })
      return
    }
    if (!res.ok) {
      setFlash({ text: `unbind 失敗：${res.error}`, tone: 'error' })
      return
    }
    if (res.op !== 'unbindChannel') return
    setFlash({
      text: res.changed
        ? `✓ 已解綁 ${row.channelId}`
        : `ℹ️ ${row.channelId} 並未綁定`,
      tone: 'info',
    })
    reload()
  }

  // ─── Whitelist 操作 ──────────────────────────────────────────────────

  async function whitelistAdd(userId: string): Promise<void> {
    const mgr = getMgrOrFlash()
    if (!mgr) return
    const res = await mgr.discordAdmin({ op: 'whitelistAdd', userId }, 10_000)
    if (res === null) {
      setFlash({ text: '逾時（10s）', tone: 'error' })
      return
    }
    if (!res.ok) {
      setFlash({ text: `add 失敗：${res.error}`, tone: 'error' })
      return
    }
    if (res.op !== 'whitelistAdd') return
    setFlash({
      text: res.changed ? `✓ 已加入 ${userId}` : `ℹ️ ${userId} 已在白名單`,
      tone: 'info',
    })
    reload()
  }

  async function whitelistRemoveSelected(): Promise<void> {
    setMode('list')
    const userId = whitelist[cursor]
    if (!userId) return
    const mgr = getMgrOrFlash()
    if (!mgr) return
    const res = await mgr.discordAdmin({ op: 'whitelistRemove', userId }, 10_000)
    if (res === null) {
      setFlash({ text: '逾時（10s）', tone: 'error' })
      return
    }
    if (!res.ok) {
      setFlash({ text: `remove 失敗：${res.error}`, tone: 'error' })
      return
    }
    if (res.op !== 'whitelistRemove') return
    setFlash({
      text: res.changed ? `✓ 已移除 ${userId}` : `ℹ️ ${userId} 不在白名單`,
      tone: 'info',
    })
    reload()
  }

  // ─── 鍵盤 ────────────────────────────────────────────────────────────

  useInput((input, key) => {
    // wizard 自帶 useInput
    if (mode === 'wizard-bind-other') return

    // wizard-whitelist-add：input buffer
    if (mode === 'wizard-whitelist-add') {
      if (key.escape) {
        setMode('list')
        setInputBuffer('')
        setInputErr(null)
        return
      }
      if (key.return) {
        const v = inputBuffer.trim()
        if (!isValidSnowflake(v)) {
          setInputErr('不像 Discord user ID（17–20 位純數字）')
          return
        }
        setInputBuffer('')
        setInputErr(null)
        setMode('list')
        void whitelistAdd(v)
        return
      }
      if (key.backspace || key.delete) {
        setInputBuffer(s => s.slice(0, -1))
        setInputErr(null)
        return
      }
      if (input && !key.ctrl && !key.meta) {
        setInputBuffer(s => s + input)
        setInputErr(null)
      }
      return
    }

    // confirmDelete
    if (mode === 'confirmDelete') {
      if (input === 'y' || input === 'Y') {
        if (tab === 'bindings') void unbindSelectedBinding()
        else if (tab === 'whitelist') void whitelistRemoveSelected()
        return
      }
      setMode('list')
      return
    }

    // detail
    if (mode === 'detail') {
      if (key.escape || key.leftArrow || input === 'q') {
        setMode('list')
      }
      return
    }

    // list 全域
    if (key.escape || input === 'q') {
      onExit('Discord manager closed')
      return
    }
    if (key.tab || key.rightArrow) {
      setTab(nextTab(tab))
      return
    }
    if (key.leftArrow) {
      setTab(prevTab(tab))
      return
    }
    if (input === 'r') {
      if (tab === 'guilds') void refreshGuilds()
      else if (tab === 'invite') void refreshInvite()
      else reload()
      return
    }

    // tab-specific
    if (tab === 'bindings') {
      if (key.upArrow) setCursor(c => Math.max(0, c - 1))
      else if (key.downArrow)
        setCursor(c => Math.min(Math.max(0, bindings.length - 1), c + 1))
      else if (key.return && bindings[cursor]) setMode('detail')
      else if (input === 'n') void bindCurrentCwd()
      else if (input === 'N') setMode('wizard-bind-other')
      else if (input === 'd' && bindings[cursor]) setMode('confirmDelete')
      return
    }
    if (tab === 'whitelist') {
      if (key.upArrow) setCursor(c => Math.max(0, c - 1))
      else if (key.downArrow)
        setCursor(c => Math.min(Math.max(0, whitelist.length - 1), c + 1))
      else if (input === 'a') {
        setMode('wizard-whitelist-add')
        setInputBuffer('')
        setInputErr(null)
      } else if (input === 'd' && whitelist[cursor]) setMode('confirmDelete')
      return
    }
    // guilds / invite：無 list 互動，r 已在上面處理
  })

  // ─── 渲染 ────────────────────────────────────────────────────────────

  if (loadError) {
    return (
      <Box flexDirection="column">
        <Text color="red">無法載入 Discord 設定：{loadError}</Text>
        <Text dimColor>按 q / Esc 關閉</Text>
      </Box>
    )
  }

  if (mode === 'wizard-bind-other') {
    return (
      <Box flexDirection="column">
        <DiscordBindWizard
          onSubmit={s => void bindOtherChannel(s)}
          onCancel={() => {
            setMode('list')
            setFlash({ text: '已取消', tone: 'info' })
          }}
        />
        {flash && renderFlash(flash)}
      </Box>
    )
  }

  if (mode === 'confirmDelete') {
    const what =
      tab === 'bindings'
        ? `解綁 ${bindings[cursor]?.channelId}（${bindings[cursor]?.projectPath}）？`
        : tab === 'whitelist'
          ? `從白名單移除 ${whitelist[cursor]}？`
          : ''
    return (
      <Box flexDirection="column" borderStyle="round" borderColor="red" paddingX={1}>
        <Text bold color="red">確認</Text>
        <Box marginTop={1}>
          <Text>{what}</Text>
        </Box>
        <Box marginTop={1}>
          <Text>輸入 </Text>
          <Text bold color="red">y</Text>
          <Text> 確認，其他鍵取消。</Text>
        </Box>
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
      {renderTabHeader(tab)}
      <Box marginTop={1}>{renderTabBody()}</Box>
      {flash && renderFlash(flash)}
    </Box>
  )

  function renderTabBody(): React.ReactNode {
    if (tab === 'bindings') return renderBindings()
    if (tab === 'whitelist') return renderWhitelist()
    if (tab === 'guilds') return renderGuilds()
    return renderInvite()
  }

  function renderBindings(): React.ReactNode {
    if (mode === 'detail' && bindings[cursor]) {
      const r = bindings[cursor]!
      return (
        <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
          <Text bold>Binding 詳情</Text>
          <Box marginTop={1}>
            <Box width={14}><Text dimColor>Channel ID</Text></Box>
            <Text>{r.channelId}</Text>
          </Box>
          <Box>
            <Box width={14}><Text dimColor>Project</Text></Box>
            <Text>
              {r.projectId ?? '(orphan)'}
              {r.projectName ? ` · ${r.projectName}` : ''}
              {r.isCwd ? ' ★ cwd' : ''}
            </Text>
          </Box>
          <Box>
            <Box width={14}><Text dimColor>Path</Text></Box>
            <Text>{r.projectPath}</Text>
          </Box>
          {r.orphan && (
            <Box marginTop={1}>
              <Text color="yellow">
                ⚠ 此 channel 對應的 projectPath 不在 projects[] 中（孤兒 binding）
              </Text>
            </Box>
          )}
          <Box marginTop={1}>
            <Text dimColor>q/Esc/← = 返回</Text>
          </Box>
        </Box>
      )
    }
    return (
      <Box flexDirection="column">
        <Text dimColor>{bindings.length} binding(s)</Text>
        <Box flexDirection="column" marginTop={1}>
          {bindings.length === 0 ? (
            <Text dimColor>(無 binding — 按 n 為當前 cwd 建立)</Text>
          ) : (
            bindings.map((r, i) => {
              const active = i === cursor
              return (
                <Box key={r.channelId}>
                  <Text color={active ? 'cyan' : undefined}>
                    {active ? figures.pointer : ' '}
                  </Text>
                  <Text> {r.isCwd ? '★' : ' '} </Text>
                  <Box width={22}>
                    <Text color={r.orphan ? 'yellow' : undefined}>
                      {truncate(r.projectId ?? '(orphan)', 20)}
                    </Text>
                  </Box>
                  <Box width={22}>
                    <Text dimColor>{r.channelId}</Text>
                  </Box>
                  <Text dimColor>{truncate(r.projectPath, 40)}</Text>
                </Box>
              )
            })
          )}
        </Box>
        <Box marginTop={1}>
          <Text dimColor>
            ↑/↓ · Enter=詳情 · n=綁 cwd · N=綁其他 channel · d=解綁 · r=刷新 · Tab=下一頁 · q=關
          </Text>
        </Box>
      </Box>
    )
  }

  function renderWhitelist(): React.ReactNode {
    if (mode === 'wizard-whitelist-add') {
      return (
        <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
          <Text bold>加入 Discord user 至白名單</Text>
          <Box marginTop={1}>
            <Text dimColor>User ID: </Text>
            <Text color="cyan">[{inputBuffer}_]</Text>
          </Box>
          {inputErr && (
            <Box marginTop={1}>
              <Text color="red">⚠ {inputErr}</Text>
            </Box>
          )}
          <Box marginTop={1}>
            <Text dimColor>Enter 送出 · Esc 取消</Text>
          </Box>
        </Box>
      )
    }
    return (
      <Box flexDirection="column">
        <Text dimColor>{whitelist.length} user(s) on whitelist</Text>
        <Box flexDirection="column" marginTop={1}>
          {whitelist.length === 0 ? (
            <Text dimColor>(空 — 按 a 加入)</Text>
          ) : (
            whitelist.map((id, i) => {
              const active = i === cursor
              return (
                <Box key={id}>
                  <Text color={active ? 'cyan' : undefined}>
                    {active ? figures.pointer : ' '}
                  </Text>
                  <Text> {id}</Text>
                </Box>
              )
            })
          )}
        </Box>
        <Box marginTop={1}>
          <Text dimColor>↑/↓ · a=加入 · d=移除 · r=刷新 · Tab=下一頁 · q=關</Text>
        </Box>
      </Box>
    )
  }

  function renderGuilds(): React.ReactNode {
    return (
      <Box flexDirection="column">
        {guildsErr ? (
          <Text color="red">⚠ {guildsErr}</Text>
        ) : guilds === null ? (
          <Text dimColor>載入中…</Text>
        ) : guilds.length === 0 ? (
          <Text dimColor>(bot 不在任何 guild — 看 Invite tab 取邀請連結)</Text>
        ) : (
          <Box flexDirection="column">
            <Text dimColor>{guilds.length} guild(s)</Text>
            <Box flexDirection="column" marginTop={1}>
              {guilds.map(g => (
                <Box key={g.id}>
                  <Box width={32}>
                    <Text>{truncate(g.name, 30)}</Text>
                  </Box>
                  <Box width={22}>
                    <Text dimColor>{g.id}</Text>
                  </Box>
                  <Text dimColor>members={g.memberCount}</Text>
                </Box>
              ))}
            </Box>
          </Box>
        )}
        <Box marginTop={1}>
          <Text dimColor>r=重新拉取 · Tab=下一頁 · q=關</Text>
        </Box>
      </Box>
    )
  }

  function renderInvite(): React.ReactNode {
    return (
      <Box flexDirection="column">
        {inviteErr ? (
          <Text color="red">⚠ {inviteErr}</Text>
        ) : invite === null ? (
          <Text dimColor>載入中…</Text>
        ) : (
          <Box flexDirection="column">
            <Text bold>Bot OAuth 邀請 URL</Text>
            <Box marginTop={1}>
              <Text>{invite.url}</Text>
            </Box>
            <Box marginTop={1}>
              <Text dimColor>App ID: {invite.appId}</Text>
            </Box>
            <Box marginTop={1}>
              <Text dimColor>
                把 URL 給 server 管理者開啟 → 選 guild → Authorize。
              </Text>
            </Box>
          </Box>
        )}
        <Box marginTop={1}>
          <Text dimColor>r=重新產生 · Tab=下一頁 · q=關</Text>
        </Box>
      </Box>
    )
  }
}

function renderTabHeader(active: Tab): React.ReactNode {
  return (
    <Box>
      <Text bold>Discord · </Text>
      {TABS.map((t, i) => (
        <React.Fragment key={t.id}>
          {i > 0 && <Text dimColor>  </Text>}
          {t.id === active ? (
            <Text bold color="cyan">‹ {t.label} ›</Text>
          ) : (
            <Text dimColor>{t.label}</Text>
          )}
        </React.Fragment>
      ))}
      <Text dimColor>    (←/→ / Tab 切 tab)</Text>
    </Box>
  )
}

function renderFlash(flash: Flash): React.ReactNode {
  return (
    <Box marginTop={1}>
      <Text color={flash.tone === 'error' ? 'red' : 'green'}>{flash.text}</Text>
    </Box>
  )
}
