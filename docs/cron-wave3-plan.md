# Cron 擴充：6 大功能整合計畫

## Context

目前 my-agent 的本地 cron（`src/utils/cronTasks.ts` + `cronScheduler.ts` + `daemon/cronWiring.ts`）功能已不弱：recurring / one-shot、paused、repeat 上限、lastStatus、preRunScript、modelOverride、jitter、daemon 內 lock、stale-run grace window 都有。但相比 Anthropic remote schedule 等 managed 排程服務，仍缺：自然語言排程、結果通知、run history 觀測、失敗重試、條件觸發、明確 catch-up 策略。

本計畫把這 6 項補齊，全部走「擴充 CronTask 欄位 + scheduler 邊界 hook」路線，**不重寫現有檔案核心邏輯**，所有新欄位 optional 保證舊 task 向後相容。重點原則：

- 保留 `cronScheduler.ts` 的 batched write（commit 6105c6c 修的 race），新邏輯一律過 `markCronFiredBatch()`
- daemon 是唯一 fire 執行者（lock 已就位），新狀態（retry attempts、history index、condition gate）都在 daemon 寫
- TUI 通知是 daemon → REPL 的新 frame，沿用 M-DAEMON 的 `useDaemonMode.onFrame` 訂閱模式
- Discord 通知重用 `replMirror.pickAllMirrorTargets` + `truncateForDiscord` + `redactSecrets`，**不另寫 posting 路徑**

---

## 使用者已對齊的決策

| # | 主題 | 決策 |
|---|------|------|
| Q1 | NL 排程策略 | 純 LLM 解析（不裝 chrono-node） |
| Q2 | TUI 通知 UI | Ephemeral toast（fire 當下）+ StatusLine 持久 badge（next/last 狀態） |
| Q3 | 失敗條件 | 不寫死；走統一 **TUI 引導對話**蒐集（含失敗判定） |
| Q3+ | Wizard 觸發時機 | **LLM 呼叫 CronCreate 時一律彈 wizard**，預填 LLM 推斷的所有欄位，使用者可改 / 確認 / 取消 |
| Q4 | Catch-up | 不固定 policy，**per-task `catchupMax: number`** 補跑次數上限 |

---

## 架構總覽

```
┌─────────────────────────────────────────────────────────────┐
│ CronTask schema (Wave 3 新增欄位 — 全 optional)             │
│ ─────────────────────────────────────────────────────────── │
│ scheduleSpec?: { kind: 'cron'|'nl'; raw: string }   // NL  │
│ notify?: NotifyConfig                                // 2  │
│ history?: { keepRuns: number }                       // 3  │
│ retry?: { maxAttempts: number; backoffMs: number;          │
│           failureMode: FailureMode; attemptCount: number } // 4 │
│ condition?: { kind: 'shell'|'lastRunOk'|'preRunGate';     │
│               spec: string }                         // 5  │
│ catchupMax?: number                                  // 6  │
└─────────────────────────────────────────────────────────────┘
         │                      │                   │
         ▼                      ▼                   ▼
┌──────────────────┐  ┌──────────────────┐  ┌─────────────────┐
│ cronScheduler.ts │  │ cronWiring.ts    │  │ history store   │
│ (catch-up,       │  │ (condition gate, │  │ .my-agent/cron/ │
│  fire decision)  │  │  retry, notify   │  │ output/{id}/ +  │
│                  │  │  emit)           │  │ history.jsonl   │
└──────────────────┘  └──────────────────┘  └─────────────────┘
                              │
                ┌─────────────┼──────────────┐
                ▼             ▼              ▼
        ┌──────────────┐ ┌──────────┐ ┌──────────────┐
        │ broker emit  │ │ Discord  │ │ TUI toast +  │
        │ cronFireEvent│ │ replMirr │ │ StatusBadge  │
        └──────────────┘ └──────────┘ └──────────────┘
```

---

## 功能 1 — 自然語言排程（純 LLM）

### 設計

