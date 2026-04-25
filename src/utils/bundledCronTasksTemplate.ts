/**
 * scheduled_tasks.json JSONC 模板（bundled）。
 *
 * 此檔案在每個專案的 .my-agent/scheduled_tasks.json 落盤，格式為
 * { tasks: CronTask[] }。
 *
 * 首次寫入（使用者尚未建過任何 cron）→ 落盤此模板（空 tasks 陣列 +
 * 檔頭繁中註解解釋 schema）。若已有 tasks，模板僅提供檔頭註解作為文件。
 */

export const CRON_TASKS_JSONC_TEMPLATE = `{
  // ═══════════════════════════════════════════════════════════════════
  // Cron 排程任務（<project>/.my-agent/scheduled_tasks.json）
  //
  // my-agent 在背景按時間表執行的任務清單。由以下 8 個工具維護，一般
  // 不需手改：CronCreate / CronList / CronDelete / CronPause / CronResume /
  // CronUpdate / CronRunNow / CronHistory。REPL 內 /cron 互動 TUI 更方便。
  //
  // my-agent 會保留本檔的註解。cron fire 後會 batched 寫入 lastFiredAt 等
  // 狀態欄位，檔頭註解與使用者在 task 物件內新加的 // 註解都會留著。
  //
  // 壞檔 → 啟動時 warn 並跳過；不 crash。復原：砍掉整份檔，下次 cron
  // 任務建立會重新落盤空版本。
  // ═══════════════════════════════════════════════════════════════════
  //
  // ═══ 每個 task 的欄位說明（新建任務時請參考）═══
  //
  //   id:              8-hex id（CronCreate 自動產生）
  //   name:            顯示用標籤（可選）
  //   cron:            5-field cron expression（CronCreate 會把 "30m" /
  //                    "every 2h" / NL 轉換成這個）
  //   prompt:          觸發時要跑的 prompt
  //   createdAt:       epoch ms 建立時間
  //   recurring:       true = 週期性；false = 一次性（fire 後自刪）
  //   state:           "scheduled" | "paused" | "completed"
  //   lastFiredAt:     最後觸發 epoch ms
  //   lastStatus:      "ok" | "error"
  //   lastError:       錯誤訊息（截 500 字）
  //   pausedAt:        CronPause 時寫入 ISO timestamp
  //   repeat:          { times: N | null, completed: N }（null = 無限）
  //   modelOverride:   per-job 模型覆寫（透過 teammate 機制）
  //   preRunScript:    觸發前先跑的 shell 指令（stdout 注入上下文）
  //   permanent:       true = 不套用 7 天 auto-expire（僅內部工具可設）
  //
  //   ── Wave 3 進階欄位（失敗重試 / 條件觸發 / 通知 / catch-up）──
  //
  //   retry:           { maxAttempts, backoffMs, failureMode, attemptCount }
  //   condition:       { kind, args... }  例如 { kind: "lastRunOk" }
  //   catchupMax:      落後太久時最多補燒幾次（預設 1）
  //   notify:          { kind: "toast" | "statusline" | "discord", ... }
  //   scheduleSpec:    { kind: "cron" | "nl", raw: "使用者原輸入" }
  //   history:         { keepRuns: N }  歷史保留筆數
  //
  // 詳見：docs/cron.md、docs/cron-wave3.md、src/tools/ScheduleCronTool/README.md

  "tasks": []
}
`
