// M-MEMRECALL-CMD：右欄 Memory Recall accordion section。
// 上半 settings（toggle + 兩個 number）、下半 session recall history + ad-hoc test。
// 使用既有 /api/projects/:id/memory(-recall) 系列 endpoint，不另起 modal。

import { useEffect, useState } from 'react'
import { api, ApiError } from '../../../api/client'
import {
  type MemoryRecallLogEntry,
  type MemoryRecallSettings,
} from '../../../api/types'
import { useWsClient } from '../../../hooks/useWsClient'
import { useSessionStore } from '../../../store/sessionStore'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Trash2, FlaskConical, RotateCw } from 'lucide-react'

export interface MemoryRecallTabProps {
  projectId: string
}

const RANGE = { min: 1, max: 20 }

function basename(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return i < 0 ? p : p.slice(i + 1)
}

function formatHHMM(ts: number): string {
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export function MemoryRecallTab({ projectId }: MemoryRecallTabProps) {
  const ws = useWsClient()
  const sessionId = useSessionStore(
    s => s.selectedSessionByProject[projectId] ?? '',
  )

  const [settings, setSettings] = useState<MemoryRecallSettings | null>(null)
  const [log, setLog] = useState<MemoryRecallLogEntry[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  // ad-hoc test recall
  const [testQuery, setTestQuery] = useState('')
  const [testResult, setTestResult] = useState<
    { path: string; mtimeMs: number }[] | null
  >(null)
  const [testing, setTesting] = useState(false)

  async function refresh() {
    setLoading(true)
    setError(null)
    try {
      const s = await api.memoryRecall.getSettings(projectId)
      setSettings(s)
      if (sessionId) {
        const r = await api.memoryRecall.sessionLog(projectId, sessionId)
        setLog(r.entries)
      } else {
        setLog([])
      }
    } catch (e) {
      setError(
        e instanceof ApiError
          ? `${e.code}: ${e.message}`
          : e instanceof Error
            ? e.message
            : String(e),
      )
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void refresh()
  }, [projectId, sessionId])

  // Cross-client settings 同步
  useEffect(() => {
    if (!ws) return
    return ws.on('frame', f => {
      if (
        f.type === 'memoryRecall.settingsChanged' &&
        (f as { projectId?: string }).projectId === projectId
      ) {
        void refresh()
      }
      // memory.itemsChanged 也刷一下（delete/edit 後 sessionLog 仍應顯示路徑但檔案已沒；保險刷新）
      if (
        f.type === 'memory.itemsChanged' &&
        (f as { projectId?: string }).projectId === projectId
      ) {
        void refresh()
      }
    })
  }, [ws, projectId, sessionId])

  async function patchSettings(p: Partial<MemoryRecallSettings>) {
    try {
      await api.memoryRecall.setSettings(projectId, p)
      // 樂觀更新
      setSettings(s => (s ? { ...s, ...p } : s))
    } catch (e) {
      alert(
        `寫入失敗：${e instanceof ApiError ? `${e.code}: ${e.message}` : (e as Error).message}`,
      )
      void refresh()
    }
  }

  async function deleteEntry(entry: MemoryRecallLogEntry) {
    if (!confirm(`軟刪 ${basename(entry.path)} 到 .trash/？`)) return
    try {
      await api.memory.delete(projectId, {
        kind: 'auto-memory',
        absolutePath: entry.path,
        filename: basename(entry.path),
      })
      // 不從 log 拿掉（保留歷史紀錄；下次刷新時若仍存在會回來）
      void refresh()
    } catch (e) {
      alert(
        `刪除失敗：${e instanceof ApiError ? `${e.code}: ${e.message}` : (e as Error).message}`,
      )
    }
  }

  async function runTest() {
    const q = testQuery.trim()
    if (q.length === 0) return
    setTesting(true)
    setTestResult(null)
    try {
      const r = await api.memoryRecall.test(projectId, q)
      setTestResult(r.entries)
    } catch (e) {
      alert(
        `測試失敗：${e instanceof ApiError ? `${e.code}: ${e.message}` : (e as Error).message}`,
      )
    } finally {
      setTesting(false)
    }
  }

  if (loading && !settings) {
    return <div className="p-3 text-sm text-muted-foreground">載入中…</div>
  }
  if (error) {
    return (
      <div className="p-3 text-sm text-destructive">
        錯誤：{error}
        <Button variant="outline" size="sm" className="ml-2" onClick={() => void refresh()}>
          <RotateCw className="h-3 w-3 mr-1" /> 重試
        </Button>
      </div>
    )
  }
  if (!settings) return null

  return (
    <div className="flex flex-col gap-3 p-2">
      {/* Settings */}
      <div className="flex flex-col gap-2 text-sm">
        <h4 className="text-xs font-semibold uppercase text-muted-foreground tracking-wide">
          Settings
        </h4>
        <div className="flex items-center justify-between">
          <span>Enabled</span>
          <Switch
            checked={settings.enabled}
            onCheckedChange={v => void patchSettings({ enabled: v })}
          />
        </div>
        <NumberRow
          label="Max files"
          value={settings.maxFiles}
          onCommit={v => void patchSettings({ maxFiles: v })}
        />
        <NumberRow
          label="Fallback max"
          value={settings.fallbackMaxFiles}
          onCommit={v => void patchSettings({ fallbackMaxFiles: v })}
        />
        <p className="text-xs text-muted-foreground">
          Max files: selector LLM 每輪可選的 memory 檔上限（範圍 {RANGE.min}-{RANGE.max}）。
          Fallback：selector 失敗時取最新 N 檔。
        </p>
      </div>

      {/* Session history */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <h4 className="text-xs font-semibold uppercase text-muted-foreground tracking-wide">
            Session history ({log.length})
          </h4>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs"
            onClick={() => void refresh()}
            title="refresh"
          >
            <RotateCw className="h-3 w-3" />
          </Button>
        </div>
        {!sessionId ? (
          <p className="text-xs text-muted-foreground">
            （尚未選 session — recall log 以 session 為單位）
          </p>
        ) : log.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            （本 session 尚無 memory 命中）
          </p>
        ) : (
          <ul className="flex flex-col gap-1 text-xs">
            {log.map(e => (
              <li
                key={e.path}
                className="flex items-center gap-2 p-1 hover:bg-accent rounded group"
              >
                <span className="flex-1 font-mono truncate" title={e.path}>
                  {basename(e.path)}
                </span>
                <span className="text-muted-foreground tabular-nums">
                  {e.hitCount}× {formatHHMM(e.ts)}
                </span>
                {e.source === 'fallback' && (
                  <span className="text-amber-600 text-[10px]">fb</span>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-5 w-5 p-0 opacity-0 group-hover:opacity-100"
                  onClick={() => void deleteEntry(e)}
                  title="軟刪到 .trash/"
                >
                  <Trash2 className="h-3 w-3" />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Test recall */}
      <div className="flex flex-col gap-2">
        <h4 className="text-xs font-semibold uppercase text-muted-foreground tracking-wide">
          Test recall
        </h4>
        <div className="flex gap-1">
          <Input
            value={testQuery}
            onChange={e => setTestQuery(e.target.value)}
            placeholder="輸入查詢，看 selector 會選哪些檔（不影響當前 context）"
            className="h-7 text-xs"
            onKeyDown={e => {
              if (e.key === 'Enter' && !testing) void runTest()
            }}
          />
          <Button
            variant="outline"
            size="sm"
            disabled={testing || testQuery.trim().length === 0}
            onClick={() => void runTest()}
            className="h-7 px-2"
          >
            <FlaskConical className="h-3 w-3 mr-1" /> Test
          </Button>
        </div>
        {testResult !== null && (
          <ul className="flex flex-col gap-0.5 text-xs">
            {testResult.length === 0 ? (
              <li className="text-muted-foreground">（selector 未選任何檔）</li>
            ) : (
              testResult.map(r => (
                <li key={r.path} className="font-mono truncate" title={r.path}>
                  {basename(r.path)}
                </li>
              ))
            )}
          </ul>
        )}
      </div>
    </div>
  )
}

function NumberRow({
  label,
  value,
  onCommit,
}: {
  label: string
  value: number
  onCommit: (n: number) => void
}) {
  const [text, setText] = useState(String(value))
  useEffect(() => {
    setText(String(value))
  }, [value])
  return (
    <div className="flex items-center justify-between gap-2">
      <span>{label}</span>
      <Input
        type="number"
        min={RANGE.min}
        max={RANGE.max}
        value={text}
        onChange={e => setText(e.target.value)}
        onBlur={() => {
          const n = Math.round(Number(text))
          if (
            !Number.isFinite(n) ||
            n < RANGE.min ||
            n > RANGE.max ||
            n === value
          ) {
            setText(String(value))
            return
          }
          onCommit(n)
        }}
        onKeyDown={e => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
          if (e.key === 'Escape') setText(String(value))
        }}
        className="h-7 w-16 text-xs text-right"
      />
    </div>
  )
}
