# Daemon Mode 使用者指南

> 對應 M-DAEMON 系列交付（M-DAEMON-1 ~ M-DAEMON-8）
>
> 最後更新：2026-04-20

my-agent 的 **daemon 模式**讓 QueryEngine + cron scheduler 常駐在背景程序，
多個 REPL / Discord adapter / cron job 都可以連同一個 daemon 共享對話狀態。
TUI 是否 attach daemon 由偵測器決定，使用者不必手動切換。

本文件只講使用者視角；實作細節（bootstrap / runner / broker / permissionRouter
等）見 ADR-012 和 `src/daemon/` source code。

---

## 快速上手

**預設行為**：REPL 啟動時若無 daemon 活著，會**自動在背景 spawn 一個 detached daemon**
（可用 `/daemon off` 或 `my-agent daemon autostart off` 關閉）。已有 daemon 則直接 attach。

```bash
# 開 REPL — 若無 daemon 會自動啟動一個背景 detached daemon（幾秒後 detector
# 偵測到 pid.json 自動 attach）。
my-agent

# 狀態列會看到：
#   daemon: attached :52371   ← 綠色

# （進階）顯式手動 foreground 啟動 daemon（方便除錯、看 log）：
my-agent daemon start
```

送出訊息（非 `/` 開頭）會走 daemon 跑；daemon 回的 assistant 訊息同步顯示。
同時再開第三個 REPL attach，兩邊都會看到對方送的訊息和回覆。

### Auto-spawn 細節

- **只 REPL 觸發**，`my-agent -p "..."` headless 不 auto-spawn（一次性命令不需要）
- **只第一次**：同一個 REPL session 內，若 daemon 中途被手動停掉，REPL 不會再 re-spawn
  （外部重開 REPL 才會）
- **非阻塞**：REPL 先起來顯示 `standalone`，spawn 完後 detector 撿到 pid.json 自動切
  `attached`
- **失敗不擋**：auto-spawn 失敗（port 佔用 / 權限）REPL 照常標 standalone + 插 warning

### 關閉 auto-spawn

三個管道（任擇）：

```bash
# 方法 1：CLI subcommand（持久寫入 ~/.my-agent/.claude.json）
my-agent daemon autostart off
my-agent daemon autostart on
my-agent daemon autostart status   # 顯示目前設定

# 方法 2：REPL 內 slash command（同樣持久；off 會順便停掉活 daemon）
/daemon off
/daemon on
/daemon status

# 方法 3：臨時 env var（不寫 config，適合 CI）
MY_AGENT_NO_DAEMON_AUTOSTART=1 my-agent
```

---

## CLI 指令

| 指令 | 功能 |
|---|---|
| `my-agent daemon start [--port N] [--host H]` | 啟動 daemon（foreground）。Ctrl+C 停止。預設 port 由 OS 指派、host `127.0.0.1`（loopback only）。 |
| `my-agent daemon stop [--graceful-ms N]` | 停止執行中 daemon：SIGTERM → 等 graceful → SIGKILL。 |
| `my-agent daemon status` | 顯示 pid / port / agentVersion / uptime / lastHeartbeat。 |
| `my-agent daemon restart [--port N] [--host H]` | stop 再 start。 |
| `my-agent daemon logs [-f]` | 印 daemon.log（JSON 行）；`-f` 類似 tail -f。 |
| `my-agent daemon autostart on\|off\|status` | 切換「REPL 首次開啟時自動啟動 daemon」的行為（持久化到 config）。 |

所有子命令吃 `CLAUDE_CONFIG_DIR` env var（預設 `~/.my-agent/`）來決定
pid.json / daemon.token / daemon.log 的位置。

---

## REPL 狀態列 Badge

```
daemon: attached :52371   ← 綠：WS connected + session 活躍
daemon: reconnecting      ← 黃：socket 斷線，嘗試重連中（最長 30s）
daemon: standalone        ← 暗：daemon 不存在或已死，REPL 走本地模式
```

切換是自動的：

- **Standalone → Attached**：使用者在另一個終端 `my-agent daemon start`，
  下次 2s poll 抓到 pid.json 就會 connect；UI 插 info 訊息告知。
- **Attached → Reconnecting → Standalone**：daemon 被 kill / stop，socket close
  觸發 reconnecting；30s 內重新連上則回 attached，否則切 standalone（UI 插
  warning 訊息；未回的 turn 需使用者自己重送）。

---

## Tool Permission 流程（attached 模式）

Daemon 跑 tool 時若需要使用者同意，會把 permissionRequest 送到**當下 turn 的
發起 client**（source client）；其他 attached client 收到 informational
`permissionPending` 訊息。

Source client 的 REPL 會看到類似：

```
⚠ Daemon 正在要求 WRITE 權限：Edit file (/tmp/foo.txt)
輸入 /allow 同意、/deny 拒絕（toolUseID=a1b2c3d4…）
```

其他 attached client 看到：

