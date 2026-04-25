# M-SSH-REMOTE：透過 SSH 在遠端主機掛載專案目錄

## Context

目前 my-agent 啟動時只能掛載**本地** cwd 作為專案目錄，所有檔案讀寫 / Bash 執行 / cron / Discord 都跑在啟動 my-agent 的那台機器。使用者想要能對「遠端 server 上的專案目錄」操作 — 包含跨平台（Win/Mac/Linux 客戶端），模型放在另一台遠端主機。

關鍵限制：跨平台、不能只考慮 Windows。

## 已評估但放棄的方案

| 方案 | 放棄原因 |
|------|---------|
| **A. SSHFS / WinFsp+sshfs OS 掛載** | Windows 端要 WinFsp 體驗差；Bash 還是跑本機（編譯/測試在錯機器），對「遠端開發」場景幾乎無用 |
| **C. VFS 抽象 + Bash SSH proxy** | `FsOperations` 抽象只覆蓋一半（BashTool 直接用 `node:fs` + `child_process.spawn`），spawn / pipe / 互動式 shell / 環境變數要全部重做；跟 M-DAEMON「daemon 是真實工作者」哲學衝突 |

## 推薦方案：B — 遠端 daemon + 本地 thin-client（沿用 M-DAEMON 架構）

核心想法：**沒有「遠端掛載」這回事，而是 daemon 本身搬到遠端**。本地 REPL 已經是 thin client（M-DAEMON 完成），只需要：
1. daemon WS server 從 loopback only 改成可選擇 bind 任意介面 + 真實 token auth
2. 本地 REPL 加一個 `--remote ssh://user@host:cwd` 啟動參數，自動建 SSH local-port-forward + attach
3. 遠端 daemon 的 model 設定指向「第三台模型主機」（已有 `LLAMACPP_BASE_URL` 支援，ADR-010）

這樣 Bash / 檔案 / cron / Discord / skills 全部在遠端 server 上跑，本地只負責畫 UI 與輸入。跨平台 by design（bun runtime 在三平台都有）。

## 架構圖

```
┌──────────────┐       SSH local forward            ┌──────────────────┐
│ Local REPL   │  127.0.0.1:RANDOM ──tunnel──>      │  Remote server   │
│ (Win/Mac/    │       :daemon_port (loopback)      │  daemon @ cwd    │
│  Linux)      │                                    │  cron / Discord  │
└──────────────┘                                    └────────┬─────────┘
                                                             │ HTTP
                                                             ▼
                                                    ┌──────────────────┐
                                                    │ Model host       │
                                                    │ llama.cpp :8080  │
                                                    └──────────────────┘
```

## 變更範圍

### 新模組

- **`src/repl/remoteAttach/`**
  - `sshTunnel.ts` — 用 OpenSSH client（系統 ssh，不引 npm 套件）建 local port forward；child_process spawn `ssh -L 127.0.0.1:0:127.0.0.1:<remotePort> -N user@host`，從 stderr 解出本地 port
  - `remoteSpec.ts` — 解析 `ssh://user@host[:port]/path/to/project` URL；支援 `~/.ssh/config` 別名（直接 `ssh host` 而非 `ssh user@host:port`）
  - `remoteHandshake.ts` — tunnel 起來後對 `127.0.0.1:<localPort>/daemon/info` 取 daemon 資訊（cwd / projectId / token），確認 cwd 對得上 spec 內的 path
  - `remoteCli.ts` — `my-agent --remote <spec>` 入口：起 tunnel → handshake → 走既有 `useDaemonMode` thin-client 流程

- **`src/daemon/networkBinding.ts`**（拆既有 `directConnectServer.ts`）
  - 新增 `--bind` 參數：`loopback`（預設，現況）/ `localhost-only-with-token`（仍 127.0.0.1 但強制非空 token，給 SSH tunnel 用）/ `interface:<addr>`（顯式指定 bind，警告風險）
  - **不允許** `0.0.0.0` 不帶 token；token < 32 char 拒絕啟動
  - 新增 `daemon/info` HTTP endpoint（GET，需 token）：回 `{cwd, projectId, version}` 給 client 確認

