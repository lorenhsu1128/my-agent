// M-MEMTUI-1-3 / Phase 1：MemoryManager 主 picker，read-only list/detail/viewer。
// M-MEMTUI Phase 2：補 mutation（create/edit/delete/rename）+ 注入掃描 + Shift+E。
// Phase 3 補 daemon RPC；Phase 4 補輔助子畫面（session-index / trash）+ multi-delete alias 模式。

import figures from 'figures'
import * as React from 'react'
import { useEffect, useMemo, useState } from 'react'
import { Box, Text, useInput } from '../../ink.js'
import { getOriginalCwd } from '../../bootstrap/state.js'
import {
  getCurrentDaemonManager,
  sendMemoryMutationToDaemon,
} from '../../hooks/useDaemonMode.js'
import type { MemoryMutationPayload } from '../../repl/thinClient/fallbackManager.js'
import {
  listAllMemoryEntries,
  type MemoryEntry,
} from '../../utils/memoryList.js'
import { readFileSync } from 'fs'
import { editFileInEditor } from '../../utils/promptEditor.js'
import {
  MemoryEditWizard,
  type WizardDraft,
  type WizardKind,
} from '../../components/memory/MemoryEditWizard.js'
import { scanForInjection } from '../../memdir/memdirOps.js'
import {
  createAutoMemory,
  createLocalConfig,
  deleteEntry,
  readFileWithFrontmatter,
  renameAutoMemory,
  renameLocalConfig,
  updateAutoMemory,
  writeRawBody,
  type MutationResult,
} from './memoryMutations.js'
import { parseMemoryType } from '../../memdir/memoryTypes.js'
import { SessionIndexPanel } from '../../components/memory/SessionIndexPanel.js'
import { TrashPanel } from '../../components/memory/TrashPanel.js'
import {
  TABS,
  type TabId,
  filterByKeyword,
  filterByTab,
  formatRelativeTime,
  nextTab,
  prevTab,
  previewBody,
  sortEntries,
  stripFrontmatter,
  truncate,
} from './memoryManagerLogic.js'
import { getTab, tabIdOfEntry } from './memoryManagerLogic.js'

// (Props 在下方擴充：加入 initialMode 給 /memory-delete alias)

type Mode =
  | 'list'
  | 'detail'
  | 'filtering'
  | 'viewer'
  | 'wizard-create'
  | 'wizard-edit'
  | 'rename'
  | 'confirmDelete'
  | 'injectionWarn'
  | 'aux-select'
  | 'aux-sessionIndex'
  | 'aux-trash'
  | 'multi-delete'
  | 'multi-delete-confirm'

export type Props = Props_Manager
type Props_Manager = {
  onExit: (summary: string) => void
  /** 起始模式 — `/memory-delete` alias 直接傳 'multi-delete' 進多選模式。 */
  initialMode?: 'list' | 'multi-delete'
}

type Flash = { text: string; tone: 'info' | 'error' }

const PREVIEW_LINES = 30
const VIEWER_PAGE_SIZE = 20

