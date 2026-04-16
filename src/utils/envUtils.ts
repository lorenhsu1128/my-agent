import { existsSync } from 'fs'
import memoize from 'lodash-es/memoize.js'
import { homedir } from 'os'
import { join } from 'path'

/**
 * Free-code 專屬的家目錄設定資料夾名稱（取代官方 Claude Code 的 .claude）。
 * 目的：避免 fork 與官方共用 ~/.my-agent/，污染官方 OAuth / 登入狀態。
 * 使用者仍可用 CLAUDE_CONFIG_DIR env var 手動覆蓋到任意路徑（向下相容）。
 */
export const FREE_CODE_HOME_DIR_NAME = '.my-agent'

/**
 * 官方 Claude Code 的舊家目錄名稱。保留常數用於 migration 提示與疑難排解。
 */
export const LEGACY_CLAUDE_HOME_DIR_NAME = '.my-agent'

// Memoized: 150+ callers, many on hot paths. Keyed off CLAUDE_CONFIG_DIR so
// tests that change the env var get a fresh value without explicit cache.clear.
export const getClaudeConfigHomeDir = memoize(
  (): string => {
    return (
      process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), FREE_CODE_HOME_DIR_NAME)
    ).normalize('NFC')
  },
  () => process.env.CLAUDE_CONFIG_DIR,
)

/**
 * 首次啟動提示：若使用者沒設 CLAUDE_CONFIG_DIR、新家目錄不存在、但舊的
 * ~/.my-agent/ 存在，代表很可能是從官方 Claude Code 切過來。印一次 hint
 * 說明 free-code 現在獨立用 ~/.my-agent/。
 *
 * 設計：只印到 stderr**一次**、只在首次偵測到切換需求時，之後自動建
 * `.migration-acknowledged` marker 後不再印。避免 PowerShell + bun.ps1
 * wrapper 對 stderr 訊息過度反應卡住 TUI 的問題（2026-04-15 使用者回報）。
 *
 * 使用者若要永久關閉：設 CLAUDE_CODE_SKIP_MIGRATION_HINT=1 或建立檔案
 * ~/.my-agent/.migration-acknowledged。
 */
let freeCodeMigrationHintPrinted = false
export function printFreeCodeMigrationHintOnce(): void {
  if (freeCodeMigrationHintPrinted) return
  freeCodeMigrationHintPrinted = true // 同一程序內只嘗試一次，不論是否實際印出
  try {
    if (process.env.CLAUDE_CODE_SKIP_MIGRATION_HINT) return
    if (process.env.CLAUDE_CONFIG_DIR) return
    const newDir = join(homedir(), FREE_CODE_HOME_DIR_NAME)
    const legacyDir = join(homedir(), LEGACY_CLAUDE_HOME_DIR_NAME)
    const ackFile = join(newDir, '.migration-acknowledged')
    if (existsSync(ackFile)) return // 已印過並記錄
    if (!existsSync(legacyDir)) return // 新使用者，沒有 Claude Code 歷史
    // hint 只寫一次到 stderr；同時在 newDir 建 ack marker 避免下次再印
    // 這也繞過 PS bun.ps1 wrapper 對多行 stderr 敏感的問題
    try {
      if (!existsSync(newDir)) {
        // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
        require('fs').mkdirSync(newDir, { recursive: true })
      }
      // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
      require('fs').writeFileSync(
        ackFile,
        `printed at ${new Date().toISOString()}\n`,
      )
    } catch {
      // 建 marker 失敗就算了；下次還是會再印一次（邊界情境）
    }
    // biome-ignore lint/suspicious/noConsole:: 告知 user 的 stderr 訊息
    console.error(
      `[free-code] 家目錄改為 ${newDir}（原 ~/.my-agent/ 不動）。` +
        `沿用舊登入：CLAUDE_CONFIG_DIR="${legacyDir}"。此訊息只顯示一次。`,
    )
  } catch {
    // 任何錯誤都靜默吞掉 — 避免 bootstrap 被 hint 阻斷
  }
}

export function getTeamsDir(): string {
  return join(getClaudeConfigHomeDir(), 'teams')
}

/**
 * Check if NODE_OPTIONS contains a specific flag.
 * Splits on whitespace and checks for exact match to avoid false positives.
 */
export function hasNodeOption(flag: string): boolean {
  const nodeOptions = process.env.NODE_OPTIONS
  if (!nodeOptions) {
    return false
  }
  return nodeOptions.split(/\s+/).includes(flag)
}

export function isEnvTruthy(envVar: string | boolean | undefined): boolean {
  if (!envVar) return false
  if (typeof envVar === 'boolean') return envVar
  const normalizedValue = envVar.toLowerCase().trim()
  return ['1', 'true', 'yes', 'on'].includes(normalizedValue)
}

export function isEnvDefinedFalsy(
  envVar: string | boolean | undefined,
): boolean {
  if (envVar === undefined) return false
  if (typeof envVar === 'boolean') return !envVar
  if (!envVar) return false
  const normalizedValue = envVar.toLowerCase().trim()
  return ['0', 'false', 'no', 'off'].includes(normalizedValue)
}

