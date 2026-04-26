# E2E 測試套件指南

> 對應 `tests/e2e/decouple-comprehensive.sh`（M-DECOUPLE-1..3 系列累積）。
> 對象：**開發者**。使用者用不到本檔。

`tests/e2e/decouple-comprehensive.sh` 是 my-agent 唯一的 full-stack E2E 套件，
跑完整 build + CLI + daemon + cron + memory + Discord + PTY REPL 一條龍驗證。
從 commit `9b1c62d`（M-DECOUPLE-2 雛型 39 cases）成長到現在 **53 cases**
（M-DECOUPLE-3 完整版），涵蓋 10 個 sections（A–J）。

---

## 快速使用

```bash
# 前置：conda activate aiagent + llama.cpp server 啟動 (port 8080)
conda activate aiagent
bash scripts/llama/serve.sh &    # 若還沒跑

# 全套件
bash tests/e2e/decouple-comprehensive.sh

# 單一 section（scope 大小寫不敏感）
bash tests/e2e/decouple-comprehensive.sh A     # 只 static checks
bash tests/e2e/decouple-comprehensive.sh E     # 只 daemon lifecycle
bash tests/e2e/decouple-comprehensive.sh J     # 只 PTY interactive REPL

# 多 section（逗號分隔）
bash tests/e2e/decouple-comprehensive.sh A,B,D

# 別名（每個 section 都有 lower-case alias）
bash tests/e2e/decouple-comprehensive.sh cron      # = F
bash tests/e2e/decouple-comprehensive.sh discord   # = I
bash tests/e2e/decouple-comprehensive.sh pty       # = J
```

報告檔自動寫到 `tests/e2e/decouple-comprehensive-YYYYMMDD-HHMMSS.txt`。

Exit code：
- `0` — 全綠
- `1` — 任何測試 fail
- `2` — 環境問題（llama.cpp 不可達 / 找不到 binary 等）

---

## Section 概覽

| Section | Cases | 跑時 | 對象 | 必要環境 |
|---|---|---|---|---|
| A. Static checks | 16 | 10s | grep dangling references / 已刪檔不存在 / 不該存在的 deps | 無 |
| B. Typecheck/Build | 2 | ~10s | typecheck baseline + `build:dev` 過 | 無 |
| C. Module imports | 8 | 10s | 動態 import → export shape 正確 / stub 行為 | 無 |
| D. CLI smoke | 6 | ~4m | 一般對話 / Read tool / unset key / fake key / `--version` / SRC mode | llama.cpp + cli-dev binary |
| E. Daemon lifecycle | 7 | ~2m | start / pid.json / print mode while attached / **真 thin-client ping** / **真 turn** / stop / SRC daemon start+stop | llama.cpp + cli-dev |
| F. Cron lifecycle | 7 | ~1m | NL parser + 寫 task + daemon 起 + 等 fire（90s 內）+ stop，**BIN 跟 SRC 各跑一輪** | llama.cpp + cli-dev |
| G. Memory recall | 3 | ~1m | memdir 存在 / `findRelevantMemories` 走 llama.cpp / unset key 不 401 | llama.cpp + cli-dev |
| H. Auto mode | 1 | 2s | `yoloClassifier` 不 401 | llama.cpp |
| I. Discord gateway | 3 | ~16s | 模組 load / 單元測試 pass / **真起 daemon 連 Discord 看 `discord ready` log** | llama.cpp + cli-dev + （I3）`~/.my-agent/discord.jsonc` 含 `enabled:true` + `botToken` |
| J. PTY interactive REPL | 2 | ~45s | `node-pty` spawn cli-dev → ink attach + 真送 prompt → 真收 `\b9\b` | llama.cpp + cli-dev + Node + `node-pty` 已裝 |
| K. Memory TUI (M-MEMTUI) | 8+1skip | ~2min | 模組 load / unit / user-profile kind / PTY 5-tab + ←/→ / mutation paths / alias / delete+restore / standalone fallback；K12 真 broadcast 需 daemon 在跑 | llama.cpp + cli-dev + Node/node-pty（K4+K5）；K12 額外需 daemon |

**總計：61 cases，10–17 分鐘**（D 跟 E 因 LLM 冷啟動各吃 1–2 分鐘是大宗；K 多 ~2min PTY + standalone smoke）。

---

## 細節：每個 section 在驗什麼

### A. Static checks（16）

