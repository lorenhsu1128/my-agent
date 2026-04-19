# 排程系統（Cron）

My Agent 內建完整的排程子系統 — 讓 agent 能在背景按時間表執行任務，
即使你不在座位上。排程是 *agent* 在跑，不是 OS cron；所以它能用到
agent 的全部工具、記憶、skills、以及（選配）不同的模型。

## Quick start

直接跟 agent 用自然語言描述：

```
你：每兩小時提醒我喝水
agent：[呼叫 CronCreate] schedule="every 2h", prompt="提醒我喝水"
       ✓ Scheduled recurring job abc12345 (every 2h). Session-only.

你：三十分鐘後幫我跑一次 deploy smoke
agent：[呼叫 CronCreate] schedule="30m", prompt="跑 deploy smoke test 並回報結果"
       ✓ Scheduled one-shot task def67890 (once in 30m). Session-only.

你：列出目前的排程
agent：[呼叫 CronList]
       abc12345 — every 2h (recurring) last=ok reps=3/∞: 提醒我喝水
       def67890 — once at 2026-04-20 15:30 (one-shot): 跑 deploy smoke test...
```

---

## 7 個排程工具

| 工具 | 功能 |
|---|---|
| **CronCreate** | 建立新排程（支援 4 種 schedule 格式） |
| **CronList** | 列出所有排程（含 next fire、lastStatus、repeat 進度） |
| **CronDelete** | 刪除排程 |
| **CronPause** | 暫停（狀態保留，不觸發，用 CronResume 還原） |
| **CronResume** | 恢復暫停的排程（next fire 從當下重算） |
| **CronUpdate** | 編輯 name / prompt / schedule / repeat / modelOverride / preRunScript |
| **CronRunNow** | 立即觸發一次（不動原本的 schedule，適合手動測試） |

詳細 I/O 規格見 [`src/tools/ScheduleCronTool/README.md`](../src/tools/ScheduleCronTool/README.md)。

---

## Schedule DSL（排程格式）

`CronCreate` 的 `schedule` 欄位接受 4 種形式：

### 1. 時長（一次性）

```
30m       一次，30 分鐘後
2h        一次，2 小時後
1d        一次，1 天後
```

從「現在 + 時長」計算發射時間，recurring 自動為 false。

### 2. 間隔（週期性）

```
every 5m      每 5 分鐘
every 2h      每 2 小時
every 1d      每天（等效 cron "0 0 * * *"）
```

**限制**：除數必須整除單位（分鐘版除 60、小時版除 24）。`every 45m`
不接受（45 不整除 60），改用標準 cron `*/45 * * * *`。

### 3. 標準 5-field cron

```
0 9 * * *        每天早上 9 點
*/15 * * * *     每 15 分鐘
0 9 * * 1-5      週一到週五早上 9 點
```

此路徑下 `recurring` 可以明確指定 false（做「指定時刻 + 不重複」的 one-shot）。

### 4. ISO 8601 時間戳（一次性）

```
2026-04-20T14:30     一次，指定時刻
2026-04-20T14:30:00
```

必須是未來時間，否則拒絕。

---

## 生命週期與狀態

每個 job 的 schema：

```ts
type CronTask = {
  id: string               // 8 hex chars
  name?: string            // 顯示用標籤
  cron: string             // 轉換後的 5-field cron
  prompt: string           // 觸發時要跑的 prompt
  createdAt: number
  lastFiredAt?: number     // 最後觸發的 epoch ms
  recurring?: boolean
  state?: 'scheduled' | 'paused' | 'completed'
  pausedAt?: string        // CronPause 時寫入
  lastStatus?: 'ok' | 'error'
  lastError?: string
  repeat?: { times: number | null; completed: number }
  modelOverride?: string   // 詳見下節
  preRunScript?: string    // 詳見下節
  durable?: boolean        // false = session-only，不寫磁碟
}
```

`state: 'paused'` 時 scheduler 會跳過；`CronResume` 清掉狀態後，next fire
從當下重算。

### durable（持久）vs session-only

- **session-only**（預設）：只留在記憶體，session 結束就消失。適合
  「提醒我 5 分鐘後…」之類的短命任務。
