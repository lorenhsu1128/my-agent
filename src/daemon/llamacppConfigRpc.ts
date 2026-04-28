/**
 * M-LLAMACPP-WATCHDOG Phase 3-7 + M-LLAMACPP-REMOTE：
 * daemon-routed llamacpp config mutations。
 *
 * Frame 協議（WS 單行 JSON）：
 *
 * client → daemon：
 *   { type: 'llamacpp.configMutation', requestId, op, payload }
 *
 *   op = 'setWatchdog'           payload = LlamaCppWatchdogConfig
 *   op = 'setRemote'             payload = LlamaCppRemoteConfig
 *   op = 'setRouting'            payload = LlamaCppRoutingConfig
 *   op = 'testRemote'            payload = { baseUrl, apiKey?, timeoutMs? }
 *
 * daemon → client (same requestId)：
 *   { type: 'llamacpp.configMutationResult', requestId, ok, error?, message?, data? }
 *
 * daemon → all attached clients (broadcast after success)：
 *   { type: 'llamacpp.configChanged', changedSection: 'watchdog' | 'remote' | 'routing' }
 *   （testRemote 不 broadcast — 它只是讀操作）
 *
 * 注意：與 cron / memory 廣播不同，llamacpp config 是 daemon 全域狀態（不
 * per-project），broadcast 不帶 projectId — 所有 attached client 都收到。
 */

import {
  testRemoteEndpoint,
  writeRemoteConfig,
  writeRoutingConfig,
  writeWatchdogConfig,
} from '../commands/llamacpp/llamacppMutations.js'
import type {
  LlamaCppRemoteConfig,
  LlamaCppRoutingConfig,
  LlamaCppWatchdogConfig,
} from '../llamacppConfig/schema.js'

export type LlamacppConfigMutationOp =
  | 'setWatchdog'
  | 'setRemote'
  | 'setRouting'
  | 'testRemote'

export type TestRemotePayload = {
  baseUrl: string
  apiKey?: string
  timeoutMs?: number
}

export type LlamacppConfigMutationRequest = {
  type: 'llamacpp.configMutation'
  requestId: string
  op: LlamacppConfigMutationOp
  payload:
    | LlamaCppWatchdogConfig
    | LlamaCppRemoteConfig
    | LlamaCppRoutingConfig
    | TestRemotePayload
}

export type LlamacppConfigMutationResult = {
  type: 'llamacpp.configMutationResult'
  requestId: string
  ok: boolean
  error?: string
  message?: string
  /** testRemote 成功時放回 model 名單 */
  data?: { models?: string[] }
}

export type LlamacppConfigChangedSection = 'watchdog' | 'remote' | 'routing'

export type LlamacppConfigChangedBroadcast = {
  type: 'llamacpp.configChanged'
  changedSection: LlamacppConfigChangedSection
}

const VALID_OPS: ReadonlySet<string> = new Set([
  'setWatchdog',
  'setRemote',
  'setRouting',
  'testRemote',
])

export function isLlamacppConfigMutationRequest(
  m: unknown,
): m is LlamacppConfigMutationRequest {
  if (!m || typeof m !== 'object') return false
  const r = m as Record<string, unknown>
  if (r.type !== 'llamacpp.configMutation') return false
  if (typeof r.requestId !== 'string') return false
  if (typeof r.op !== 'string' || !VALID_OPS.has(r.op)) return false
  if (!r.payload || typeof r.payload !== 'object') return false
  return true
}

export async function handleLlamacppConfigMutation(
  req: LlamacppConfigMutationRequest,
): Promise<LlamacppConfigMutationResult> {
  const reply = (
    p: Partial<LlamacppConfigMutationResult>,
  ): LlamacppConfigMutationResult => ({
    type: 'llamacpp.configMutationResult',
    requestId: req.requestId,
    ok: false,
    ...p,
  })
  try {
    if (req.op === 'setWatchdog') {
      const r = await writeWatchdogConfig(req.payload as LlamaCppWatchdogConfig)
      return r.ok
        ? { ...reply({}), ok: true, message: r.message }
        : reply({ error: r.error })
    }
    if (req.op === 'setRemote') {
      const r = await writeRemoteConfig(req.payload as LlamaCppRemoteConfig)
      return r.ok
        ? { ...reply({}), ok: true, message: r.message }
        : reply({ error: r.error })
    }
    if (req.op === 'setRouting') {
      const r = await writeRoutingConfig(req.payload as LlamaCppRoutingConfig)
      return r.ok
        ? { ...reply({}), ok: true, message: r.message }
        : reply({ error: r.error })
    }
    if (req.op === 'testRemote') {
      const p = req.payload as TestRemotePayload
      const r = await testRemoteEndpoint(p)
      return r.ok
        ? { ...reply({}), ok: true, data: { models: r.models } }
        : reply({ error: r.error })
    }
    return reply({ error: `unknown op: ${(req as { op?: string }).op}` })
  } catch (err) {
    return reply({
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

/**
 * 對應 op 的 broadcast section。'testRemote' 回 null（不 broadcast）。
 */
export function broadcastSectionForOp(
  op: LlamacppConfigMutationOp,
): LlamacppConfigChangedSection | null {
  if (op === 'setWatchdog') return 'watchdog'
  if (op === 'setRemote') return 'remote'
  if (op === 'setRouting') return 'routing'
  return null
}
