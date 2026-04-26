/**
 * M-LLAMACPP-WATCHDOG Phase 3-7：daemon-routed llamacpp config mutations。
 *
 * Frame 協議（WS 單行 JSON）：
 *
 * client → daemon：
 *   { type: 'llamacpp.configMutation', requestId, op, payload }
 *
 *   op = 'setWatchdog'
 *   payload = LlamaCppWatchdogConfig
 *
 * daemon → client (same requestId)：
 *   { type: 'llamacpp.configMutationResult', requestId, ok, error?, message? }
 *
 * daemon → all attached clients (broadcast after success)：
 *   { type: 'llamacpp.configChanged', changedSection: 'watchdog' }
 *
 * 注意：與 cron / memory 廣播不同，llamacpp config 是 daemon 全域狀態（不
 * per-project），broadcast 不帶 projectId — 所有 attached client 都收到。
 */

import { writeWatchdogConfig } from '../commands/llamacpp/llamacppMutations.js'
import type { LlamaCppWatchdogConfig } from '../llamacppConfig/schema.js'

export type LlamacppConfigMutationRequest = {
  type: 'llamacpp.configMutation'
  requestId: string
  op: 'setWatchdog'
  payload: LlamaCppWatchdogConfig
}

export type LlamacppConfigMutationResult = {
  type: 'llamacpp.configMutationResult'
  requestId: string
  ok: boolean
  error?: string
  message?: string
}

export type LlamacppConfigChangedBroadcast = {
  type: 'llamacpp.configChanged'
  changedSection: 'watchdog'
}

export function isLlamacppConfigMutationRequest(
  m: unknown,
): m is LlamacppConfigMutationRequest {
  if (!m || typeof m !== 'object') return false
  const r = m as Record<string, unknown>
  if (r.type !== 'llamacpp.configMutation') return false
  if (typeof r.requestId !== 'string') return false
  if (r.op !== 'setWatchdog') return false
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
      const r = await writeWatchdogConfig(req.payload)
      if (r.ok) return { ...reply({}), ok: true, message: r.message }
      return reply({ error: r.error })
    }
    return reply({ error: `unknown op: ${(req as { op?: string }).op}` })
  } catch (err) {
    return reply({
      error: err instanceof Error ? err.message : String(err),
    })
  }
}
