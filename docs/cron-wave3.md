# Cron Wave 3 — 6 大功能使用指南

Wave 3 把本地 cron 從「會 fire 的 timer」升級成「可觀測 / 可確認 / 可恢復」的排程子系統。規劃詳見 `docs/cron-wave3-plan.md`；本文是使用者視角的速查。

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

## 未完成 / 後續

- Discord cronMirror：走 gateway.ts registry.onLoad hook 訂閱 `cron.events.on('cronFireEvent')`，`pickAllMirrorTargets` + `redactSecrets` + `truncateForDiscord` 發 home / per-project channel
- Wizard inline edit：本版 summary card 僅 confirm / cancel；未來可加 `[E]dit field` 分頁 editor
- Slash command `/cron-history` 獨立包裝 CronHistoryTool 給人類快速查
- NL parser 的 CronListTool 顯示 raw + humanReadable（目前只存 scheduleSpec，list 尚未 render）
