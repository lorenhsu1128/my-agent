/**
 * web.jsonc 預設模板。
 * 首次 seed 時寫入；含繁中註解，使用者編輯後 my-agent 寫回會保留註解。
 */
export const WEB_JSONC_TEMPLATE = `{
  // ============================================================
  // ~/.my-agent/web.jsonc — Web UI（M-WEB）設定
  // ============================================================
  //
  // 開啟流程：
  //   1. 改 "enabled" 為 true
  //   2. 重啟 daemon（my-agent daemon restart）；或在 REPL 裡跑 /web start
  //   3. 瀏覽器開 http://<本機LAN-IP>:9090
  //
  // 安全提醒：W2 預設不做認證，bindHost=0.0.0.0 表示 LAN 全開。
  // 若想限本機才能連，把 bindHost 改成 "127.0.0.1"。

  // 開關。false 時 daemon 不啟動 web HTTP server。
  "enabled": false,

  // daemon 啟動時若 enabled=true 是否自動起 web listener。
  // false 時需手動 /web start 才開。
  "autoStart": true,

  // HTTP / WS 監聽 port；衝突時會自動 +1（最多嘗試 maxPortProbes 次）。
  "port": 9090,
  "maxPortProbes": 10,

  // 綁定 host：
  //   "0.0.0.0"    = LAN 全開（預設；對應 W2 政策）
  //   "127.0.0.1"  = 僅本機可連
  //   "192.168.x.y" = 指定網卡
  "bindHost": "0.0.0.0",

  // 同時連線的 browser tab 上限。
  "maxClients": 50,

  // WS heartbeat ping 間隔（ms）。
  "heartbeatIntervalMs": 30000,

  // 額外允許的 CORS origin（dev 階段；正式 build 由同 server 服務不需要）。
  "corsOrigins": [],

  // Dev mode 反向 proxy URL（搭配 bun run dev:web）。
  // 設成 "http://127.0.0.1:5173" 時 daemon 會把 GET / → vite dev server，
  // 同時 /api 與 /ws 仍由 daemon 自己處理。
  // "devProxyUrl": "http://127.0.0.1:5173"
}
`
