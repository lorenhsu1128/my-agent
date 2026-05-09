# Remote Sessions（CCR 遠端 session）

> 對應目錄：`src/remote/`
> 使用者面：`claude assistant` 子命令（viewer 模式）
> 後端：CCR（Claude Code Remote）— Anthropic 託管的 session container

把 agent loop 跑在 CCR 容器內，本地 CLI 透過 WebSocket 收 SDKMessage 與 permission request、送 user message 與 permission response、處理 cancel 與斷線重連。與 daemon-mode（本地 daemon）不同：CCR 是雲端容器、有 token 認證、permission 走 server-side gating。

## 兩種角色

由 `RemoteSessionConfig.viewerOnly` 控制：

| 模式 | viewerOnly | 觸發 | 行為 |
|---|---|---|---|
| 互動 | `false` | `claude --remote` 等 | 可送 user message、Ctrl+C 真的中斷 remote agent、60s reconnect timeout、會更新 session title |
| Viewer | `true` | `claude assistant` | 只看 — Ctrl+C/Esc 不送 interrupt、不 reconnect timeout、不改 title |

## 訊息流

```
本地 CLI                                      CCR container
  │                                              │
  │  ── WS connect (orgUuid, sessionId, token) ─→│
  │                                              │  (run agent loop)
  │                                              │
  │  ←─── SDKMessage (assistant text/tool) ──── │
  │  ←─── SDKControlPermissionRequest ────────── │  (tool 想跑前)
  │  ─── SDKControlResponse (allow/deny) ─────→ │
  │  ←─── SDKControlCancelRequest ────────────── │  (server 撤回 pending request)
  │                                              │
  │  ─── SDKMessage (user follow-up) ──────────→ │
  │  ─── SDKControlCancelRequest (Ctrl+C) ─────→ │  (僅互動模式)
  │                                              │
```

## 主要 component

### `RemoteSessionManager`（`RemoteSessionManager.ts`）

最上層 facade。Config：

```ts
type RemoteSessionConfig = {
  sessionId: string
  getAccessToken: () => string  // 每次重連時呼叫，token 可能已 refresh
  orgUuid: string
  hasInitialPrompt?: boolean    // session 是否帶初始 prompt 在跑
  viewerOnly?: boolean
}

type RemoteSessionCallbacks = {
  onMessage: (msg: SDKMessage) => void
  onPermissionRequest: (req, requestId) => void
  onPermissionCancelled?: (requestId, toolUseId) => void
  onConnected?: () => void
  onDisconnected?: () => void
}
```

職責：包 `SessionsWebSocket`、把 control_request 解 demux 成 permission callback、用 `sendEventToRemoteSession()`（`utils/teleport/api.ts`）送 user-side event。

### `SessionsWebSocket`（`SessionsWebSocket.ts`）

底層 WS client。處理：

- 重連（`RECONNECT_DELAY_MS=2000`、`MAX_RECONNECT_ATTEMPTS=5`）
- Ping（30 秒）
- Close code 處理：
  - `4001` session not found — 可能是 compaction 中暫時看不到，限 `MAX_SESSION_NOT_FOUND_RETRIES=3` 次重試
  - `4003` unauthorized — 永久拒絕，停止重連
  - 其他 — 走一般 reconnect 邏輯
- mTLS（`getWebSocketTLSOptions()`）+ HTTPS proxy（`getWebSocketProxyAgent()`）

訊息 type guard 用 `isSessionsMessage()` — 只擋非 object / 沒 `type` 欄位的明顯垃圾，**不**做 type allowlist（避免 backend 加新 type 時 client 靜默 drop）。

### `remotePermissionBridge.ts`

CCR 上的 tool use 沒有真正的本地 `AssistantMessage`，但 my-agent 既有 permission UI（`ToolUseConfirm`）需要它。Bridge 提供：

- `createSyntheticAssistantMessage(request, requestId)` — 合成一條 minimal assistant message 包住 `tool_use` block。
- `createToolStub(toolName)` — 對 local 沒載入的 tool（如 remote 的 MCP tool），合成最小 `Tool` 物件 route 到 `FallbackPermissionRequest`。

### `sdkMessageAdapter.ts`

把 SDK message 轉換成本地 message 系統可消費的格式（`AssistantMessage` / `UserMessage` 等）。

## Permission response

`RemotePermissionResponse`：

```ts
type RemotePermissionResponse =
  | { behavior: 'allow', updatedInput: Record<string, unknown> }
  | { behavior: 'deny', message: string }
```

注意：和本地 `PermissionResult` 不同 — 簡化版，沒有 mode / scope / decision reason 等欄位（CCR 端只需要做 / 不做的決定）。

## 物件路徑

| 檔案 | 內容 |
|---|---|
| `src/remote/RemoteSessionManager.ts` | 最上層 facade、permission demux |
| `src/remote/SessionsWebSocket.ts` | WS client、重連、ping、close code |
| `src/remote/remotePermissionBridge.ts` | synthetic AssistantMessage + tool stub |
| `src/remote/sdkMessageAdapter.ts` | SDK ↔ local message 轉換 |
| `src/utils/teleport/api.ts` | `sendEventToRemoteSession()` HTTP 路徑 |
| `src/entrypoints/agentSdkTypes.ts` | `SDKMessage` type |
| `src/entrypoints/sdk/controlTypes.ts` | `SDKControlPermissionRequest` 等 |

## 與 upstreamproxy 的關係

**獨立功能但常一起出現**：CCR session container 內可能同時：

- 本層（remote sessions）：本地 CLI ←→ CCR agent loop
- `src/upstreamproxy/`：CCR container 內的 HTTPS 代理（注入第三方 API credentials）

詳見 `docs/upstreamproxy-relay.md`。

## 啟動 env vars

| Env | 用途 |
|---|---|
| `MY_AGENT_REMOTE` | 進 remote 模式總開關 |
| `MY_AGENT_REMOTE_SESSION_ID` | CCR session ID |
| `ANTHROPIC_BASE_URL` | CCR API base（注意：不是 prod api.anthropic.com，是 CCR endpoint） |

## 已知限制

- Mergeable state transitions 不會自動 webhook（GitHub 限制）— 需要 PR 監控時要 poll `gh pr view N --json mergeable`。
- Compaction 中可能短暫 4001，已自動處理。
- 4003 是永久 reject — 通常是 token 失效或 session 已歸檔。