- **durable**：`CronCreate durable=true` 寫入
  `<project>/.my-agent/scheduled_tasks.json`，跨 session / 重啟後依然會跑。
  只在使用者明確要求「永久排這個」時才用。

**teammate 不能用 durable**：teammate 不會跨 session 存在，durable 的
teammate cron 重啟後會孤立指向不存在的 teammate，會被拒絕。

---

## Per-job `modelOverride`

每個 job 可以指定自己用哪個模型跑 — 透過 teammate 機制實作：

```
你：每小時用本地小模型檢查 PR 狀態，有動靜再用 opus 寫總結
agent：[CronCreate]
       schedule="every 1h"
       prompt="檢查 github.com/foo/bar 的 PR 清單..."
       modelOverride="qwen3.5-9b-neo"
```

### 運作方式

1. 第一次觸發時，`useScheduledTasks` 呼叫 `spawnInProcessTeammate`
   建一個 in-process teammate（同 process 的平行 agent），
   傳入 `model: task.modelOverride`。
2. Teammate 的初始 prompt 就是 task.prompt，它會跑到完成。
3. 後續觸發時，複用同一個 teammate（`injectUserMessageToTeammate`
   注入新 prompt）。
4. 若 teammate 被 kill 或消失，下次觸發會 respawn。

### 使用場景

- **成本控管**：高頻觸發用便宜 / 本地模型；真的需要複雜推理時 agent
  可以再 spawn 新的 teammate 升級模型。
- **專業化**：code review 用 coding-centric 模型、摘要用 context-window
  大的模型。
- **隔離**：teammate 有獨立 abort controller，cron 作業不會拖累主 REPL。

### 限制

- 只支援 `model` 覆寫；不支援 per-teammate `provider` / `baseUrl`
  覆寫（這些是 session-wide 的 env var）。要切 provider，用 session
  層級的 env var。
- Teammate 消耗主 process 資源；同時太多 teammates 會影響 REPL 流暢度。

---

## `preRunScript`：注入即時上下文

每次觸發前可以先跑一段 shell 指令，把 stdout 當成 context 前置注入到
prompt：

```
你：每早 8 點跑這個 — 先執行 `git log --since=yesterday --oneline`，
    然後幫我寫一份昨日工作摘要
agent：[CronCreate]
       schedule="0 8 * * *"
       prompt="根據上面的 git log，寫一份昨日工作摘要（中文，條列，不超過 10 條）"
       preRunScript="git log --since=yesterday --oneline"
```

觸發時流程：

1. Scheduler 先 `spawn(shell, ['-c', preRunScript])` 跑指令。
2. 取 stdout（**上限 8000 字元**、**10 秒 timeout**）。
3. `redactSecrets` 掃描 stdout（遮蔽 API key / token / 私鑰 / DB 連線字串）。
4. 以 CommonMark fence 包起來前置到 prompt：

```md
## Context (from preRunScript)

```
<stdout 內容>
```

<原 prompt>
```

5. 把增強後的 prompt 送給 agent 或 teammate。

失敗情境：
- **Timeout / exit != 0**：仍會送 prompt，但 context 區塊改為
  `## Context (preRunScript failed: <reason> — partial stdout below)` 配上任何收到的 partial stdout。
- **Spawn 失敗**：fallback 到原始 prompt 不含 context block。

### 使用場景

- 「檢查 X 有沒有變」類的 diff / polling
- 時間敏感 context（`date`、`uptime`、`df -h`）
- 特定資料來源輪詢（`curl -s api/status`）

### 安全模型

- **跑的是本機 shell** — 可以做任何 shell 能做的事。慎選 preRunScript。
- stdout 經過 `secretScan` 再注入；已知 prefix（30+ 種 token 格式）、
  env assignment、JSON 欄位、Bearer header、私鑰 PEM、DB 連線字串都會
  被遮蔽。
- 如果 preRunScript **本身內容** 觸發 injection scan（含 `curl $(cat ~/.ssh/...)`
  等 pattern），`CronCreate` / `CronUpdate` 會直接拒絕。

---

## 觀測性

### 稽核 log

