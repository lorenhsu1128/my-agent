/**
 * M-WEB-PARITY-3：WS 重連補帧測試。
 *
 * 直接測 createBrowserSessionRegistry — 不起 WS server，用 fake ws.send 收集
 * 訊息。驗證：
 *   - broadcastWithSeq 會自動 stamp 遞增 _seq + 進 ring buffer
 *   - replayTo 補送 (lastSeq, ...] 範圍的 frame
 *   - ring buffer 滿後 oldest 被丟（lastSeq 比最舊還早回 0，client 應 fallback full refresh）
 */
import { describe, expect, test } from 'bun:test'
import {
  createBrowserSessionRegistry,
  type BrowserSocketData,
} from '../../../src/web/browserSession.js'
import type { ServerWebSocket } from 'bun'

interface FakeWs {
  ws: ServerWebSocket<BrowserSocketData>
  sent: string[]
}

function makeFakeWs(remoteAddress = '127.0.0.1'): FakeWs {
  const sent: string[] = []
  const ws = {
    data: { sessionId: '', remoteAddress, connectedAt: Date.now() } as BrowserSocketData,
    send: (s: string) => {
      sent.push(s)
      return 1
    },
    close: () => {},
  } as unknown as ServerWebSocket<BrowserSocketData>
  return { ws, sent }
}

describe('M-WEB-PARITY-3 WS replay (browserSessionRegistry)', () => {
  test('broadcastWithSeq stamps monotonic _seq per project', () => {
    const reg = createBrowserSessionRegistry()
    const a = makeFakeWs()
    const sa = reg.register({ ws: a.ws })
    sa.setSubscriptions(['p1'])

    const seq1 = reg.broadcastWithSeq({ type: 't', projectId: 'p1', n: 1 }, 'p1')
    const seq2 = reg.broadcastWithSeq({ type: 't', projectId: 'p1', n: 2 }, 'p1')
    expect(seq1).toBe(1)
    expect(seq2).toBe(2)
    expect(a.sent.length).toBe(2)
    const f1 = JSON.parse(a.sent[0]!)
    const f2 = JSON.parse(a.sent[1]!)
    expect(f1._seq).toBe(1)
    expect(f2._seq).toBe(2)
    expect(f1.n).toBe(1)
  })

  test('per-project seq 互不干擾', () => {
    const reg = createBrowserSessionRegistry()
    const a = makeFakeWs()
    const sa = reg.register({ ws: a.ws })
    sa.setSubscriptions(['p1', 'p2'])

    expect(reg.broadcastWithSeq({ type: 't', projectId: 'p1' }, 'p1')).toBe(1)
    expect(reg.broadcastWithSeq({ type: 't', projectId: 'p2' }, 'p2')).toBe(1)
    expect(reg.broadcastWithSeq({ type: 't', projectId: 'p1' }, 'p1')).toBe(2)
  })

  test('replayTo 重送 lastSeq 之後的 frame', () => {
    const reg = createBrowserSessionRegistry()
    const a = makeFakeWs()
    const sa = reg.register({ ws: a.ws })
    sa.setSubscriptions(['p1'])
    reg.broadcastWithSeq({ type: 't', projectId: 'p1', n: 1 }, 'p1')
    reg.broadcastWithSeq({ type: 't', projectId: 'p1', n: 2 }, 'p1')
    reg.broadcastWithSeq({ type: 't', projectId: 'p1', n: 3 }, 'p1')

    // 模擬 client 斷線後重連 — 換新 session
    const b = makeFakeWs()
    const sb = reg.register({ ws: b.ws })
    sb.setSubscriptions(['p1'])
    expect(b.sent.length).toBe(0) // 重新 attach 不會自動補
    const replayed = reg.replayTo(sb.id, 'p1', 1)
    expect(replayed).toBe(2) // n=2, n=3
    expect(b.sent.length).toBe(2)
    expect(JSON.parse(b.sent[0]!).n).toBe(2)
    expect(JSON.parse(b.sent[1]!).n).toBe(3)
  })

  test('replayTo lastSeq=0 補送全部 ring 內 frame', () => {
    const reg = createBrowserSessionRegistry()
    const a = makeFakeWs()
    const sa = reg.register({ ws: a.ws })
    sa.setSubscriptions(['p1'])
    reg.broadcastWithSeq({ type: 't', projectId: 'p1', n: 1 }, 'p1')
    reg.broadcastWithSeq({ type: 't', projectId: 'p1', n: 2 }, 'p1')

    const b = makeFakeWs()
    const sb = reg.register({ ws: b.ws })
    sb.setSubscriptions(['p1'])
    expect(reg.replayTo(sb.id, 'p1', 0)).toBe(2)
  })

  test('ring buffer 上限：超過後 oldest 被丟', () => {
    const reg = createBrowserSessionRegistry({ ringSizePerProject: 3 })
    const a = makeFakeWs()
    const sa = reg.register({ ws: a.ws })
    sa.setSubscriptions(['p1'])
    for (let i = 1; i <= 5; i++) {
      reg.broadcastWithSeq({ type: 't', projectId: 'p1', n: i }, 'p1')
    }
    const b = makeFakeWs()
    const sb = reg.register({ ws: b.ws })
    sb.setSubscriptions(['p1'])
    // ring 只剩 seq 3,4,5；client lastSeq=0 應只拿到 3 個
    expect(reg.replayTo(sb.id, 'p1', 0)).toBe(3)
    expect(JSON.parse(b.sent[0]!).n).toBe(3)
  })

  test('replayTo 對未訂閱 project 也會送（caller 負責確認 session 已 subscribed）', () => {
    // 設計：replayTo 只是「把 ring 重送」，不檢查 subscription — wsServer 在
    // subscribe handler 內會先 setSubscriptions 才 replay，順序正確。
    const reg = createBrowserSessionRegistry()
    const a = makeFakeWs()
    const sa = reg.register({ ws: a.ws })
    // 不訂閱 p1 — 但 broadcast 對其他 sub 還是會推進 seq
    reg.broadcastWithSeq({ type: 't', projectId: 'p1', n: 1 }, 'p1')
    reg.broadcastWithSeq({ type: 't', projectId: 'p1', n: 2 }, 'p1')
    expect(a.sent.length).toBe(0) // 沒訂閱不收
    expect(reg.replayTo(sa.id, 'p1', 0)).toBe(2)
    expect(a.sent.length).toBe(2)
  })

  test('未知 projectId replayTo 回 0', () => {
    const reg = createBrowserSessionRegistry()
    const a = makeFakeWs()
    const sa = reg.register({ ws: a.ws })
    expect(reg.replayTo(sa.id, 'nonexistent', 0)).toBe(0)
  })

  test('未知 sessionId replayTo 回 0', () => {
    const reg = createBrowserSessionRegistry()
    reg.broadcastWithSeq({ type: 't', projectId: 'p1' }, 'p1')
    expect(reg.replayTo('not-a-session', 'p1', 0)).toBe(0)
  })
})
