# M-LLAMACPP-WATCHDOG — 防止 llama.cpp 失控生成的客戶端守門

## Context

**起因**：M-MEMTUI 開發過程，使用者反映 llama.cpp 持續運算。診斷發現：
- qwen3.5-9b-neo 在某些短指令下進 `<think>` reasoning block 後**沒 emit `</think>`**，CoT 自我迴圈，跑滿 `max_tokens=32000` 才停（30+ 分鐘）
- 兩個 cli 孤兒 process 同時 hold llama.cpp slot，slot cancel API 沒啟用
- my-agent 內現有的 `AbortSignal` 只在使用者按 Esc 時才會觸發，背景呼叫（cron / memory prefetch / sideQuery）一旦進 reasoning loop 沒人能中斷

**目標**：客戶端三層 watchdog，各管不同的失控情境，不誤殺 legit 長 turn。

**前提決策（與使用者對齊）**：
- Q1 不採固定 wall-clock timeout — 誤殺率高，legit 長 turn（refactor / 長文總結 / 深度推理）會被切
- Q2 採三層各自精準：inter-chunk gap / reasoning-block / token-cap
- Q3 全部走 `~/.my-agent/llamacpp.json` config 可調
- Q4 主 turn 與背景呼叫的 `max_tokens` ceiling 分流（per-call-site）
- Q5 重點不是「server 端 cancel」而是「client 端斷連 → server 自動釋放 slot」（HTTP 標準行為）
- **Q6（新）watchdog 預設關閉** — 安裝後 ABC 三層皆 `enabled: false`，不影響既有行為。使用者透過 `/llamacpp` TUI 或 `/llamacpp watchdog A on` 主動開啟。理由：(a) 避免誤殺 legit 長 turn 給不知情使用者；(b) 留 escape hatch，watchdog 是 opt-in 安全網不是強制保護；(c) `/llamacpp` TUI 一鍵開關讓 opt-in 成本極低

---

## 設計：三層 watchdog（**預設全關**，使用者 opt-in）

| 防線 | 觸發條件 | 阻誰 | 預設啟用 | 預設值（啟用後） | 誤判風險 |
|---|---|---|---|---|---|
| **A. Inter-chunk gap** | 連續 N 秒沒收到任何 SSE token | 連線真的 hung（網路斷、server crash） | ❌ off | 30 秒 | ⚪ 極低 — 正常生成每秒至少 1 token |
| **B. Reasoning-block watchdog** | 進 `<think>` 後 N 秒仍未見 `</think>` | qwen CoT reasoning loop | ❌ off | 120 秒 | 🟡 中 — 需深度推理時可調 |
| **C. Token cap (max_tokens ceiling)** | 累積 token 超過上限（per call-site） | 防失控總量 | ❌ off | 16000 主 turn / 4000 背景 | 🟢 可控 — 使用者改 config |

**為什麼這樣分層擋得住這次 bug 也不誤殺 legit**：
- 這次 bug：模型穩定吐 token（A 抓不到），但全在 `<think>` 裡 loop（**B 60 秒抓到**），且累積 30000 token（**C 16000 抓到，雙保險**）
- Legit 長 turn：token 持續流（A 不誤殺），reasoning < 60 秒結束（B 不誤殺），輸出可能多但 cap 可調（C 可改）

---

## 待新增 / 修改的檔案

### 新增
| 路徑 | 用途 |
|---|---|
| `src/services/api/llamacppWatchdog.ts` | 三層 watchdog 的純函式實作（pipe SSE / 計時器 / abort 邏輯）+ 單元測試 |
| `tests/integration/llamacpp/watchdog.test.ts` | unit：三層各自觸發 + 不誤判正常 stream |
| `tests/e2e/_llamacppHungSimulator.ts` | 模擬 server 慢 stream / `<think>` loop / hung connection 三種情境的 mock server |