```
ℹ 另一個 client（abcd…）正在被詢問 Edit 權限（Edit file）
```

使用 `/allow` 或 `/deny`（slash command）回應；daemon 收到後 tool 繼續執行
或 deny。Timeout 預設 **5 分鐘**，逾時 **自動 allow**（保持原本 CLI 預設行為）。

---

## Session Continuity / JSONL

每次 `daemon start` 都會 regenerate 一個新的 sessionId，寫到
`<projectDir>/<sessionId>.jsonl`（跟 print / REPL 的 session 檔在同一個地方）。
可以用 `my-agent` 另一個視窗的 `/resume` 找回 daemon 跑過的 session。

**注意**：daemon 模式的 session.jsonl 仍由既有 `recordTranscript()` 寫入
（`src/utils/sessionStorage.ts` 的 `Project` singleton），不重複實作避免跟
pending queue / reAppendSessionMetadata 爭 race。

每個 project dir 在 daemon 啟動時會加上 `.daemon.lock` 檔案獨占，避免同個
cwd 被兩個 daemon 誤啟用（pidfile 只管 per-user）。

---

## Cron Scheduler 行為

Cron（`~/.my-agent/scheduled_tasks.json`）由 daemon **獨占跑**：

- daemon alive：daemon 每秒 tick scheduler；到時間 fire → 塞 background
  intent 到 InputQueue（FIFO，不打斷 interactive turn）。所有 attached
  client 看得到 cron 產生的 turn（同步廣播）。
- daemon dead：REPL (`useScheduledTasks`) 和 headless (`./cli -p`) 的 cron
  都會 `isDaemonAliveSync()` 探測後跳過 — 使用者自己啟 daemon 才會有 cron。
  避免雙跑。

---

## 多 Client 廣播語意

Daemon 把這些事件廣播給**所有** attached client：

- `hello`（單點；剛 attach 時送）
- `state`（IDLE / RUNNING / INTERRUPTING）
- `turnStart` / `turnEnd`
- `runnerEvent`（含 SDKMessage：assistant、user tool_result、system、result）
- `permissionPending`（非 source client）

只點對點送給 source client 的：

- `permissionRequest`

---

## Input Intent（混合策略）

WS inbound frame `{type:'input', text, intent?}` 的 `intent` 三選一：

- `interactive`（預設，source=`repl`/`discord`）：若 daemon 正在跑 turn，
  **打斷**當前 turn、換跑這個。
- `background`（source=`cron`/其他）：**排 FIFO** 在 pending 尾端；等當前 turn
  結束才跑。
- `slash`（source=`slash`）：**排優先權** pending 頭；下個空檔立即執行。

InputQueue（`src/daemon/inputQueue.ts`）狀態機 IDLE ↔ RUNNING ↔ INTERRUPTING，
interrupt grace 3s 逾時 force-clear（防 runner 卡死）。

---

## 故障排除

### daemon 不啟動：`already running`
- 先 `my-agent daemon status` 看是否真有活 daemon。
- 若 pid.json 顯示 stale（heartbeat 超過 30s），下次 `daemon start` 會自動
  take-over。
- 強制清：刪掉 `~/.my-agent/daemon.pid.json` + `~/.my-agent/<projectDir>/.daemon.lock`。

### REPL badge 卡在 `reconnecting`
- WS 連 daemon 失敗但 pidfile 還在；daemon 程序可能 hang。
- 另一個視窗 `my-agent daemon stop` 或 `kill -9 <pid>`。

### 訊息只在某一邊顯示
- 檢查 badge：若有一邊 `standalone`，那邊沒連上 daemon。
- Token 不一致（手動複製 config dir 時會發生）：`daemon stop` + 重啟。

### cron 沒觸發
- Daemon 必須 alive（`daemon status` 確認）。
- Feature flag：確認 `AGENT_TRIGGERS` 和 `isKairosCronEnabled()` 都 true
  （見 `src/tools/ScheduleCronTool/prompt.ts`）。
- `scheduled_tasks.json` 檢查 cron 格式是否正確。

---

## 限制 / 未覆蓋

- **Tool result 細粒度 UI**（M-DAEMON-7 後續）：目前 thin-client 只 render
  assistant messages；tool_result 的進度條 / 結果折疊 UI 尚未完整。
- **In-flight turn 重跑**：Q3=a spec 允許「daemon 掛掉 → standalone 自動重跑
  未完 turn」，目前只插 system banner 告知使用者手動重送。
- **Slash command in attached mode**：attached 時 REPL 的 `/command` 仍走
  本地；daemon 端沒 slash 處理。
- **Discord fallback**：`PermissionFallbackHandler` interface 預留但未接
  （M-DISCORD 才會實作把 permission prompt 送到 Discord DM）。
- **Windows signal**：SIGBREAK 已註冊，但某些場景可能需要直接 SIGKILL（pipe
  層可能擋 SIGTERM）。