### 改造既有

- **`src/daemon/daemonCli.ts`** — `daemon start` 新增旗標：`--bind`、`--token`（未指定則沿用 `pid.json` 隨機 token）、`--remote-allow`（明確 opt-in 才允許非 loopback bind）
- **`src/repl/thinClient/thinClientSocket.ts`** — 連線目標從硬編 `127.0.0.1` 改成可注入 host:port，token 從 spec / pid.json 兩來源取
- **`src/screens/REPL.tsx`** + `src/hooks/useDaemonMode.ts` — status bar 加 `🌐 remote: user@host` badge，連線斷開時 fallback 處理改為：remote 模式不嘗試 standalone，僅 reconnect 或退出（remote 場景沒有「降級到本機」的合理意義）
- **`src/main.tsx`** — 加 `--remote` CLI flag 解析；遠端模式時跳過本機 daemon 偵測 / 啟動，直接走 remote attach 路徑

### 不動的部分

- `QueryEngine.ts` / `StreamingToolExecutor.ts`（deny list 內，本來就不該動）
- 所有 41 個 tools（FileRead / Bash / etc.）— daemon 在遠端跑，tool 視角看到的是遠端本地 fs，無感
- Cron scheduler / Discord gateway — 跟著 daemon 走在遠端，無需改造
- Session JSONL 寫在**遠端** `~/.my-agent/projects/<slug>/`（在 daemon 主機，符合既有設計；本地 thin-client 不存歷史 — 可改 follow-up）

## 安全模型

- 預設仍 loopback only；遠端 bind 必須 **顯式 opt-in**（`--remote-allow` flag），且 token 強制 ≥ 32 char
- SSH tunnel = 雙向加密信道；daemon 本身仍 bind 127.0.0.1（在遠端 host 看），對外不開埠 — 攻擊面只有 SSH 本身
- Token 透過 `daemon/info` endpoint 取（用 ssh 已知主機的安全通道一次性派發），不必額外存於本機
- Bash tool 的 deny list（`rm -rf` / `sudo` 等）跟著 daemon 在遠端 enforce，行為一致

## 關鍵檔案

修改：
- `src/daemon/daemonCli.ts`
- `src/daemon/directConnectServer.ts`
- `src/repl/thinClient/thinClientSocket.ts`
- `src/repl/thinClient/fallbackManager.ts`
- `src/screens/REPL.tsx`
- `src/hooks/useDaemonMode.ts`
- `src/main.tsx`

新增：
- `src/repl/remoteAttach/{sshTunnel,remoteSpec,remoteHandshake,remoteCli}.ts`
- `src/daemon/networkBinding.ts`
- `docs/ssh-remote-mode.md`

參考既有可重用：
- `src/daemon/directConnectServer.ts` — WS server bind 邏輯
- `src/repl/thinClient/` 整套 — handshake / reconnect / frame 處理已寫好
- `src/llamacppConfig/` — model 指向遠端主機已支援，免改

## 遠端安裝

遠端機器最小需求：
1. `bun` ≥ 1.x（curl 一行裝）
2. `git clone` my-agent + `bun install` + `bun run build:dev`
3. `~/.my-agent/llamacpp.json` 設 `baseUrl` 指向第三台 model host
4. 啟動：`my-agent daemon start --bind localhost-only-with-token --remote-allow`

### 自動化安裝腳本（納入本 milestone）

新增三檔，三平台 first-class：

