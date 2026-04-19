# Session FTS 索引（SQLite + bun:sqlite）

## 說明

my-agent 用 SQLite FTS5 建對話歷史索引，支援跨 session recall 與 query-driven prefetch。本 skill 記錄 M2-01～M2-03 建基時踩到的坑與必守的規則。M2-05（SessionSearchTool）、M2-09（memoryPrefetch）及未來任何「索引既有檔案進 SQLite」類型任務都應先讀。

相關檔案：`src/services/sessionIndex/`（paths / schema / db / indexWriter / reconciler / index）、`scripts/poc/session-index-smoke.ts`（62 個測試覆蓋）。

## 工具集

file, grep, bash（bun 指令）

---

## FTS5 tokenizer：為何選 trigram（而且必須 ≥3 字元）

### 決策

`src/services/sessionIndex/schema.ts` 的 `messages_fts` 用 `tokenize='trigram'`，不是預設的 `unicode61`。

### 為何

- **unicode61 對中文災難**：Unicode 斷詞規則不認 CJK 字元邊界，一整段中文「我們上次討論了」會被當成**一個 token**。查「討論」→ 0 筆。
- **trigram 對中英混合都 OK**：把內容切成 3-char sliding window（"cache" → cac/ach/che；「討論了」→ 1 個 trigram「討論了」）。中文 3+ 字詞和英文 word 都能命中。

### **陷阱：trigram 需要查詢字串 ≥3 字元**

- `MATCH 'KV'`（2 chars）→ 0 筆，即使內容確實含 "KV cache"
- `MATCH '討論'`（2 chars）→ 0 筆，即使內容含「討論了」
- 這是 trigram 的數學特性，不是 bug

### **怎麼在 SessionSearchTool 層處理**

M2-05 必須：
1. 在 query 進來時檢查長度 <3 → 拒絕 or 自動擴展（加上下文字元）
2. 或 fallback 到 `sessions.first_user_message` / `title` 的 `LIKE` 搜尋
3. 不要預期所有查詢都能命中 FTS

### FTS5 MATCH 語法坑

- `.`、`"` 是 reserved 字元。查 `"llama.cpp"` 會噴 `fts5: syntax error near "."`
- 有兩條路：(a) 只查 `llama`（單 word）、(b) 用 phrase literal `"llama.cpp"`（雙引號包起來當 literal phrase）
- smoke test 驗證了 `'llama'` 單字正常命中

---

## 路徑識別：`getProjectRoot()` vs `getOriginalCwd()`

### **絕對要用 `getProjectRoot()`**（`src/bootstrap/state.ts:511`）

### 為什麼不用 `getOriginalCwd()`

- `getOriginalCwd()` 在 `EnterWorktreeTool` 會被改（`state.ts:500–517` 明示）
- 索引 key 跟著 slug 走 → 如果 cwd 變，同一 session 的 entries 會被寫進**兩個** db
- `getProjectRoot()` 是 session identity 穩定源，worktree 進出不影響

### 舉例

```ts
// ❌ 錯：sessionStorage 內 EnterWorktreeTool 後索引分裂
indexEntry(entry, sessionId, getOriginalCwd())

// ✅ 對：session 身份穩定
indexEntry(entry, sessionId, getProjectRoot())
```

所有 `openSessionIndex(cwd)` / `reconcileProjectIndex(cwd)` / `ensureReconciled(cwd)` 的 `cwd` 參數都應該是 `getProjectRoot()`。

---

## FTS5 虛擬表不支援 UNIQUE → 需要 shadow dedup 表

### 問題

SQLite FTS5 virtual table（`CREATE VIRTUAL TABLE ... USING fts5(...)`）語法層就不支援 `UNIQUE` constraint。沒辦法在 FTS 層本身做 dedup。

### 解法

M2-01 schema v2 加一張普通表 `messages_seen(session_id, uuid)` 當守門：

```sql
CREATE TABLE messages_seen (
  session_id TEXT NOT NULL,
  uuid TEXT NOT NULL,
  PRIMARY KEY (session_id, uuid)
);
```

寫入流程改成兩步：
```ts
const seen = db
  .query('INSERT OR IGNORE INTO messages_seen (session_id, uuid) VALUES (?, ?)')
  .run(sessionId, uuid)
if (seen.changes === 0) return  // 已存在，跳過 FTS 寫入
// 通過才寫 messages_fts
```

