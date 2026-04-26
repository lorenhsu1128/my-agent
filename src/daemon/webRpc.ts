/**
 * M-WEB-7：daemon 內 `/web start/stop/status` RPC handler。
 *
 * Frame protocol（WS 單行 JSON）：
 *
 * client → daemon:
 *   { type: 'web.control', requestId, op: 'start' | 'stop' | 'status' }
 *
 * daemon → client（same requestId）:
 *   { type: 'web.controlResult', requestId, ok, error?, status: WebServerStatus }
 *
 * daemon → all attached clients（broadcast，每次狀態變更）:
 *   { type: 'web.statusChanged', running, port?, bindHost? }
 *
 * 注意：與 cron / memory 廣播不同，web server 是 daemon 全域狀態（不 per-project），
 * broadcast 不帶 projectId — 所有 attached client 都收到。
 */
import type {
  WebServerController,
  WebServerStatus,
} from '../web/webController.js'

export type WebControlRequest = {
  type: 'web.control'
  requestId: string
  op: 'start' | 'stop' | 'status'
}

export type WebControlResult = {
  type: 'web.controlResult'
  requestId: string
  ok: boolean
  error?: string
  status: WebServerStatus
}

export type WebStatusChangedBroadcast = {
  type: 'web.statusChanged'
  running: boolean
  port?: number
  bindHost?: string
}

export function isWebControlRequest(m: unknown): m is WebControlRequest {
  if (!m || typeof m !== 'object') return false
  const r = m as Record<string, unknown>
  if (r.type !== 'web.control') return false
  if (typeof r.requestId !== 'string') return false
  return r.op === 'start' || r.op === 'stop' || r.op === 'status'
}

export async function handleWebControl(
  controller: WebServerController,
  req: WebControlRequest,
): Promise<WebControlResult> {
  const reply = (p: Partial<WebControlResult>): WebControlResult => ({
    type: 'web.controlResult',
    requestId: req.requestId,
    ok: false,
    status: controller.status(),
    ...p,
  })
  try {
    if (req.op === 'start') {
      const status = await controller.start()
      return { ...reply({}), ok: true, status }
    }
    if (req.op === 'stop') {
      const status = await controller.stop()
      return { ...reply({}), ok: true, status }
    }
    if (req.op === 'status') {
      return { ...reply({}), ok: true, status: controller.status() }
    }
    return reply({ error: `unknown op: ${(req as { op?: string }).op}` })
  } catch (err) {
    return reply({ error: err instanceof Error ? err.message : String(err) })
  }
}