export function MemoryManager({
  onExit,
  initialMode,
}: Props): React.ReactNode {
  const cwd = getOriginalCwd()
  const [mode, setMode] = useState<Mode>(
    initialMode === 'multi-delete' ? 'multi-delete' : 'list',
  )
  const [multiSelected, setMultiSelected] = useState<Set<string>>(new Set())
  const [tab, setTab] = useState<TabId>('auto-memory')
  const [cursor, setCursor] = useState(0)
  const [keyword, setKeyword] = useState('')
  const [allEntries, setAllEntries] = useState<MemoryEntry[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)
  const [flash, setFlash] = useState<Flash | null>(null)
  const [reloadToken, setReloadToken] = useState(0)
  const [bodyContent, setBodyContent] = useState<string>('')
  const [bodyError, setBodyError] = useState<string | null>(null)
  const [viewerOffset, setViewerOffset] = useState(0)
  const [wizardDraft, setWizardDraft] = useState<WizardDraft | null>(null)
  const [renameBuffer, setRenameBuffer] = useState<string>('')
  const [pendingInjection, setPendingInjection] = useState<{
    description: string
    onConfirm: () => Promise<void>
  } | null>(null)

  const reload = (): void => setReloadToken(n => n + 1)

  function flashResult(r: MutationResult): void {
    if (r.ok) {
      setFlash({ text: r.message, tone: 'info' })
      reload()
    } else {
      setFlash({ text: r.error, tone: 'error' })
    }
  }

  // Load + 5s poll for external changes
  useEffect(() => {
    let cancelled = false
    function load(): void {
      try {
        const list = listAllMemoryEntries(cwd)
        if (!cancelled) {
          setAllEntries(list)
          setLoadError(null)
        }
      } catch (err) {
        if (!cancelled) {
          setLoadError(err instanceof Error ? err.message : String(err))
        }
      }
    }
    load()
    const t = setInterval(load, 5000)
    return () => {
      cancelled = true
      clearInterval(t)
    }
  }, [cwd, reloadToken])

  // Auto-clear flash after 2.5s
  useEffect(() => {
    if (!flash) return
    const t = setTimeout(() => setFlash(null), 2500)
    return () => clearTimeout(t)
  }, [flash])

  // Subscribe to daemon broadcasts — memory.itemsChanged → immediate reload.
  // Phase 1：只訂閱不送 mutation；Phase 3 接通寫入路徑。
  useEffect(() => {
    const mgr = getCurrentDaemonManager()
    if (!mgr) return
    const handler = (f: { type: string }): void => {
      if (f.type === 'memory.itemsChanged') {
        setReloadToken(n => n + 1)
      }
    }
    mgr.on('frame', handler as never)
    return () => mgr.off('frame', handler as never)
  }, [])

  const tabRows = useMemo(() => {
    const tabFiltered = filterByTab(allEntries, tab)
    const filtered = filterByKeyword(tabFiltered, keyword)
    return sortEntries(filtered)
  }, [allEntries, tab, keyword])

  const safeCursor = Math.min(cursor, Math.max(0, tabRows.length - 1))
  const selected = tabRows[safeCursor]

  // Load body content when entering detail / viewer mode for selected entry.
  useEffect(() => {
    if (mode !== 'detail' && mode !== 'viewer') return
    if (!selected) {
      setBodyContent('')
      setBodyError('(no entry)')
      return
    }
    try {
      const content = readFileSync(selected.absolutePath, 'utf-8')
      setBodyContent(content)
      setBodyError(null)
    } catch (err) {
      setBodyContent('')
      setBodyError(err instanceof Error ? err.message : String(err))
    }
  }, [mode, selected])

  // Reset viewer scroll when entering / changing entry
  useEffect(() => {
    if (mode === 'viewer') setViewerOffset(0)
  }, [mode, selected])

  // --- mutation entry points ---
  function openCreate(): void {
    const tabSpec = getTab(tab)
    if (!tabSpec.canCreate) {
      setFlash({ text: `${tabSpec.label} tab 不可新建`, tone: 'error' })
      return
    }
    if (tab === 'auto-memory') {
      setWizardDraft({
        isCreate: true,
        kind: 'auto-memory',
        filename: '',
        name: '',
        description: '',
        type: 'feedback',
        body: '',
      })
      setMode('wizard-create')
      return
    }
    if (tab === 'local-config') {
      setWizardDraft({
        isCreate: true,
        kind: 'local-config',
        filename: '',
        name: '',
        description: '',
        type: 'feedback',
        body: '',
      })
      setMode('wizard-create')
      return
    }
    setFlash({ text: `${tabSpec.label} tab 不可新建`, tone: 'error' })
  }

  function openEditFrontmatter(): void {
    if (!selected || !selected.filename) {
      setFlash({ text: '此 entry 無 frontmatter 可編', tone: 'error' })
      return
    }
    const t = getTab(tab)
    if (!t.canEditFrontmatter) {
      setFlash({
        text: `${t.label} tab 無 frontmatter；body 編輯按 E（Shift+E）`,
        tone: 'info',
      })
      return
    }
    // 從檔案讀現有值
    void (async () => {
      try {
        const { fm, body } = await readFileWithFrontmatter(selected.absolutePath)
        const type = parseMemoryType(fm.type) ?? 'feedback'
        setWizardDraft({
          isCreate: false,
          kind: 'auto-memory',
          filename: selected.filename!,
          name: fm.name ?? '',
          description: fm.description ?? '',
          type,
          body,
        })
        setMode('wizard-edit')
      } catch (err) {
        setFlash({
          text: `read fail: ${err instanceof Error ? err.message : String(err)}`,
          tone: 'error',
        })
      }
    })()
  }

  function openRename(): void {
    if (!selected || !selected.filename) {
      setFlash({ text: '此 entry 不可重命名', tone: 'error' })
      return
    }
    if (!getTab(tab).canRename) {
      setFlash({ text: `${tab} tab 不可重命名`, tone: 'error' })
      return
    }
    setRenameBuffer(selected.filename)
    setMode('rename')
  }

  function openDelete(): void {
    if (!selected) return
    if (!getTab(tab).canDelete) {
      setFlash({ text: `${tab} tab 不可刪除`, tone: 'error' })
      return
    }
    setMode('confirmDelete')
  }

  function spawnEditorForBody(): void {
    if (!selected) return
    if (!getTab(tab).canEditBody) {
      setFlash({ text: `${tab} tab 唯讀`, tone: 'error' })
      return
    }
    try {
      const result = editFileInEditor(selected.absolutePath)
      if (result.error) {
        setFlash({ text: `editor: ${result.error}`, tone: 'error' })
      } else if (result.content !== null) {
        setFlash({ text: '已存檔', tone: 'info' })
        reload()
        // 重新載入 body 預覽
        try {
          setBodyContent(readFileSync(selected.absolutePath, 'utf-8'))
          setBodyError(null)
        } catch (err) {
          setBodyError(err instanceof Error ? err.message : String(err))
        }
      } else {
        setFlash({ text: '取消編輯（無 $EDITOR 或檔案問題）', tone: 'info' })
      }
    } catch (err) {
      setFlash({
        text: `spawn fail: ${err instanceof Error ? err.message : String(err)}`,
        tone: 'error',
      })
    }
  }

  /**
   * 嘗試走 daemon RPC；attached 時返 daemon 結果，否則 'not-attached' 讓
   * caller 走本機 fallback。
   */
  async function tryDaemon(
    payload: MemoryMutationPayload,
  ): Promise<MutationResult | 'not-attached'> {
    const res = await sendMemoryMutationToDaemon(payload, 10_000)
    if (res === null) return 'not-attached'
    if (res.ok) return { ok: true, message: res.message ?? 'daemon ok' }
    return { ok: false, error: res.error }
  }

  async function performMutation(
    draft: WizardDraft,
    skipInjectionScan: boolean,
  ): Promise<void> {
    if (!skipInjectionScan) {
      const hit = scanForInjection(draft.body)
      if (hit) {
        setPendingInjection({
          description: hit,
          onConfirm: async () => {
            await performMutation(draft, true)
          },
        })
        setMode('injectionWarn')
        return
      }
    }
    // 1) 嘗試 daemon RPC
    const op = draft.isCreate ? 'create' : 'update'
    let payload: MemoryMutationPayload
    if (op === 'create') {
      if (draft.kind === 'auto-memory') {
        payload = {
          op: 'create',
          payload: {
            kind: 'auto-memory',
            filename: draft.filename,
            name: draft.name,
            description: draft.description,
            type: draft.type,
            body: draft.body,
          },
        }
      } else {
        payload = {
          op: 'create',
          payload: {
            kind: 'local-config',
            filename: draft.filename,
            body: draft.body,
          },
        }
      }
    } else {
      if (draft.kind === 'auto-memory') {
        payload = {
          op: 'update',
          payload: {
            kind: 'auto-memory',
            filename: draft.filename,
            name: draft.name,
            description: draft.description,
            type: draft.type,
            body: draft.body,
          },
        }
      } else {
        payload = {
          op: 'update',
          payload: {
            kind: selected?.kind === 'auto-memory'
              ? 'local-config'
              : (selected?.kind ?? 'local-config'),
            absolutePath: selected?.absolutePath ?? '',
            body: draft.body,
          },
        }
      }
    }
    const dRes = await tryDaemon(payload)
    let r: MutationResult
    if (dRes === 'not-attached') {
      // 2) 本機 fallback
      if (op === 'create') {
        if (draft.kind === 'auto-memory') {
          r = await createAutoMemory({
            filename: draft.filename,
            name: draft.name,
            description: draft.description,
            type: draft.type,
            body: draft.body,
          })
        } else {
          r = await createLocalConfig({
            cwd,
            filename: draft.filename,
            body: draft.body,
          })
        }
      } else {
        if (draft.kind === 'auto-memory') {
          r = await updateAutoMemory({
            filename: draft.filename,
            name: draft.name,
            description: draft.description,
            type: draft.type,
            body: draft.body,
          })
        } else {
          r = await writeRawBody(selected?.absolutePath ?? '', draft.body)
        }
      }
    } else {
      r = dRes
    }
    setWizardDraft(null)
    setPendingInjection(null)
    setMode('list')
    flashResult(r)
  }

  function commitRename(): void {
    if (!selected || !selected.filename) return
    const newName = renameBuffer.trim()
    if (!newName || newName === selected.filename) {
      setFlash({ text: '取消重命名', tone: 'info' })
      setMode('detail')
      return
    }
    void (async () => {
      const kind = tab === 'auto-memory' ? 'auto-memory'
        : tab === 'local-config' ? 'local-config'
        : null
      if (!kind) {
        setMode('list')
        flashResult({ ok: false, error: 'tab 不支援重命名' })
        return
      }
      const dRes = await tryDaemon({
        op: 'rename',
        payload: {
          kind,
          oldFilename: selected.filename!,
          newFilename: newName,
        },
      })
      let r: MutationResult
      if (dRes === 'not-attached') {
        if (kind === 'auto-memory') {
          r = await renameAutoMemory({
            oldFilename: selected.filename!,
            newFilename: newName,
          })
        } else {
          r = await renameLocalConfig({
            cwd,
            oldFilename: selected.filename!,
            newFilename: newName,
          })
        }
      } else {
        r = dRes
      }
      setMode('list')
      flashResult(r)
    })()
  }

  function commitDelete(): void {
    if (!selected) return
    void (async () => {
      const dRes = await tryDaemon({
        op: 'delete',
        payload: {
          kind: selected.kind,
          absolutePath: selected.absolutePath,
          filename: selected.filename,
          displayName: selected.displayName,
          description: selected.description,
        },
      })
      let r: MutationResult
      if (dRes === 'not-attached') {
        r = deleteEntry(cwd, selected)
      } else {
        r = dRes
      }
      setMode('list')
      flashResult(r)
    })()
  }

  useInput((input, key) => {
    // Wizard / aux 子畫面有自己的 useInput；這層全部 bail，避免雙重處理
    if (
      mode === 'wizard-create' ||
      mode === 'wizard-edit' ||
      mode === 'aux-sessionIndex' ||
      mode === 'aux-trash'
    ) {
      return
    }

    // aux-select：上下選 + Enter 進子畫面
    if (mode === 'aux-select') {
      if (key.escape || input === 'q' || key.leftArrow) {
        setMode('list')
        return
      }
      if (input === '1') {
        setMode('aux-sessionIndex')
        return
      }
      if (input === '2') {
        setMode('aux-trash')
        return
      }
      return
    }

    // multi-delete confirm
    if (mode === 'multi-delete-confirm') {
      if (key.escape || input === 'n' || input === 'N') {
        setMode('multi-delete')
        return
      }
      if (input === 'y' || input === 'Y') {
        const ids = Array.from(multiSelected)
        const map = new Map(allEntries.map(e => [e.absolutePath, e]))
        let ok = 0
        const errs: string[] = []
        for (const p of ids) {
          const e = map.get(p)
          if (!e) {
            errs.push(`${p}: not found`)
            continue
          }
          const r = deleteEntry(cwd, e)
          if (r.ok) ok++
          else errs.push(`${e.displayName}: ${r.error}`)
        }
        const summary =
          errs.length === 0
            ? `軟刪 ${ok} 個項目到 .trash/`
            : `軟刪 ${ok}/${ids.length}（${errs.length} 失敗）`
        setMultiSelected(new Set())
        setMode('multi-delete')
        setFlash({
          text: summary,
          tone: errs.length > 0 ? 'error' : 'info',
        })
        reload()
        return
      }
      return
    }

    // multi-delete picker
    if (mode === 'multi-delete') {
      if (key.escape || input === 'q') {
        onExit('Memory delete cancelled (no changes)')
        return
      }
      if (key.leftArrow) {
        setTab(prevTab(tab))
        setCursor(0)
        return
      }
      if (key.rightArrow) {
        setTab(nextTab(tab))
        setCursor(0)
        return
      }
      if (key.upArrow) {
        setCursor(c => Math.max(0, c - 1))
        return
      }
      if (key.downArrow) {
        setCursor(c => Math.min(tabRows.length - 1, c + 1))
        return
      }
      if (input === '/') {
        setMode('filtering')
        return
      }
      if (input === ' ') {
        const row = tabRows[safeCursor]
        if (!row) return
        const next = new Set(multiSelected)
        if (next.has(row.absolutePath)) next.delete(row.absolutePath)
        else next.add(row.absolutePath)
        setMultiSelected(next)
        return
      }
      if (input === 'a') {
        setMultiSelected(new Set(tabRows.map(r => r.absolutePath)))
        return
      }
      if (input === 'N') {
        setMultiSelected(new Set())
        return
      }
      if (key.return) {
        if (multiSelected.size === 0) {
          setFlash({ text: '無選取項目', tone: 'info' })
          return
        }
        setMode('multi-delete-confirm')
        return
      }
      return
    }

    // Filtering mode: text input first
    if (mode === 'filtering') {
      if (key.escape || key.return) {
        setMode('list')
        return
      }
      if (key.backspace || key.delete) {
        setKeyword(k => k.slice(0, -1))
        return
      }
      if (input && input.length === 1 && !key.ctrl && !key.meta) {
        setKeyword(k => k + input)
      }
      return
    }

    // Viewer (full-screen body): scroll only
    if (mode === 'viewer') {
      if (key.escape || input === 'q' || input === 'V' || input === 'v') {
        setMode('detail')
        return
      }
      if (key.upArrow) {
        setViewerOffset(o => Math.max(0, o - 1))
        return
      }
      if (key.downArrow) {
        setViewerOffset(o => o + 1)
        return
      }
      if (key.pageUp) {
        setViewerOffset(o => Math.max(0, o - VIEWER_PAGE_SIZE))
        return
      }
      if (key.pageDown) {
        setViewerOffset(o => o + VIEWER_PAGE_SIZE)
        return
      }
      return
    }

    // Confirm delete
    if (mode === 'confirmDelete') {
      if (key.escape || input === 'n' || input === 'N') {
        setMode('detail')
        return
      }
      if (input === 'y' || input === 'Y') {
        commitDelete()
        return
      }
      return
    }

    // Rename input
    if (mode === 'rename') {
      if (key.escape) {
        setMode('detail')
        return
      }
      if (key.return) {
        commitRename()
        return
      }
      if (key.backspace || key.delete) {
        setRenameBuffer(b => b.slice(0, -1))
        return
      }
      if (input && !key.ctrl && !key.meta) {
        setRenameBuffer(b => b + input)
        return
      }
      return
    }

    // Injection warn — y 強制寫入 / 任意鍵取消
    if (mode === 'injectionWarn') {
      if (input === 'y' || input === 'Y') {
        if (pendingInjection) {
          // 記 warn log（未來 daemon.log 可 grep `injection-override`）
          // eslint-disable-next-line no-console
          console.warn(
            `[memory-tui] injection-override: ${pendingInjection.description}`,
          )
          void pendingInjection.onConfirm()
        }
        return
      }
      if (key.escape || input === 'n' || input === 'N') {
        setPendingInjection(null)
        setMode(wizardDraft ? 'wizard-create' : 'list')
        return
      }
      return
    }

    // Wizard modes — wizard 自帶 useInput；不在此處理（依 react event order，
    // wizard 渲染時才訂閱 input；list 層保持安靜）。但若 wizard 未渲染（萬一）
    // 仍要兜底。
    if (mode === 'wizard-create' || 'wizard-edit') {
      // 委由 wizard 子元件 useInput 處理；這裡不阻擋。
    }
    if (mode === 'wizard-create' || mode === 'wizard-edit') {
      return
    }

    // Detail mode
    if (mode === 'detail') {
      if (key.escape || key.leftArrow || input === 'q') {
        setMode('list')
        return
      }
      if (input === 'V' || input === 'v') {
        setMode('viewer')
        return
      }
      if (input === 'e') {
        openEditFrontmatter()
        return
      }
      if (input === 'E') {
        spawnEditorForBody()
        return
      }
      if (input === 'r') {
        openRename()
        return
      }
      if (input === 'd') {
        openDelete()
        return
      }
      return
    }

    // List mode
    if (key.escape || input === 'q') {
      onExit('Memory manager closed')
      return
    }
    if (key.leftArrow) {
      setTab(prevTab(tab))
      setCursor(0)
      return
    }
    if (key.rightArrow) {
      setTab(nextTab(tab))
      setCursor(0)
      return
    }
    if (key.upArrow) {
      setCursor(c => Math.max(0, c - 1))
      return
    }
    if (key.downArrow) {
      setCursor(c => Math.min(tabRows.length - 1, c + 1))
      return
    }
    if (key.return) {
      if (!selected) {
        setFlash({ text: '(no entry to inspect)', tone: 'info' })
        return
      }
      setMode('detail')
      return
    }
    if (input === '/') {
      setMode('filtering')
      return
    }
    if (input === 'n') {
      openCreate()
      return
    }
    if (input === 'e') {
      if (selected) {
        // 從 list 直接跳 frontmatter wizard（auto-memory tab）
        // 其他 tab 走 spawnEditor body 編輯
        if (tab === 'auto-memory') {
          openEditFrontmatter()
        } else {
          spawnEditorForBody()
        }
      }
      return
    }
    if (input === 'E') {
      if (selected) spawnEditorForBody()
      return
    }
    if (input === 'd') {
      if (selected) openDelete()
      return
    }
    if (input === 'r') {
      if (selected) openRename()
      return
    }
    if (input === 'V' || input === 'v') {
      if (selected) setMode('viewer')
      return
    }
    if (input === 's') {
      setMode('aux-select')
      return
    }
  })

  // ---- multi-delete mode handler（用 useInput 的另一個 hook） ----
  // 為簡化，直接掛在主 useInput 內以 mode 分支。multi-delete 邏輯只在 mode 對時 run。

  // 注意：上方主 useInput 已經根據 mode 分支了；'multi-delete' / 'multi-delete-confirm'
  // 我會直接在 render 端檢查 mode，但 useInput 也要分支 — 改在 main handler 裡再加。

  // ---------- Render branches ----------

  if (mode === 'aux-sessionIndex') {
    return <SessionIndexPanel cwd={cwd} onExit={() => setMode('aux-select')} />
  }

  if (mode === 'aux-trash') {
    return <TrashPanel cwd={cwd} onExit={() => setMode('aux-select')} />
  }

  if (mode === 'aux-select') {
    return (
      <Box flexDirection="column">
        <Text bold color="cyan">輔助子畫面</Text>
        <Box flexDirection="column" marginTop={1}>
          <Text>1) Session-index — 觀測 + rebuild</Text>
          <Text>2) Trash — 列出與還原軟刪項目</Text>
        </Box>
        <Box marginTop={1}>
          <Text dimColor>1/2 進入 · ←/q/Esc 退回</Text>
        </Box>
      </Box>
    )
  }

  if (mode === 'multi-delete' || mode === 'multi-delete-confirm') {
    return renderMultiDelete({
      mode,
      tab,
      tabRows,
      cursor: safeCursor,
      multiSelected,
      flash,
    })
  }

  if (mode === 'wizard-create' || mode === 'wizard-edit') {
    if (!wizardDraft) {
      return <Text color="red">wizard state missing</Text>
    }
    const title =
      mode === 'wizard-create'
        ? `New ${wizardDraft.kind}`
        : `Edit ${wizardDraft.filename}`
    return (
      <MemoryEditWizard
        initial={wizardDraft}
        title={title}
        onSubmit={d => {
          // Caller passed via wizard 把最新 draft 收回
          void performMutation(d, false)
        }}
        onCancel={() => {
          setWizardDraft(null)
          setMode(mode === 'wizard-create' ? 'list' : 'detail')
        }}
      />
    )
  }

  if (mode === 'rename') {
    return (
      <Box flexDirection="column">
        <Text bold>重命名 {selected?.filename ?? '(no entry)'}</Text>
        <Box>
          <Text>新檔名：</Text>
          <Text>{renameBuffer}</Text>
          <Text color="cyan">_</Text>
        </Box>
        <Box marginTop={1}>
          <Text dimColor>Enter 確認 · Esc 取消</Text>
        </Box>
        {flash && (
          <Text color={flash.tone === 'error' ? 'red' : 'yellow'}>
            {flash.text}
          </Text>
        )}
      </Box>
    )
  }

  if (mode === 'confirmDelete') {
    return (
      <Box flexDirection="column">
        <Text bold color="yellow">
          軟刪除 {selected?.displayName} 到 .trash/？
        </Text>
        <Text dimColor>auto-memory 條目會同步移除 MEMORY.md 索引行。</Text>
        <Text>
          按 <Text bold>y</Text> 確認 · 任意鍵取消
        </Text>
      </Box>
    )
  }

  if (mode === 'injectionWarn') {
    return (
      <Box flexDirection="column">
        <Text bold color="red">
          ⚠ 偵測到 prompt injection / 可疑 pattern
        </Text>
        <Text>{pendingInjection?.description ?? '(unknown)'}</Text>
        <Box marginTop={1}>
          <Text dimColor>
            TUI 是人類介面 — 若你確認這份 memory 安全，可強制寫入。
          </Text>
        </Box>
        <Text>
          按 <Text bold color="red">y</Text> 強制寫入（會記 warn log）· 任意鍵取消
        </Text>
      </Box>
    )
  }

  if (mode === 'viewer') {
    return renderViewer({
      entry: selected,
      bodyContent,
      bodyError,
      viewerOffset,
    })
  }

  if (mode === 'detail') {
    return renderDetail({
      entry: selected,
      bodyContent,
      bodyError,
      flash,
    })
  }

  // list / filtering 共用
  return (
    <Box flexDirection="column">
      {renderTabHeader(tab)}
      {renderFilterRow(mode, keyword)}
      {loadError && (
        <Text color="red">load error: {loadError}</Text>
      )}
      {renderRows(tabRows, safeCursor)}
      {renderFooter(mode)}
      {flash && (
        <Box>
          <Text color={flash.tone === 'error' ? 'red' : 'yellow'}>
            {flash.text}
          </Text>
        </Box>
      )}
    </Box>
  )
}