### 修改
| 路徑 | 改動 |
|---|---|
| `src/llamacppConfig/schema.ts` | 加 `LlamaCppWatchdogSchema`：`interChunkGapMs` / `reasoningBlockMs` / `maxTokensCeiling: { default, memoryPrefetch, sideQuery, background }`；env override `LLAMACPP_WATCHDOG_DISABLE` 一鍵關 |
| `src/llamacppConfig/loader.ts` | 解析新欄位；snapshot 加 `watchdog` field |
| `src/services/api/llamacpp-fetch-adapter.ts` | (1) `createLlamaCppFetch` 內 fetch 之前 wrap watchdog AbortController；(2) SSE stream loop 接 inter-chunk timer + reasoning timer；(3) `translateRequestToOpenAI` 套 max_tokens ceiling（依 call-site context）；(4) abort 時的 error message 標明哪層 watchdog 觸發（diagnostics） |
| `src/services/api/llamacppSideQuery.ts` | 改用 adapter watchdog（不另實作）；caller 可傳 `callSite: 'sideQuery'` 走嚴格 cap |
| `src/memdir/findRelevantMemories.ts` | `selectViaLlamaCpp()` 加 `callSite: 'memoryPrefetch'` |
| `src/services/extractMemories/...`（如 fork agent 走 llamacpp）| 加 `callSite: 'background'` |
| `scripts/llama/serve.sh` | 加 `--slot-save-path "$HOME/.cache/llama/slots"` 啟用 server 端 cancel API（給診斷工具用，watchdog 不依賴） |

### 重用既有（不改）
- `AbortSignal.any()`（Node ≥ 20）— 串接 caller signal + watchdog signal
- `iterOpenAISSELines()`（adapter 內既有 SSE 解析器）— 接上 inter-chunk timer
- `LlamaCppConfigSchema` zod 解析 + 三層 snapshot 凍結（M-LLAMA-CFG pattern）
- `~/.my-agent/llamacpp.json` config 檔（已存在）

---

## 觸發點 & call-site 標記

呼叫端怎麼告知 adapter 自己屬於哪個 call-site：

```ts
// 主 turn（QueryEngine.ts → fetch via adapter）
fetch(url, { ... })                          // 預設 callSite='turn' → ceiling=16000

// 背景呼叫（明確標記）
fetch(url, {
  ...,
  // @ts-expect-error custom field; adapter reads from request body marker
  body: JSON.stringify({ ...body, _myAgent: { callSite: 'memoryPrefetch' } }),
})
```

或更乾淨的方式：caller 直接呼叫 adapter export 的 helper（`createLlamaCppRequest({ callSite, ... })`）。最終以實作便利為準（讓 sideQuery 和 memdir 既有 caller 改動最小）。

---

## Watchdog abort 行為

當任一層 watchdog 觸發：
1. 呼叫內部 `AbortController.abort(new Error('llamacpp-watchdog: <layer> triggered ...'))`
2. fetch 中斷 → HTTP connection close → llama.cpp server 偵測到 client gone → slot 自動釋放
3. adapter 把 abort error 包裝成 Anthropic-shape error response（不 throw 到 QueryEngine 直接掛）
4. 寫 `console.warn` log（含層次 / 時間 / token 數）讓使用者知道為何中斷
5. **主 turn**：回給 UI「LLM call interrupted by watchdog（reasoning loop / token cap / hung）」訊息，使用者可重試
6. **背景呼叫**：caller 用既有 fallback（memory prefetch 已有空陣列 fallback；sideQuery throw → caller 處理）

---

## Config schema（draft）

```jsonc
{
  // 既有欄位（不動）
  "baseUrl": "http://127.0.0.1:8080/v1",
  "model": "qwen3.5-9b-neo",
  "contextSize": 131072,

  // 新增（預設整個 watchdog 關閉）
  "watchdog": {
    "enabled": false,                   // master toggle，預設 false
    "interChunk": {
      "enabled": false,                 // A：預設 off
      "gapMs": 30000
    },
    "reasoning": {
      "enabled": false,                 // B：預設 off
      "blockMs": 120000
    },
    "tokenCap": {
      "enabled": false,                 // C：預設 off
      "default": 16000,                 // 主 turn 上限（ceiling，caller 還可送更小）
      "memoryPrefetch": 256,
      "sideQuery": 1024,
      "background": 4000                // cron / extractMemories / NL parser
    }
  }
}
```

**生效規則**：master `enabled: true` 且該層 `enabled: true` 才實際生效（雙層 AND）。一個都 off 等於 watchdog 不存在、行為與目前完全一致。

env override：
- `LLAMACPP_WATCHDOG_ENABLE=1` 一鍵開（master + 三層全開）— 給 quick-test 用
- `LLAMACPP_WATCHDOG_DISABLE=1` 一鍵關（debug 用，無視 config）

---

## Phase 序