- CronCreate 工具新增 `schedule` 欄位接受 NL 字串（既有 `cron` 欄位保留）
- 新模組 `src/utils/cronNlParser.ts`：
  - `parseScheduleNL(input: string): Promise<{ cron: string; recurring: boolean; humanReadable: string }>`
  - 內部走 `services/api/client.ts` 取目前 provider，丟一個結構化 prompt（system: 「你只能輸出 JSON `{cron, recurring, humanReadable}`，cron 為 5 欄」），帶當前 tz / now 給 model 對齊
  - 失敗 retry 1 次；2 次都壞回 typed error
- CronTask 存兩份：`cron` 欄位存翻譯後的 5-field 字串（scheduler 不變），`scheduleSpec: { kind: 'nl', raw: '每週一早上 9 點' }` 留原文供 list / edit 時顯示
- LLM 失敗的 graceful path：CronCreate 回 error message 引導使用者直接給 cron，**不**靜默 fallback（避免錯誤排程）

### 修改

| 檔案 | 動作 |
|------|------|
| `src/utils/cronNlParser.ts` | **新增**。LLM 呼叫 + JSON 解析 + cron 字串驗證（過 `parseCronExpression`） |
| `src/tools/ScheduleCronTool/CronCreateTool.ts` | input schema 加 NL 路徑分支；偵測非 5-field 且非 `every Nm` / ISO 就走 `parseScheduleNL` |
| `src/utils/cronTasks.ts:30-115` | `CronTask` 加 `scheduleSpec?: { kind: 'cron'\|'nl'; raw: string }` |
| `src/tools/ScheduleCronTool/CronListTool.ts` | 輸出時若 `scheduleSpec.kind==='nl'` 同時顯示 raw + humanReadable |

---

## 功能 2 — 結果通知 / 投遞

### 設計

#### 2a. CronTask `notify` 欄位

```ts
notify?: {
  tui: 'always' | 'failure-only' | 'off'      // 預設 'always'
  discord: 'home' | 'project' | 'off'         // 預設 'off'
  desktop?: boolean                            // OS notification（reuse notification-session-end.sh 模式）
}
```

#### 2b. Daemon 新 broker frame `cronFireEvent`

`src/daemon/sessionBroker.ts` 加事件型別：
```ts
{
  type: 'cronFireEvent'
  taskId: string
  taskName: string
  schedule: string          // human readable
  status: 'fired' | 'completed' | 'failed' | 'retrying' | 'skipped'
  startedAt: number
  finishedAt?: number
  durationMs?: number
  errorMsg?: string         // 已過 redactSecrets
  attempt?: number          // retry 第幾次
  nextFireAt?: number
  source: 'cron'
  projectId: string
}
```

emit 點：
- `cronWiring.ts` 的 `handleFire()` 開頭 emit `fired`
- `turnEnd` 訂閱判斷 source==='cron' 後 emit `completed` / `failed`
- retry 流程 emit `retrying`
- condition gate 拒絕時 emit `skipped`

#### 2c. Discord 通知

走既有 `src/discord/gateway.ts:282` 的 `registry.onLoad` listener，加一個新 subscriber 訂閱 broker `cronFireEvent`：
- `notify.discord === 'home'` → `pickAllMirrorTargets` 強制走 `homeChannelId`
- `notify.discord === 'project'` → `pickAllMirrorTargets(runtime, config)` 預設行為
- 訊息 body：`⏰ {taskName} {status icon} | {duration} | {schedule}`，failure 時附上 `errorMsg`（已 redacted）
- 沿用 `truncateForDiscord` 處理長度

#### 2d. TUI

兩件事：

**Ephemeral toast**（`src/hooks/useDaemonMode.ts` 加 `onCronFireEvent` callback）：
- REPL.tsx 呼叫 `addNotification({ key: 'cron-fire-{taskId}', text: '⏰ daily-build fired ✓ in 4.2s', priority: status==='failed'?'high':'medium', timeoutMs: status==='failed'?12000:6000, fold: ... })`
- `fold` 把同 key 內近期事件聚合：「2 tasks fired in 1m」
- 重用 `src/context/notifications.tsx` 既有 queue，零新元件

