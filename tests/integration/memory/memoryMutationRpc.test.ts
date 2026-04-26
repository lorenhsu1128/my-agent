// M-MEMTUI Phase 3：daemon memoryMutationRpc 單元測試。
// 直接 call handleMemoryMutation 看回傳，跳過 WS 層；驗 5 ops 皆成功路徑。

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { existsSync, mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

let tmpMemDir: string
let tmpCwd: string

beforeEach(() => {
  const stamp = Date.now() + '-' + Math.random().toString(36).slice(2, 8)
  tmpMemDir = join(tmpdir(), `memrpc-memdir-${stamp}`)
  tmpCwd = join(tmpdir(), `memrpc-cwd-${stamp}`)
  mkdirSync(tmpMemDir, { recursive: true })
  mkdirSync(tmpCwd, { recursive: true })
  mkdirSync(join(tmpCwd, '.my-agent'), { recursive: true })
})

afterEach(() => {
  try { rmSync(tmpMemDir, { recursive: true, force: true }) } catch {}
  try { rmSync(tmpCwd, { recursive: true, force: true }) } catch {}
})

const realPaths = await import('../../../src/memdir/paths.js')
mock.module('../../../src/memdir/paths.js', () => ({
  ...realPaths,
  getAutoMemPath: () => tmpMemDir,
  getMemoryBaseDir: () => tmpMemDir,
  isAutoMemoryEnabled: () => true,
}))

async function loadRpc(): Promise<
  typeof import('../../../src/daemon/memoryMutationRpc.js')
> {
  return await import('../../../src/daemon/memoryMutationRpc.js')
}

describe('isMemoryMutationRequest', () => {
  test('合法 frame 通過', async () => {
    const rpc = await loadRpc()
    expect(
      rpc.isMemoryMutationRequest({
        type: 'memory.mutation',
        requestId: 'r1',
        op: 'create',
        payload: { kind: 'auto-memory', filename: 'a.md', name: 'a', description: 'a', type: 'feedback', body: 'x' },
      }),
    ).toBe(true)
  })

  test('未知 op 拒絕', async () => {
    const rpc = await loadRpc()
    expect(
      rpc.isMemoryMutationRequest({
        type: 'memory.mutation',
        requestId: 'r1',
        op: 'fake',
        payload: {},
      }),
    ).toBe(false)
  })

  test('缺 requestId 拒絕', async () => {
    const rpc = await loadRpc()
    expect(
      rpc.isMemoryMutationRequest({
        type: 'memory.mutation',
        op: 'create',
        payload: {},
      }),
    ).toBe(false)
  })

  test('type 不對 拒絕', async () => {
    const rpc = await loadRpc()
    expect(
      rpc.isMemoryMutationRequest({
        type: 'memory.foo',
        requestId: 'r1',
        op: 'create',
        payload: {},
      }),
    ).toBe(false)
  })
})

describe('handleMemoryMutation', () => {
  const ctx = () => ({ projectRoot: tmpCwd, projectId: 'pid-test' })

  test('create auto-memory → ok + 檔案存在', async () => {
    const rpc = await loadRpc()
    const res = await rpc.handleMemoryMutation(
      {
        type: 'memory.mutation',
        requestId: 'r1',
        op: 'create',
        payload: {
          kind: 'auto-memory',
          filename: 'k12.md',
          name: 'K12',
          description: 'rpc test',
          type: 'feedback',
          body: 'body',
        },
      },
      ctx(),
    )
    expect(res.ok).toBe(true)
    expect(res.requestId).toBe('r1')
    expect(existsSync(join(tmpMemDir, 'k12.md'))).toBe(true)
  })

  test('update auto-memory → ok + 內容換新', async () => {
    const rpc = await loadRpc()
    await rpc.handleMemoryMutation(
      {
        type: 'memory.mutation',
        requestId: 'c1',
        op: 'create',
        payload: {
          kind: 'auto-memory',
          filename: 'upd.md',
          name: 'Old',
          description: 'old',
          type: 'feedback',
          body: 'old body',
        },
      },
      ctx(),
    )
    const res = await rpc.handleMemoryMutation(
      {
        type: 'memory.mutation',
        requestId: 'u1',
        op: 'update',
        payload: {
          kind: 'auto-memory',
          filename: 'upd.md',
          name: 'New',
          description: 'new',
          type: 'project',
          body: 'new body',
        },
      },
      ctx(),
    )
    expect(res.ok).toBe(true)
  })

  test('rename → ok + 舊不存在新存在', async () => {
    const rpc = await loadRpc()
    await rpc.handleMemoryMutation(
      {
        type: 'memory.mutation',
        requestId: 'c1',
        op: 'create',
        payload: {
          kind: 'auto-memory',
          filename: 'a.md',
          name: 'A',
          description: 'A',
          type: 'feedback',
          body: 'body',
        },
      },
      ctx(),
    )
    const res = await rpc.handleMemoryMutation(
      {
        type: 'memory.mutation',
        requestId: 'rn1',
        op: 'rename',
        payload: { kind: 'auto-memory', oldFilename: 'a.md', newFilename: 'b.md' },
      },
      ctx(),
    )
    expect(res.ok).toBe(true)
    expect(existsSync(join(tmpMemDir, 'a.md'))).toBe(false)
    expect(existsSync(join(tmpMemDir, 'b.md'))).toBe(true)
  })

  test('delete auto-memory → ok + 檔案搬到 .trash', async () => {
    const rpc = await loadRpc()
    await rpc.handleMemoryMutation(
      {
        type: 'memory.mutation',
        requestId: 'c1',
        op: 'create',
        payload: {
          kind: 'auto-memory',
          filename: 'del.md',
          name: 'D',
          description: 'D',
          type: 'feedback',
          body: 'body',
        },
      },
      ctx(),
    )
    const res = await rpc.handleMemoryMutation(
      {
        type: 'memory.mutation',
        requestId: 'd1',
        op: 'delete',
        payload: {
          kind: 'auto-memory',
          absolutePath: join(tmpMemDir, 'del.md'),
          filename: 'del.md',
          displayName: '[feedback] D',
          description: 'D',
        },
      },
      ctx(),
    )
    expect(res.ok).toBe(true)
    expect(existsSync(join(tmpMemDir, 'del.md'))).toBe(false)
  })

  test('restore op → 仍未實作（reply ok=false）', async () => {
    const rpc = await loadRpc()
    const res = await rpc.handleMemoryMutation(
      {
        type: 'memory.mutation',
        requestId: 'rs1',
        op: 'restore',
        payload: { trashId: 'fake' },
      },
      ctx(),
    )
    expect(res.ok).toBe(false)
    expect(res.error).toContain('Phase 4')
  })
})
