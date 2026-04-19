# ScheduleCronTool

Agent-facing 排程子系統 — 7 個工具 + schedule DSL + in-process teammate
整合 + pre-run script + injection 防禦。使用者層面的完整指南見
`docs/cron.md`，本檔是 per-tool reference。

## 工具清單

| Tool | 用途 | 主要輸入 |
|---|---|---|
| **CronCreate** | 新建排程 | `schedule` 或 `cron`, `prompt`, 選配：`name` / `recurring` / `durable` / `repeat` |
| **CronList** | 列出所有排程 | — |
| **CronDelete** | 刪除排程 | `id` |
| **CronPause** | 暫停（保留狀態不觸發） | `id` |
| **CronResume** | 恢復暫停的排程 | `id` |
| **CronUpdate** | 編輯既有排程 | `id` + 要改的欄位 |
| **CronRunNow** | 立即觸發一次 | `id` |

所有工具 `isEnabled()` 檢查 `isKairosCronEnabled()`（build-time
`AGENT_TRIGGERS` flag + runtime `CLAUDE_CODE_DISABLE_CRON` killswitch）。

---

## CronCreate

### Input

```ts
{
  schedule?: string     // 新 DSL 欄位（推薦）
  cron?: string         // 向後相容 alias
  prompt: string
  name?: string
  recurring?: boolean   // 僅 cron / every DSL 有效；duration 與 ISO 自動 false
  repeat?: number       // 正整數；僅 recurring 有效
  durable?: boolean     // 預設 false（session-only）
}
```

`schedule` 與 `cron` 擇一提供（both 都給會用 `schedule`）。接受的格式：

| 形式 | 例 | 結果 |
|---|---|---|
| 5-field cron | `0 9 * * *` | recurring（可用 `recurring: false` 改為 one-shot） |
| `every N<u>` | `every 5m` / `every 2h` / `every 1d` | recurring |
| 時長 | `30m` / `2h` / `1d` | one-shot（now + duration） |
| ISO timestamp | `2026-04-20T14:30` | one-shot（必須未來） |

### validateInput 檢查

1. `parseSchedule` 成功（否則 errorCode 1）
2. cron 在接下來 1 年內至少匹配一個日期（errorCode 2）
3. `scanCronPrompt(prompt)` 無命中（errorCode 5，見「Injection 防禦」）
4. MAX_JOBS=50 限制未超（errorCode 3）
5. durable=true 且 teammate context 存在 → 拒絕（errorCode 4）

### Output

```ts
{
  id: string               // 8 hex chars
  humanSchedule: string    // 顯示字串
  recurring: boolean
  durable?: boolean
  name?: string
  repeat?: number
}
```

---

## CronList

無輸入。輸出每個 job：

```ts
{
  id: string
  cron: string
  humanSchedule: string
  prompt: string
  recurring?: true
  durable?: false       // session-only 標記
  name?: string
  nextRunAt?: string    // ISO timestamp
  lastStatus?: 'ok' | 'error'
  lastError?: string
  repeat?: { times: number | null; completed: number }
}
```

Teammate context 下只看到自己的 job（`agentId === ctx.agentId`）。
無 teammate context（主 REPL）看到所有 job。

---

## CronDelete

```ts
{ id: string }
```

Teammate 無法刪除他人的 cron（`agentId` 比對）。

---

## CronPause / CronResume

`CronPause { id }` → 設 `state='paused'` + `pausedAt: ISO now`。
`CronResume { id }` → 清 `pausedAt`、`state='scheduled'`。

Scheduler tick 時 `state === 'paused'` 的任務會被 `nextFireAt.delete()`
然後跳過整個處理流程（既不觸發也不 reschedule）。
`CronResume` 後，下次 tick 會 re-anchor 計算 next fire。

---

## CronUpdate

```ts
{
  id: string
  name?: string
  prompt?: string       // 覆寫時會跑 scanCronPrompt
  schedule?: string     // 覆寫時會跑 parseSchedule；清掉舊的 lastFiredAt
  repeat?: number       // 重設為 { times: N, completed: 0 }
  modelOverride?: string  // 空字串 '' 表示清除
  preRunScript?: string   // 空字串 '' 表示清除
}
```

返回 `{ id, changed: string[] }`（變動的欄位名）。

---

## CronRunNow

```ts
{ id: string }
```

透過 `enqueuePendingNotification` 送進 REPL 佇列（`priority: 'later'`，
`workload: WORKLOAD_CRON`）。**不更新** `lastFiredAt`、**不 bump**
`repeat.completed` — 是手動觸發路徑，不影響原本的排程節奏。

---

## Schedule DSL 規則（`parseSchedule`）

原始碼：`src/utils/cronTasks.ts::parseSchedule`

| 輸入 | 轉換 |
|---|---|
| 5-field cron | 原樣通過，`recurring: true` |
| `every N m/min/minute` | `*/N * * * *`（N 必須整除 60） |
| `every N h/hr/hour` | `0 */N * * *`（N 必須整除 24） |
| `every 1d` / `every 24h` | `0 0 * * *` |
| `Nm` / `Nh` / `Nd`（無 `every`） | 算出 now + N → `M H DoM Mon *`, `recurring: false` |
| ISO timestamp（含 T 或 YYYY-MM-DD） | 解析後 → `M H DoM Mon *`, `recurring: false` |