**持久 badge**：
- 新元件 `src/components/CronStatusBadge.tsx`：訂閱 broker（透過新 hook `useCronStatus()`）+ `CronListTool` 拉當前 tasks 算 next fire
- 顯示格式：`cron: next 7m ✓`（綠勾）/ `cron: next 7m ✗1`（紅叉 + 失敗計數）/ `cron: 0 jobs`（無 task 時隱藏）
- 掛在 `src/components/StatusLine.tsx` 條件渲染（沿用 `statusLineShouldDisplay` gate）
- 狀態快取：last fire status 保 5 分鐘 TTL，避免無限累積

### 修改

| 檔案 | 動作 |
|------|------|
| `src/utils/cronTasks.ts` | 加 `notify` 欄位到 `CronTask` |
| `src/daemon/sessionBroker.ts` | 加 `cronFireEvent` 事件型別 + emit helper |
| `src/daemon/cronWiring.ts:107-128` | `handleFire` 改寫：emit `fired` → 跑 turn → 訂 turnEnd emit `completed/failed`；`runLane` 結束處清理訂閱 |
| `src/server/directConnectServer.ts` | broker `cronFireEvent` → broadcast WS frame `cronFireEvent` |
| `src/discord/gateway.ts` | `registry.onLoad` 內加 `subscribeCronFireEvent(runtime)`：訂閱 broker → `pickAllMirrorTargets` → `redactSecrets` → `truncateForDiscord` → post |
| `src/discord/cronMirror.ts` | **新增**。專門處理 cron event 格式化 + 路由（home/project 分支） |
| `src/hooks/useDaemonMode.ts:222-256` | 加 `onCronFireEvent` callback dispatch |
| `src/screens/REPL.tsx:4198-4219` | 註冊 `onCronFireEvent` → 呼叫 `addNotification` |
| `src/components/CronStatusBadge.tsx` | **新增**。訂閱 + 顯示 |
| `src/hooks/useCronStatus.ts` | **新增**。聚合 broker 事件 + CronListTool 結果 |
| `src/components/StatusLine.tsx` | 加 `<CronStatusBadge />` 渲染（gated by tasks.length > 0） |

---

## 功能 3 — Run History / 觀測

### 設計

- 既有 `saveJobOutput()` 已寫 `.my-agent/cron/output/{id}/{timestamp}.md`（cronScheduler.ts:386-399），這是 raw 內容
- 新增 **history index**：`.my-agent/cron/history/{id}.jsonl`（append-only），每行一筆：
  ```json
  {"ts": 1735000000000, "status": "ok", "durationMs": 4200, "attempt": 1, "outputFile": "2026-04-23T09:00:01.md", "errorMsg": null}
  ```
- 由 `markCronFiredBatch()` 寫入時順帶 append（同一個 read-modify-write 之後做）
- `keepRuns` 上限：超過時 truncate 最舊（檔案 read → slice → atomic write）；預設 50
- 新工具 `CronHistoryTool`：input `{ id, limit?: 20 }` → 回最近 N 筆 entries + output snippet（讀 `outputFile` 前 200 chars）
- 新 slash command `/cron-history <id>`：人類友善表格

### 修改

| 檔案 | 動作 |
|------|------|
| `src/utils/cronTasks.ts` | 加 `history?: { keepRuns: number }` 欄位 |
| `src/utils/cronHistory.ts` | **新增**。`appendHistoryEntry`、`readHistory`、`truncateHistory` |
| `src/utils/cronTasks.ts:813-852` | `markCronFiredBatch` 結尾呼叫 `appendHistoryEntry(records)` |
| `src/tools/CronHistoryTool/` | **新增工具**（同 CronListTool pattern） |
| `src/commands/cronHistory.ts` | **新增 slash command** |

---

## 功能 4 — 失敗重試 / Backoff（含 TUI 引導對話）

### 設計

#### 4a. CronTask `retry` 欄位

