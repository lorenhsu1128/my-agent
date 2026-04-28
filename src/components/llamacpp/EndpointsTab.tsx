// M-LLAMACPP-REMOTE：Endpoints / Routing tab UI。
//
// 上半 = remote endpoint 5 個欄位（enabled / baseUrl / model / apiKey / contextSize）
// 下半 = routing 表 5 row（5 callsite × local|remote toggle）
// 動作：Space 切 toggle / Enter 編輯文字或數字 / s 寫檔 / t 連線測試 / r reset

import figures from 'figures'
import * as React from 'react'
import { useState } from 'react'
import { Box, Text, useInput } from '../../ink.js'
import type {
  LlamaCppCallSite,
  LlamaCppRemoteConfig,
  LlamaCppRoutingConfig,
} from '../../llamacppConfig/schema.js'

type Flash = { text: string; tone: 'info' | 'error' }

type RowId =
  | 'remote.enabled'
  | 'remote.baseUrl'
  | 'remote.model'
  | 'remote.apiKey'
  | 'remote.contextSize'
  | 'routing.turn'
  | 'routing.sideQuery'
  | 'routing.memoryPrefetch'
  | 'routing.background'
  | 'routing.vision'

type Row = {
  id: RowId
  label: string
  /** 'toggle' | 'text' | 'number' | 'routing' */
  kind: 'toggle' | 'text' | 'number' | 'routing'
  /** routing key（kind=routing 才有） */
  callsite?: LlamaCppCallSite
}

const ROWS: ReadonlyArray<Row> = [
  { id: 'remote.enabled', label: 'Remote enabled', kind: 'toggle' },
  { id: 'remote.baseUrl', label: '   baseUrl', kind: 'text' },
  { id: 'remote.model', label: '   model', kind: 'text' },
  { id: 'remote.apiKey', label: '   apiKey', kind: 'text' },
  { id: 'remote.contextSize', label: '   contextSize', kind: 'number' },
  { id: 'routing.turn', label: 'routing.turn', kind: 'routing', callsite: 'turn' },
  {
    id: 'routing.sideQuery',
    label: 'routing.sideQuery',
    kind: 'routing',
    callsite: 'sideQuery',
  },
  {
    id: 'routing.memoryPrefetch',
    label: 'routing.memoryPrefetch',
    kind: 'routing',
    callsite: 'memoryPrefetch',
  },
  {
    id: 'routing.background',
    label: 'routing.background',
    kind: 'routing',
    callsite: 'background',
  },
  {
    id: 'routing.vision',
    label: 'routing.vision',
    kind: 'routing',
    callsite: 'vision',
  },
]

type Props = {
  remote: LlamaCppRemoteConfig
  routing: LlamaCppRoutingConfig
  onChangeRemote: (next: LlamaCppRemoteConfig) => void
  onChangeRouting: (next: LlamaCppRoutingConfig) => void
  onSave: () => void
  onTestConnection: () => Promise<void>
  flash: Flash | null
}

