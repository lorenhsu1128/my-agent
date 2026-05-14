# SSH 遠端執行模式（方案 B）

> **狀態**：規劃完成，尚未實作。前置需求 M-DAEMON-8 (session resume)。
> **來源**：plan `~/.claude/plans/my-agent-ssh-ssh-woolly-dragon.md`（2026-05-11）。

## Context

讓 my-agent 跑在遠端 SSH host，本地 UX「像 VSCode Remote SSH 一樣」：ssh 過去後所有 agent 操作都在遠端執行（檔案、shell、llama.cpp、tool call 全部遠端視角），本地不需特別設定；網路斷線/關筆電後 session 不中斷，重連可續。

替代方案 A（純 ssh -t dumb terminal）/ C（本地 Ink + 每個 tool RPC 到遠端）已捨棄：
- **A**：不滿足「不用特別設定」+ 斷線重連需配 tmux 體驗差
- **C**：工程量過大（~500-1000 行）且本地是 state 主場違反斷線重連需求，違反 ADR-005 邊界

## 核心架構（VSCode Remote SSH 風格）

```
┌─────────────────────────┐                    ┌─────────────────────────────┐
│ 本地 (Windows/macOS)    │                    │ 遠端 SSH host (Linux + GPU) │
│                         │                    │                             │
│  my-agent --remote host │                    │  my-agent daemon            │
│   │                     │                    │   ├── QueryEngine           │
│   ├── Ink TUI (render)  │                    │   ├── Tools (Bash/Read/...) │
│   └── transport client ─┼──ssh stdio pipe───►│   ├── llama.cpp adapter     │
│         (Duplex stream) │  (走 SSH 22 內)    │   ├── ~/.virtual-assistant-desktop/ (遠端)   │
│                         │                    │   └── stdio transport       │
└─────────────────────────┘                    │       (--stdio --attach)    │
                                               └─────────────────────────────┘
                                                   ↑ 同時保留 127.0.0.1 WS
                                                   ↑ 給遠端本機 web/其他工具
```

**通訊方式**：本地 spawn `ssh user@host my-agent daemon --stdio --attach <sid>` 作為 child process，把 ssh 進程的 stdin/stdout 當成 message stream（取代 WebSocket transport），所有 client↔daemon 訊息在 SSH session 內 multiplex，**遠端零監聽 port**。

### 為什麼 stdio 而非 `ssh -L` port forward

- 不需遠端 `AllowTcpForwarding`（企業 hardening 常關）
- 不需管 random local port / daemon.json 撞 port
- 不擔心 daemon 誤 bind 0.0.0.0 暴露
- 防火牆只要 SSH 22 通；遠端防火牆 inbound 即使完全沒設定也無影響
- 本地與 remote 物理不同 transport（TCP socket vs child process stdio）→ **不可能誤連**
- 跨平台無 port/防火牆煩惱（Windows 本地防火牆軟體不會擋本機 loopback random port）

## 現況可重用（src 唯讀調查確認）

| 項目 | 現況 | 對方案 B 的含意 |
|------|------|----------------|
| Daemon WS protocol | `src/daemon/daemonMain.ts:40-46` 已有完整 WS message framing | 抽象成 transport-agnostic 即可重用全部 message handler |
| 多 client 廣播 | `sessionBroker.ts` 已支援 | 多裝置 attach 同 sessionId 直接可用 |
| Tool 邊界 | Bash/Read/Write/Edit 全在 daemon process 內 | 遠端 daemon 即可承擔，零 local-only 依賴 |
| Config 路徑 | `~/.virtual-assistant-desktop` 走 `homedir()`（`envUtils.ts:12`），無硬編碼 | 遠端 daemon 自然指向遠端 home |
| Session 資料 | JSONL 寫 project dir | 遠端跑就寫遠端 disk |
| REPL attach 路徑 | `src/entrypoints/cli.tsx` 已有 attach daemon 模式 | 加 `--remote` flag 即可分支到 stdio transport |
| ⚠️ Session resume | `sessionBootstrap.ts:26` 註記 M-DAEMON-8 未做 | **前置需求** |

## 改動範圍

新增 / 修改估算（總計 ~400-600 行）：

1. **Transport abstraction**（~80-150 行）
   - 把 daemon 現有 WS server 抽出 `Transport` interface（send/recv message frames）
   - 實作 `StdioTransport`（讀 stdin / 寫 stdout，配合 length-prefixed framing）
   - 實作 `WebSocketTransport`（現有邏輯包裝）
   - daemon 啟動時依 flag 選 transport