- **`scripts/install-remote.sh`**（Linux / macOS / WSL，POSIX bash）
  1. 偵測平台 + arch（uname -sm），決定 bun installer URL
  2. 若無 bun：`curl -fsSL https://bun.sh/install | bash` 並 source 新 PATH
  3. `git clone <my-agent repo> ~/my-agent`（已存在則 `git pull`）
  4. `cd ~/my-agent && bun install && bun run build:dev`
  5. 互動詢問或讀 flags：`--model-host=<url>` / `--token=<token>`（預設 openssl 隨機 48 char）
  6. 寫 `~/.my-agent/llamacpp.json`（沿用 `seed.ts` 邏輯，覆寫 baseUrl）
  7. 寫 daemon systemd unit（Linux）或 launchd plist（macOS）— optional flag `--install-service`
  8. echo 出 `my-agent --remote ssh://<this-host>/<cwd>` 範例供本地 client 使用

- **`scripts/install-remote.ps1`**（Windows server，PowerShell ≥ 5.1）
  1. 偵測 arch（`$env:PROCESSOR_ARCHITECTURE`）
  2. 若無 bun：`irm bun.sh/install.ps1 | iex`
  3. `git clone` / `git pull`，同上
  4. `bun install && bun run build:dev`
  5. 同上的設定寫入（PowerShell JSON cmdlet）
  6. optional `--InstallService` → 註冊 NSSM 或 Windows Scheduled Task（NSSM 需另裝，預設用 Task Scheduler）

- **`scripts/install-remote-bootstrap.sh`**（一行安裝器，給 docs 引用）
  ```bash
  curl -fsSL https://raw.githubusercontent.com/<repo>/main/scripts/install-remote.sh | bash -s -- --model-host=http://modelhost:8080
  ```
  本檔 = thin wrapper：偵測 OS → 下載對應 installer → 執行

跨平台一致性：
- 三腳本接受同樣的 flag 命名（`--model-host` / `--token` / `--install-service` / `--repo-url`）
- 都產生同樣的 `~/.my-agent/llamacpp.json` schema
- 都印出同樣格式的「下一步」訊息（本地 client 該打的指令）

驗證腳本本身：
- `tests/integration/install-remote/` — Docker container 跑 Linux installer dry-run（驗證 idempotent + 不破壞既有 install）
- macOS / Windows installer 列為手動驗證項（CI 不跑）

## 使用者操作流程

### Phase 0：一次性遠端準備（每台 server 跑一次）

使用者在**遠端 server**（假設 IP `10.0.0.5`，user `loren`）登入後執行：

```bash
ssh loren@10.0.0.5
# 一行安裝（會問 model host）
curl -fsSL https://<repo>/scripts/install-remote-bootstrap.sh | bash -s -- \
    --model-host=http://10.0.0.6:8080 \
    --install-service
```

腳本完成後印出：

```
✓ my-agent installed at /home/loren/my-agent
✓ Daemon service registered (systemd: my-agent-daemon.service)
✓ Token written to ~/.my-agent/daemon-token (chmod 600)

Next step on your local machine:
    my-agent --remote ssh://loren@10.0.0.5/path/to/your/project
```

使用者退出 SSH。之後 daemon 由 systemd 自動跑；token 留在遠端家目錄。

### Phase 1：本機日常使用

**情境 A — 首次連某個遠端專案**

本機（Mac / Win / Linux 任一）：

```bash
my-agent --remote ssh://loren@10.0.0.5/home/loren/work/myapp
```

背後流程（使用者看到的 UI）：

1. `🔌 Establishing SSH tunnel to loren@10.0.0.5...`（spawn 系統 ssh，~1s）
2. `🔑 Fetching daemon token via ssh exec...`（一次性 `ssh loren@10.0.0.5 cat ~/.my-agent/daemon-token`）
3. `🤝 Handshake with remote daemon (cwd=/home/loren/work/myapp)...`
4. 進入熟悉的 REPL 畫面，狀態列顯示 `🌐 remote: loren@10.0.0.5  📁 myapp  🟢 daemon`

之後互動跟本機完全一樣 — 打字、跑 slash command、tool calls、permission prompts 都正常出現在本機 UI，但**實際執行在遠端**。

**情境 B — 連同一台但別的專案**

```bash
my-agent --remote ssh://loren@10.0.0.5/home/loren/work/anotherapp
```

