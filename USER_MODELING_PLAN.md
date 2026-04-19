# Plan: 引入 Hermes 式「使用者建模」(User Modeling) 到 my-agent

## Context

使用者想把 Hermes Agent 的 **使用者建模** 概念移植進 my-agent，並加上可開關的參數；設定檔 / 記錄檔放在 `~/.my-agent/` 下。

### 兩邊現況比較

| 面向 | Hermes | my-agent M2 現況 |
|---|---|---|
| 檔案結構 | `~/.hermes/memories/MEMORY.md` + `USER.md` 兩檔 | `~/.my-agent/projects/<slug>/memory/` 下多個 typed 檔案（`user_*.md`, `feedback_*.md`, `project_*.md`, `reference_*.md`）+ `MEMORY.md` 索引 |
| 使用者檔案 | **獨立 `USER.md`**、字元上限 1375、session 啟動**凍結快照**注入 system prompt | 無獨立 persona 檔；使用者資訊散落在 `user_*.md` / `feedback_*.md` 多檔 |
| 工具寫入 | `memory` 工具 `target=user\|memory` | `MemoryTool` 寫到 typed entry，無 `user_profile` target |
| 注入機制 | System prompt 前綴（凍結快照、prefix cache 友善） | `buildMemoryPrompt()` 讀 `MEMORY.md` 索引（truncate 200 lines / 25KB） |
| 開關 | `config.yaml: memory.user_profile_enabled` | `CLAUDE_CODE_DISABLE_AUTO_MEMORY` env var、`settings.json: autoMemoryDirectory` |

### 問題定位

my-agent 雖然已有 typed user memories，但它們是**條目式、散落、無 persona 視角**；LLM 每次拿到的是「MEMORY.md 索引 + 按需展開」，沒有一個穩定、凍結、高優先級的「**這個使用者是誰**」blob。Hermes 的 USER.md 正是補這一塊 —— 一個 curated、size-capped、永遠放在 system prompt 頂部的 persona block。

### 目標產出

1. 新增 `USER.md` 使用者檔案 —— 獨立於現有 typed memories，session 啟動凍結快照注入 system prompt。
2. 提供可開關參數（settings.json + env var + CLI flag 三路）。
3. 不破壞現有 M2 memory（並存、不替代）。
4. 設定與資料全部存在 `~/.my-agent/` 體系下。

---

## 關鍵設計決策（已與 user 對齊）

- **D1 儲存範圍**：**雙層 — global + per-project override**
  - Global base：`~/.my-agent/USER.md`
  - Per-project override：`~/.my-agent/projects/<slug>/USER.md`
  - 注入時：`global` + `per-project`（若存在則 append，以 `### Project-specific` 標題分隔）
  - 寫入時：`target='user_profile'` 預設寫 global；加 `scope: 'project'` 參數時寫 per-project
- **D2 寫入介面**：延伸現有 `MemoryTool`，新增 `target: 'user_profile'` + 可選 `scope: 'global' | 'project'`（預設 `global`）
- **D3 注入位置**：system prompt 中 `buildMemoryPrompt()` 之前，獨立 `<user-profile>` fence
- **D4 大小上限**：1500 字元（global + project 合計），超出警告但不截斷
- **D5 快照行為**：session 啟動讀一次並凍結，system prompt 用凍結版；MemoryTool 回應顯示 live 狀態
- **D6 預設狀態**：**預設啟用**；三路開關可關閉（CLI > env > settings 優先序）

---

## 實作規劃

### 關鍵檔案

**新增**
- `src/userModel/userModel.ts` — 讀寫 / 快照 / 格式化 `USER.md`（雙層合併）
- `src/userModel/paths.ts` — 解析 global + per-project 路徑
  - global：`~/.my-agent/USER.md`（env override: `MYAGENT_USER_MODEL_PATH`）
  - project：`~/.my-agent/projects/<slug>/USER.md`（複用 `getProjectDir()`）