```ts
retry?: {
  maxAttempts: number              // 含首次，例 3 = 首次 + 2 重試
  backoffMs: number                // exponential: backoffMs * 2^(attempt-1)
  failureMode: FailureMode          // 由引導對話蒐集
  attemptCount: number             // runtime 計數，markCronFiredBatch 維護
}

type FailureMode =
  | { kind: 'turn-error' }                                    // turn ended with error/exception
  | { kind: 'pre-run-exit' }                                  // preRunScript exit ≠ 0
  | { kind: 'output-regex'; pattern: string; flags?: string } // turn output 命中 regex
  | { kind: 'output-missing'; pattern: string }               // turn output 不含 pattern
  | { kind: 'composite'; modes: FailureMode[]; logic: 'any'|'all' }
```

#### 4b. （詳見「Wizard 統一設計」章節）

retry / failureMode 是 wizard 蒐集的欄位之一，不再單獨設計觸發路徑。LLM 呼叫 CronCreate 一律彈 wizard 預填，使用者在 wizard 內確認或修改 retry / failureMode（以及所有其他欄位）。

#### 4c. Scheduler retry 流程

`cronWiring.ts:handleFire`：
1. 跑 task → 等 turnEnd
2. 用 `failureMode` 判斷成敗（新 helper `classifyFireResult`）
3. 失敗且 `attemptCount < maxAttempts`：
   - emit `retrying`
   - `setTimeout(..., backoffMs * 2^(attempt-1))` 重新呼叫 `handleFire`（**同一 task，不走 schedule**）
   - `markCronFiredBatch` 寫 `retry.attemptCount++`，**不**更新 `lastFiredAt`（保留原始 schedule anchor）
4. 失敗且 `attemptCount >= maxAttempts`：emit `failed`、reset attemptCount=0、走正常 reschedule
5. 成功：reset attemptCount=0、emit `completed`

注意：retry 不能跨 daemon restart（pending setTimeout 沒了）。重啟時若 `attemptCount > 0` 視同放棄、reset 並走下一次 schedule。

### 修改

| 檔案 | 動作 |
|------|------|
| `src/utils/cronTasks.ts` | 加 `retry` 欄位 + `FailureMode` type export |
| `src/utils/cronFailureClassifier.ts` | **新增**。`classifyFireResult(turnEndEvent, output, failureMode): 'ok'\|'error'` |
| `src/daemon/cronWiring.ts` | `handleFire` 改造：訂 turnEnd → classify → retry / reschedule 分支；攔截 turn output 內容供 regex 比對 |

---

## 統一 Wizard：LLM 建立 cron 的確認關卡

### 設計

**核心轉變**：CronCreateTool 不再「靜默執行 + 寫入」，所有透過 LLM 觸發的呼叫都進入 wizard 模式 — daemon 把 LLM 推斷的完整 task draft 推到使用者所在的 REPL，使用者在 inline TUI 上確認 / 修改 / 取消。

#### 觸發路徑

| 來源 | 行為 |
|------|------|
| LLM 呼叫 CronCreateTool | **一律彈 wizard**，預填 LLM 給的所有欄位 |
| 使用者 `/cron-create <args>` slash | 彈 wizard，預填 args 解析結果（缺欄位空白） |
| 程式 / 測試 / `assistantMode` 內建 task | 帶 `bypassWizard: true` 內部旗標，直接寫入（保留 escape hatch） |
| Discord `/cron-create` 經 daemon | 走 wizard 路徑送到 attached REPL；無 attached REPL 時走 fallback wizard（DM 對話 — phase 2，本期先回 error） |

#### Wizard 流程（單一互動 UI，非多步分頁）

採「**summary card + inline edit**」模式，不是逐題問答：