Daemon 已在跑（lazy load 第二個 ProjectRuntime，沿用 M-DISCORD 的 multi-project 機制）。Tunnel 重用 / 新建一條都行。

**情境 C — 用 SSH config 別名**

`~/.ssh/config`：
```
Host work-server
    HostName 10.0.0.5
    User loren
```

本機：
```bash
my-agent --remote ssh://work-server/home/loren/work/myapp
```

走系統 ssh 自動讀 config，jump host / key / port 都繼承。

**情境 D — 純本機（既有行為，無變化）**

```bash
my-agent          # 跟現在完全一樣，本機 daemon 自動偵測 / 啟動
```

### Phase 2：斷線情境

- **網路抖動**：UI 顯示 `🌐 remote: loren@10.0.0.5  🟡 reconnecting...`，背景重建 tunnel + WS（最多 30s 重試三次）
- **遠端 daemon crash**：systemd 自動重啟 daemon；client 重 attach 後續用同 session
- **完全斷線**：`❌ Lost connection to remote daemon. Exit? [y/N]`（不 fallback standalone — remote 場景沒有合理降級）

### Phase 3：管理操作

| 動作 | 指令 |
|------|------|
| 看遠端 daemon 狀態 | `my-agent --remote ssh://host/path daemon status` |
| 停遠端 daemon | `ssh host systemctl --user stop my-agent-daemon`（或本機 `... daemon stop`） |
| 看遠端 session 歷史 | 暫時要 ssh 進去看（本機歷史鏡像列為 follow-up） |
| 升級遠端 my-agent | `ssh host 'cd ~/my-agent && git pull && bun install && bun run build:dev && systemctl --user restart my-agent-daemon'` — 之後可包成 `my-agent --remote ... upgrade` 子命令（follow-up） |

### 心智模型

「`--remote` 旗標 = 把整個 my-agent runtime 搬去那台機器跑，本機只是螢幕」。所有專案檔案、Bash 執行、cron、Discord、模型呼叫都發生在遠端；本機 ↔ 遠端只走兩條東西：**鍵盤輸入** 與 **UI 畫面更新**（皆 over SSH-encrypted WS）。

## 驗證

1. **本機 round-trip**：在本機跑兩個 cwd，daemon 起 `--bind localhost-only-with-token`，`my-agent --remote ssh://localhost/path/A` 與 `/path/B` 各 attach 一個 REPL，確認 turn / Discord / cron 正確分流
2. **跨機器**：本機 Win → 遠端 Linux server，`my-agent --remote ssh://user@server/home/user/proj`，跑 `Bash: pwd` 應回遠端路徑、`FileRead README.md` 應讀到遠端檔案
3. **模型在第三台**：遠端 daemon 的 `LLAMACPP_BASE_URL` 指 model host，turn 應能完成（驗證 model tunnel 不必額外建）
4. **斷線恢復**：手動 kill SSH process，REPL 應顯示 reconnecting 並在 tunnel 重建後自動 reattach
5. **安全 negative test**：daemon 沒帶 `--remote-allow` 時 `--bind localhost-only-with-token` 應拒絕；token < 32 char 應拒絕
6. **既有功能不退化**：`./cli` 直接跑（不帶 `--remote`）行為完全不變；既有 268 integration tests 全綠 + typecheck baseline 不變

## 不在範圍

- 多 hop SSH（jump host）— 使用者可自己在 `~/.ssh/config` 設 ProxyJump
- 本地 ↔ 遠端檔案鏡像 / 同步
- Session 歷史鏡像到本機
- VFS 抽象重構（C 方案，明確不做）

## 延伸思考（不做但記下）

- 若未來想要「daemon 在本地 / fs 在遠端」的混合模式，那才會用到 C 方案的 VFS 重構 — 留給未來真有需求時再評估
- Discord gateway 跟著 daemon 跑遠端時，bot 連線從遠端 server 出 — 注意防火牆 outbound 443 可能要開