每次觸發會寫一筆 markdown 到：

```
<project>/.my-agent/cron/output/<job-id>/<timestamp>.md
```

內容：

```md
# Cron fire

- id: abc12345
- name: 檢查 PR
- cron: `every 1h`
- recurring: true
- fired_at: 2026-04-19T15:00:03.142Z

## Prompt

```
<完整 prompt 內容>
```
```

這是 audit trail — 事後可查 *什麼時候觸發了什麼 prompt*。
（目前不寫入模型回應，因為 REPL 是 async 佇列，fire 時還沒結果。）

### 狀態欄位

`CronList` 輸出會帶：

- `lastStatus`: 上次觸發結果（`ok` / `error`）
- `lastError`: 錯誤訊息（截到 500 字）
- `nextRunAt`: 下次觸發 ISO timestamp
- `repeat.completed` / `repeat.times`: 執行次數進度

---

## Stale-run fast-forward

如果 REPL 閒置很久，下次開起來發現週期性 job 已經落後太多，scheduler
**不會** 把錯過的全部補燒 — 只會跳到下次未來時點：

- **Grace window**：週期的一半，clamp 在 2 分鐘～2 小時之間。
  - 每分鐘 job：grace 2 分鐘
  - 每小時 job：grace 30 分鐘
  - 每日 job：grace 2 小時（上限）
- 落後超過 grace → 直接跳到下次未來時點，不補。
- 落後在 grace 內 → 正常觸發（輕微延遲可接受）。

一次性（one-shot）的任務不適用此策略 — 它們會以「missed task」通知使用者，
讓使用者決定要不要 *現在* 補跑。

---

## 安全：Injection 防禦

`CronCreate` / `CronUpdate` 在寫入前會掃描 prompt，以下情況直接拒絕：

1. **內含活躍 secret**：偵測 30+ 種 API key 前綴
   （`sk-ant-`、`ghp_`、`AKIA`、`AIza`、`xox[baprs]-`…）、Bearer token、
   私鑰 PEM 等。理由：cron 會重複跑，一次 leak 就是永久 leak。
2. **Shell 敏感 pattern**：
   - `curl ... $(cat ~/.ssh/...)` 類命令
   - `cat ~/.ssh/id_rsa` / `cat ~/.ssh/id_ed25519` / `authorized_keys`
   - `curl/wget | sh` / `| bash` pipe-to-shell

這些是 heuristic，不是完整防禦 — 如果 prompt 本身合法但你覺得可疑，
還是自己審一下再 CronCreate。

---

## 環境變數

| 變數 | 用途 |
|---|---|
| `MY_AGENT_DISABLE_CRON` | truthy 值 → killswitch，整個 cron 子系統停跑 |

---

## 檔案位置總表

| 路徑 | 用途 |
|---|---|
| `<project>/.my-agent/scheduled_tasks.json` | durable job 儲存（JSON） |
| `<project>/.my-agent/cron/output/<id>/*.md` | 每次觸發的稽核 log |
| `<project>/.my-agent/scheduler.lock` | 多 session 互斥鎖 |

---

## 進階細節

- **Multi-session 互斥**：同一 cwd 下跑多個 My Agent session 時，透過
  `scheduler.lock` 做 leader election；只有 owner 會觸發 durable job，
  避免重複觸發。Owner 掛了其他 session 會接管。
- **Thundering herd 抖動**：`0 * * * *` 之類的整點 cron 會加入基於 taskId
  的 deterministic jitter（週期性任務最多 period 的 10%、上限 15 分鐘；
  一次性任務最多提前 90 秒），避免艦隊在 :00 同時打端點。
- **At-most-once**：觸發後 batched 寫 `lastFiredAt` 到磁碟；crash 中斷
  後重啟不會 burst-fire 已經燒過的任務。
- **Auto-expire**：預設週期性 job 7 天後自動到期（再跑一次最後一輪才刪）。
  理由：bound 無限長的 session lifetime。用 `permanent: true`（僅內部工具寫入）
  可豁免。

詳細演算法見 `src/utils/cronScheduler.ts` 與 `src/utils/cronTasks.ts`。