### Phase 1 — Config schema + adapter watchdog 三層
1. M-LLAMACPP-WATCHDOG-1-1：擴 `LlamaCppConfigSchema` + `LlamaCppWatchdogSchema`、loader 解析、snapshot 加 watchdog
2. M-LLAMACPP-WATCHDOG-1-2：新 `src/services/api/llamacppWatchdog.ts` 純函式：`createWatchdogStream(stream, config, signal)` 包 SSE iterator、嵌入 inter-chunk timer + reasoning timer + token counter；abort 時設定 reason 字串
3. M-LLAMACPP-WATCHDOG-1-3：`createLlamaCppFetch` 串入 watchdog（fetch 前 wrap signal、stream 後接 watchdog iterator、error path 識別 watchdog abort）
4. M-LLAMACPP-WATCHDOG-1-4：unit tests（mock SSE → 三層各自觸發 + 正常 stream 不誤判 + disabled 路徑跳過）

### Phase 2 — Per-call-site max_tokens ceiling
1. M-LLAMACPP-WATCHDOG-2-1：`translateRequestToOpenAI()` 加 `callSite` 參數，clamp `max_tokens = min(caller_request, ceiling[callSite])`
2. M-LLAMACPP-WATCHDOG-2-2：`llamacppSideQuery.ts` 傳 `callSite: 'sideQuery'`；`findRelevantMemories.ts` `selectViaLlamaCpp()` 傳 `callSite: 'memoryPrefetch'`；`extractMemories` 走 llamacpp path 傳 `callSite: 'background'`
3. M-LLAMACPP-WATCHDOG-2-3：unit + 修改既有測試 expectation

### Phase 3 — `/llamacpp` master TUI + hybrid args + broadcast

**設計概覽**（與使用者對齊）：
- 命令：合併 `/llamacpp`（取代 Phase 3 原本的 `/llamacpp-status`），未來擴 server 啟停等子畫面共用
- UI：Hybrid — 無參數開 TUI、有參數直接套用（兼顧監看與 script）
- 持久化：兩者都做 — 寫 `~/.my-agent/llamacpp.json` + adapter 每次 fetch 重讀 snapshot（hot-reload）
- 多 REPL 同步：daemon broadcast `llamacpp.configChanged` frame（mirror cron pattern）

**Master TUI 結構（Hybrid）**：
```
LlamaCpp · ‹ Watchdog ›   Slots                    (←/→ 切 tab)
─────────────────────────────────────────────────────────────────
 Watchdog 設定（檔案：~/.my-agent/llamacpp.json）

   ☐ Master enabled                  (整體開關，預設 OFF)
 ▶ ☐ A. Inter-chunk gap            30000 ms     (預設 OFF)
   ☐ B. Reasoning-block watchdog  120000 ms     (預設 OFF)
   ☐ C. Token cap (default)         16000       (預設 OFF)
   ┃    ├─ memoryPrefetch              256
   ┃    ├─ sideQuery                  1024
   ┃    └─ background                 4000
─────────────────────────────────────────────────────────────────
↑/↓ 移動 · Space toggle · Enter 改值 · r reset · w 永久寫檔 · q quit
注意：Master + 該層皆 ON 才實際生效。

```

```
LlamaCpp · Watchdog  ‹ Slots ›                    (←/→ 切 tab)
─────────────────────────────────────────────────────────────────
 server: http://127.0.0.1:8080/v1   model: qwen3.5-9b-neo

 slot 0  idle      n_decoded=38     remain=31962
 ▶ slot 1  processing n_decoded=30101  remain=1899  ← reasoning loop?
   slot 2  processing n_decoded=27343  remain=4657
   slot 3  idle      n_decoded=1157   remain=6843
─────────────────────────────────────────────────────────────────
↑/↓ · K kill slot（需 server 帶 --slot-save-path） · R 重 fetch · q quit
```

**Args 形式**（同 command 直接套用）：
```bash
/llamacpp                                # 開 TUI（無參數）
/llamacpp watchdog                       # 印當前狀態（master + ABC 各自 enabled / 數值）
/llamacpp watchdog enable                # master 開（仍需 ABC 各自開才實際擋）
/llamacpp watchdog disable               # master 關
/llamacpp watchdog A on                  # 開 inter-chunk gap watchdog
/llamacpp watchdog A off                 # 關
/llamacpp watchdog B 180000              # 改 reasoning timeout 為 180s（不改 enabled）
/llamacpp watchdog all on                # master + ABC 全開（quick start）
/llamacpp watchdog all off               # master + ABC 全關（回預設）
/llamacpp watchdog C.background 8000     # 改 background ceiling
/llamacpp watchdog reset                 # 全部回預設（= all off + 數值回預設）
/llamacpp watchdog --session A on        # 只 session 內生效不寫檔
/llamacpp slots                          # 印 slot 狀態
/llamacpp slots kill 1                   # kill slot 1（需 --slot-save-path）
```