`grep` 為主，無 runtime。重點：
- 已刪檔（OAuth crypto / Grove / migrateAutoUpdates 等 27 條）不應存在
- 應存在的新檔（`apiBase.ts` / `oauth/types.ts`）有
- GrowthBook flag readers 0 真實 caller（註解不計）
- `getOauthConfig().BASE_API_URL` 等 0 caller（已被 `apiBase.ts` 取代）
- `getClaudeConfigHomeDir` 0 caller（已 rename）
- `PRODUCT_URL` / auto-updater 系列 0 引用
- `package.json` name=`my-agent`、無 `@growthbook/growthbook` dep
- `bridgeMain.ts` 無 `claude.ai/code`、`config.ts` 無 `cachedGrowthBookFeatures` schema、`sideQuery.ts` 無 `getAnthropicClient`
- `Grove.tsx` 已刪、`services/oauth/{client,getOauthProfile}.ts` 已 stub 化（line 數限制）
- `auth.ts` 不 import OAuth refresh

### B. Typecheck / Build（2）

`bun run typecheck` 跟 `bun run build:dev` 各跑一次，回 exit 0 + cli-dev binary 產出。

### C. Module imports（8）

動態 `import('...')` 取模組 → 確認 export shape：
- `apiBase.ts` 6 個 getter + `OAUTH_BETA_HEADER` export
- `oauth/client.ts` 兩個 stub 留著
- `getOauthProfileFromApiKey()` 回 `undefined`
- `isAnthropicAuthEnabled() === false`
- `sideQuery` + `queryHaiku` export 正確
- `teleport` 含 `isPolicyAllowed` stub
- `cronNlParser` / `daemon/projectRegistry` 可載入

### D. CLI smoke（6）— 用 fresh `cli-dev[.exe]`

`pick_bin()` 三層 cascade（Windows `.exe` / macOS / production fallback）。

| Case | 驗 | timeout |
|---|---|---|
| D1 | 算術「2+2 等於幾」回 4 | 60s |
| D2 | 「讀 package.json 然後回 name 欄位的值」（測 Read tool 可用） | 60s |
| D3 | `unset ANTHROPIC_API_KEY` + 算術 → 走 llama.cpp 不 401 | 90s |
| D4 | `ANTHROPIC_API_KEY=fake-test-key` + 對話 → 不撞 Anthropic 401（仍走 llama.cpp） | 30s |
| D5 | `--version` 啟動 < 10s | 10s |
| D6 | SRC mode `bun run dev --version` — `dev.ts` shim 跑 cli.tsx 原始碼 | 90s |

D6 為什麼用 `--version` 而不 LLM 算術：SRC 三層 bun + tsx 全樹 transpile cold
start 需 4 分鐘+，太貴。`--version` 仍 import 整個 module 樹 → dangling import /
feature flag 殘留 / vendored SDK 壞會立刻爆，1 秒內完成。

### E. Daemon lifecycle（7）— `cli-dev` BIN + SRC mode

每個 daemon start/stop 都用 `( $BIN daemon start > log 2>&1 & )` 子 shell + bg
+ redirect 防 pipe hang（直接 `$BIN daemon start | tail` 會掛 — daemon 繼承
stdout 但 tail 等 EOF 永遠不到）。

| Case | 驗 |
|---|---|
| E1 | `daemon start` 寫 `pid.json` |
| E2 | print mode while daemon up — `cli-dev -p` **不**走 thin-client（standalone 直打 llama.cpp），驗的是「daemon 在跑 + standalone print 共存無 race」 |
| E4 | **真 thin-client attach + hello + ack**（M-DECOUPLE-3-3-1）— `_thinClientPing.ts` 直接打 WS、收 hello frame、送 `permissionContextSync`；驗 daemon.log 計數 +1 |
| E5 | **真完整 turn**（M-DECOUPLE-3-3-3）— `_thinClientTurn.ts` 用 `createFallbackManager` 跑 sendInput → turnEnd 抽 `runnerEvent` assistant 文字 |
| E3 | `daemon stop` 清 `pid.json` |
| E6 | SRC `bun run dev daemon start` 寫 `pid.json` |
| E7 | SRC `bun run dev daemon stop` 清 `pid.json` |

E2 之前叫「thin-client attach + turn」是 false-positive — `cli -p` print 模式
對 daemon 只查 `isDaemonAliveSync()` 沒實際 attach。M-DECOUPLE-3-3 把那條補成
E4 + E5。

### F. Cron lifecycle（7）— BIN + SRC 各一輪

抽 `cron_lifecycle()` helper 包 「寫 task → 起 daemon → 等 fire（90s 內）→ stop」
為 3 case 一組。F1-F3 跑 BIN、F4-F6 跑 SRC，外加 F0 NL parser 不 throw（純單元）。

