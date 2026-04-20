/**
 * M-DISCORD-1.0：DaemonTurnMutex 單元測試。
 *
 * 覆蓋：FIFO ordering、rapid acquire/release、abort 移除 waiter、
 * withProjectCwd chdir/chdir-back、chdir 失敗 cleanup。
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  createDaemonTurnMutex,
  withProjectCwd,
} from '../../../src/daemon/daemonTurnMutex'

const baseCwd = process.cwd()
afterEach(() => {
  try {
    process.chdir(baseCwd)
  } catch {
    // ignore
  }
})

describe('DaemonTurnMutex basic', () => {
  test('immediate acquire when idle', async () => {
    const m = createDaemonTurnMutex()
    const lease = await m.acquire({ projectId: 'a', inputId: 'i1' })
    expect(m.currentOwner()?.projectId).toBe('a')
    expect(m.pendingCount()).toBe(0)
    lease.release()
    expect(m.currentOwner()).toBeNull()
  })

  test('FIFO ordering of concurrent acquires', async () => {
    const m = createDaemonTurnMutex()
    const events: string[] = []

    const first = await m.acquire({ projectId: 'a', inputId: 'i1' })
    expect(m.currentOwner()?.inputId).toBe('i1')

    const p2 = m.acquire({ projectId: 'b', inputId: 'i2' }).then(l => {
      events.push('i2-acquired')
      return l
    })
    const p3 = m.acquire({ projectId: 'c', inputId: 'i3' }).then(l => {
      events.push('i3-acquired')
      return l
    })
    expect(m.pendingCount()).toBe(2)
    expect(events).toEqual([])

    first.release()
    const l2 = await p2
    expect(events).toEqual(['i2-acquired'])
    expect(m.currentOwner()?.inputId).toBe('i2')
    l2.release()

    const l3 = await p3
    expect(events).toEqual(['i2-acquired', 'i3-acquired'])
    l3.release()
    expect(m.currentOwner()).toBeNull()
  })

  test('double release is idempotent', async () => {
    const m = createDaemonTurnMutex()
    const lease = await m.acquire({ projectId: 'a', inputId: 'i1' })
    lease.release()
    lease.release()
    expect(m.currentOwner()).toBeNull()
  })

  test('aborted acquire is rejected and removes from queue', async () => {
    const m = createDaemonTurnMutex()
    const held = await m.acquire({ projectId: 'a', inputId: 'i1' })

    const ac = new AbortController()
    const p = m.acquire({ projectId: 'b', inputId: 'i2' }, ac.signal)
    expect(m.pendingCount()).toBe(1)
    ac.abort()
    await expect(p).rejects.toThrow(/aborted/)
    expect(m.pendingCount()).toBe(0)

    held.release()
    expect(m.currentOwner()).toBeNull()
  })

  test('already-aborted signal rejects synchronously', async () => {
    const m = createDaemonTurnMutex()
    const ac = new AbortController()
    ac.abort()
    await expect(
      m.acquire({ projectId: 'a', inputId: 'i1' }, ac.signal),
    ).rejects.toThrow(/aborted/)
    expect(m.currentOwner()).toBeNull()
  })

  test('aborted waiter skipped on release; next non-aborted proceeds', async () => {
    const m = createDaemonTurnMutex()
    const held = await m.acquire({ projectId: 'a', inputId: 'i1' })

    const ac2 = new AbortController()
    const p2 = m.acquire({ projectId: 'b', inputId: 'i2' }, ac2.signal)
    const p3 = m.acquire({ projectId: 'c', inputId: 'i3' })
    expect(m.pendingCount()).toBe(2)

    // Don't abort before release; abort AFTER release starts handoff.
    // Simpler: abort first then release — i2 should be skipped.
    ac2.abort()
    await expect(p2).rejects.toThrow(/aborted/)
    expect(m.pendingCount()).toBe(1)

    held.release()
    const l3 = await p3
    expect(m.currentOwner()?.inputId).toBe('i3')
    l3.release()
  })

  test('_reset rejects pending and clears current', async () => {
    const m = createDaemonTurnMutex()
    await m.acquire({ projectId: 'a', inputId: 'i1' })
    const p = m.acquire({ projectId: 'b', inputId: 'i2' })
    m._reset()
    await expect(p).rejects.toThrow(/reset/)
    expect(m.currentOwner()).toBeNull()
    expect(m.pendingCount()).toBe(0)
  })

  test('owner includes acquiredAt timestamp', async () => {
    const m = createDaemonTurnMutex()
    const before = Date.now()
    const lease = await m.acquire({ projectId: 'a', inputId: 'i1' })
    const after = Date.now()
    expect(lease.owner.acquiredAt).toBeGreaterThanOrEqual(before)
    expect(lease.owner.acquiredAt).toBeLessThanOrEqual(after)
    lease.release()
  })
})

describe('withProjectCwd', () => {
  const tmpA = join(tmpdir(), `mutex-test-A-${Date.now()}`)
  const tmpB = join(tmpdir(), `mutex-test-B-${Date.now()}`)

  test('chdir during body, restore after', async () => {
    mkdirSync(tmpA, { recursive: true })
    try {
      const m = createDaemonTurnMutex()
      let observedDuringBody = ''
      const base = process.cwd()
      await withProjectCwd(
        m,
        { projectId: 'A', inputId: 'i1', cwd: tmpA, baseCwd: base },
        async () => {
          observedDuringBody = process.cwd()
        },
      )
      expect(observedDuringBody).toBe(tmpA)
      expect(process.cwd()).toBe(base)
      expect(m.currentOwner()).toBeNull()
    } finally {
      rmSync(tmpA, { recursive: true, force: true })
    }
  })

  test('restore cwd even if body throws', async () => {
    mkdirSync(tmpB, { recursive: true })
    try {
      const m = createDaemonTurnMutex()
      const base = process.cwd()
      await expect(
        withProjectCwd(
          m,
          { projectId: 'B', inputId: 'i1', cwd: tmpB, baseCwd: base },
          async () => {
            throw new Error('body-boom')
          },
        ),
      ).rejects.toThrow(/body-boom/)
      expect(process.cwd()).toBe(base)
      expect(m.currentOwner()).toBeNull()
    } finally {
      rmSync(tmpB, { recursive: true, force: true })
    }
  })

  test('chdir to non-existent dir throws and releases lock', async () => {
    const m = createDaemonTurnMutex()
    const base = process.cwd()
    const bad = join(tmpdir(), `mutex-does-not-exist-${Date.now()}-${Math.random()}`)
    await expect(
      withProjectCwd(
        m,
        { projectId: 'X', inputId: 'i1', cwd: bad, baseCwd: base },
        async () => {
          throw new Error('should-not-run')
        },
      ),
    ).rejects.toThrow(/chdir/)
    expect(process.cwd()).toBe(base)
    expect(m.currentOwner()).toBeNull()
  })

  test('serializes two concurrent withProjectCwd calls', async () => {
    const tmpC = join(tmpdir(), `mutex-C-${Date.now()}`)
    const tmpD = join(tmpdir(), `mutex-D-${Date.now()}`)
    mkdirSync(tmpC, { recursive: true })
    mkdirSync(tmpD, { recursive: true })
    try {
      const m = createDaemonTurnMutex()
      const base = process.cwd()
      const events: string[] = []

      const first = withProjectCwd(
        m,
        { projectId: 'C', inputId: 'iC', cwd: tmpC, baseCwd: base },
        async () => {
          events.push('C-start')
          await new Promise(r => setTimeout(r, 30))
          events.push(`C-mid-cwd=${process.cwd()}`)
          await new Promise(r => setTimeout(r, 20))
          events.push('C-end')
        },
      )

      // 給 first 小量時間進入 body（取得鎖），確保 D 排在後面
      await new Promise(r => setTimeout(r, 5))

      const second = withProjectCwd(
        m,
        { projectId: 'D', inputId: 'iD', cwd: tmpD, baseCwd: base },
        async () => {
          events.push(`D-start-cwd=${process.cwd()}`)
        },
      )

      await Promise.all([first, second])

      // C 的 start/end 應該完全包住，D 必須在 C 結束後
      expect(events[0]).toBe('C-start')
      expect(events[events.length - 1]).toContain('D-start')
      const cEndIdx = events.indexOf('C-end')
      const dStartIdx = events.findIndex(e => e.startsWith('D-start'))
      expect(cEndIdx).toBeLessThan(dStartIdx)
      expect(process.cwd()).toBe(base)
    } finally {
      rmSync(tmpC, { recursive: true, force: true })
      rmSync(tmpD, { recursive: true, force: true })
    }
  })
})
