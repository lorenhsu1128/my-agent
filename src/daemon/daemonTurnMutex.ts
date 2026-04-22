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
import { resetGetMemoryFilesCache } from '../utils/claudemd.js'
import { getUserContext, getSystemContext, getGitStatus } from '../context.js'
import { getProjectPathForConfig } from '../utils/config.js'
import { getAutoMemPath } from '../memdir/paths.js'
import { getResolvedWorkingDirPaths } from '../utils/permissions/filesystem.js'
import { clearCommandMemoizationCaches } from '../commands.js'
import { clearSystemPromptSections } from '../constants/systemPromptSections.js'
import { isLlamaCppActive } from '../utils/model/providers.js'
import { setSkipPromptCacheOnce } from '../services/api/llamacpp-fetch-adapter.js'

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

let lastTurnProjectId: string | null = null

/**
 * 當 daemon 切換到不同 project 時，標記 adapter 下次 request 跳過 prompt cache。
 * llama.cpp server 的 KV cache 會殘留前一個 project 的 attention pattern，
 * 導致 LLM 生成時傾向引用前一個 project 的檔案。cache_prompt:false 強制
 * 重新計算完整 prompt，消除跨 project 汙染。
 * 同 project 連續 turn 不觸發，保留 prompt cache 加速。
 */
function invalidateLlamaCppCacheIfProjectChanged(projectId: string): void {
  if (!isLlamaCppActive()) return
  if (lastTurnProjectId === projectId) return
  const prev = lastTurnProjectId
  lastTurnProjectId = projectId
  if (prev === null) return
  setSkipPromptCacheOnce()
}

/**
 * M-CWD-FIX：清除所有影響 system prompt 的 memoize cache。
 * daemon 切換 project cwd 後必須清除，否則 system prompt 會沿用
 * 首次 cache 的結果（錯誤的 CLAUDE.md / git status）。
 */
function clearAllContextCaches(): void {
  try {
    resetGetMemoryFilesCache('session_start')
  } catch {
    // ignore
  }
  try {
    getUserContext.cache?.clear?.()
    getSystemContext.cache?.clear?.()
    getGitStatus.cache?.clear?.()
    getProjectPathForConfig.cache?.clear?.()
    getAutoMemPath.cache?.clear?.()
    getResolvedWorkingDirPaths.cache?.clear?.()
    clearCommandMemoizationCaches()
    clearSystemPromptSections()
  } catch {
    // ignore
  }
}

/**
 * 套用鎖 + chdir + originalCwd 切換 + chdir-back 的 helper。
 *
 * 為什麼要動 STATE.originalCwd：`getProject()` 等許多 sessionStorage 呼叫點
 * 用 `getOriginalCwd()` 作為 project 身分鍵。B-1 方案下 daemon 切換到
 * runtime.cwd 時，這些呼叫點才會拿到對的 Project instance、寫對的 session
 * JSONL。turn 結束 finally 還原成 baseCwd。
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
  // 延遲 import 避免 daemonTurnMutex 單元測試啟動時就把整個 bootstrap DAG 拉進來。
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const state = require('../bootstrap/state.js') as typeof import('../bootstrap/state.js')
  const prevCwd = process.cwd()
  const prevOriginalCwd = state.getOriginalCwd()
  const prevProjectRoot = state.getProjectRoot()
  try {
    try {
      process.chdir(opts.cwd)
      state.setOriginalCwd(opts.cwd)
      state.setCwdState(opts.cwd)
      state.setProjectRoot(opts.cwd)
      clearAllContextCaches()
    } catch (e) {
      throw new Error(
        `failed to chdir to ${opts.cwd}: ${e instanceof Error ? e.message : String(e)}`,
      )
    }
    return await body()
  } finally {
    try {
      process.chdir(prevCwd)
    } catch {
      try {
        process.chdir(opts.baseCwd)
      } catch {
        // 真的沒救了；daemon 後續 turn 會失敗，但此處不該 crash mutex 釋鎖
      }
    }
    try {
      state.setOriginalCwd(prevOriginalCwd)
      state.setProjectRoot(prevProjectRoot)
    } catch {
      // ignore
    }
    lease.release()
  }
}

/**
 * 包 SessionRunner：每次 run 前搶 mutex + chdir 到 runtime.cwd + 切
 * STATE.originalCwd；finally 還原。這是 B-1 方案的 per-turn 進入點。
 *
 * 不動 signal 語意：acquire 階段會尊重 signal.aborted（rejects）；underlying
 * runner.run 收到的是同一 signal。Mutex 本身不監控 signal（acquire 已處理），
 * lease 在 finally 釋放。
 */
export function wrapRunnerWithProjectCwd(
  inner: import('./sessionRunner.js').SessionRunner,
  opts: {
    mutex: DaemonTurnMutex
    projectId: string
    cwd: string
    baseCwd: string
  },
): import('./sessionRunner.js').SessionRunner {
  return {
    async *run(input, signal) {
      let lease: MutexLease
      try {
        lease = await opts.mutex.acquire(
          { projectId: opts.projectId, inputId: input.id },
          signal,
        )
      } catch (e) {
        yield {
          type: 'error',
          error: e instanceof Error ? e.message : String(e),
        }
        return
      }
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const state = require('../bootstrap/state.js') as typeof import('../bootstrap/state.js')
      const prevCwd = process.cwd()
      const prevOriginalCwd = state.getOriginalCwd()
      const prevProjectRoot = state.getProjectRoot()
      let chdirOk = false
      try {
        try {
          process.chdir(opts.cwd)
          state.setOriginalCwd(opts.cwd)
          state.setCwdState(opts.cwd)
          state.setProjectRoot(opts.cwd)
          clearAllContextCaches()
          invalidateLlamaCppCacheIfProjectChanged(opts.projectId)
          chdirOk = true
        } catch (e) {
          yield {
            type: 'error',
            error: `failed to chdir to ${opts.cwd}: ${e instanceof Error ? e.message : String(e)}`,
          }
          return
        }
        yield* inner.run(input, signal)
      } finally {
        if (chdirOk) {
          try {
            process.chdir(prevCwd)
          } catch {
            try {
              process.chdir(opts.baseCwd)
            } catch {
              // nothing to do
            }
          }
          try {
            state.setOriginalCwd(prevOriginalCwd)
            state.setProjectRoot(prevProjectRoot)
          } catch {
            // ignore
          }
        }
        lease.release()
      }
    },
  }
}