每輪用獨立 task ID（含 `BIN` / `SRC` suffix），驗 `.my-agent/cron/history/{id}.jsonl`
有 entry 或 `scheduled_tasks.jsonc` 的 `lastFiredAt` 已寫。

E section 開頭有 prophylactic 清理 — 讀 `scheduled_tasks.jsonc` filter 砍
`e2etest*` task。歷史教訓：F backup/restore 不夠（pre-existing 污染狀態形成
鏈式累積）。

### G. Memory recall（3）

| Case | 驗 |
|---|---|
| G1 | `~/.my-agent/projects/<slug>/memory` 存在 |
| G2 | `findRelevantMemories` 走 llama.cpp 路徑（M-MEMRECALL-LOCAL）不 throw |
| G3 | `unset ANTHROPIC_API_KEY` + `cli -p "ok"` 不 401 |

### H. Auto mode（1）

`yoloClassifier` 模組可載入 + 跑一次不 401。

### I. Discord gateway（3）

| Case | 驗 |
|---|---|
| I1 | 5 個關鍵 discord 模組可動態 import + helper 不 throw（router / messageAdapter / truncate / channelNaming / discordConfig） |
| I2 | `bun test tests/integration/discord/` 全 pass（155 tests） |
| I3 | discord enabled + token 可解時，daemon start 60s 內 `~/.my-agent/daemon.log` 出現 `discord ready` + `slash commands registered` 雙 marker |

I3 token 不可解 → skip 不算 fail（這台機器可能沒設 bot）。

驗 daemon.log 不驗 stdout 因為 daemon 還在 run 時 stdout pipe 不 flush（OS
buffering）— 詳見 LESSONS.md 對應條目。

### K. Memory TUI（M-MEMTUI）（8 + 1 skip）

| Case | 驗 |
|---|---|
| K1 | `MemoryManager.tsx` + `memoryManagerLogic.ts` 動態 import → `TABS.length === 5` |
| K2 | `bun test` 跑 3 個 unit 檔（`memoryManagerLogic` 27 + `memoryMutations` 9 + `memoryMutationRpc` 10）全綠 |
| K3 | `listAllMemoryEntries()` 結果含 `kind: 'user-profile'`（global USER.md 存在時） |
| K4+K5 | **PTY 互動**：`_memoryTuiInteractive.ts` spawn cli-dev → 送 `/memory<Enter>` → 看到 5 個 tab label + `‹ auto-memory ›` active marker → 送 4 次 `→` → 看到 `‹ daily-log ›` |
| K6-K10 | mutation paths（create / update / rename / delete / injection-warn）— K2 9 cases 程式碼層覆蓋。完整 PTY wizard 互動成本高、邊際 coverage 低，不額外加 case |
| K11 | `/memory-delete` alias 模組可載入（thin wrapper → `MemoryManager(initialMode='multi-delete')`） |
| K9 | `delete` + `restore` round-trip — K2 第 10 個 case（create → delete → trashId → restore） |
| K13 | standalone fallback — daemon 不在時 `cli-dev -p` 仍可用（不退回 401） |
| K12 | （skip 除非 daemon 在跑）`_memoryMutationRpcClient.ts` — 兩個 thin-client attach 同 cwd，A 送 `memory.mutation create` → B 1s 內收 `memory.itemsChanged` broadcast。手動：`cli-dev daemon start` → `bash tests/e2e/decouple-comprehensive.sh K` → 看 K12 PASS |

**為什麼 K2 同時跑 3 個檔**：純函式 + mutations + RPC handler 都是同 milestone 同 owner；若 K2 fail 則 K6-K12 大半都不會綠，集中跑省時。

**K4+K5 PTY 風險**：跟 J section 同模型 — Bun + node-pty + ink alt-screen 撞 ERR_SOCKET_CLOSED，**必須走 `npx tsx`**（Node + tsx）。`/memory` 是 `local-jsx` slash command，PTY ANSI 輸出含 box-drawing + `‹ X ›` Unicode marker，靠 `strip-ansi` 過濾後 grep。

**K12 為什麼預設 skip**：daemon 在 e2e 套件中不 unconditional 啟動（會干擾 E section）。手動驗時先 `daemon start`、跑 K12，再 `daemon stop`。本次 milestone 已實機驗過 `B received memory.itemsChanged broadcast — OK`。

---

### J. PTY interactive REPL（2）