```
┌─ Create Cron Task ────────────────────────────────┐
│ Name        : daily-build                  [edit] │
│ Schedule    : 0 9 * * *  (每天早上 9 點)    [edit] │
│ Prompt      : Run bun build and report ...  [edit] │
│ Recurring   : ✓ yes                        [edit] │
│ ─── Advanced (LLM 預填值，可改) ──────────────────  │
│ Notify      : tui=always discord=home      [edit] │
│ Retry       : 3 attempts, 60s backoff      [edit] │
│ Failure mode: turn-error                   [edit] │
│ Condition   : (none)                       [edit] │
│ Catch-up max: 1                            [edit] │
│ History     : keep 50 runs                 [edit] │
│ Pre-run     : (none)                       [edit] │
├───────────────────────────────────────────────────┤
│  [Enter] Confirm   [E] Edit field   [Esc] Cancel  │
└───────────────────────────────────────────────────┘
```

- 使用者按 `E` → 列表選欄位 → 進該欄位的 inline editor（text / number / select / sub-form）
- `Enter` 確認 → daemon 寫入 → CronCreateTool 回 success result
- `Esc` 取消 → daemon 回 CronCreateTool error `'user cancelled'`，LLM 看到後可決定是否重試或放棄

#### LLM 與 Wizard 的契約

CronCreateTool input schema 維持完整（所有欄位 LLM 都可指定），但**回傳值改為 async 等待 wizard 結果**：
- 工具呼叫 → daemon emit `cronCreateWizard` frame 帶 draft → REPL 顯示 wizard
- 使用者操作 → REPL 回 `cronCreateWizardResult` frame（confirm + 最終 task / cancel）
- daemon 收到後執行寫入 / 取消，回填 tool result
- timeout 5 分鐘無回應 → 自動 cancel + 回 tool error

#### 多 client 場景

- 同 project 有多個 attached REPL：wizard 廣播給所有，**先回應的得標**，其他 client 收到 `cronCreateWizardResolved` 自動關閉 UI（沿用 M-DAEMON permission router 的 first-wins pattern）
- 沒 attached REPL：tool 立即回 error，請使用者開 REPL 重試（避免靜默自動寫入產生意外 cron）

#### 實作要點

| 檔案 | 動作 |
|------|------|
| `src/tools/ScheduleCronTool/CronCreateTool.ts` | 改 async 回傳 — 建 draft → emit wizard frame → 等 result → 寫入 / 回錯 |
| `src/daemon/sessionBroker.ts` | 加 `cronCreateWizard` / `cronCreateWizardResult` / `cronCreateWizardResolved` 三個 frames |
| `src/daemon/cronCreateWizardRouter.ts` | **新增**。pending wizard map + first-wins 仲裁 + timeout（mirror permissionRouter pattern） |
| `src/server/directConnectServer.ts` | broadcast wizard frames |
| `src/hooks/useDaemonMode.ts` | 加 `onCronCreateWizard` callback |
| `src/components/CronCreateWizard.tsx` | **新增**。summary card + inline edit ink UI |
| `src/screens/REPL.tsx` | 註冊 wizard handler → push 元件到 modal slot（沿用既有 centeredModal 機制） |

#### Wizard UI 模式選擇理由

選 summary-card 而非多步問答：
- LLM 已給完整 draft，逐題問會白白重複 LLM 已經填好的內容、體驗很長
- 使用者大部分時候只想確認 + 改 1-2 個欄位，summary 一眼掃完按 Enter 最快
- 多步問答只在使用者第一次手動建立、什麼都沒填時才有優勢，這時可走 `/cron-create-interactive` 提供（phase 2，本期不做）

---

## 功能 5 — Conditional / Event-driven 觸發

### 設計

`condition` 欄位定義 fire 前的 gate：

```ts
condition?:
  | { kind: 'shell'; spec: string }          // 執行 shell，exit 0 才 fire
  | { kind: 'lastRunOk' }                    // 上次必須 lastStatus === 'ok' 才 fire
  | { kind: 'lastRunFailed' }                // 上次必須 'error' 才 fire（重試型）
  | { kind: 'fileChanged'; path: string }    // 檔案 mtime 比 lastFiredAt 新才 fire
```

`shell` kind 走既有 `runPreRunScript` 機制（10s timeout、stdout 丟棄、看 exit code），跟 `preRunScript` 區別：
- `preRunScript` = **資料蒐集** prepend 到 prompt
- `condition` = **gate** 決定要不要 fire

