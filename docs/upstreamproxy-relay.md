# Upstream Proxy Relay（CCR 容器代理）

> 對應目錄：`src/upstreamproxy/`
> 啟用條件：`MY_AGENT_REMOTE=1` AND `CCR_UPSTREAM_PROXY_ENABLED=1`
> 平台：Linux only（其他平台 silently no-op）

CCR（remote session container）內的 HTTPS 代理機制 — 把 agent 子程序所有 HTTPS 流量導到本地 CONNECT proxy，再用 WebSocket 隧道送到 CCR upstreamproxy endpoint，由伺服器端終結 TLS、注入 org-configured credentials（如 DD-API-KEY），轉發到真正的上游。讓 worker 不必看到密鑰就能呼叫第三方 API。

## 流程

```
agent subprocess (curl / gh / kubectl / python ...)
   ↓ HTTPS_PROXY=http://127.0.0.1:<port>
local CONNECT proxy（relay.ts，同 CLI 程序）
   ↓ WebSocket（UpstreamProxyChunk protobuf framing）
CCR upstreamproxy WS endpoint
   ↓ TLS termination + credential injection
real upstream（Datadog / GitHub / ...）
```

## 初始化（`upstreamproxy.ts:79` `initUpstreamProxy()`）

呼叫一次，於 `init.ts` 啟動時：

1. 檢查 `MY_AGENT_REMOTE` + `CCR_UPSTREAM_PROXY_ENABLED` env var — 任一不開直接 return。
2. 讀 `MY_AGENT_REMOTE_SESSION_ID` env var。
3. 從 `/run/ccr/session_token` 讀 session token（不存在直接 return）。
4. **`prctl(PR_SET_DUMPABLE, 0)`**（`upstreamproxy.ts:226`）：用 `bun:ffi` 呼叫 libc，阻擋同 UID `gdb -p $PPID` 從 heap 撈 token。
5. 從 `${ANTHROPIC_BASE_URL}/v1/code/upstreamproxy/ca-cert` 下載 CCR MITM CA cert，與 `/etc/ssl/certs/ca-certificates.crt` 串接寫到 `~/.ccr/ca-bundle.crt`。
6. 啟動 `startUpstreamProxyRelay({ wsUrl, sessionId, token })` 監聽 localhost:random_port。
7. 解除 token 檔（**listener 確認起來才 unlink**，failed 重啟可重試）。
8. 設 state.enabled = true。

**全部 fail-open**：任何一步出錯就 disable，warn 一行 log，絕不打斷正常 session。

## 子程序 env 注入（`getUpstreamProxyEnv()`）

被 `subprocessEnv()` 呼叫，注入給 Bash / MCP / LSP / hooks 子程序：

```bash
HTTPS_PROXY=http://127.0.0.1:<port>
https_proxy=http://127.0.0.1:<port>
NO_PROXY=<RFC1918 + loopback + IMDS + Anthropic + GitHub + 套件 registry>
no_proxy=...
SSL_CERT_FILE=~/.ccr/ca-bundle.crt
NODE_EXTRA_CA_CERTS=~/.ccr/ca-bundle.crt
REQUESTS_CA_BUNDLE=~/.ccr/ca-bundle.crt
CURL_CA_BUNDLE=~/.ccr/ca-bundle.crt
```

**只設 HTTPS，不設 HTTP**：relay 只接 CONNECT，plain HTTP 走過去會 405。

子 CLI process 自己無法 re-init（token 檔已 unlink），但會繼承 parent 的 env vars，照樣走 parent 的 relay。

## NO_PROXY 列表

`upstreamproxy.ts:37`：

- `localhost` / `127.0.0.1` / `::1`
- RFC1918：`10.0.0.0/8` / `172.16.0.0/12` / `192.168.0.0/16`
- IMDS：`169.254.0.0/16`
- **Anthropic**：`anthropic.com` / `.anthropic.com` / `*.anthropic.com`（三種寫法應付不同 runtime parsing — Bun glob、Python suffix、apex fallback）
- GitHub：`github.com` / `api.github.com` / `*.github.com` / `*.githubusercontent.com`
- 套件 registry：`registry.npmjs.org` / `pypi.org` / `files.pythonhosted.org` / `index.crates.io` / `proxy.golang.org`

理由：Anthropic API 沒對應上游路由 + MITM 會打壞 Python httpx/certifi（不認 forged CA）。GitHub 與套件 registry 走直連快且穩。

## 為什麼是 WebSocket 不是裸 CONNECT

`relay.ts:9`：CCR ingress 是 GKE L7 path-prefix routing，沒有 `connect_matcher`。沿用 session-ingress tunnel（`sessions/tunnel/v1alpha/tunnel.proto`）的同款 pattern。

## Wire 格式

`UpstreamProxyChunk` protobuf：

```proto
message UpstreamProxyChunk { bytes data = 1; }
```

手寫編碼（`relay.ts:66` `encodeChunk()`）— 單欄位 bytes message，10 行就解決，避開 protobufjs runtime dep。

## 限制與防線

| 項目 | 數值 / 說明 |
|---|---|
| 單 chunk 上限 | 512 KB（Envoy per-request buffer cap） |
| WS ping 週期 | 30 秒（sidecar idle timeout 50 秒）|
| CA download timeout | 5 秒（Bun fetch 預設無 timeout，會卡死 startup） |
| Linux-only | `prctl` 是 Linux 系統呼叫，其他平台跳過 |
| Bun-only FFI | 沒 `bun:ffi` 就 no-op `prctl`，warn |

## 物件路徑

| 檔案 | 內容 |
|---|---|
| `src/upstreamproxy/upstreamproxy.ts` | `initUpstreamProxy()` / `getUpstreamProxyEnv()` / token 讀取 / CA download / `prctl` |
| `src/upstreamproxy/relay.ts` | CONNECT TCP server + WS upgrade + protobuf framing |
| `src/utils/cleanupRegistry.ts` | `registerCleanup` — exit 時關 relay |
| `src/utils/proxy.ts` | `getWebSocketProxyAgent` / `getWebSocketProxyUrl` — relay 自己也要走 egress proxy |
| `src/utils/mtls.ts` | `getWebSocketTLSOptions` |

## 測試

`resetUpstreamProxyForTests()`（`upstreamproxy.ts:203`）— 測試之間清 module state。`initUpstreamProxy(opts)` 各路徑可覆寫供 unit test。
