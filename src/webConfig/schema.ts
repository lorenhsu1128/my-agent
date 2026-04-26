/**
 * M-WEB：Web UI 嵌入 daemon 的設定 schema。
 *
 * 存放位置：~/.my-agent/web.jsonc
 *
 * 設計原則：
 *   - 預設 enabled=false：使用者明確開啟前 daemon 不會綁額外 port
 *   - 預設 bindHost='0.0.0.0'：對應 W2 LAN-exposure 政策（無認證、IP-only）
 *   - 預設 port=9090；衝突時 httpServer.ts 會自動 +1（最多 +10）
 *   - 任何欄位缺漏走 DEFAULT_WEB_CONFIG，schema 失敗 → 走預設 + warn
 */
import { z } from 'zod'

export const WebConfigSchema = z.object({
  /** 開關。為 false 時 daemon 不啟動 web HTTP server。 */
  enabled: z.boolean().default(false),
  /**
   * daemon 啟動時若 enabled=true 是否自動 spawn web listener。
   * 為 false 時需手動 `/web start` 才開。
   */
  autoStart: z.boolean().default(true),
  /**
   * HTTP / WS 監聽 port。預設 9090；若被占用 httpServer 會自動 +1
   * 探測到 maxPortProbes 次未果才 fail。
   */
  port: z
    .number()
    .int()
    .min(1)
    .max(65535)
    .default(9090),
  /** port 衝突時往上探測的次數上限。 */
  maxPortProbes: z.number().int().min(1).max(100).default(10),
  /**
   * 綁定 host：
   *   - '0.0.0.0' = LAN（W2 預設）
   *   - '127.0.0.1' = 僅本機
   *   - 其他 IP = 指定網卡
   */
  bindHost: z.string().default('0.0.0.0'),
  /** 同時連線的 browser tab 上限。 */
  maxClients: z.number().int().min(1).max(1000).default(50),
  /** WS heartbeat ping 間隔（ms）。 */
  heartbeatIntervalMs: z.number().int().min(1_000).max(300_000).default(30_000),
  /**
   * 額外允許的 CORS origin（dev 階段例如 `http://127.0.0.1:5173`）。
   * 正式 build 後 web/dist 由同一 server 服務，無 CORS 問題。
   */
  corsOrigins: z.array(z.string()).default([]),
  /**
   * Dev mode：daemon 不 serve web/dist，而是反向 proxy 到 vite dev server。
   * 通常配合 `bun run dev:web` 使用。
   */
  devProxyUrl: z.string().optional(),
})

export type WebConfig = z.infer<typeof WebConfigSchema>

export const DEFAULT_WEB_CONFIG: WebConfig = {
  enabled: false,
  autoStart: true,
  port: 9090,
  maxPortProbes: 10,
  bindHost: '0.0.0.0',
  maxClients: 50,
  heartbeatIntervalMs: 30_000,
  corsOrigins: [],
  devProxyUrl: undefined,
}