scheduler 在 `check()` 決定 fire 後 / `cronWiring.handleFire` 起頭，先跑 condition：
- 不通過 → emit `cronFireEvent` status='skipped' → 不更新 `lastFiredAt`（讓下次 schedule 還是會看到並再判定）→ 不算 retry
- 通過 → 走原 fire 流程

### 修改

| 檔案 | 動作 |
|------|------|
| `src/utils/cronTasks.ts` | 加 `condition` 欄位 |
| `src/utils/cronCondition.ts` | **新增**。`evaluateCondition(task, lastFiredAt): Promise<boolean>` |
| `src/daemon/cronWiring.ts:handleFire` | 開頭加 `if (!await evaluateCondition(task, ...)) { emitSkipped(); return; }` |
| `src/tools/ScheduleCronTool/CronCreateTool.ts` | input schema 接受 condition |

---

## 功能 6 — Catch-up 策略明確化

### 設計

per-task `catchupMax: number`（預設 1，與目前隱性行為相容）：

- daemon 起 / scheduler load 時：對每個 recurring task，計算 `lastFiredAt` 到 now 之間錯過幾次 fire（用 cron expression 列舉）
- `missedCount = min(actualMissed, catchupMax)`
- 連續 fire `missedCount` 次（每次間隔 small jitter 避免 burst），最後一次走正常 reschedule
- emit `cronFireEvent` 時帶 `attempt` / 標記 catch-up 來源（新增 `catchUpIndex?: number`）
- `catchupMax: 0` = skip 全部
- `catchupMax: 1` = 只補最近一次（對齊 Q4 預設）
- one-shot 維持現行 startup 提示流程，不受影響

新 helper 在 `cronScheduler.ts:findMissedTasks` 旁加：
- `enumerateMissedFires(cron, lastFiredAt, now): number` — 算錯過次數
- `selectCatchUpFires(task, missedCount): number` — 應用 `catchupMax`

### 修改

| 檔案 | 動作 |
|------|------|
| `src/utils/cronTasks.ts` | 加 `catchupMax?: number` 欄位 |
| `src/utils/cronScheduler.ts:571-576` | `findMissedTasks` 擴展支援 recurring |
| `src/utils/cronScheduler.ts` | 加 `enumerateMissedFires` / `selectCatchUpFires` helpers |
| `src/daemon/cronWiring.ts` | startup 時跑 catch-up 排程（spread 出 jitter，逐個 submit） |

---

## 整合風險與配套

1. **scheduler.ts 是 deny-list 之外但邏輯敏感**：所有新分支都做成「if optional field 存在才走新路徑」，舊 task `notify`/`retry`/`condition`/`catchupMax` 全 undefined 時行為與目前 byte-for-byte 一致。typecheck + 既有 `tests/integration/daemon/cron-wiring.test.ts` 必須全綠。
2. **race condition 不能回退**：所有 lastStatus / attemptCount / history append 都走 `markCronFiredBatch` 一次 read-modify-write，禁止再開第二條 write path。
3. **bun + Windows mkdir EEXIST**：新增 history dir 寫入時沿用既有 `writeCronTasks` 的 EEXIST catch pattern。
4. **跨 platform**：history.jsonl 用 `\n` 不是 `\r\n`；shell condition 在 Windows 走 cmd / bash 自動偵測（reuse `cronPreRunScript.ts:runPreRunScript` 的 spawn 邏輯）。
5. **wizard 與 LLM 路徑共存**：CronCreate 工具被 LLM 呼叫時若帶完整 `retry.failureMode` 就跳過 wizard；只有人類 `/cron-create` 缺欄位時才彈 wizard。
6. **NL parser LLM 失敗**：明確 error 給使用者，不靜默 fallback。

---

## 階段性 commit 計畫

每階段獨立可交付、typecheck + smoke test 綠後 commit：

