/**
 * M-DISCORD-1.0：Daemon 全域 turn mutex（B-1 並行控制）。
 *
 * 背景：單 daemon 多 ProjectRuntime 共用一個 process，`process.cwd()` /
 * `process.chdir()` 是進程級全域。若兩個 ProjectRuntime 的 turn 同時跑，
 * Bash / Read / Write 等讀 process.cwd() 的 tool 會互相汙染。
 *
 * 解法（方案 B-1）：全域 FIFO mutex 序列化 turn。等待者 enqueue；持有者
 * release 時 dequeue 下一個。鎖 scope 只涵蓋 turn 本身（runner.run），
 * WS admin / permission prompt 不鎖。
 *
 * 代價：兩 project 同時觸發 turn → 後到者排隊等。使用者（2026-04-20）確認
 * 接受此 UX — 個人使用並行 turn 極少。
 *
 * 跟 InputQueue 的差異：
 *   - InputQueue 是 **per-broker** 的 interactive / background / slash 混合策略
 *   - TurnMutex 是 **全 daemon** 的 cross-project 互斥；InputQueue 之上
 *   - 正確順序：broker 從 InputQueue 拿到下一 input → 送進 ProjectRuntime.runTurn
 *     → 後者先 `await turnMutex.acquire()` → 再 chdir + runner.run → finally release
 */

export interface MutexLease {
  /** 呼叫 release() 釋放鎖。冪等 — 多呼叫無害。 */
  release(): void
  /** 誰在持鎖（debug / `/daemon list` 顯示）。 */
  readonly owner: MutexOwner
}

export interface MutexOwner {
  projectId: string
  inputId: string
  acquiredAt: number
}

export interface DaemonTurnMutex {
  /**
   * 取鎖。若鎖空閒立刻 resolve；否則 FIFO 排隊。
   * `signal.aborted` 時 reject `Error('mutex acquire aborted')`，不佔位。
   */
  acquire(owner: Omit<MutexOwner, 'acquiredAt'>, signal?: AbortSignal): Promise<MutexLease>
  /** 目前持鎖者；無人持鎖回 null。 */
  currentOwner(): MutexOwner | null
  /** 等候中的 owner 數量（不含當前持鎖者）。 */
  pendingCount(): number
  /** 測試用：強制清空所有 waiter（reject）+ release current。 */
  _reset(): void
}

interface Waiter {
  owner: Omit<MutexOwner, 'acquiredAt'>
  resolve: (lease: MutexLease) => void
  reject: (err: Error) => void
  signal?: AbortSignal
  onAbort?: () => void
}

export function createDaemonTurnMutex(): DaemonTurnMutex {
  let current: MutexOwner | null = null
  const queue: Waiter[] = []

  const makeLease = (owner: MutexOwner): MutexLease => {
    let released = false
    return {
      owner,
      release: (): void => {
        if (released) return
        released = true
        if (current !== owner) {
          // race: 可能被 _reset 清掉；忽略
          return
        }
        current = null
        // 取下一個 waiter
        while (queue.length > 0) {
          const next = queue.shift()!
          if (next.signal?.aborted) {
            next.reject(new Error('mutex acquire aborted'))
            continue
          }
          const nextOwner: MutexOwner = {
            ...next.owner,
            acquiredAt: Date.now(),
          }
          current = nextOwner
          if (next.onAbort && next.signal) {
            next.signal.removeEventListener('abort', next.onAbort)
          }
          next.resolve(makeLease(nextOwner))
          return
        }
      },
    }
  }

  const acquire = (
    owner: Omit<MutexOwner, 'acquiredAt'>,
    signal?: AbortSignal,
  ): Promise<MutexLease> => {
    if (signal?.aborted) {
      return Promise.reject(new Error('mutex acquire aborted'))
    }
    if (current === null) {
      const acquired: MutexOwner = { ...owner, acquiredAt: Date.now() }
      current = acquired
      return Promise.resolve(makeLease(acquired))
    }
    return new Promise((resolve, reject) => {
      const waiter: Waiter = { owner, resolve, reject, signal }
      if (signal) {
        waiter.onAbort = (): void => {
          const idx = queue.indexOf(waiter)
          if (idx >= 0) {
            queue.splice(idx, 1)
            reject(new Error('mutex acquire aborted'))
          }
        }
        signal.addEventListener('abort', waiter.onAbort, { once: true })
      }
      queue.push(waiter)
    })
  }

  return {
    acquire,
    currentOwner: () => current,
    pendingCount: () => queue.length,
    _reset: () => {
      for (const w of queue) {
        if (w.onAbort && w.signal) {
          w.signal.removeEventListener('abort', w.onAbort)
        }
        w.reject(new Error('mutex reset'))
      }
      queue.length = 0
      current = null
    },
  }
}

/**
 * 套用鎖 + chdir + chdir-back 的 helper。
 *
 * 用法：
 * ```ts
 * await withProjectCwd(mutex, { projectId, inputId, cwd: runtime.cwd, baseCwd },
 *   async () => { await runner.run(...) })
 * ```
 */
export async function withProjectCwd<T>(
  mutex: DaemonTurnMutex,
  opts: {
    projectId: string
    inputId: string
    cwd: string
    baseCwd: string
    signal?: AbortSignal
  },
  body: () => Promise<T>,
): Promise<T> {
  const lease = await mutex.acquire(
    { projectId: opts.projectId, inputId: opts.inputId },
    opts.signal,
  )
  const prevCwd = process.cwd()
  try {
    try {
      process.chdir(opts.cwd)
    } catch (e) {
      // chdir 失敗：釋鎖、丟錯讓 caller 處理（例如 runtime.cwd 已被刪）
      throw new Error(
        `failed to chdir to ${opts.cwd}: ${e instanceof Error ? e.message : String(e)}`,
      )
    }
    return await body()
  } finally {
    try {
      process.chdir(prevCwd)
    } catch {
      // 極端：base 目錄消失。最後嘗試 baseCwd
      try {
        process.chdir(opts.baseCwd)
      } catch {
        // 真的沒救了；daemon 後續 turn 會失敗，但此處不該 crash mutex 釋鎖
      }
    }
    lease.release()
  }
}