function renderMultiDelete({
  mode,
  tab,
  tabRows,
  cursor,
  multiSelected,
  flash,
}: {
  mode: 'multi-delete' | 'multi-delete-confirm'
  tab: TabId
  tabRows: MemoryEntry[]
  cursor: number
  multiSelected: Set<string>
  flash: Flash | null
}): React.ReactNode {
  if (mode === 'multi-delete-confirm') {
    return (
      <Box flexDirection="column">
        <Text bold color="yellow">
          軟刪 {multiSelected.size} 個項目到 .trash/？
        </Text>
        <Text dimColor>auto-memory 會同步移除 MEMORY.md 索引行</Text>
        <Text>
          按 <Text bold>y</Text> 確認 · 任意鍵取消
        </Text>
      </Box>
    )
  }
  return (
    <Box flexDirection="column">
      {renderTabHeader(tab)}
      <Box>
        <Text dimColor>Memory Delete · </Text>
        <Text>
          {tabRows.length} shown · {multiSelected.size} selected
        </Text>
      </Box>
      <Box flexDirection="column">
        {tabRows.length === 0 ? (
          <Text dimColor>(no entries in this tab)</Text>
        ) : (
          tabRows.slice(0, 30).map((row, i) => {
            const isSel = multiSelected.has(row.absolutePath)
            const isCur = i === cursor
            const mark = isSel ? '[✓]' : '[ ]'
            return (
              <Box key={row.absolutePath}>
                <Text color={isCur ? 'cyan' : undefined}>
                  {isCur ? figures.pointer : ' '}
                </Text>
                <Text color={isSel ? 'yellow' : undefined}> {mark} </Text>
                <Text>{row.displayName}</Text>
                <Text dimColor>
                  {row.description ? ` — ${row.description}` : ''}
                </Text>
              </Box>
            )
          })
        )}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>
          ↑/↓ · ←/→ tab · space toggle · a all · N none · / filter · Enter 確認 · Esc/q 取消
        </Text>
      </Box>
      {flash && (
        <Text color={flash.tone === 'error' ? 'red' : 'yellow'}>
          {flash.text}
        </Text>
      )}
    </Box>
  )
}