拒絕的輸入：
- 不整除的 interval（`every 45m`）→ 錯誤訊息建議改用 plain cron
- 過去的 ISO timestamp
- 無法辨識的字串

---

## In-process teammate 整合

當 `task.modelOverride` 存在且 task 沒有 `agentId` 時，`useScheduledTasks`
hook 的 `deliver()` 會：

1. 查 `modelOverrideTeammates: Map<cronId, teammateTaskId>` 是否已有活著的 teammate
2. 有且未 terminal → `injectUserMessageToTeammate(teammateTaskId, prompt, setAppState)`
3. 沒有 → 呼叫 `spawnInProcessTeammate({ name: 'cron-<id>', teamName: 'cron', model, prompt, planModeRequired: false }, { setAppState })`
4. Spawn 失敗 → fallback 到主 REPL 佇列

`modelOverrideTeammates` 是 closure-local，session 結束自然釋放。
Durable cron 跨 session 會重新 spawn。

**限制**：`spawnInProcessTeammate` 只接受 `model`，不接受 `provider` /
`baseUrl`。這兩個覆寫層級做不到是刻意的架構限制（session-wide env var）。

---

## preRunScript 執行流程

`src/utils/cronPreRunScript.ts`：

1. `spawn(shell, ['-c'|'/c', command])`（依平台選 `sh` / `cmd.exe`）
2. 10 秒硬 timeout；runaway stdout 截到 32000 字元避免記憶體爆
3. `close` event 或 timeout 時 redactSecrets 後 resolve
4. `augmentPromptWithPreRun(prompt, result)` 以 CommonMark fence 包起來
   前置注入（fence 長度自動比 stdout 內最長 backtick run +1 避免
   fence 被 inner backtick 關掉）

失敗不阻擋觸發：`result.ok === false` 時 context header 改為
`preRunScript failed: <error> — partial stdout below`，prompt 仍送出。

---

## Injection 防禦（`scanCronPrompt`）

`src/tools/ScheduleCronTool/CronCreateTool.ts::scanCronPrompt`

1. **`containsSecret(prompt)`** — M4 的 30+ token prefix 掃描。命中 →
   拒絕並告知「scheduled cron can exfiltrate on repeat」。
2. **Shell exfil pattern**（4 條 regex）：
   - `curl|wget|fetch ... $(cat|ls|grep|awk|sed ...)`
   - `cat|type ... ~/.ssh/ | authorized_keys | id_rsa | id_ed25519`
   - 裸 `authorized_keys`
   - `curl|wget ... | sh|bash|zsh|cmd|powershell`

命中任一 → 拒絕並回應 `"Refusing to schedule."`。

`CronUpdate` 改 `prompt` 時也會跑同一組檢查。

---

## 儲存與調度

### 檔案位置

- `<project>/.my-agent/scheduled_tasks.json` — durable job
- `<project>/.my-agent/cron/output/<id>/<ts>.md` — 觸發稽核
- `<project>/.my-agent/scheduler.lock` — 多 session 互斥

### Scheduler tick（`src/utils/cronScheduler.ts`）

- 每 1000ms 跑 `check()`
- 讀 file tasks + session tasks（來自 `bootstrap/state.ts::getSessionCronTasks`）
- 每 task：
  - `state === 'paused'` → skip
  - 計 `nextFireAt`（首次 anchored from `lastFiredAt ?? createdAt`）
  - 已到期且不在 grace 內 → fast-forward（僅 recurring）
  - 已到期且在 grace 內 → `onFireTask(t)` / `onFire(t.prompt)`
  - Recurring 觸發後：push 到 `firedFileRecurring` 做批次 `markCronTasksFired`
  - One-shot 觸發後：`removeCronTasks([id])`（inFlight guard 防 double-fire）
- 觸發後 per-task：
  - `saveJobOutput(id, now, auditContent, dir)` 稽核
  - Recurring → `markJobRun(id, true, undefined, dir)` 記錄狀態 + bump repeat.completed

### Jitter

- **Recurring**：forward jitter，proportional to period，cap 15 min
- **One-shot 於 :00 / :30 整點**：backward jitter up to 90s

避免整點 thundering herd。

---

## Feature flags

| Flag | 效果 |
|---|---|
| `AGENT_TRIGGERS` | build-time 啟用本子系統 |
| `tengu_kairos_cron` (GrowthBook) | runtime kill switch（flip=false 即時停所有 schedule） |
| `tengu_kairos_cron_durable` (GrowthBook) | 控制 durable 路徑；off 時 durable=true 自動降成 session-only |
| `tengu_kairos_cron_config` (GrowthBook) | jitter 參數線上調整 |
| `CLAUDE_CODE_DISABLE_CRON` (env) | 本地 killswitch，壓過 GB |

---

## 相關檔案

- `src/utils/cronTasks.ts` — schema + I/O + parseSchedule + markJobRun + advanceNextRun + saveJobOutput + computeGraceMs
- `src/utils/cronScheduler.ts` — tick loop + jitter + lock + file watch + stale fast-forward
- `src/utils/cronTasksLock.ts` — scheduler.lock 多 session 互斥
- `src/utils/cronPreRunScript.ts` — preRunScript 執行與 prompt augmentation
- `src/hooks/useScheduledTasks.ts` — REPL 整合層 + teammate 路由 + fireLanes
- `src/utils/web/secretScan.ts` — injection 防禦的 token 掃描（共用 M4）