### 為何 IO 很划算

- 一次 primary-key INSERT OR IGNORE 是 sub-microsecond
- 避免 replay / bulk reindex / 多程序競爭時插重複
- 就算 FTS index 損毀重建，shadow 表跟著重建沒有一致性問題

---

## Hook 點：`sessionStorage.appendEntry()`

### 所有訊息收斂點

`src/utils/sessionStorage.ts:1128` 的 `appendEntry(entry, sessionId)` 是所有訊息寫入的漏斗。TranscriptMessage 分支在 line 1216+，`isNewUuid` 檢查在 1242。

**Tee 要放在 `if (isAgentSidechain || isNewUuid)` 區塊內、`!isAgentSidechain` 分支裡、`enqueueWrite` 之後**（line 1243–1245 附近）。

### 為何不動 `appendEntryToFile`（line 2572）

那是 sync metadata 路徑（titles / tags / modes），**沒有 message 內容**，安全忽略。不需要多插 hook。

### 為何不動 `drainWriteQueue`（line 645）

那時已經 JSON.stringify 過，要再 parse 回來效率差。在 `appendEntry` 拿到的是結構化 entry，更直接。

### `shouldSkipPersistence()` 守衛（line 960）

不需在 tee 層重加守衛 —— `appendEntry:1129` 已先檢查。hook 放在它後面自然繼承。

---

## SQLITE_BUSY：直接吞，不重試

### 為什麼

- Bun 1.3.x 在 Windows 的 SQLite WAL 多程序競爭較激進
- 主執行緒等鎖最多 `busy_timeout=1000`（1 秒），會卡 UI
- 漏寫的幾筆 M2-03 reconciler 啟動時會補

### 實作

`indexWriter.ts` 內：

```ts
function isSqliteBusy(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  const code = (err as Error & { code?: string }).code
  if (code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED') return true
  return /SQLITE_BUSY|SQLITE_LOCKED|database is locked/i.test(err.message)
}

try { /* INSERT */ }
catch (err) {
  if (isSqliteBusy(err)) return  // 靜默
  logIndexError(err)
}
```

### 錯誤 log 抑制

非 BUSY 錯誤每 session 只 log 一次（`loggedGenericError` flag），避免洗版。

---

## JSONL 實際路徑（注意：沒有 `conversations/` 子目錄）

### 真正結構

```
{CLAUDE_CONFIG_HOME}/projects/{sanitized-cwd}/
├── {sessionId-1}.jsonl          ← 主 session 直接在此層
├── {sessionId-2}.jsonl
├── session-index.db              ← M2-01 建的索引
└── {sessionId-1}/
    └── subagents/
        └── agent-{agentId}.jsonl  ← subagent 的 sidechain
```

### 文件措辭陷阱

TODO / DEPLOYMENT_PLAN 早期版本寫「`.claude/projects/{slug}/conversations/*.jsonl`」是錯的 — **沒有** `conversations/` 子目錄。以 `src/utils/sessionStoragePortable.ts:getProjectDir()` + `src/utils/sessionStorage.ts:204` 為準。

### Reconciler 掃描規則

`reconciler.ts:reconcileProjectIndex`：
```ts
const dirents = await readdir(projectDir, { withFileTypes: true })
files = dirents
  .filter(d => d.isFile() && d.name.endsWith('.jsonl'))
  .map(d => d.name)
```

**只要直接層的 .jsonl**，不 recurse 進 `{sessionId}/subagents/`（與 tee 行為一致：sidechain 不索引）。

---

## 啟動 hook 點：`setup.ts` background-jobs 區塊

### 位置

`src/setup.ts` line ~287 附近有一段「Background jobs - only critical registrations that must happen before first query」。旁邊就是 `initSessionMemory()`。

### 為什麼在這裡

- `setProjectRoot()` 已在此之前跑完（line 277）→ `getProjectRoot()` 可用
- 不動 bootstrap 主線、不動 main.tsx
- 與 `initSessionMemory` / `lockCurrentVersion` 等既有背景註冊**風格一致**
- 受 `!isBareMode()` 保護 → scripted 使用不會觸發

### 模式

```ts
if (!isBareMode()) {
  initSessionMemory()
  void ensureReconciled(getProjectRoot())  // fire-and-forget，冪等
  // ...
}
```