function renderTabHeader(active: TabId): React.ReactNode {
  return (
    <Box>
      <Text bold>Memory · </Text>
      {TABS.map((t, i) => {
        const isActive = t.id === active
        return (
          <React.Fragment key={t.id}>
            {i > 0 && <Text dimColor>  </Text>}
            {isActive ? (
              <Text bold color="cyan">
                ‹ {t.label} ›
              </Text>
            ) : (
              <Text dimColor>{t.label}</Text>
            )}
          </React.Fragment>
        )
      })}
      <Text dimColor>    (←/→ 切 tab)</Text>
    </Box>
  )
}

function renderFilterRow(mode: Mode, keyword: string): React.ReactNode {
  const filtering = mode === 'filtering'
  return (
    <Box>
      <Text dimColor>Filter: </Text>
      <Text color={filtering ? 'cyan' : undefined}>
        {filtering ? `[${keyword}_]` : keyword || '(none)'}
      </Text>
    </Box>
  )
}

function renderRows(
  rows: MemoryEntry[],
  cursor: number,
): React.ReactNode {
  if (rows.length === 0) {
    return (
      <Box>
        <Text dimColor>(no entries in this tab)</Text>
      </Box>
    )
  }
  return (
    <Box flexDirection="column">
      {rows.slice(0, 30).map((row, i) => {
        const isCur = i === cursor
        const ts = formatRelativeTime(row.mtimeMs)
        return (
          <Box key={row.absolutePath}>
            <Text color={isCur ? 'cyan' : undefined}>
              {isCur ? figures.pointer : ' '}
            </Text>
            <Text> {truncate(row.displayName, 40)}</Text>
            <Text dimColor>
              {row.description ? ` — ${truncate(row.description, 40)}` : ''}
            </Text>
            <Text dimColor>  {ts}</Text>
          </Box>
        )
      })}
      {rows.length > 30 && (
        <Text dimColor>…and {rows.length - 30} more（按 / 篩選）</Text>
      )}
    </Box>
  )
}