export function EndpointsTab({
  remote,
  routing,
  onChangeRemote,
  onChangeRouting,
  onSave,
  onTestConnection,
  flash,
}: Props): React.ReactNode {
  const [cursor, setCursor] = useState(0)
  const [mode, setMode] = useState<'list' | 'editing'>('list')
  const [buffer, setBuffer] = useState('')
  const [editingId, setEditingId] = useState<RowId | null>(null)
  const safeCursor = Math.min(cursor, ROWS.length - 1)

  function commit(): void {
    if (!editingId) return
    if (editingId === 'remote.baseUrl') {
      onChangeRemote({ ...remote, baseUrl: buffer })
    } else if (editingId === 'remote.model') {
      onChangeRemote({ ...remote, model: buffer })
    } else if (editingId === 'remote.apiKey') {
      onChangeRemote({
        ...remote,
        apiKey: buffer.length === 0 ? undefined : buffer,
      })
    } else if (editingId === 'remote.contextSize') {
      const n = Number(buffer)
      if (Number.isFinite(n) && n > 0)
        onChangeRemote({ ...remote, contextSize: n })
    }
    setMode('list')
    setBuffer('')
    setEditingId(null)
  }

  useInput((input, key) => {
    if (mode === 'editing') {
      if (key.escape) {
        setMode('list')
        setBuffer('')
        setEditingId(null)
        return
      }
      if (key.return) {
        commit()
        return
      }
      if (key.backspace || key.delete) {
        setBuffer(b => b.slice(0, -1))
        return
      }
      if (input && input.length === 1 && !key.ctrl && !key.meta) {
        setBuffer(b => b + input)
        return
      }
      return
    }

    if (key.upArrow) {
      setCursor(c => Math.max(0, c - 1))
      return
    }
    if (key.downArrow) {
      setCursor(c => Math.min(ROWS.length - 1, c + 1))
      return
    }
    const row = ROWS[safeCursor]!
    if (input === ' ') {
      if (row.kind === 'toggle') {
        onChangeRemote({ ...remote, enabled: !remote.enabled })
      } else if (row.kind === 'routing' && row.callsite) {
        const cur = routing[row.callsite]
        const next = cur === 'local' ? 'remote' : 'local'
        onChangeRouting({ ...routing, [row.callsite]: next })
      }
      return
    }
    if (key.return) {
      if (row.kind === 'text' || row.kind === 'number') {
        setEditingId(row.id)
        const cur =
          row.id === 'remote.baseUrl'
            ? remote.baseUrl
            : row.id === 'remote.model'
              ? remote.model
              : row.id === 'remote.apiKey'
                ? remote.apiKey ?? ''
                : row.id === 'remote.contextSize'
                  ? String(remote.contextSize)
                  : ''
        setBuffer(cur)
        setMode('editing')
      }
      return
    }
    if (input === 's' || input === 'S') {
      onSave()
      return
    }
    if (input === 't' || input === 'T') {
      void onTestConnection()
      return
    }
  })

  return (
    <Box flexDirection="column">
      <Text dimColor>
        ↑↓ 移動 · Space toggle · Enter 編輯文字 · s 寫檔 · t 測試連線 · q 退出
      </Text>
      <Box marginTop={1} flexDirection="column">
        {ROWS.map((r, i) => {
          const isCursor = i === safeCursor
          const cursorMark = isCursor ? figures.pointer + ' ' : '  '
          let value: string
          if (r.id === 'remote.enabled') {
            value = remote.enabled ? '✓ on' : '✗ off'
          } else if (r.id === 'remote.baseUrl') {
            value = remote.baseUrl
          } else if (r.id === 'remote.model') {
            value = remote.model
          } else if (r.id === 'remote.apiKey') {
            value = maskApiKey(remote.apiKey)
          } else if (r.id === 'remote.contextSize') {
            value = String(remote.contextSize)
          } else if (r.kind === 'routing' && r.callsite) {
            const v = routing[r.callsite]
            value = v === 'remote' ? '→ remote' : '→ local'
          } else {
            value = ''
          }
          const isEditing = mode === 'editing' && editingId === r.id
          const displayValue = isEditing ? `${buffer}_` : value
          const valueColor =
            r.kind === 'routing' &&
            r.callsite &&
            routing[r.callsite] === 'remote'
              ? 'magenta'
              : isCursor
                ? 'cyan'
                : undefined
          return (
            <Box key={r.id}>
              <Text>{cursorMark}</Text>
              <Text bold={isCursor}>{r.label.padEnd(28)}</Text>
              <Text color={valueColor} bold={isEditing}>
                {displayValue}
              </Text>
            </Box>
          )
        })}
      </Box>
      {flash && (
        <Box marginTop={1}>
          <Text color={flash.tone === 'error' ? 'red' : 'green'}>
            {flash.text}
          </Text>
        </Box>
      )}
    </Box>
  )
}

function maskApiKey(key: string | undefined): string {
  if (!key || key.length === 0) return '(none)'
  if (key.length <= 6) return '***'
  return `${key.slice(0, 3)}***${key.slice(-3)}`
}
