# 設定檔參考

my-agent 所有主要設定檔從 2026-04-25 起採用 **JSONC** 格式（JSON with
Comments — 支援 `//` 與 `/* */` 註解、尾部逗號），每個欄位都有內嵌繁體
中文 `//` 註解。本文件是「哪些檔案存在、做什麼用、何時會被寫入」的高
階對照；具體欄位說明以**每個檔案自身的 JSONC 註解**為 source of truth。

## 檔案清單

### 全域（`~/.my-agent/` 下）

| 檔案 | 用途 | 首次 seed | my-agent 寫回頻率 | bundled 模板 |
|---|---|---|---|---|
| `.my-agent.json` | 全域設定（100+ 欄位，含 projects / skillUsage / 功能開關） | ❌ 由 `saveGlobalConfig` 首次寫入；或手動觸發 `/config-rewrite-with-docs` | **每 turn 寫**（stats / `numStartups` / `projects[cwd].last*`） | [`src/globalConfig/bundledTemplate.ts`](../src/globalConfig/bundledTemplate.ts) |
| `llamacpp.json` | 本地 llama.cpp server 設定（TS + shell 共用） | ✅ `src/llamacppConfig/seed.ts` 自動 | 幾乎不寫回（使用者手編） | [`src/llamacppConfig/bundledTemplate.ts`](../src/llamacppConfig/bundledTemplate.ts) |
| `discord.json` | Discord gateway 設定 | ✅ `src/discordConfig/seed.ts` 自動 | 低頻（`/discord-bind` / 白名單變更） | [`src/discordConfig/bundledTemplate.ts`](../src/discordConfig/bundledTemplate.ts) |

### 專案層（`<project>/.my-agent/` 下）

| 檔案 | 用途 | 首次建立 | my-agent 寫回頻率 | bundled 模板 |
|---|---|---|---|---|
| `scheduled_tasks.json` | Cron 任務清單 | 第一次 `CronCreate` 時建立 | cron fire 後 batched 寫 `lastFiredAt` / `lastStatus` | [`src/utils/bundledCronTasksTemplate.ts`](../src/utils/bundledCronTasksTemplate.ts) |

## JSONC 寫回保留註解的實作

核心 helper：[`src/utils/jsoncStore.ts`](../src/utils/jsoncStore.ts)

寫入流程（用於 `.my-agent.json` / `discord.json` / `scheduled_tasks.json`
的寫回路徑）：

1. 讀原檔文字 `originalText`
2. 偵測是否為 JSONC（`//` 或 `/* */` 出現）
3. `parseJsonc(originalText)` 得 `currentObj`
4. 呼叫 updater → `newObj`
5. `diffPaths(currentObj, newObj)` 找所有變更路徑（最細粒度，如
   `['projects', 'C:/...', 'lastCost']`）
6. 對每個路徑呼叫 `jsonc.modify(text, path, value)` 累積 Edit[]
7. `jsonc.applyEdits(text, edits)` 得新文字
8. Atomic write（tempfile + rename）

效果：使用者在 `.my-agent.json` 裡加的 `// 這個設定我改過` 註解，即使
my-agent 每 turn 寫入 `lastCost` / `numStartups` 也不會被洗掉。

## 手動操作

### 取得帶繁中註解的版本

```
/config-rewrite-with-docs
```

會重寫 4 個設定檔為最新 bundled 模板（保留既有值）、自動備份原檔為
`*.pre-rewrite-<timestamp>`。

### 檢視某個欄位的說明

直接開檔看即可 — 每個欄位上方的 `//` 行就是說明。

例如 `~/.my-agent/.my-agent.json`：

```jsonc
{
  // ═══ §4 核心功能開關（最常手動編輯） ═══

  // 詳細 log 模式。true 時印更多 diagnostic；預設 false 避免 terminal 刷屏。
  "verbose": false,
  ...
}
```

### 若檔案壞了

每次 `saveGlobalConfig` 寫入前會先備份到 `~/.my-agent/backups/`（保留
最近 5 份）。llamacpp / discord / cron 壞檔會 warn 並走內建預設，不 crash。

## 現有 README sidecar

以下兩個 `*.README.md` 從更早版本就存在，保留為「跨檔 / 流程 / 安全」
等深度資訊（欄位細節已搬進 JSON 檔內部）：

- [`~/.my-agent/llamacpp.README.md`](../src/llamacppConfig/seed.ts) — env var 覆蓋表、shell 端共用
- [`~/.my-agent/discord.README.md`](../src/discordConfig/seed.ts) — 啟動流程 8 步、安全提醒、路由規則

## 相關 ADR

- ADR-003：my-agent 不使用 feature flag — 所有功能直接啟用
- ADR-008：29 段 system prompt 外部化至 `~/.my-agent/system-prompt/*.md`
- ADR-010：llamacpp 設定統一到 `llamacpp.json`（本檔 JSONC 化後不變）
- ADR-012：Daemon 模式 — 影響 `daemonAutoStart` 欄位
- ADR-013：Discord gateway — 影響 `discord.json` 整組欄位
- M-CONFIG-JSONC：本次 milestone（`~/.my-agent/` 四個設定檔全面 JSONC 化 + 繁中註解）

---

## Claude Code 整合（`.claude/settings.json`）

> 從 CLAUDE.md 拆出。這是 Claude Code 自身的 hooks / 權限設定，不是 my-agent runtime config。

### Hooks（自動執行）

| Hook | 觸發時機 | 動作 |
|------|---------|------|
| `pre-tool-use-conda.sh` | 任何 Bash/Terminal 指令執行前 | 驗證 `conda activate aiagent` 已啟用，未啟用則阻擋。 |
| `post-tool-use-typecheck.sh` | 任何 .ts/.tsx 檔案被編輯後 | 自動執行 `bun run typecheck`，報告通過/失敗。 |
| `notification-session-end.sh` | Session 結束時 | 將摘要附加到 TODO.md，發送桌面通知。 |

### 權限設定

**已預先核准**（不彈確認）：
- 任何檔案的讀取
- 在 `tests/`、`TODO.md`、`LESSONS.md` 的寫入/編輯
- Shell 指令：conda、bun、git、curl localhost、cat/ls/find/grep/head/tail/wc/echo/mkdir/cp/mv 等

**已封鎖**（會被拒絕）：
- `rm -rf`、`sudo`、`chmod`
- 寫入 `src/QueryEngine.ts`、`src/Tool.ts`、`src/services/tools/StreamingToolExecutor.ts`（核心檔案 — 先問）
- 寫入 `reference/`（唯讀的 Hermes 原始碼）