function renderFooter(mode: Mode): React.ReactNode {
  if (mode === 'filtering') {
    return (
      <Box marginTop={1}>
        <Text dimColor>Esc/Enter 結束篩選 · Backspace 退一字</Text>
      </Box>
    )
  }
  return (
    <Box marginTop={1}>
      <Text dimColor>
        ↑/↓ · ←/→ 切 tab · Enter detail · / filter · n new · e edit · r rename · d delete · s 輔助 · q quit
      </Text>
    </Box>
  )
}

function renderDetail({
  entry,
  bodyContent,
  bodyError,
  flash,
}: {
  entry: MemoryEntry | undefined
  bodyContent: string
  bodyError: string | null
  flash: Flash | null
}): React.ReactNode {
  if (!entry) {
    return (
      <Box flexDirection="column">
        <Text color="red">(no entry selected)</Text>
        <Text dimColor>← back</Text>
      </Box>
    )
  }
  const body = stripFrontmatter(bodyContent)
  const preview = previewBody(body, PREVIEW_LINES)
  return (
    <Box flexDirection="column">
      <Box>
        <Text bold>{entry.displayName}</Text>
      </Box>
      {entry.description && (
        <Box>
          <Text dimColor>description: </Text>
          <Text>{entry.description}</Text>
        </Box>
      )}
      <Box>
        <Text dimColor>path: {entry.absolutePath}</Text>
      </Box>
      <Box>
        <Text dimColor>
          {entry.sizeBytes} bytes · {formatRelativeTime(entry.mtimeMs)}
        </Text>
      </Box>
      <Box marginTop={1}>
        <Text dimColor>── body preview (first {PREVIEW_LINES} lines) ──</Text>
      </Box>
      {bodyError ? (
        <Text color="red">read failed: {bodyError}</Text>
      ) : (
        <Box flexDirection="column">
          {preview.split('\n').map((line, i) => (
            <Text key={i}>{line || ' '}</Text>
          ))}
        </Box>
      )}
      <Box marginTop={1}>
        <Text dimColor>
          V 全螢幕 · e 編 frontmatter · E 編 body · r 重命名 · d 刪除 · ←/q 退回
        </Text>
      </Box>
      {flash && (
        <Box>
          <Text color={flash.tone === 'error' ? 'red' : 'yellow'}>
            {flash.text}
          </Text>
        </Box>
      )}
    </Box>
  )
}

