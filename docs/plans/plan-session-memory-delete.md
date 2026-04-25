# `/session-delete` / `/memory-delete` / `/trash` Slash Commands 規劃

## Context

使用者想新增三個互動式 slash commands，UX 仿照既有 `/tools` picker：
- `/session-delete` — 選取 session 並刪除（連同 FTS 索引、tool-results、JSONL）
- `/memory-delete` — 選取 memory 條目，可 **刪除** 或 **編輯**
- `/trash` — 管理軟刪除的垃圾桶（list / restore / empty / prune）

三者均採 **軟刪除**（移到 `.trash/<timestamp>-<name>/`），檔案與 DB 紀錄分離：DB（FTS 索引等）直接硬刪，原始檔搬到 .trash 保留。需要還原時從 .trash 復原檔案並重跑 reconciler 重建 FTS 索引。

---

## 決策確認（已對齊）

| 項目 | 決定 |
|------|------|
| Memory 範圍 | auto-memory（個別條目） + MY-AGENT.md（專案）+ `./.my-agent/*.md` + Kairos daily logs |
| 專案 memory 目標 | **MY-AGENT.md**（不是 CLAUDE.md — my-agent 實際 import 的是前者）+ `./.my-agent/*.md` |
| Session 當前進行中 | 禁止刪，picker 顯示 `[current]` 且 disabled |
| 刪除模式 | 軟刪（`.trash/`），搭配 `/trash` 還原或清空 |
| 搜尋 UX | Live filter — picker 內按 `/` 進入輸入模式 |
| 時間篩選 | 快捷鍵切換預設範圍（`1`=今天 `2`=本週 `3`=本月 `a`=全部） |
| `.trash` 管理 | `/trash` 一個 picker 涵蓋 list + restore + empty + prune |
| Memory picker 雙鍵 | `d` 刪除、`e` 編輯（spawn `$EDITOR`） |
| **Discord 來源** | **禁止觸發** 這三個 command — slash commands 全數拒絕，回覆「刪除類操作只能在 REPL 執行」 |

---

## 共用 UX（picker 骨架）

仿 `src/commands/tools/ToolsPicker.tsx`：

```
 Session / Memory / Trash picker ─ 42 items shown (of 128)
 Filter: [live filter: /__________]      Range: [今天 本週 本月 *全部*]

 [ ] 2026-04-21 14:32  (3h ago)  msgs=42  $0.87  "implement discord gateway..."
 [✓] 2026-04-20 22:38  (19h ago) msgs=115 $2.10  "M-DISCORD 全部落地"
 [current] 2026-04-22 09:10    (now)   msgs=12  $0.08  "planning /session-delete"

 ↑/↓ move  SPACE toggle  / filter  1/2/3/a range  a-all  n-none
 ENTER delete-selected   D edit (memory only)   ESC cancel
```

- **兩段式確認**：Enter → 「即將刪除 N 筆到 .trash，鍵入 `y` 確認 / Esc 取消」
- **執行時** spinner；完成後每筆顯示 ✓/✗
- **不可逆保護**：硬刪的是 DB 行，檔案進 .trash 可復原

---

## `/session-delete`

### 顯示欄位
從 `session-index.db` `sessions` 表讀：
```
[ ] 2026-04-21 14:32  (3h ago)  msgs=42  $0.87  "first_user_message truncated..."
```

### 刪除執行順序
1. **DB 硬刪**（新 `src/services/sessionIndex/delete.ts` 的 `deleteSession(cwd, sessionId)`，單一 transaction）：
   ```sql
   BEGIN;
   DELETE FROM messages_fts  WHERE session_id = ?;
   DELETE FROM messages_seen WHERE session_id = ?;
   DELETE FROM sessions      WHERE session_id = ?;
   COMMIT;
   ```
2. **檔案軟刪**（新 `src/utils/sessionStorage.ts` 的 `moveSessionToTrash(cwd, sessionId)`）：
   - `<projectDir>/<sessionId>.jsonl` → `<projectDir>/.trash/session-<ts>-<sessionId>/transcript.jsonl`
   - `<projectDir>/<sessionId>/` → `<projectDir>/.trash/session-<ts>-<sessionId>/tool-results/`
   - 附一個 `meta.json`（原 path、sessionId、DB snapshot —供未來 restore 時重建）
3. **Cache evict**：若 `Project` singleton Map 持有該 cwd+sessionId，evict（restore 時會重建）

### 防呆
- 當前 session ID 從 AppState 取得；picker 該列 disabled + 顯示 `[current]`
- Enter 按下時再次驗證 selection 不含 current（race 保險）

---

## `/memory-delete`

### 涵蓋項目（混合列表）
| 類型 | 來源 | 顯示 | 可編輯 (e)? |
|------|------|------|------------|
| auto-memory 條目 | `~/.my-agent/projects/<slug>/memory/*.md`（解析 frontmatter） | `[user] user_role — ...` | ✓（開 $EDITOR） |
| Project memory | `MY-AGENT.md`（整檔） | `[project] MY-AGENT.md` | ✓ |
| Project local configs | `./.my-agent/*.md` | `[local] <filename>` | ✓ |
| Kairos daily logs | `~/.my-agent/projects/<slug>/memory/logs/YYYY/MM/DD.md` | `[log] 2026-04-21` | ✓ |

### Picker 操作
- `SPACE` toggle 選取；Enter → 確認 → 軟刪所選
- `e`（單列）→ spawn `$EDITOR`（`process.env.EDITOR || 'notepad'` on Win）編輯該檔
- `d` 同 Enter

