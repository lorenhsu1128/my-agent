/**
 * M-MEMTUI Phase 3：Daemon-routed memory mutations。
 *
 * Frame 協議（WS 單行 JSON）：
 *
 * client → daemon：
 *   { type: 'memory.mutation', requestId, op, payload }
 *
 *   op ∈ { 'create' | 'update' | 'rename' | 'delete' | 'restore' }
 *
 *   create payload (kind=auto-memory):
 *     { kind: 'auto-memory', filename, name, description, type, body }
 *   create payload (kind=local-config):
 *     { kind: 'local-config', filename, body }
 *
 *   update payload (kind=auto-memory):
 *     { kind: 'auto-memory', filename, name, description, type, body }
 *   update payload (kind!=auto-memory):
 *     { kind, absolutePath, body }   // 純 body 寫入（USER / project / local-config）
 *
 *   rename payload:
 *     { kind: 'auto-memory' | 'local-config', oldFilename, newFilename }
 *
 *   delete payload:
 *     { kind, absolutePath, filename? }
 *     — 軟刪到 .trash/；auto-memory 同步移除 MEMORY.md 索引行
 *
 *   restore payload:
 *     { trashId }   // Phase 4 補
 *
 * daemon → client (same requestId)：
 *   { type: 'memory.mutationResult', requestId, ok, error?, message? }
 *
 * daemon → all same-project clients (broadcast after success)：
 *   { type: 'memory.itemsChanged', projectId }
 *
 * 注入掃描在 client（TUI）那層先做，daemon 不重複擋（TUI 已經顯警告 + override
 * 走過了；daemon 重擋會讓「override 後寫入」失敗）。LLM 路徑（MemoryTool）
 * 仍由 MemoryTool.ts 內的硬阻擋處理。
 */

import {
  createAutoMemory,
  createLocalConfig,
  deleteEntry,
  renameAutoMemory,
  renameLocalConfig,
  updateAutoMemory,
  writeRawBody,
  type MutationResult,
} from '../commands/memory/memoryMutations.js'
import type { MemoryEntry, MemoryEntryKind } from '../utils/memoryList.js'
import type { MemoryType } from '../memdir/memoryTypes.js'

export interface MemoryMutationContext {
  projectRoot: string
  projectId: string
}

export type MemoryMutationOp = 'create' | 'update' | 'rename' | 'delete' | 'restore'

type CreateAutoPayload = {
  kind: 'auto-memory'
  filename: string
  name: string
  description: string
  type: MemoryType
  body: string
}

type CreateLocalPayload = {
  kind: 'local-config'
  filename: string
  body: string
}

type UpdateAutoPayload = {
  kind: 'auto-memory'
  filename: string
  name: string
  description: string
  type: MemoryType
  body: string
}

type UpdateRawPayload = {
  kind: Exclude<MemoryEntryKind, 'auto-memory'>
  absolutePath: string
  body: string
}

type RenamePayload = {
  kind: 'auto-memory' | 'local-config'
  oldFilename: string
  newFilename: string
}

type DeletePayload = {
  kind: MemoryEntryKind
  absolutePath: string
  filename?: string
  /** 顯示用（trash details） */
  displayName?: string
  description?: string
}

type RestorePayload = {
  trashId: string
}

export type MemoryMutationRequest = {
  type: 'memory.mutation'
  requestId: string
} & (
  | { op: 'create'; payload: CreateAutoPayload | CreateLocalPayload }
  | { op: 'update'; payload: UpdateAutoPayload | UpdateRawPayload }
  | { op: 'rename'; payload: RenamePayload }
  | { op: 'delete'; payload: DeletePayload }
  | { op: 'restore'; payload: RestorePayload }
)

export type MemoryMutationResult = {
  type: 'memory.mutationResult'
  requestId: string
  ok: boolean
  error?: string
  message?: string
}

export type MemoryItemsChangedBroadcast = {
  type: 'memory.itemsChanged'
  projectId: string
}

export function isMemoryMutationRequest(m: unknown): m is MemoryMutationRequest {
  if (!m || typeof m !== 'object') return false
  const r = m as Record<string, unknown>
  if (r.type !== 'memory.mutation') return false
  if (typeof r.requestId !== 'string') return false
  const op = r.op
  if (op !== 'create' && op !== 'update' && op !== 'rename' && op !== 'delete' && op !== 'restore') {
    return false
  }
  if (!r.payload || typeof r.payload !== 'object') return false
  return true
}

export async function handleMemoryMutation(
  req: MemoryMutationRequest,
  ctx: MemoryMutationContext,
): Promise<MemoryMutationResult> {
  const reply = (
    partial: Partial<MemoryMutationResult>,
  ): MemoryMutationResult => ({
    type: 'memory.mutationResult',
    requestId: req.requestId,
    ok: false,
    ...partial,
  })

  try {
    let r: MutationResult
    if (req.op === 'create') {
      const p = req.payload
      if (p.kind === 'auto-memory') {
        r = await createAutoMemory({
          filename: p.filename,
          name: p.name,
          description: p.description,
          type: p.type,
          body: p.body,
        })
      } else {
        r = await createLocalConfig({
          cwd: ctx.projectRoot,
          filename: p.filename,
          body: p.body,
        })
      }
    } else if (req.op === 'update') {
      const p = req.payload
      if (p.kind === 'auto-memory') {
        r = await updateAutoMemory({
          filename: p.filename,
          name: p.name,
          description: p.description,
          type: p.type,
          body: p.body,
        })
      } else {
        r = await writeRawBody(p.absolutePath, p.body)
      }
    } else if (req.op === 'rename') {
      const p = req.payload
      if (p.kind === 'auto-memory') {
        r = await renameAutoMemory({
          oldFilename: p.oldFilename,
          newFilename: p.newFilename,
        })
      } else {
        r = await renameLocalConfig({
          cwd: ctx.projectRoot,
          oldFilename: p.oldFilename,
          newFilename: p.newFilename,
        })
      }
    } else if (req.op === 'delete') {
      const p = req.payload
      const stub: MemoryEntry = {
        kind: p.kind,
        displayName: p.displayName ?? p.filename ?? p.absolutePath,
        description: p.description ?? '',
        absolutePath: p.absolutePath,
        filename: p.filename,
        sizeBytes: 0,
        mtimeMs: 0,
      }
      r = deleteEntry(ctx.projectRoot, stub)
    } else {
      // restore — Phase 4 補（trash panel 接通後啟用）
      r = { ok: false, error: 'restore op 尚未實作（Phase 4）' }
    }

    if (r.ok) {
      return { ...reply({}), ok: true, message: r.message }
    }
    return reply({ error: r.error })
  } catch (err) {
    return reply({
      error: err instanceof Error ? err.message : String(err),
    })
  }
}