1. **W3-1**：CronTask schema 擴充（6 個新欄位 + types），`writeCronTasks` strip 邏輯更新，typecheck only
2. **W3-2**：history store + `CronHistoryTool` + `/cron-history` slash command（功能 3）
3. **W3-3**：condition gate（功能 5，最低風險）
4. **W3-4**：catch-up 明確化（功能 6）
5. **W3-5**：retry / backoff scheduler 端（功能 4 後端，FailureMode classifier）
6. **W3-6**：broker `cronFireEvent` + Discord cronMirror（功能 2 daemon/discord 部分）
7. **W3-7**：TUI toast + StatusBadge（功能 2 REPL 部分）
8. **W3-8a**：Wizard 後端（broker frames + router + CronCreateTool async 改造 + bypass escape hatch）
9. **W3-8b**：Wizard 前端（CronCreateWizard summary-card 元件 + REPL handler + inline editors）
10. **W3-9**：NL parser + CronCreate NL 路徑（功能 1，最後做因為 fire 路徑 + wizard 全 ready）
11. **W3-10**：docs（更新 `docs/daemon-mode.md` 加 cron 章節）+ 開發日誌 + LESSONS

---

## 驗證計畫

### 單元測試
- `cronNlParser`：mock provider 回幾種 NL 句型 → 預期 cron 字串
- `cronFailureClassifier`：每種 FailureMode × 真/假輸入
- `cronCondition`：每種 kind 的真/假分支
- `enumerateMissedFires` / `selectCatchUpFires`：邊界（剛好錯過一次、跨日、跨年）
- `cronHistory`：append + truncate（keepRuns 上限）

### 整合測試（沿用 `tests/integration/daemon/cron-wiring.test.ts` pattern）
- daemon spawn → create cron with retry → 故意失敗（preRunScript exit 1）→ 觀察 retry 計數遞增、最終 emit `failed`
- daemon spawn → create cron with `condition: shell exit 1` → 看到 `skipped` event 不 fire
- daemon stop 1 小時後重啟 → catchupMax=2 的 hourly task → 看到只 fire 2 次

### 手動端到端
- REPL `/cron-create` 不帶 retry → 一般 task；帶 `--retry 3` 不帶 failureMode → 出 wizard
- 跑 daemon + Discord bot：cron fire → home channel 收到 `⏰ ... ✓` 訊息
- REPL 開著時 cron fire → toast 出現 + StatusLine badge `cron: next 7m ✓`
- NL：`/cron-create "每週一早上 9 點 build" "bun run build"` → 自動轉 `0 9 * * 1`

### 性能 / 健全
- 1000 個 history entries 後讀 + truncate 仍 < 100ms
- daemon 重啟時 100 個 tasks 計算 catch-up < 200ms（cron 列舉用 `nextCronRunMs` 迴圈）
- `./cli` 啟動冒煙不變慢（NL parser lazy load）

---

## 關鍵檔案速查表

**核心改造**：
- `src/utils/cronTasks.ts` — schema + persistence
- `src/utils/cronScheduler.ts` — fire decision、catch-up、grace
- `src/daemon/cronWiring.ts` — fire 執行、retry、condition、emit
- `src/daemon/sessionBroker.ts` — cronFireEvent / cronCreateWizard frames
- `src/tools/ScheduleCronTool/CronCreateTool.ts` — NL 路徑、wizard 觸發

**新增**：
- `src/utils/cronNlParser.ts`
- `src/utils/cronHistory.ts`
- `src/utils/cronCondition.ts`
- `src/utils/cronFailureClassifier.ts`
- `src/daemon/cronCreateWizardRouter.ts`
- `src/discord/cronMirror.ts`
- `src/components/CronStatusBadge.tsx`
- `src/components/CronCreateWizard.tsx`
- `src/hooks/useCronStatus.ts`
- `src/tools/CronHistoryTool/{CronHistoryTool,prompt}.ts`
- `src/commands/cronHistory.ts`

**TUI 整合點**：
- `src/screens/REPL.tsx:4198-4219` — frame handler
- `src/hooks/useDaemonMode.ts:222-256` — onCronFireEvent / onCronWizard
- `src/components/StatusLine.tsx` — badge 掛點
- `src/context/notifications.tsx` — toast 重用（無修改）