### 冪等快取

`ensureReconciled` 用 `Map<projectRoot, Promise>` 快取：第一次呼叫觸發 reconcile，之後任何呼叫（包括 M2-05 SessionSearchTool 的 `await ensureReconciled(...)`）都拿同一個 Promise，不會重複掃描。

---

## bun:sqlite 要點

### 開啟 + PRAGMA

```ts
import { Database } from 'bun:sqlite'
const db = new Database(path, { create: true })
db.exec('PRAGMA journal_mode = WAL')
db.exec('PRAGMA busy_timeout = 1000')
db.exec('PRAGMA synchronous = NORMAL')
db.exec('PRAGMA foreign_keys = ON')
```

### Statement API

- `db.query<ReturnType, ParamsType>(sql)` 回傳 Statement
- `.get(...params)` / `.all(...params)` / `.run(...params)`
- 範例：`db.query<{ version: number }, []>('SELECT version FROM schema_version').get()`

### Schema versioning

用 `schema_version` 表存整數。`initializeSchema` 比對 code 的 `SCHEMA_VERSION` 常數 vs 表中值：
- 新 db（row === null）→ INSERT 當前 version
- 一致 → return
- v1 → v2 類 in-place migration → UPDATE schema_version
- 沒 migration path → throw，訊息提示 `rm` 索引檔重建（JSONL 仍是 source of truth，安全）

---

## Smoke 測試策略

### 關鍵模式：throwaway `CLAUDE_CONFIG_DIR`

```ts
const tempHome = mkdtempSync(join(tmpdir(), 'freecode-index-smoke-'))
process.env.CLAUDE_CONFIG_DIR = tempHome

// 重點：設完 env 再 dynamic import
const { openSessionIndex, ... } = await import('../../src/services/sessionIndex/index.js')
```

先設 env 再 import，是因為 `getClaudeConfigHomeDir` 用 `memoize` + keyed on env。static import 會在 env 設定前評估。

### Windows 清理：關連線才能 rmSync

Windows 的檔案鎖 =  db.close() 前 rm 會 `EBUSY`。finally 裡先 `closeAllSessionIndexes()` 再 rmSync。

### Trigram 驗證

每次擴充 schema 時都要用 `EXPLAIN QUERY PLAN` 驗證索引有被用到。例：

```ts
const plan = db.query('EXPLAIN QUERY PLAN SELECT ... WHERE parent_session_id = ?').all(...)
check('idx_sessions_parent 被使用', plan.some(r => r.detail.includes('idx_sessions_parent')))
```

---

## 未完項目（轉交 M2-05+）

1. **分叉 session**（`src/commands/branch/branch.ts:161`）— 用 `writeFile` 整份寫，繞過 `appendEntry`。M2-03 reconciler 啟動時會對齊，**但同一程序內分叉後馬上搜尋**可能找不到。
2. **Agent sidechain**（`subagents/*.jsonl`）— tee 跳過、reconciler 也跳過。M2-05 若感覺 recall 不完整再考慮加。
3. **Tombstone 刪訊** — JSONL 刪行時 FTS 殘留。M2 可接受。
4. **Hard-kill 丟最後一筆** — WAL + synchronous=NORMAL 可能丟最後幾筆。下次啟動 reconciler 補。

---

## 常見檢查清單（給未來任務）

當你要擴充 `src/services/sessionIndex/` 或寫類似索引時：

- [ ] 寫入路徑：用 `getProjectRoot()` 還是 `getOriginalCwd()`？（應該是前者）
- [ ] 有沒有守衛？`shouldSkipPersistence` / feature flag / `isBareMode` 繼承上游還是新加？
- [ ] `SQLITE_BUSY` 怎麼處理？（應該直接吞，讓 reconciler 補）
- [ ] Schema 改動要不要 bump `SCHEMA_VERSION`？migration path 在哪？
- [ ] FTS 搜尋字串 <3 字元怎麼辦？（SessionSearchTool 層擋掉或擴展）
- [ ] Dedup 用 `messages_seen`？新資料表要加 PK / UNIQUE 嗎？
- [ ] Smoke 測試：throwaway `CLAUDE_CONFIG_DIR` 設好了嗎？finally 有 closeAll 嗎？