### 刪除執行
- auto-memory 條目：搬檔到 `.trash/memory-<ts>-<filename>/`，同步更新 `MEMORY.md` 索引（原子 temp+rename，重用 MemoryTool 內部 API）
- 其他類型：整檔搬 `.trash/`

---

## `/trash`

### 一個 picker 涵蓋多動作
```
 Trash ─ 15 items (total 45.2 MB)

 [ ] 2026-04-21 14:30  session-a3f2... (12 MB)
 [ ] 2026-04-20 09:11  memory-feedback_*.md (2 KB)
 [✓] 2026-04-15 ...     session-77ab... (8 MB)

 SPACE toggle  / filter  ENTER-selected  r restore  x empty-all  p prune <days>
```

### 動作
- `ENTER` 預設 = 永久刪選中
- `r` = restore 選中（檔案搬回原路徑，重跑 reconciler 讓 FTS 重建該 session 索引）
- `x` = empty all（雙段確認）
- `p` = prune：輸入天數 N，自動選中 N 天前的所有項目 → 按 x 清除

### Restore 實作
- `meta.json` 記錄原 path → 搬回原位
- Session restore 後 call `reconcileProjectIndex(cwd)`（既有 API）重建 FTS
- Memory restore 後重生 `MEMORY.md` 索引行

---

## 關鍵檔案 / 要修改的位置

### 新增
- `src/commands/session-delete/{index.ts,SessionDeletePicker.tsx}`
- `src/commands/memory-delete/{index.ts,MemoryDeletePicker.tsx}`
- `src/commands/trash/{index.ts,TrashPicker.tsx}`
- `src/services/sessionIndex/delete.ts` — `deleteSession()`, `listSessions(cwd, { range, keyword, limit })`
- `src/utils/trash/index.ts` — 共用 trash API：`moveToTrash(path, meta)` / `restoreFromTrash(id)` / `listTrash(cwd)` / `emptyTrash(cwd)` / `pruneTrash(cwd, days)`
- `src/commands/shared/PickerFrame.tsx`（選用）— 把 ToolsPicker 共同邏輯（cursor / live filter / range shortcut）抽共用

### 修改
- `src/commands.ts` — 註冊 3 個新 command
- `src/utils/sessionStorage.ts` — 新增 `moveSessionToTrash()` / `restoreSessionFromTrash()`
- `src/tools/MemoryTool/MemoryTool.ts` — 把 `remove` 內部實作抽成可重用函式給 `/memory-delete` 呼叫

### 重用
- `src/commands/tools/ToolsPicker.tsx` — UI 模板
- `src/services/sessionIndex/index.ts` — `openSessionIndex()` / `reconcileProjectIndex()`
- `src/utils/claudemd.ts` `getMemoryFiles()` — project memory reader
- `src/components/memory/MemoryFileSelector.tsx` — memory picker UI 參考

---

## 實作前置

0a. 把本計畫複製到 `docs/plan-session-memory-delete.md` 作為倉庫內文件
0b. 在 `TODO.md` 新增 `M-DELETE` 區段，列出下方 1–9 的子任務

## 實作順序

1. **Trash 共用層**（`src/utils/trash/`）+ unit test
2. **Session DB API**（`src/services/sessionIndex/delete.ts` — `deleteSession` + `listSessions`）+ unit test
3. **Session storage**（`moveSessionToTrash` + `restoreSessionFromTrash`）+ unit test
4. **MemoryTool 重構**（抽 remove 為 pure function）
5. **PickerFrame 共用元件**（或直接各自 copy，視工作量）
6. `/session-delete` command + 手動 E2E
7. `/memory-delete` command + 手動 E2E
8. `/trash` command + 手動 E2E
9. 整合測試 + docs（`docs/session-and-memory-management.md`）+ commit（每步一個 commit）

---

## 驗證（End-to-End）

### Session
```bash
./cli /session-delete
# 選 2 筆 → Enter → y
sqlite3 ~/.my-agent/projects/<slug>/session-index.db \
  "SELECT COUNT(*) FROM sessions;"         # 應減 2
ls ~/.my-agent/projects/<slug>/.trash/     # 應出現 session-* 目錄
./cli /trash
# r restore 其中一筆 → reconciler 重建 → /session-search 找得回
```

### Memory
```bash
./cli /memory-delete
# 選 [user] user_role → d → y
cat ~/.my-agent/projects/<slug>/memory/MEMORY.md      # 索引行消失
ls ~/.my-agent/projects/<slug>/.trash/memory-*        # 軟刪檔在
./cli /memory-delete
# 選 MY-AGENT.md → e → $EDITOR 開啟
```

### Trash
```bash
./cli /trash
# p → 輸入 30 → 自動勾選 30 天前所有項 → x empty
ls ~/.my-agent/projects/<slug>/.trash/                # 30 天前已清
```

---

## 開放議題（不阻塞規劃，實作時處理）

- `.trash` 上限總容量（避免無限膨脹）— v1 不設限，靠 `/trash` 手動清
- Windows `$EDITOR` fallback — 預設 `notepad`（簡單且每台 Win 都有）
- Restore 跨 FTS schema 版本 — v1 restore 時 run full reconcile，避開 schema mismatch
- Discord source 拒絕邏輯實作點：`src/discord/slashCommands.ts` router 層，檢查 command name 命中 `/session-delete` `/memory-delete` `/trash` 直接 reply「此操作僅限 REPL 內執行」，不 forward 到 daemon
