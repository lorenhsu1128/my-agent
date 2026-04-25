# Cron Wave 3 + Wave 4 — 進階功能與 `/cron` TUI 使用指南

Wave 3（2026-04-23）把本地 cron 從「會 fire 的 timer」升級成「可觀測 / 可確認 /
可恢復」的排程子系統。Wave 4（2026-04-24）在這基礎上加 `/cron` 互動式 TUI，
讓人類也能直接用一個 slash command 涵蓋 list / create / edit / pause / resume /
delete / run-now / history 全部操作。規劃詳見 `docs/plans/cron-wave3-plan.md`；
本文是使用者視角的速查。

## 6 大功能速覽

| 功能 | 實作欄位 | 預設行為 |
|------|---------|---------|
| 自然語言排程 | `scheduleSpec: { kind: 'nl', raw }` | 非 5-field / 非 "every Nm" / 非 ISO 自動走 LLM 翻譯 |
| 結果通知 | `notify: { tui, discord, desktop? }` | `tui='always'`, `discord='off'` |
| Run history | `history: { keepRuns }` | keepRuns=50，存 `.my-agent/cron/history/{id}.jsonl` |
| 失敗重試 | `retry: { maxAttempts, backoffMs, failureMode, attemptCount }` | 不設 = 不重試，舊行為 |
| Conditional 觸發 | `condition: CronCondition` | 不設 = 每次都 fire |
| Catch-up 策略 | `catchupMax: number` | 1（與 Wave 2 隱性行為相容） |

所有新欄位 optional，舊 task 行為 byte-for-byte 不變。

## 功能 1：自然語言排程

LLM 不必記 cron 語法，直接寫「每週一早上 9 點」。

```
CronCreate({ schedule: "每週一早上 9 點", prompt: "build" })
# 內部 queryHaiku → { cron: "0 9 * * 1", recurring: true, humanReadable: ... }
# 儲存時 scheduleSpec.raw = "每週一早上 9 點" 供 list 顯示
```

- 純 LLM 策略（不裝 chrono-node）。
- 失敗 retry 1 次；2 次都壞 → `CronNLParseError`，不靜默 fallback。
- 走目前 provider 的 small-fast model（本地 llamacpp 會用 `qwen3.5-9b-neo`）。

## 功能 2：結果通知（TUI toast + StatusLine badge + 未來 Discord）

**TUI toast**：每次 fire / 失敗 / skip / retry 在 REPL 彈 ephemeral 訊息（6s；失敗 12s）。

**StatusLine badge**：最後一次 fire 的 icon + label，5 分鐘 TTL 自動淡出。
- ✓ completed (綠) / ✗ failed (紅) / ↻ retrying (黃) / ↷ skipped (灰) / ⏰ fired

**Discord**（daemon 有配）：cronFireEvent 已廣播到 WS；Discord cronMirror 計劃在後續 milestone 補上（走 `replMirror.pickAllMirrorTargets` + `redactSecrets` + `truncateForDiscord`）。

## 功能 3：Run history

`CronHistoryTool(id, limit?)` 回最近 N 筆 fire：

```
✓ 2026-04-23T09:00:01.000Z 4200ms att=1
↻ 2026-04-23T08:00:02.000Z 3800ms att=1 err="timeout"
✗ 2026-04-23T07:00:01.000Z 5100ms att=3 err="unreachable"
```

- 每 task 一檔 `.my-agent/cron/history/{id}.jsonl`（append-only）
- keepRuns 上限自動 truncate（10% 機率每次 append 檢查）
- LLM 透過 `CronHistoryTool` 查；人類可 `cat` 該檔

## 功能 4：失敗重試

```ts
retry: {
  maxAttempts: 3,        // 含首次
  backoffMs: 60_000,     // exponential * 2^(n-1)，最長 1 hour
  failureMode: FailureMode,
  attemptCount: 0,       // runtime 計數
}

type FailureMode =
  | { kind: 'turn-error' }                                    // turn 結束 reason !== 'done'
  | { kind: 'pre-run-exit' }                                  // preRunScript exit ≠ 0
  | { kind: 'output-regex'; pattern: string; flags?: string }
  | { kind: 'output-missing'; pattern: string }               // output 不含 pattern
  | { kind: 'composite'; modes: FailureMode[]; logic: 'any'|'all' }
```