**任務分解**：
1. M-LLAMACPP-WATCHDOG-3-1：新 `src/commands/llamacpp/{index.ts, llamacpp.tsx, LlamacppManager.tsx, llamacppManagerLogic.ts}` master TUI（mirror MemoryManager 5-tab pattern；2 tabs 起步）
2. M-LLAMACPP-WATCHDOG-3-2：Watchdog tab — 列 A/B/C + per-call-site ceilings；Space toggle / Enter 改值 / r reset / w 永久寫檔（預設改完即 hot-reload + 寫檔，w 鍵明確寫檔）
3. M-LLAMACPP-WATCHDOG-3-3：Slots tab — `fetch /v1/slots` 5 秒 poll + 顯示；K 鍵 `POST /slots/N?action=erase`（先檢查 server 有無 `--slot-save-path` 啟用，沒啟用 flash 提示如何打開）
4. M-LLAMACPP-WATCHDOG-3-4：Hybrid args parser — 認識 `watchdog A off` / `watchdog B 180000` / `watchdog reset` / `slots kill N` 等動詞；無參數 → render TUI；有參數 → 直接呼叫 mutation helper + flash 結果文字
5. M-LLAMACPP-WATCHDOG-3-5：`scripts/llama/serve.sh` 加 `--slot-save-path "$HOME/.cache/llama/slots"`（讓 K 鍵能用）+ README 說明
6. M-LLAMACPP-WATCHDOG-3-6：Hot-reload — `LlamaCppConfigSnapshot` 改成「每次 `getLlamaCppConfigSnapshot()` 偵測檔案 mtime 變化重讀」（保留 startup snapshot 為 fallback；env override 仍優先）
7. M-LLAMACPP-WATCHDOG-3-7：Daemon broadcast — 新 `src/daemon/llamacppConfigRpc.ts` mirror cron mutation pattern；frame：
   - `llamacpp.configMutation`（client → daemon：op=watchdog/slot-kill/reset，payload）
   - `llamacpp.configMutationResult`（daemon → client：ok / error / message）
   - `llamacpp.configChanged`（daemon → all same-project clients：projectId + change summary）
   - daemon 寫檔成功後 broadcast；TUI 訂閱 `llamacpp.configChanged` 立即 reload UI；adapter（在 daemon process 內）也跟著 hot-reload
8. M-LLAMACPP-WATCHDOG-3-8：`fallbackManager.sendLlamacppConfigMutation()` + `useDaemonMode` callback；TUI mutation 路徑 daemon-aware（attached → WS / standalone → 本機 + chokidar 自動 reload）
9. M-LLAMACPP-WATCHDOG-3-9：unit tests `tests/integration/llamacpp/{managerLogic,configMutationRpc}.test.ts`

### Phase 4 — E2E 測試（Section L）
新 section L「Llamacpp watchdog + manager」，9 cases：

**Watchdog 三層觸發 + 不誤判**
1. **L1** — Mock SSE server 連續 fast token（5 秒、1000 token）→ 不誤判 abort
2. **L2** — Mock SSE server 進 `<think>` 後 130 秒內不收尾 → reasoning watchdog 觸發、abort error 含 `reasoning-block` marker
3. **L3** — Mock SSE server `<think>` 內持續吐 token 累積超 16000 → token-cap watchdog 觸發
4. **L4** — Mock SSE server 第 1 chunk 後 35 秒沒下一個 → inter-chunk gap watchdog 觸發

**`/llamacpp` master command**
5. **L5** — Module load：`LlamacppManager` / `llamacppManagerLogic` / `daemon/llamacppConfigRpc` 動態 import 通過
6. **L6** — Args 直接套用：`/llamacpp watchdog A off` 寫檔 + 下次 `getLlamaCppConfigSnapshot()` 反映新值（hot-reload 驗證）
7. **L7** — PTY interactive（mirror `_memoryTuiInteractive.ts` pattern）：spawn cli-dev → `/llamacpp<Enter>` → 看到 `‹ Watchdog ›` tab + 3 行 A/B/C → `→` → 看到 `‹ Slots ›` tab
8. **L8** — Daemon RPC + broadcast：兩個 thin-client A/B attach 同 project → A 送 `llamacpp.configMutation` → B 收 `llamacpp.configChanged` 廣播（mirror K12）
9. **L9**（skip 除非 server 帶 `--slot-save-path`）— `/llamacpp slots kill <id>` 對 active slot fire → curl `/slots` 該 slot 在 5 秒內 `is_processing: false`

