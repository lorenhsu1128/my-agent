# 本地 + 遠端 llama.cpp 雙 endpoint（M-LLAMACPP-REMOTE）

讓 my-agent 同時連兩台 llama.cpp，按「呼叫情境（callsite）」分流。例如：

- **主對話（turn）** 走遠端機器跑 32B / 70B 大模型
- **sideQuery / memoryPrefetch / cron NL parser / vision** 繼續走本機 9B 小模型

下個 turn 立刻生效，不需重啟 session（沿用 mtime hot-reload）。

## 設定

編輯 `~/.my-agent/llamacpp.jsonc`：

```jsonc
{
  // 既有頂層 = local endpoint
  "baseUrl": "http://127.0.0.1:8080/v1",
  "model": "qwen3.5-9b-neo",

  // 新：remote endpoint
  "remote": {
    "enabled": true,
    "baseUrl": "https://my-rig.tailscale.ts.net:8443/v1",
    "model": "qwen3.5-32b-instruct",
    "apiKey": "sk-...",        // 選填；有值就帶 Authorization: Bearer
    "contextSize": 32768
  },

  // 新：routing 表（缺欄位 = 'local'）
  "routing": {
    "turn": "remote",
    "sideQuery": "local",
    "memoryPrefetch": "local",
    "background": "local",
    "vision": "local"
  }
}
```

## 5 個 callsite

| key              | 用途                                      | 預設       |
| ---------------- | ----------------------------------------- | ---------- |
| `turn`           | 主對話（chat）                            | `'local'`  |
| `sideQuery`      | 旁路查詢（queryHaiku / cron NL parser）   | `'local'`  |
| `memoryPrefetch` | 記憶體召回（findRelevantMemories selector）| `'local'`  |
| `background`     | 背景任務（extractMemories 等）            | `'local'`  |
| `vision`         | 圖像理解（VisionClient）                  | `'local'`  |

## 改設定的三條路

### A. 編輯 jsonc（重啟 session 才生效，但 mtime hot-reload 已開）

直接改 `~/.my-agent/llamacpp.jsonc`，下個 turn 就吃新 routing。

### B. TUI `/llamacpp` 第 3 tab `Endpoints`

```bash
my-agent
> /llamacpp
# ←/→ 切到 Endpoints tab
# ↑↓ 移動、Space toggle、Enter 編輯文字、s 寫檔、t 測試連線
```

設定改完按 `s` 寫回 jsonc。daemon attached 時走 WS RPC + broadcast；
standalone 模式直接寫本機。

### C. Web admin（瀏覽器）

`/web start` 後在右欄 `Llamacpp` tab 看到 Endpoints / Routing 兩個 card：

- **Endpoints**：local 唯讀顯示；remote 表單（enabled / baseUrl / model /
  apiKey / contextSize）+ Save + Test 按鈕
- **Routing**：5 個 callsite × Select(local|remote)，即時寫入

任一端改了，broadcast `llamacpp.configChanged` 同步到 TUI / 其他 web 視窗。

## 失敗策略：硬性報錯

故意設計成「**不 silent fallback**」：

- routing 指 `'remote'` 但 `remote.enabled=false` → 該 callsite 觸發時直接
  throw `[llamacpp routing=<callsite>→remote] remote endpoint not enabled in
  llamacpp.jsonc; set remote.enabled=true or change routing.<callsite> to
  'local'`
- remote 真連不上（網路斷 / 認證失敗）→ 拋原始錯誤，訊息前綴含 routing 標籤
  方便定位

理由：M-MEMRECALL-LOCAL 教訓 — silent fallback 會讓使用者誤以為功能正常。
若要 fallback，請手動把該 callsite 改回 `'local'`。

## 安全提醒：apiKey

- `apiKey` 直接寫在 `~/.my-agent/llamacpp.jsonc` 是「單一來源」設計（無 env
  override，避免多處不一致）。建議家目錄已隔離 + 必要時 `chmod 600`。
- Web `/api/llamacpp/endpoints` GET 回傳的 apiKey 已 mask（前 3 + 後 3）。
- TUI Endpoints tab 顯示也只顯示 mask 版本；按 Enter 編輯重新輸入。
- Web Endpoints 表單 apiKey 留空 = 不變更現有 key（避免無意覆蓋）。

## 測試連線

TUI 按 `t`，或 Web 點 Test 按鈕。daemon attached 時走 WS RPC 由 daemon 出 fetch；
standalone 走 client 端 fetch。逾時 5 秒。

成功 → 顯示遠端 model 名單前 3 個。失敗 → 顯示 HTTP status / 錯誤訊息。

## 限制 / 後續 milestone

本 milestone 範圍內不做：

- **N endpoints（>2 個）**：未來 `M-LLAMACPP-MULTI` 支援陣列形式 endpoints +
  routing 指 endpoint id
- **per-endpoint watchdog**：目前 watchdog 全域共用一份。`M-LLAMACPP-PER-ENDPOINT-WD`
- **auto-fallback policy**：remote 連不上自動降 local；目前硬性失敗。`M-LLAMACPP-FALLBACK`
- **per-tool routing override**：例如「這個 cron 任務指定走 remote」
- **env var override remote**：暫不加（jsonc 為單一來源）

## 相關 ADR

- ADR-005 `provider 內部做格式轉譯` — adapter 邊界 routing 不影響 QueryEngine
- ADR-010 `M-LLAMA-CFG` — config 統一走 `~/.my-agent/llamacpp.jsonc`
- ADR-015 `M-LLAMACPP-WATCHDOG` — watchdog 三層分層偵測 + hot-reload

## 跨平台

- jsonc 路徑解析走 `os.homedir()` + `path.join` — 跨平台
- 連線測試用 Bun/Node 內建 fetch — 無平台特定指令
- TUI Tab 操作鍵碼跨平台一致（←/→ Space Enter q）