/**
 * --bare / CLAUDE_CODE_SIMPLE — skip hooks, LSP, plugin sync, skill dir-walk,
 * attribution, background prefetches, and ALL keychain/credential reads.
 * Auth is strictly ANTHROPIC_API_KEY env or apiKeyHelper from --settings.
 * Explicit CLI flags (--plugin-dir, --add-dir, --mcp-config) still honored.
 * ~30 gates across the codebase.
 *
 * Checks argv directly (in addition to the env var) because several gates
 * run before main.tsx's action handler sets CLAUDE_CODE_SIMPLE=1 from --bare
 * — notably startKeychainPrefetch() at main.tsx top-level.
 */
export function isBareMode(): boolean {
  return (
    isEnvTruthy(process.env.CLAUDE_CODE_SIMPLE) ||
    process.argv.includes('--bare')
  )
}

/**
 * Parses an array of environment variable strings into a key-value object
 * @param envVars Array of strings in KEY=VALUE format
 * @returns Object with key-value pairs
 */
export function parseEnvVars(
  rawEnvArgs: string[] | undefined,
): Record<string, string> {
  const parsedEnv: Record<string, string> = {}

  // Parse individual env vars
  if (rawEnvArgs) {
    for (const envStr of rawEnvArgs) {
      const [key, ...valueParts] = envStr.split('=')
      if (!key || valueParts.length === 0) {
        throw new Error(
          `Invalid environment variable format: ${envStr}, environment variables should be added as: -e KEY1=value1 -e KEY2=value2`,
        )
      }
      parsedEnv[key] = valueParts.join('=')
    }
  }
  return parsedEnv
}

/**
 * Get the AWS region with fallback to default
 * Matches the Anthropic Bedrock SDK's region behavior
 */
export function getAWSRegion(): string {
  return process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1'
}

/**
 * Get the default Vertex AI region
 */
export function getDefaultVertexRegion(): string {
  return process.env.CLOUD_ML_REGION || 'us-east5'
}

/**
 * Check if bash commands should maintain project working directory (reset to original after each command)
 * @returns true if CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR is set to a truthy value
 */
export function shouldMaintainProjectWorkingDir(): boolean {
  return isEnvTruthy(process.env.CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR)
}

/**
 * Check if running on Homespace (ant-internal cloud environment)
 */
export function isRunningOnHomespace(): boolean {
  return (
    process.env.USER_TYPE === 'ant' &&
    isEnvTruthy(process.env.COO_RUNNING_ON_HOMESPACE)
  )
}

/**
 * Conservative check for whether Claude Code is running inside a protected
 * (privileged or ASL3+) COO namespace or cluster.
 *
 * Conservative means: when signals are ambiguous, assume protected. We would
 * rather over-report protected usage than miss it. Unprotected environments
 * are homespace, namespaces on the open allowlist, and no k8s/COO signals
 * at all (laptop/local dev).
 *
 * Used for telemetry to measure auto-mode usage in sensitive environments.
 */
export function isInProtectedNamespace(): boolean {
  // USER_TYPE is build-time --define'd; in external builds this block is
  // DCE'd so the require() and namespace allowlist never appear in the bundle.
  if (process.env.USER_TYPE === 'ant') {
    /* eslint-disable @typescript-eslint/no-require-imports */
    return (
      require('./protectedNamespace.js') as typeof import('./protectedNamespace.js')
    ).checkProtectedNamespace()
    /* eslint-enable @typescript-eslint/no-require-imports */
  }
  return false
}

// @[MODEL LAUNCH]: Add a Vertex region override env var for the new model.
/**
 * Model prefix → env var for Vertex region overrides.
 * Order matters: more specific prefixes must come before less specific ones
 * (e.g., 'claude-opus-4-1' before 'claude-opus-4').
 */
const VERTEX_REGION_OVERRIDES: ReadonlyArray<[string, string]> = [
  ['claude-haiku-4-5', 'VERTEX_REGION_CLAUDE_HAIKU_4_5'],
  ['claude-3-5-haiku', 'VERTEX_REGION_CLAUDE_3_5_HAIKU'],
  ['claude-3-5-sonnet', 'VERTEX_REGION_CLAUDE_3_5_SONNET'],
  ['claude-3-7-sonnet', 'VERTEX_REGION_CLAUDE_3_7_SONNET'],
  ['claude-opus-4-1', 'VERTEX_REGION_CLAUDE_4_1_OPUS'],
  ['claude-opus-4', 'VERTEX_REGION_CLAUDE_4_0_OPUS'],
  ['claude-sonnet-4-6', 'VERTEX_REGION_CLAUDE_4_6_SONNET'],
  ['claude-sonnet-4-5', 'VERTEX_REGION_CLAUDE_4_5_SONNET'],
  ['claude-sonnet-4', 'VERTEX_REGION_CLAUDE_4_0_SONNET'],
]

/**
 * Get the Vertex AI region for a specific model.
 * Different models may be available in different regions.
 */
export function getVertexRegionForModel(
  model: string | undefined,
): string | undefined {
  if (model) {
    const match = VERTEX_REGION_OVERRIDES.find(([prefix]) =>
      model.startsWith(prefix),
    )
    if (match) {
      return process.env[match[1]] || getDefaultVertexRegion()
    }
  }
  return getDefaultVertexRegion()
}