- `src/userModel/prompt.ts` — 產生 `<user-profile>` 區塊（1500 char 上限、超出告警）
- `tests/integration/user-model/` — smoke test（寫入 → 快照 → 注入 → 雙層合併 → 開關）

**修改（最小化）**
- `src/tools/MemoryTool/MemoryTool.ts` — schema 增加 `target: 'user_profile'` 分支，路由到 `userModel.ts`
- `src/memdir/memdir.ts` — `buildMemoryPrompt()` 在最前面 prepend user profile block（受開關控制）
- `src/utils/settings/settings.ts` — 型別加 `userModelEnabled?: boolean`（預設 `true`）
- `src/utils/envUtils.ts` 消費端 — 讀 `MYAGENT_DISABLE_USER_MODEL`
- CLI 參數處理（找到 `--no-auto-memory` 類似位置後加 `--no-user-model`）

### 開關三路（優先序：CLI > env > settings）

1. CLI flag：`--no-user-model` / `--user-model`（最高優先）
2. Env var：`MYAGENT_DISABLE_USER_MODEL=1`
3. settings.json：`{ "userModelEnabled": true }`（預設 true）

實作參考現有 `isAutoMemoryEnabled()` in `src/memdir/paths.ts` 的 pattern。

### 資料流

```
寫入：
  LLM → MemoryTool(target='user_profile', action='add', content='...')
       → userModel.append(content)
       → ~/.my-agent/USER.md (檔案鎖 proper-lockfile)

讀取（session 啟動）：
  bootstrap → userModel.loadSnapshot()
           → 存在 in-memory singleton

注入：
  buildSystemPrompt() → userModel.formatBlock() → <user-profile>...</user-profile>
                     → + 現有 buildMemoryPrompt()

工具回應 mid-session：
  回傳 live state（非 snapshot），讓 LLM 看到剛寫入的內容
```

### 複用既有程式碼

- 檔案鎖：`src/tools/MemoryTool/*` 已用 `proper-lockfile`，抽共用 helper
- Injection scanning：`src/tools/MemoryTool/injectionScan.ts` 寫入前掃描重用
- 路徑解析：`src/memdir/paths.ts` 的 `getAutoMemPath()` pattern 照抄
- 字元上限 + 警告：`src/memdir/memdir.ts` 的 `truncateEntrypointContent()` 可參考

### 不做的事

- ❌ 不改 `src/QueryEngine.ts` / `src/Tool.ts`（deny list）
- ❌ 不移除或重寫現有 M2 typed memories
- ❌ 不做複雜的外部 provider 整合（Hermes 那層等 M7+）
- ❌ 不加新依賴

---

## 驗證計畫

1. `bun run typecheck` 通過
2. 整合測試：
   - `user-model-write.test.ts` — 寫入後檔案存在、內容正確
   - `user-model-snapshot.test.ts` — session 啟動凍結、mid-session 寫不影響 system prompt
   - `user-model-toggle.test.ts` — 三個開關各自正確關閉注入
3. E2E：
   - `./cli -p "我叫 Loren，用繁中，主要 shell 是 PowerShell"` → 檢查 `~/.my-agent/USER.md` 有寫入
   - 重開 session，`./cli -p "你還記得我的 shell 嗎？"` → 答案提及 PowerShell
   - `MYAGENT_DISABLE_USER_MODEL=1 ./cli -p "..."` → system prompt 不含 `<user-profile>` fence（用 `--debug` 或 inspect 驗證）

---

## 里程碑切分（建議 commit 粒度）

- M-UM-1：`src/userModel/` 骨架 + paths + types + 單元測試
- M-UM-2：`MemoryTool` schema 擴充 + 寫入路由
- M-UM-3：`memdir.ts` 注入整合 + 三路開關
- M-UM-4：整合測試 + E2E smoke
- M-UM-5：文件（CLAUDE.md / TODO.md / DEPLOYMENT_PLAN.md 同步）