M-DECOUPLE-3-6 補上 (b) 變體 `_thinClientTurn.ts` 缺的最後一哩 — (b) 跳過
React/ink 渲染那層。J 用 `node-pty` 真實 spawn cli-dev[.exe] 起互動 REPL，
**必須走 Node**（`npx tsx`）— Bun + node-pty + ink alt-screen 撞 async
ERR_SOCKET_CLOSED，詳見 LESSONS。

| Case | 驗 |
|---|---|
| J1 | PTY ink + daemon attach（看到 `Daemon 已連線` marker） |
| J2 | PTY ink `<Messages>` 渲染 — 送 `4+5 等於幾` → ANSI strip 後 stdout grep `\b9\b` |

J2 是 ink `<Messages>` 渲染壞會抓到的 P0 bug — typecheck + (b) 都不抓。

---

## 新增 case 的步驟

1. **確定屬於哪個 section** — 純 grep 進 A、模組 load 進 C、需 daemon 進 E、需
   實機外部服務（Discord/cron 真 fire）進 I/F/J、其他 cli 行為進 D
2. **看現有 case** 的 idiom（test_pass / test_fail / test_skip 三 helper）：
   ```bash
   if <condition>; then
     test_pass "X<n> 描述（看到關鍵字 / 計數 +1 / etc）"
   else
     test_fail "X<n> 短 label" "$OUT"
   fi
   ```
3. **每個 LLM-related case** 都要包 `timeout -k 10s N CMD` — 預設 timeout 只送
   SIGTERM，child 不退會 hang。`-k 10s` 是 SIGKILL 後援
4. **如果起 daemon**：用 `( $BIN daemon start > log 2>&1 & )` 子 shell + bg +
   redirect。直接 `$BIN daemon start | tail` 會掛
5. **新加 section** 要加：(a) 在 `scope_includes` 接受 alias、(b) 在腳本頂端
   注解列出、(c) update README/MY-AGENT 的「文件索引」如果是 user-visible 段
6. **如果寫 case 用 LLM**：給 prompt 用獨特的數字（如 `4+5=9`、`6+7=13`），
   避免跟 sessionIndex / startup banner 文字撞 grep

---

## 跨平台

腳本走 bash + Git Bash 在 Windows / macOS / Linux 都能跑。具體跨平台點：

- **`pick_bin()`** 三層 cascade `cli-dev.exe → cli-dev → cli`
- **`timeout -k 10s`** 是 GNU coreutils（Git Bash / macOS via brew 都有）
- **`node-pty`**（J section）prebuilt binary 含 Windows x64 + macOS arm64/x64
- **D6 / E6/E7** 走 `bun run ./scripts/dev.ts` — Bun 在三平台都支援

實機驗證範圍：開發時持有 Windows 機器 = Windows 端驗到。macOS 端腳本 portable
但需有對應 hardware 才能真實機測（M-DECOUPLE-3-6-mac 留 open）。

---

## 常見坑（指 LESSONS.md）

本 milestone 累積的 6 條 E2E 教訓在 [LESSONS.md](../LESSONS.md) 的「E2E 測試套件
（M-DECOUPLE-3）」section：

1. Bun + node-pty + ink alt-screen → async ERR_SOCKET_CLOSED → 改 npx tsx
2. ConPTY spawn 必須吃絕對路徑
3. ink TextInput 把合併寫的 trailing `\r` 當 SSH-coalesced Enter strip 掉
4. `timeout N CMD` 偶發不殺 child → 加 `-k 10s` SIGKILL 後援
5. F section cron e2e task 殘留 → 撞 E5 sendInput 變 P0 false-positive
6. daemon stdout banner 在 daemon 還在 run 時不 flush 到 file

寫新 case 前先翻一下 LESSONS，避免重新踩。

---

## 相關檔案

- `tests/e2e/decouple-comprehensive.sh` — 主腳本（~900 行）
- `tests/e2e/_thinClientPing.ts` — E4 helper（底層 WS smoke）
- `tests/e2e/_thinClientTurn.ts` — E5 helper（用 fallbackManager 跑完整 turn）
- `tests/e2e/_replInteractive.ts` — J helper（PTY 互動 REPL）
- `tests/e2e/_memoryTuiInteractive.ts` — K4+K5 helper（PTY `/memory` 5-tab + ←/→）
- `tests/e2e/_memoryMutationRpcClient.ts` — K12 helper（兩個 thin-client + WS broadcast 驗證）
- `tests/e2e/decouple-comprehensive-*.txt` — 歷次跑的報告檔（gitignored）
- `LESSONS.md` — E2E 踩坑記錄
- `CLAUDE.md` 開發日誌 — M-DECOUPLE-1..3 commit 流水帳