重啟注意：pending setTimeout 跨不了 process；daemon restart 時 attemptCount > 0 視同放棄、走下一次 schedule。

## 功能 5：Conditional 觸發

```ts
condition:
  | { kind: 'shell'; spec: 'grep ERROR /var/log/app.log' }  // exit 0 = pass
  | { kind: 'lastRunOk' }                                    // 上次 ok 才跑
  | { kind: 'lastRunFailed' }                                // 上次 error 才跑（retry 型）
  | { kind: 'fileChanged'; path: '/etc/config.json' }        // mtime > lastFiredAt
```

blocked 時 `lastFiredAt` 仍前進（避免 tick-loop 狂 eval），等下一次正常 schedule。fire event 會帶 `status='skipped'` + `skipReason`。

## 功能 6：Catch-up 策略

```ts
catchupMax: 1  // 預設。與 Wave 2 行為相容
catchupMax: 0  // skip 所有錯過的 fire
catchupMax: 5  // 補跑最近 5 次（適合「每小時收信」累積型任務）
```

daemon startup 對每個 recurring task 計算 missedCount，補跑 `min(missedCount, catchupMax)` 次。額外 fire 間隔 2s spacing 避免 burst。

## 統一 wizard（LLM 建 cron 時）

當 daemon 內的 LLM 呼叫 `CronCreate` 時，daemon **不直接寫盤**，而是把 draft 廣播到 attached REPL，使用者看到一個 summary card：

```
┌─ Create Cron Task — confirm or cancel ──────────┐
│ Schedule  : 0 9 * * 1  (Every Monday at 9am)    │
│   raw     : 每週一早上 9 點                     │
│ Prompt    : bun run build                       │
│ Recurring : ✓ yes                               │
│ ── Advanced ────────────────────────────────    │
│ Notify    : {tui=always, discord=home}          │
│ Retry     : {maxAttempts=3, backoffMs=60000...} │
├─────────────────────────────────────────────────┤
│  [Enter] Confirm    [Esc] Cancel                │
└─────────────────────────────────────────────────┘
```

- Enter 確認 → 寫入、回傳 tool result
- Esc 取消 → tool 回 Error 給 LLM
- 5 分鐘無人回 → auto-cancel + timeout error
- 沒 attached REPL → 立即回 error（避免意外靜默建立）
- 多 REPL 同 project → first-wins，其他自動關 wizard

Standalone REPL（無 daemon）不過 wizard — 直接走舊路徑寫入（wizard gate 只在 daemon context 啟用）。

## 檔案地圖

**核心**：
- `src/utils/cronTasks.ts` — schema + persistence
- `src/utils/cronScheduler.ts` — fire decision
- `src/daemon/cronWiring.ts` — fire 執行 / retry / condition / emit

**Wave 3 新模組**：
- `src/utils/cronNlParser.ts` — NL → cron
- `src/utils/cronHistory.ts` — JSONL append/truncate
- `src/utils/cronCondition.ts` — gate evaluator
- `src/utils/cronFailureClassifier.ts` — 失敗判定
- `src/daemon/cronCreateWizardRouter.ts` — wizard first-wins router
- `src/components/CronCreateWizard.tsx` — summary card UI
- `src/components/CronStatusBadge.tsx` — StatusLine badge
- `src/tools/ScheduleCronTool/CronHistoryTool.ts`

## 測試

- 單元：`tests/integration/cron/{history,condition,catchup,failure-classifier,nl-parser}.test.ts`
- 整合：`tests/integration/daemon/{cron-wiring,cron-retry,cron-wizard-router}.test.ts`
- 全套 Wave 3 後總共 130 cron/daemon-cron tests 綠（包含 Wave 2 的 42 個）

## Wave 4 — `/cron` 互動式 TUI（2026-04-24）

Wave 3 給了 LLM 8 個工具能 programmatically 管 cron，但人類想自己看 / 改還是
要 `cat scheduled_tasks.jsonc`。Wave 4 補上一個 master-detail TUI，按
`/cron` 進入。

### 入口

REPL 內打 `/cron`（Slash command）開 picker。Standalone 跟 attached 兩種
mode 都支援；attached 時 mutation 走 daemon WS RPC（broadcast 給其他 attached
client 即時刷新），standalone 走本機 fs。

