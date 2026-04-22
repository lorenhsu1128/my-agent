# Session、Memory 與 Trash 管理（M-DELETE）

my-agent 內建三個互動式 REPL slash commands，方便清理歷史 session 與 memory：

| Command | 功能 |
|---------|------|
| `/session-delete` | 選取歷史 session 軟刪除（檔案進 `.trash/`、DB FTS 索引硬刪） |
| `/memory-delete` | 選取 memory 條目軟刪除，或按 `e` 開 `$EDITOR` 直接編輯 |
| `/trash` | 管理垃圾桶：list / restore / empty / prune |

三者皆為 **REPL-only** — Discord 訊息若以這些 command 開頭會被閘門攔下並回覆「僅限 REPL 執行」（ADR-MD-06）。

## 軟刪除模型

刪除不會馬上抹掉檔案：
- **檔案**：搬到 `~/.my-agent/projects/<slug>/.trash/<kind>-<timestamp>-<hex>/payload/`，附 `meta.json` 記錄原始路徑
- **DB 紀錄**（`session-index.db` 的 `sessions` / `messages_fts` / `messages_seen` 三表）：transaction 硬刪
- **MEMORY.md 索引**：對應 auto-memory 條目的索引行以 regex 定位後原子移除

想還原？用 `/trash` 選中後按 `r`。Session 還原後需要重跑 FTS reconciler 才能重新搜到（下次 `/session-search` 會自動觸發，或重啟 REPL）。

## `/session-delete` 用法

```
Session Delete · 42 shown · 3 selected
Range: 1=today 2=week 3=month *0=all*  · Filter: discord_

  [ ] 3h ago  msg= 42 $0.87 implement discord gateway...
  [✓] 19h ago msg=115 $2.10 M-DISCORD 全部落地
▸ [cur]       msg= 12 $0.08 planning /session-delete   ← 當前 session，禁刪
```

| 鍵 | 動作 |
|----|------|
| `↑` `↓` | 移動游標 |
| 空白 | toggle 選取 |
| `a` | 全選（自動跳過 `[cur]`） |
| `n` | 全不選 |
| `1` `2` `3` `0` | 時間範圍：今天 / 本週 / 本月 / 全部 |
| `/` | 進入關鍵字輸入模式（Esc 離開） |
| Enter | 進入二段確認 |
| `y` | 確認執行刪除 |
| Esc | 取消 |

**禁止刪除當前進行中的 session**（picker 顯示 `[cur]` 標記且 space toggle 無效）。

## `/memory-delete` 用法

涵蓋四類：

| kind | 顯示 | 來源 |
|------|------|------|
| `auto-memory` | `[user] user_role — ...` | `~/.my-agent/projects/<slug>/memory/*.md` |
| `project-memory` | `[project] MY-AGENT.md` | 專案根目錄 MY-AGENT.md（my-agent 實際讀的檔；**非** CLAUDE.md） |
| `local-config` | `[local] .my-agent/*.md` | 專案根目錄 `.my-agent/*.md` |
| `daily-log` | `[log] 2026-04-21` | `memory/logs/YYYY/MM/YYYY-MM-DD.md` |

特殊鍵：
- `e` 在游標列 spawn `$EDITOR`（Windows 預設 `notepad`、*nix 預設 `vi`）— 編輯器關閉後 picker 重新整理列表
- Enter 進入二段確認後 `y` 批次軟刪

auto-memory 條目軟刪會**同時**更新 `MEMORY.md` 索引（移除對應行，原子 temp+rename）。其他 kind 只搬檔案，不動索引。

## `/trash` 用法

```
Trash · 15 shown · 2 selected · total 45.2 MB
Filter: (none)

▸ [✓] 2026-04-21 14:30   12.0 MB  [session] a3f2e1...
  [ ] 2026-04-20 09:11    2.0 KB  [memory] user_role.md
  [✓] 2026-04-15 22:44    8.0 MB  [session] 77ab...
```

| 鍵 | 動作 |
|----|------|
| `↑` `↓` / space / a / n / `/` | 同其他 picker |
| `r` | 還原選中（檔案搬回原路徑） |
| `x` | 清空**所有** trash（二段確認） |
| `p` | 進入天數輸入模式 → 輸入 N → Enter → 自動勾選 N 天前所有項 → 按 Enter 再確認刪 |
| Enter | 永久刪除選中項（不可還原） |
| Esc | 離開 picker |

### Session restore 的 FTS 重建

Session 還原後 `.trash/` 裡的 JSONL 搬回原位，但 `session-index.db` 已硬刪該 session 的索引。下一次任何代碼路徑呼叫 `reconcileProjectIndex(cwd)` 會掃 JSONL mtime 補回索引 — 典型觸發點：
- `/session-search` 查詢前會 `await ensureReconciled(projectRoot)`
- REPL 啟動時 `src/setup.ts` 背景 fire-and-forget

實務上重啟 REPL 後 session 就會重新出現在搜尋結果。

## 資料夾結構

```
~/.my-agent/projects/<slug>/
  ├── <sessionId>.jsonl                  # transcript
  ├── <sessionId>/tool-results/...       # 工具結果
  ├── memory/
  │   ├── MEMORY.md                      # auto-memory 索引
  │   ├── <filename>.md                  # 每個 entry
  │   └── logs/YYYY/MM/YYYY-MM-DD.md     # Kairos daily logs
  ├── session-index.db                   # FTS5 SQLite
  └── .trash/
      └── <kind>-<epochMs>-<hex>/
          ├── meta.json                  # { id, kind, originalPath, label, createdAt, sizeBytes }
          └── payload/<原始檔名>
```

## 架構筆記

- **ADR-MD-01** 軟刪 — 檔案進 `.trash/`、DB 硬刪；restore 時還原檔 + reconciler 重建索引
- **ADR-MD-02** Memory 目標 = MY-AGENT.md（非 CLAUDE.md）+ auto-memory + `./.my-agent/*.md` + daily logs；picker 雙鍵 d / e
- **ADR-MD-03** 禁止刪當前 session，picker `[cur]` 標記
- **ADR-MD-04** `/trash` 整合 list / restore / empty / prune
- **ADR-MD-05** Live filter `/`、時間快捷鍵 1/2/3/0
- **ADR-MD-06** Discord source 攔截三個 command

## 關聯模組

- `src/utils/trash/index.ts` — 共用 trash API（moveToTrash / restoreFromTrash / list / empty / prune）
- `src/utils/trash/sessionOps.ts` — session 級別整合（搬 transcript + tool-results + 硬刪 DB）
- `src/services/sessionIndex/delete.ts` — `deleteSessionWithDb`（transaction 刪三表）+ `listSessionsWithDb`
- `src/utils/memoryDelete.ts` — `softDeleteMemoryEntry` / `softDeleteStandaloneFile` / `removeMemoryIndexLine`
- `src/utils/memoryList.ts` — `listAllMemoryEntries(cwd)` 四類混合列表
- `src/commands/{session-delete,memory-delete,trash}/` — Ink picker UI

## 測試

整合 smoke tests 位於 `tests/integration/delete/`：

```bash
bun run tests/integration/delete/trash-smoke.ts             # 34 case
bun run tests/integration/delete/session-delete-smoke.ts    # 22 case
bun run tests/integration/delete/memory-ops-smoke.ts        # 27 case
bun run tests/integration/delete/discord-blacklist-smoke.ts # 10 case
```