function renderViewer({
  entry,
  bodyContent,
  bodyError,
  viewerOffset,
}: {
  entry: MemoryEntry | undefined
  bodyContent: string
  bodyError: string | null
  viewerOffset: number
}): React.ReactNode {
  if (!entry) {
    return (
      <Box flexDirection="column">
        <Text color="red">(no entry)</Text>
      </Box>
    )
  }
  if (bodyError) {
    return (
      <Box flexDirection="column">
        <Text color="red">read failed: {bodyError}</Text>
        <Text dimColor>q/V/Esc 退回 detail</Text>
      </Box>
    )
  }
  const lines = bodyContent.split('\n')
  const visible = lines.slice(
    viewerOffset,
    viewerOffset + 40,
  )
  return (
    <Box flexDirection="column">
      <Box>
        <Text bold color="cyan">{entry.displayName}</Text>
        <Text dimColor>  (viewer · 行 {viewerOffset + 1}-{viewerOffset + visible.length} / {lines.length})</Text>
      </Box>
      <Box flexDirection="column">
        {visible.map((line, i) => (
          <Text key={i}>{line || ' '}</Text>
        ))}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>↑/↓ 行捲動 · PgUp/PgDn 翻頁 · q/V/Esc 退回 detail</Text>
      </Box>
    </Box>
  )
}
