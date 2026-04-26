# LlamaCpp Watchdog 使用指南

> 對應 milestone：M-LLAMACPP-WATCHDOG（2026-04-26）
> 命令：`/llamacpp`

## 為什麼需要 watchdog

本地 llama.cpp（特別是 qwen3.5-9b-neo 等 reasoning 模型）有時會進 `<think>` block 後無止境生成 chain-of-thought（**沒 emit `</think>` 收尾**），跑滿 `max_tokens=32000` 才停。表現是 GPU 風扇全開、my-agent 看似卡死、llama.cpp slot 被佔住數十分鐘。

my-agent 既有的 `AbortSignal` 只在使用者按 Esc 才觸發；**背景呼叫（cron / memory prefetch / sideQuery）一旦進 reasoning loop 沒人能中斷**。Watchdog 提供 client 端守門，主動偵測異常並中斷 fetch（→ HTTP connection close → llama.cpp 自動釋放 slot）。

## 三層設計

| 防線 | 觸發條件 | 預設值 | 適合擋誰 |
|---|---|---|---|
| **A. Inter-chunk gap** | 連續 N 秒沒收到 SSE token | 30 秒 | 連線真的 hung（網路斷、server crash） |
| **B. Reasoning-block** | 進 `<think>` 後 N 秒沒見 `</think>` | 120 秒 | qwen CoT reasoning loop |
| **C. Token cap** | 累積 token 超 ceiling | 主 turn 16000 / 背景呼叫 4000 / sideQuery 1024 / memoryPrefetch 256 | 防失控總量 |

**全部預設關閉** — 安裝後不影響既有行為。要 opt-in 自己決定。

## Quick start

```bash
# 一鍵全開（master + ABC 三層）
/llamacpp watchdog all on

# 只開 reasoning watchdog
/llamacpp watchdog enable        # master 開
/llamacpp watchdog B on          # 只開 B 層

# 看當前狀態
/llamacpp watchdog

# 全部關閉
/llamacpp watchdog all off
```

## TUI

```
/llamacpp                # 無參數開 master TUI（Watchdog 與 Slots 兩個 tab）
```

**操作鍵**：
- `↑/↓` 移動游標
- `←/→` 切 tab（Watchdog ↔ Slots）
- `Space` / `Enter` toggle 或編輯數值
- `r` reset 全部回預設
- `w` 永久寫檔
- `q` / `Esc` 離開

**Watchdog tab** — 10 個欄位（master + A/B/C + per-call-site ceilings）；改完即時生效（hot-reload）+ 自動寫檔。`✓ effective` 標籤顯示該層是否實際生效（master AND 該層皆 ON 才算）。

**Slots tab** — 每 5 秒輪詢 `GET /v1/slots`：
- `K` kill 游標所在 slot（呼叫 `POST /slots/N?action=erase`）
- 需要 server 啟動時帶 `--slot-save-path`，否則 K 會收到 501 + 顯示提示

## Args 形式

| 命令 | 動作 |
|---|---|
| `/llamacpp watchdog` | 印當前狀態 |
| `/llamacpp watchdog enable` | master 開 |
| `/llamacpp watchdog disable` | master 關 |
| `/llamacpp watchdog A on` / `A off` | A.enabled 切換 |
| `/llamacpp watchdog B 180000` | reasoning blockMs = 180s |
| `/llamacpp watchdog C.background 8000` | tokenCap.background = 8000 |
| `/llamacpp watchdog all on` / `all off` | master + ABC 全開/全關 |
| `/llamacpp watchdog reset` | 全部回預設 |
| `/llamacpp watchdog --session A on` | 只 session 內生效不寫檔 |
| `/llamacpp slots` | 印 slot 狀態 |
| `/llamacpp slots kill 1` | kill slot 1 |
| `/llamacpp help` | 印命令列表 |

## 設定檔

寫到 `~/.my-agent/llamacpp.json` 的 `watchdog` 區塊：