### 主畫面（master-detail）

```
┌─ Tasks ────────────────────────────────────────┐  ┌─ Detail ──────────────────────────────────┐
│ ▸ daily-build        */15 * * * *  scheduled  │  │ ID    : daily-build                       │
│   weekly-report      0 9 * * 1     paused     │  │ Name  : Daily build                       │
│   one-shot-deploy    one-shot      completed  │  │ Cron  : */15 * * * *                      │
│ ...                                            │  │ Prompt: bun run build                     │
└────────────────────────────────────────────────┘  │ Last  : 2026-04-25T13:00 ✓ (3.2s)         │
                                                    │ Next  : 2026-04-25T13:15                  │
[n]ew  [e]dit  [d]elete  [p]ause  [r]esume         │ Retry : maxAttempts=3 backoffMs=60000     │
[H]istory  [a]dvanced fields  [Esc]                 └────────────────────────────────────────────┘
```

排序：state rank（scheduled=0、paused=1、completed=2）× 1e15 + nextFireMs

### 操作鍵

| 鍵 | 動作 |
|---|---|
| `↑/↓` | 上 / 下選 task |
| Enter | 進 detail 全頁（含 inline history） |
| `n` | 新增 task → wizard |
| `e` | 編輯選中 task → wizard 預帶當前欄位 |
| `d` | 刪除（`y/N` confirm 防誤觸） |
| `p` / `r` | 暫停 / 恢復（state toggle，立即 broadcast） |
| `R` | 立刻 run-now（走 REPL queue，沿用 CronRunNowTool） |
| `H` | history full-screen 捲動（每頁 20 筆） |
| `a` | advanced fields toggle（隱藏的 retry/condition/notify 等） |
| `Esc` / `q` | 退出 |

### Schedule Editor（建 / 編 task 時）

三層混合策略涵蓋大多數場景：

1. **14 個 preset**（fast path，80% 場景）：every 1m / 5m / 15m / 30m /
   hourly / daily 9am / weekly Monday / weekly Friday / monthly 1st 9am /
   one-shot YYYY-MM-DD HH:MM / every N hours / every N minutes / cron 5-field /
   natural language
2. **Custom 5-field cron**（標準 cron 語法）— 即時 preview 「下次 fire 何時」
   + 過去日期 / unreachable cron / N hours 不整除 24 等檢查
3. **Natural language**（fallback）— 走 LLM `parseScheduleNL`（本地 llamacpp
   走 qwen3.5-9b-neo），失敗 retry 1 次

每次調整都即時計算 `nextCronRunMs` 顯示「下次 fire 2026-04-25 09:00 (in 2h 14m)」。

### Daemon attached 時的同步

- mutation（create/update/pause/resume/delete）走 `cron.mutation` WS frame
- daemon 寫盤後 broadcast `cron.tasksChanged`
- 同 project 其他 attached REPL ~即時刷新（取代 200ms chokidar polling）
- LLM-gate（前述 Wave 3 wizard）跟 `/cron` 共用 `CronCreateWizard` 元件

### 跟 Wave 3 工具的關係

Wave 3 的 8 個工具（CronList / CronCreate / CronUpdate / CronPause / CronResume /
CronDelete / CronRunNow / CronHistory）給 LLM；Wave 4 `/cron` TUI 給人類。
backend 同一份 `cronTasks.ts` schema，行為對齊。

### 跨平台

純 ink TUI、無平台分歧。Windows ConPTY 跟 macOS PTY 都驗過（後者由 M-DECOUPLE-3-6
PTY E2E 涵蓋當前 platform，另一平台 portable 但需有對應 hardware 才能實機測）。

## 未完成 / 後續

- Discord cronMirror：走 gateway.ts registry.onLoad hook 訂閱 `cron.events.on('cronFireEvent')`，`pickAllMirrorTargets` + `redactSecrets` + `truncateForDiscord` 發 home / per-project channel
- Slash command `/cron-history` 獨立包裝 CronHistoryTool 給人類快速查（目前 H 鍵已涵蓋 95%）
- Schedule editor B 方案：5-欄位結構化 builder（preset → custom → NL 三條路，缺中間結構化 field 編輯）
