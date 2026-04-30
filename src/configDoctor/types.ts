/**
 * Config doctor 型別定義（M-CONFIG-DOCTOR）。
 *
 * Issue 三級嚴重度：error / warning / info
 * Fix 動作分「safe-auto-fix」與「needs-human」兩類；後者 doctor 只 report 不動。
 */

export type IssueSeverity = 'error' | 'warning' | 'info'

export type DoctorMode = 'check' | 'fix' | 'rewrite-with-docs'

export interface Issue {
  /** 唯一 ID（用於去重 / 測試斷言） */
  code: string
  /** 嚴重度 */
  severity: IssueSeverity
  /** 哪個 config 模組 */
  module: 'llamacpp' | 'web' | 'discord' | 'global' | 'systemPrompt'
  /** 受影響檔案路徑（絕對） */
  path?: string
  /** 一句話摘要（給人看） */
  summary: string
  /** 詳細說明（含建議修法） */
  detail?: string
  /** 此 issue 是否可由 --fix 自動修復 */
  autoFixable: boolean
  /** 給 fixer 用的內部 hint（fix-by-id 時用） */
  fixHint?: Record<string, unknown>
}

export interface DoctorResult {
  issues: Issue[]
  /** 每個模組的載入路徑（INFO） */
  modulePaths: Record<string, string>
  /** 跑 check 花的時間（ms） */
  durationMs: number
}

export interface FixResult {
  /** 哪些 issue 被修了（按 code） */
  fixed: string[]
  /** 哪些 issue 沒修（needs-human / fix 失敗） */
  remaining: string[]
  /** fix 過程的副作用（備份檔路徑等） */
  sideEffects: string[]
}

export interface DoctorRunOptions {
  mode: DoctorMode
  /** 輸出 JSON 模式（給 CI） */
  json?: boolean
  /** 限定模組（debug 用） */
  onlyModule?: Issue['module']
}