```jsonc
{
  // ... 既有欄位
  "watchdog": {
    "enabled": false,                   // master toggle
    "interChunk": {
      "enabled": false,
      "gapMs": 30000
    },
    "reasoning": {
      "enabled": false,
      "blockMs": 120000
    },
    "tokenCap": {
      "enabled": false,
      "default": 16000,                 // 主 turn ceiling
      "memoryPrefetch": 256,
      "sideQuery": 1024,
      "background": 4000
    }
  }
}
```

**生效規則**：master `enabled: true` AND 該層 `enabled: true` 才實際生效。任一 false = 該層不存在。

**Hot-reload**：改檔後下次 `getLlamaCppConfigSnapshot()` 偵測 mtime 變化重讀 — 不需重啟 daemon 或 my-agent。

## env override

| env var | 行為 |
|---|---|
| `LLAMACPP_WATCHDOG_DISABLE=1` | 強制關（無視 config，最高優先；debug 用） |
| `LLAMACPP_WATCHDOG_ENABLE=1` | 一鍵全開（無視 config 內的 enabled，三層全 on；quick test 用） |

## Daemon attached 多 REPL 同步

A REPL 改設定 → daemon 寫檔 + 廣播 `llamacpp.configChanged` frame → B REPL 即時刷 TUI。Mirror cron 的 broadcast pattern。

## 觸發後的行為

watchdog 任一層觸發 →
1. 內部 `AbortController.abort(WatchdogAbortError)` → fetch 中斷
2. HTTP connection close → llama.cpp server 偵測 client gone → slot 自動釋放
3. adapter 把 abort 包成正常 stream 結束（`stop_reason = max_tokens` 或 `end_turn`）— 不是 fatal error
4. `console.warn` 記錄層次 / tokens / elapsed / callSite，例如：
   ```
   [llamacpp-watchdog] aborted layer=reasoning callSite=turn tokens=12345 elapsedMs=125000 reason=...
   ```
5. UI 顯示部分回應 + warn log；使用者可重試

## 常見情境 → 怎麼設

**情境 1：偶爾 reasoning loop，但日常需要長 turn**
- `/llamacpp watchdog enable` + `/llamacpp watchdog B on`
- 只開 B（reasoning watchdog 120s），不開 A/C — 避免誤殺
- 真的 reasoning 跑超 2 分鐘 = 模型卡住，可接受被中斷

**情境 2：純背景跑，希望嚴格 cap**
- `/llamacpp watchdog all on`
- 改 `C.background` 到 2000（背景任務不該寫長文）
- A 30s + B 120s + C 4000（背景）三重保護

**情境 3：除錯時臨時關掉**
- `LLAMACPP_WATCHDOG_DISABLE=1 ./cli`
- 不動 config 檔；env var 強制關掉

## 服務端啟用 slot cancel API

`scripts/llama/serve.sh` 已預設帶 `--slot-save-path "$HOME/.cache/llama/slots"`，重啟 llama-server 即可啟用 `POST /slots/N?action=erase`。

如果 server 是手動啟動沒帶這個 flag，`/llamacpp slots kill` 會收到 501 並提示如何啟用。

## 限制 / 已知問題

- Watchdog 只覆蓋 llama.cpp 路徑；Anthropic / Bedrock / Vertex 路徑不受影響
- Token 數估算用 `chars / 3` 粗估，非 server 真實 tokenizer — 邊界值可能誤差 ±15%
- B 層偵測「進 `<think>` 後沒收尾」靠觀察 SSE chunk 中的 `reasoning_content` 與 `content` 切換；server 若用非標準格式輸出 reasoning，B 層可能不工作

## 相關 milestone

- `M-LLAMACPP-NOTHINK`（後續）：在 system prompt 注入 `/no_think` trigger 抑制整個 reasoning，與 watchdog 互補
- `M-CLI-SIGINT-CLEANUP`（後續）：cli SIGINT 時強制斷 fetch，防孤兒 cli process 持續占 slot