2. **`my-agent --remote <ssh-target>` 包裝命令**（~150-200 行）
   - 解析 ssh target（user@host / ssh config alias）
   - 偵測遠端 daemon 是否裝好
   - 不存在 / 版本不符 → bootstrap：上傳對應 OS/arch 的 my-agent binary 到 `~/.virtual-assistant-desktop/server/`
   - spawn `ssh ... my-agent daemon --stdio --attach <sid>` child
   - lifecycle：health check、自動 reconnect、優雅關閉
   - 本地 Ink TUI 改連這條 stdio transport 而非 TCP WS

3. **Daemon hardening**（~30 行）
   - 強制 127.0.0.1 bind（即使 stdio 模式 WS 還在，仍要鎖）
   - `~/.virtual-assistant-desktop/remotes/<host>.json` 寫入：last sessionId / 連線時間（純記錄）

4. **M-DAEMON-8 session resume**（前置）
   - 已在 TODO.md（不算 SSH 規劃的新工作）

5. **跨平台 bootstrap 細節**（~100 行）
   - 本地 Windows + Bun → 遠端 Linux → 需要 `bun build --target=bun-linux-x64` 產 cross-build artifact
   - 上傳途徑：純 ssh stdio pipe（不依賴 scp）
   - Windows 本地 spawn `ssh.exe`（OpenSSH for Windows 內建）

## 子題 B：遠端 daemon binary 部署機制

**選項對照：**

| 選項 | 首次連線體驗 | 維護成本 | 「不用特別設定」程度 |
|---|---|---|---|
| B1. 約定遠端先 `bun install` | 使用者手動 | 低 | ❌ 違反需求 |
| B2. 本地 cross-build single binary + 推送 | 自動，~30-60 秒上傳 ~80MB | 中（要 maintain arch matrix） | ✅ |
| B3. 遠端 `git clone + bun install` | 自動，3-5 分鐘 | 低（自動跟 main） | ⚠️ 需遠端有 bun + git + 網路 |

**推薦：B2（cross-build）為主，B3 為 fallback。** 理由：
- 符合「檔案集中 my-agent 內管理」原則（self-contained）
- VSCode 同款做法（vscode-server 預編譯 + 推送）
- Bun 原生支援 `bun build --compile --target=bun-linux-x64 / bun-linux-arm64 / bun-darwin-arm64`，arch matrix 只需 3-4 個 target
- 加版本對齊：path 為 `~/.virtual-assistant-desktop/server/<my-agent-version>-<git-sha>/my-agent`，版本不符自動重推

**Bootstrap 流程**：
1. `my-agent --remote user@host` 首次跑
2. `ssh host 'cat ~/.virtual-assistant-desktop/server/.version 2>/dev/null'` 偵測
3. 不存在或版本不符 → 本地 `bun build --compile --target=$(detect remote arch via ssh uname)` 產 binary
4. 透過 ssh stdin pipe 上傳：`cat dist/my-agent-server | ssh host 'cat > ~/.virtual-assistant-desktop/server/<v>/my-agent && chmod +x ...'`
5. 寫版本 marker
6. spawn `ssh host my-agent daemon --stdio --attach <sid>`

**Fallback B3**：上傳失敗或目標 arch 沒準備好 cross-build → 提示使用者「降級到 git clone 模式」並引導執行。

## 子題 C + D：cwd / project 識別 + 本地遠端檔案混淆預防

### cwd 識別

**語法**：採 VSCode `code --remote ssh-remote+host /path` 風格：

```
my-agent --remote user@host                # 遠端 $HOME
my-agent --remote user@host:/path/to/proj  # 遠端 /path/to/proj
my-agent --remote user@host --cwd /path    # 另一種寫法
```

**預設行為**：不帶 path → 遠端 `$HOME`（最安全）。**不**用本地 cwd echo 到遠端（本地 path 在遠端可能不存在/語義不同）。

**Project 識別**：sessionId 由 daemon 依 `(host_machine_id, project_path)` 自動產生 key；`~/.virtual-assistant-desktop/remotes/<host>.json` 記錄各 project 的 last sessionId、上次 cwd、上次連線時間。第二次 `my-agent --remote user@host` 預設 attach 同一 sessionId（除非帶 `--new-session`）。

### 檔案混淆預防

