/**
 * System Prompt Externalization — 當前 cwd context（M-SP-FULL Phase 1）
 *
 * 透過 AsyncLocalStorage 在 daemon 模式下追蹤「當前 ask() 屬於哪個 project
 * 的 cwd」，讓 prompts.ts 內同步的 getExternalSection() 不必擴簽名也能拿到
 * 正確的 per-project snapshot。
 *
 * 使用方式：
 *   - daemon 端：queryEngineRunner.run() 把整個 ask() 迴圈包在
 *     `runWithSystemPromptCwd(context.cwd, () => ...)` 內。
 *   - prompts.ts 端：`getCurrentSystemPromptCwd()` 在同步路徑取當前 cwd，
 *     傳給 snapshot.getSection(id, cwd)。
 *   - REPL / 啟動 setup 路徑：不呼叫 runWith，cwd 為 undefined，snapshot 走
 *     DEFAULT_KEY（行為與 M-SP-FULL 前一致）。
 *
 * AsyncLocalStorage 自動 scope 到 async chain，多 project 並發 ask 不會互蓋。
 */
import { AsyncLocalStorage } from 'async_hooks'

const cwdAls = new AsyncLocalStorage<string>()

/**
 * 在 cwd context 內執行 fn。fn 內部任何同步 / async 呼叫鏈都能透過
 * getCurrentSystemPromptCwd() 拿到 cwd。
 */
export function runWithSystemPromptCwd<T>(cwd: string, fn: () => T): T {
  return cwdAls.run(cwd, fn)
}

/**
 * 取當前 ALS scope 內的 cwd。不在任何 scope 內回 undefined（呼叫端 fallback
 * 到 DEFAULT_KEY snapshot）。
 */
export function getCurrentSystemPromptCwd(): string | undefined {
  return cwdAls.getStore()
}