helper：
- `tests/e2e/_llamacppHungSimulator.ts` — Bun.serve mock SSE endpoint，三種情境靠 query param 切換（fast / reasoning-loop / hung-after-first-chunk）
- `tests/e2e/_llamacppManagerInteractive.ts` — PTY 互動 helper（npx tsx + node-pty）
- `tests/e2e/_llamacppConfigRpcClient.ts` — daemon WS broadcast 驗證 helper

### Phase 5 — Docs + commit
1. CLAUDE.md 開發日誌（commit 序列、踩坑、ADR）— 含 ADR-015「Watchdog 採三層分層偵測 + hot-reload 而非固定 wall-clock」
2. LESSONS.md 補（如有新踩坑）
3. `docs/e2e-test-suite.md` 加 L section（9 cases + 3 helper）+ scope alias `llamacpp` / `watchdog`
4. README + CLAUDE.md「llama.cpp 設定」段加 watchdog config 章節 + `/llamacpp` 命令使用範例
5. 新 `docs/llamacpp-watchdog.md` 使用者指南：A/B/C 三層意義、何時調哪個、`/no_think` 觸發詞、`--slot-save-path` 服務端啟用

每 Phase 完成跑 `bun run typecheck` + `./cli -p hello`（必須包 `timeout -k 5s 60s`）+ 該 Phase 的 unit tests + 該 Phase 的 E2E case；綠後 commit。

---

## Verification（end-to-end）

1. `conda activate aiagent && bun run typecheck && bun run build:dev`
2. `bun test tests/integration/llamacpp/{watchdog,managerLogic,configMutationRpc}.test.ts` 全綠
3. `bash tests/e2e/decouple-comprehensive.sh L` 8 PASS + 1 skip（L9 需 `--slot-save-path`）
4. **預設關閉驗證（最重要）**：
   - 安裝 / `bun run build:dev` 後**不改任何設定**
   - 跑全套 `decouple-comprehensive.sh A-K`：行為與當前一致，不退步、不被 watchdog 誤殺任何 case
   - `cat ~/.my-agent/llamacpp.json` 看 `watchdog.enabled = false` + ABC 也 false
5. **實機 watchdog 驗證（opt-in 路徑）**：
   - `/llamacpp watchdog all on` 開全部
   - `curl /slots` 看 idle
   - 在 my-agent 跑「會觸發 reasoning loop」的短指令（例如 daemon attached + 短 prompt）
   - 預期：120-180 秒內 reasoning watchdog 觸發、UI 顯示 abort 訊息、`/slots` 在 5 秒內回 `is_processing: false`
   - `/llamacpp watchdog all off` 收工
6. **正常 turn 不誤殺驗證**（all on 狀態）：
   - 跑「真的需要長思考」的指令（refactor 大檔、長文總結）
   - 預期：legit turn 完成不被中斷（除非超過使用者設的 ceiling）
6. **`/llamacpp` TUI 實機**：
   - 開 TUI、改 watchdog A 為 off → 寫檔 → 下次 turn 觀察 hung 場景不再 abort（驗 hot-reload）
   - 切 Slots tab → 看到當前 slot 狀態
   - 兩個 REPL attached：A TUI 改值 → B TUI 在 200ms 內反映（驗 broadcast）
7. **Args 形式實機**：`/llamacpp watchdog B 180000` → llamacpp.json `reasoningBlockMs` 變 180000
8. **跨平台冒煙**（per `feedback_cross_platform_default.md` memory）：Windows + macOS 各跑一次 L section
9. **回歸驗證**：跑全套 `decouple-comprehensive.sh`（A-K + L）不退步

---

## 不在範圍（後續）

- **Server 端強制 cancel slot**（在 my-agent 內主動呼叫 `/slots/N?action=erase`）— 可在 Phase 3 的 `/llamacpp-status` 命令內加，但不是 watchdog 的核心
- **`/no_think` system prompt trigger**（qwen 系列認得，可 suppress reasoning）— 是 prompt-engineering 層 fix，與 watchdog 互補；列入後續 milestone `M-LLAMACPP-NOTHINK`
- **`</think>` stop sequence 加進 request body** — 同上，列入 `M-LLAMACPP-NOTHINK`
- **Bash tool 孤兒 cli 的 prevention**（修 cli SIGINT cleanup 強制斷 fetch）— 列為獨立 milestone `M-CLI-SIGINT-CLEANUP`
- **GUI / dashboard 監控 llama.cpp slot 狀態** — UX nice-to-have，不影響 bug 防治