daemon 在遠端 → `Read /etc/hosts` 必然讀遠端。混淆來自視覺上看起來像本地 my-agent。對策：

| 機制 | 行為 |
|---|---|
| Prompt indicator | 取代 `my-agent>` 為 `my-agent [user@host:/path]>`，顏色不同（青色 vs 預設白色） |
| TUI 標題列 | 第一行固定顯示 `▶ remote session — user@host:/path/to/proj` |
| 啟動 banner | 連上後印「⚠ 你正在 user@host 操作，所有 Read/Write/Bash 都在該遠端執行」一次 |
| 拒絕「附加本地檔案」 | 不提供 `--attach-local-file` 之類；保持邊界乾淨（屬 C 方案精神，B 不收） |
| 結尾退出提示 | `exit` 時印「remote session 已斷開，daemon 仍在遠端跑（sessionId: ...），下次可 attach」 |

## 子題 A + E：Stdio transport framing + 斷線重連 UX

### Framing 協議

| 方式 | 優 | 劣 |
|---|---|---|
| A1. JSON Lines（每行一個 JSON） | 易調試 / 易實作 | LLM streaming token 含 `\n` 要 escape；大 payload 不友善 |
| A2. Length-prefixed（LSP 風格 `Content-Length: N\r\n\r\n<bytes>`） | 任意 byte / streaming 友善 / 有成熟 parser / VSCode 同心 | 多 4 行 header overhead 可忽略 |
| A3. MessagePack length-prefixed | 較小 payload | 調試難（非文字） |

**推薦：A2（LSP 風格 length-prefixed JSON）**。理由：與 VSCode Remote / LSP / DAP 同款協議、Node 端有 `vscode-jsonrpc` 之類成熟 parser 可參考、debug 時把 frame body dump 出來是純 JSON。

**Backpressure**：stdio pipe 滿時 `write()` 阻塞 → daemon sender 用 Node Writable stream 的 `drain` event；high-water mark 設 1MB；超過時暫停讀 LLM streaming token 直到 drain。client 端對稱處理。

### 斷線重連 UX

**狀態機**：

```
Connected → (ssh child exit) → Reconnecting → (3 次失敗) → Disconnected
                                    ↓ 成功
                                  Connected
```

**重試策略**：指數退避 1s/2s/4s/8s/30s 上限；最多 6 次；每次重試先 quick `ssh host my-agent daemon status` 確認遠端 daemon 還活著（不浪費完整 spawn）。

**TUI 提示**：底部 status bar 顯示 `● Reconnecting to host (attempt 3/6, next in 8s)...` 並鎖輸入；連回來印 `✓ Reconnected, session 234 turn 17 resumed`。

**Fallback 層級**：
1. 網路斷 → 自動重連，session 保留 → 透明（使用者只看到短暫 lag）
2. 遠端 daemon 死了，但 session JSONL 健在 → 詢問「自動重啟 daemon + resume sessionId X？」(yes/no)
3. JSONL 也 corrupt → 提供「以新 session 繼續，舊內容保留為 backup」選項
4. SSH 認證失敗 / host 不可達 → 立即 abort，印明確錯誤

**緩衝期**：client 端把斷線期間使用者打的字暫存（不送出），重連後 prompt「要送出這段嗎？」防誤觸。

## 子題 F + H：Memory / sub-LLM prompt / llama.cpp 跨機同步

### 分類

| Config 類型 | 是否該同步 | 推薦處理 |
|---|---|---|
| `models/`、`llamacpp.jsonc`、`daemon.json` | ❌ 不該（每台機硬體 / runtime 不同） | 純遠端，本地完全不參與 |
| `~/.virtual-assistant-desktop/system-prompt/*.md`、`subllm/*.md`（人格、子 LLM 行為） | ✅ 應該（使用者偏好，跨機共用合理） | 顯式同步指令，**不**自動 |
| `~/.claude/projects/.../memory/MEMORY.md` + 個別 memory files | ⚠️ 視角度 | 每 (host, project) 自成一份；本地不參與遠端 session 的 memory |
| Project 內 CLAUDE.md / TODO.md / docs/ | ✅ 應該 | git 已同步，不需 my-agent 介入 |

### 推薦策略

**llama.cpp**：完全遠端優先，本地不碰。`my-agent --remote` 啟動時直接用遠端 `~/.virtual-assistant-desktop/llamacpp.jsonc`。

