# web.jsonc 欄位參考

> 本檔由 `bun run docs:gen` 從 zod schema 自動產生表格部分。
> 表格區段以外的敘述請手寫在 AUTO-GENERATED 段落之外。

## 概覽

M-WEB Web UI 嵌入 daemon 的設定。

**來源優先序**：env var override → `~/.my-agent/web.jsonc` → schema default。


## Env 變數一覽

| Env | 覆蓋欄位 |
|---|---|
| `MYAGENT_WEB_CONFIG_PATH` | (整個檔案路徑) |

## Schema 欄位

<!-- AUTO-GENERATED-START — 跑 `bun run docs:gen` 重新產生 -->

### `WebConfigSchema`

| 欄位 | 型別 | Default | Env override | 說明 |
|---|---|---|---|---|
| `enabled` | `boolean` | `false` | — | 開關。為 false 時 daemon 不啟動 web HTTP server。 |
| `autoStart` | `boolean` | `true` | — | daemon 啟動時若 enabled=true 是否自動 spawn web listener。 為 false 時需手動 `/web start` 才開。 |
| `port` | `number` | `9090` | — | HTTP / WS 監聽 port。預設 9090；若被占用 httpServer 會自動 +1 探測到 maxPortProbes 次未果才 fail。 |
| `maxPortProbes` | `number` | `10` | — | port 衝突時往上探測的次數上限。 |
| `bindHost` | `string` | `'0.0.0.0'` | — | 綁定 host： - '0.0.0.0' = LAN（W2 預設） - '127.0.0.1' = 僅本機 - 其他 IP = 指定網卡 |
| `maxClients` | `number` | `50` | — | 同時連線的 browser tab 上限。 |
| `heartbeatIntervalMs` | `number` | `30_000` | — | WS heartbeat ping 間隔（ms）。 |
| `corsOrigins` | `array<string>` | `[]` | — | 額外允許的 CORS origin（dev 階段例如 `http://127.0.0.1:5173`）。 正式 build 後 web/dist 由同一 server 服務，無 CORS 問題。 |
| `devProxyUrl` | `string` _(optional)_ | _(undefined)_ | — | Dev mode：daemon 不 serve web/dist，而是反向 proxy 到 vite dev server。 通常配合 `bun run dev:web` 使用。 |

<!-- AUTO-GENERATED-END -->