**System-prompt / sub-LLM overrides**：
- 預設不同步（避免雙向修改衝突）
- 提供 `my-agent --remote host --sync-prompts` 一次性指令：純 ssh stdio + tar pipe 推送（避免要求遠端裝 rsync）
- 反向：`--pull-prompts` 把遠端拉回本地
- 衝突檢測：兩端 `.last-sync.json` 比 mtime，不一致時印 diff + 詢問方向

**Auto memory**：
- 採「每 (host, project) 自成一份」原則
- 遠端 daemon 寫遠端的 `~/.claude/projects/<encoded-cwd>/memory/`
- 本地與遠端的不共用
- 理由：memory 是「給未來 session 的 hint」，跟 (host, project) 強綁；同一 project 在不同 host 上工作，常有 host-specific 細節（如「這台是 RTX 5070 12GB」vs「那台是 H100」），不該污染對方
- 提供 `my-agent memory pull-remote host` 手動 merge 工具供使用者需要時用（後續 milestone）

### 例外處理

跨機共用 `feedback_*.md`（如「回覆繁中」這類純偏好）→ 使用者可手動 `--sync-prompts` 帶上 memory 子目錄；或建議把這類純偏好寫進 CLAUDE.md 而非 auto memory（CLAUDE.md 走 git 自然同步）。

## 已捨棄子題

- **G. ControlMaster + Windows**：Windows OpenSSH 對 ControlMaster 支援有限但對本方案不關鍵 — 每個 `--remote` session 一條 SSH 連線即可；多 channel 共用是效能優化，不是正確性需求。Linux/macOS 自動享受，Windows 退化到 per-session 一條連線。不阻塞 MVP。
- **I. Multi-tenant auth**：stdio transport 走 ssh session，已是 per-user auth；同 host 多使用者各自 daemon process（用 user home 自然隔離）。127.0.0.1 WS 那邊強制 bind localhost + 同機 user 隔離由 OS file permission 守（`~/.virtual-assistant-desktop/daemon.json` chmod 600）。不需額外應用層 token。

## 不在範圍

- 本地剪貼簿 / 桌寵 / 本地檔案的雙邊融合（屬 C 方案精神）
- 多遠端 host 同時切換的高級 UI
- Web 模式跨 SSH 暴露（如要：另開 `ssh -L 9090:127.0.0.1:9090` 即可，不需特別設計）

## 後續驗證步驟（落地時）

1. **stdio transport unit test**：daemon 跑在子進程，本地 client 透過 stdin/stdout 完成一輪 turn，驗證 framing/back-pressure。
2. **手動 SSH 驗證**：遠端先裝好 daemon → 本地 `ssh user@host my-agent daemon --stdio --attach <sid>` 手動跑通 → 確認 turn event 流回本地 stdout。
3. **包裝命令**：寫 `my-agent --remote <ssh-target>`，測首次 bootstrap（自動部署 daemon 二進位到 `~/.virtual-assistant-desktop/server/`）。
4. **斷線重連**：完成 M-DAEMON-8 → 驗證「中途 kill ssh child → 自動 reconnect → 接回同 sessionId 不丟 turn」。
5. **Hardening 驗證**：嘗試把 daemon config 改成 `bind 0.0.0.0` 應該被 code 拒絕；stdio 模式啟動時 `netstat` 確認遠端零監聽 port。
6. **跨平台冒煙**：Windows (本地, OpenSSH client) → Linux (遠端 GPU host)；macOS (本地) → Linux 各跑一輪。
7. **ControlMaster**（Linux/macOS 本地）：本地 `~/.ssh/config` 設 `ControlMaster auto` 後開兩個 `--remote` 視窗，確認共用單一 SSH 連線。

## 關鍵檔案（落地時會碰到的）

- `src/daemon/daemonMain.ts` — daemon entry / WS server，要抽出 Transport interface
- `src/daemon/sessionBroker.ts` — 多 client 廣播（不需改，驗證即可）
- `src/daemon/sessionBootstrap.ts:26` — resume gap 註記處（M-DAEMON-8）
- `src/entrypoints/cli.tsx` — 加 `--remote` flag 與 stdio transport attach 路徑
- `src/utils/envUtils.ts:12` — config home 解析（驗證遠端正確指向遠端 home）
- 新增：`src/services/transport/{Transport,StdioTransport,WebSocketTransport}.ts`
- 新增：`src/remote/{sshClient,bootstrap,binaryDeploy}.ts`
- 新增：`scripts/build-server-binaries.sh`（cross-build matrix）
