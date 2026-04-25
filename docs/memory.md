# 記憶系統（Memory）

My Agent 的記憶分三層，彼此互補：

| 層級 | 機制 | 檔案位置 | 用途 |
|---|---|---|---|
| **Session Recall** | SQLite FTS5 索引 | `~/.my-agent/session-index.db` | 跨 session 搜尋歷史對話 |
| **Dynamic Memory Prefetch** | Query-driven 注入 | 無 persist | 每次 query 自動附上最相關的過去訊息 |
| **MemoryTool + memdir** | 結構化 markdown | `~/.my-agent/memory/` | 長期偏好、計劃、專案、待辦 |
| **User Modeling** | 雙層 markdown | `USER.md`（global + project） | 使用者人格 / 偏好 / 工作脈絡 |

---

## Session Recall（跨 session 搜尋）

每個對話被寫進 JSONL 的同時，也被增量索引到 SQLite FTS5。

### 索引怎麼建的

- **Session schema**：每個 session 有 id、`parent_session_id`（compaction
  chain）、started_at、ended_at。
- **寫入同步**：JSONL 寫一行 → 同步 tee 到 FTS 索引（不是 batch 重建）。
- **啟動 reconcile**：開啟 My Agent 時掃 session 目錄，比對 FTS 與
  JSONL，補上遺漏的訊息。啟動 log 會印：
  ```
  [sessionIndex] 啟動掃描完成：掃 10 個 session，索引 1（0 新），寫入 0 筆訊息
  ```
- **手動重建**：如果索引壞了：
  ```bash
  bun scripts/rebuild-session-index.ts
  ```

### 搜尋：SessionSearchTool

Agent 自帶 `SessionSearch` 工具，可以全文搜尋所有歷史 session：

```
你：我上週討論那個 llamacpp 的 context window 問題是怎麼解的？
agent：[呼叫 SessionSearch] query="llamacpp context window"
       找到 3 個相關 session：
       - 2026-04-16 [session-abc] — M-LLAMACPP-CTX 設計討論...
       - 2026-04-16 [session-def] — 128K 模型溢出復原實作...
       - ...
```

特點：

- **CJK trigram**：中文查詢會先走 trigram 抽取，失敗才 fallback 到 LIKE。
- **多 token OR**：多詞查詢用 OR（不是 AND），避免空格把中文切碎導致
  查無結果。
- **Summarize 分支**：`SessionSearch mode=summarize` 會呼叫本地 llamacpp
  做摘要，而非把原文貼回來 — 省 context。
- **輸出格式對齊 Grep**：為了讓 9B 級本地模型讀得懂，結構與 Grep /
  Glob 的輸出保持一致。

### 續跑 session

```bash
./cli --resume <session-id>    # 精確跳回
./cli --continue               # 延續上次
```

---

## Dynamic Memory Prefetch

每次你送 prompt 出去前，系統會：

1. 對 prompt 做 query 處理（trigram / token）。
2. 在 FTS 索引裡找最相關的歷史片段。
3. 依預算（token budget）篩選。
4. 以 `<memory-context>` fence 注入到 system message 之前。
5. 模型讀到這段 context 再生成回應。

**這是完全自動的** — 使用者不需要操作。相關程式碼：

- `src/services/memoryPrefetch/ftsSearch.ts` — FTS 搜尋
- `src/services/memoryPrefetch/budget.ts` — token 預算控制
- `src/services/memoryPrefetch/index.ts` — 對外 API
- `src/services/api/query.ts` — 注入點（callModel 前）

**失敗靜默**：prefetch 失敗（索引壞、DB lock、等等）會 silent fallback，
不會擋住主流程。

### Budget 控制

`buildMemoryContextFence()` 會依當前模型的 context size 留出適當的預算
給 prefetch 結果。本地 128K 模型有充裕空間；雲端的 200K 模型更寬鬆。
Context 快滿時 prefetch 自動縮量。

### llama.cpp 模式下的 selector（ADR-014 / M-MEMRECALL-LOCAL）

Prefetch 內部要決定「目前的 query 該抓哪幾個 memory 檔」— 這個 selector
原本寫死走 Anthropic Sonnet（透過 `sideQuery`）。對純本地模型用戶
（沒有 `ANTHROPIC_API_KEY`）會 silent 401 → selector 回 `[]` →
**memory 機制等於關閉**。

修復後（2026-04-24）：

- `selectRelevantMemories` 偵測 `isLlamaCppActive()` → 改走
  `selectViaLlamaCpp()`，直接 fetch `${baseUrl}/chat/completions`（OpenAI
  相容 endpoint，不依賴 structured output beta，prompt 引導模型輸出
  JSON array）。
- `extractFilenamesFromText` 容錯解析（處理 markdown fence、preamble、
  `{selected_memories: [...]}` 包裝）。
- **Safety-net fallback**：selector 任何原因回 `[]` 時（HTTP 非 200 /
  parse 失敗 / 網路錯 / 真的零相關），自動帶最新 `FALLBACK_MAX_FILES=8`
  個 memory（按 mtime 排序）讓新 session 至少有最近 memory 能 ground。
- 不污染 `sideQuery`（後者仍純 Anthropic）— 整體 provider-aware 化已
  獨立列為 M-SIDEQUERY-PROVIDER 後續 milestone。

實作見 `src/memdir/findRelevantMemories.ts`，整合測試在
`tests/integration/memory/findRelevantMemories-llamacpp.test.ts`。

---

## MemoryTool + memdir

結構化長期記憶，存在 `~/.my-agent/memory/` 下。

### 四型檔案（memdir）

```
~/.my-agent/memory/
├── preferences/       # 使用者偏好（例：「寫 code 時總是加 type hint」）
├── plans/             # 進行中計劃（例：「M-LLAMA-CFG 設計決策」）
├── projects/          # 專案級事實（例：「專案 X 用 Drizzle ORM」）
└── todos/             # 待辦事項
```

每個子目錄裡是多個 `.md` 檔，檔名由 agent 自動決定（slugified）。

### Agent 怎麼用

Agent 用 `MemoryTool` 工具讀寫：

- `MemoryTool action="read"` — 列出 / 讀取某類型檔案
- `MemoryTool action="create"` — 新建一條記憶
- `MemoryTool action="update"` — 改既有檔案
- `MemoryTool action="delete"` — 刪除

使用時機寫在 prompt 裡（`src/systemPromptFiles/` 可自訂）— 例如：

> 「當使用者提到工作習慣偏好時，存到 preferences。」
> 「當使用者開始新專案時，建 projects/<slug>.md。」

### 安全特性

- **原子寫入**：tempfile + rename，crash 不留半寫檔。
- **Advisory lock**：同 cwd 多 session 時避免競寫。
- **Prompt injection scanner**：寫入前掃描內容，命中已知 exfil pattern
  （如 `curl $(cat ~/.ssh/...)`）直接拒絕寫入。
- **配額警告**：memdir 過大時 agent 會收到警告，提示整理。

### 使用者可以直接編輯

`~/.my-agent/memory/` 下都是純 markdown，可以用任何編輯器開起來改。
Agent 下次讀取就會拿到新的內容。

---

## User Modeling（`USER.md`）

專門給 *使用者人格* 的記憶層，比 memdir 更權威。靈感來自雙層設計：

```
~/.my-agent/USER.md                      # 全域人格
~/.my-agent/projects/<slug>/USER.md      # per-project 覆寫（可選）
```

### 內容範例

```md
# USER.md

## 身份
- 資深 backend engineer，10 年 Go / TypeScript 經驗
- 現在兼做 AI agent 開發

## 偏好
- 溝通：中文優先、直接了當、不要冗長道歉
- Code：TypeScript strict mode、no any、prefer functional style
- 測試：integration > unit

## 工作脈絡
- 環境：Windows 11 + Bun + conda（env 名稱 aiagent）
- 專案 my-agent 正在做 Hermes-like 功能的 port

## 指引
- 先問再動結構性決策
- 失敗立即修，不累積技術債
- 每次 commit 前跑 typecheck
```

### 三路開關

M-UM 的實作有三個獨立控制點：

- **寫入開關**：是否允許 agent 寫 `USER.md`。
- **注入開關**：是否把 `USER.md` 內容注入 system prompt。
- **自動建立開關**：第一次啟動時是否 seed 範本。

預設：寫入 on / 注入 on / seed off（需要使用者手動建立，避免冒昧）。

### 層級合併規則

兩層都有 `USER.md` 時：**per-project 完全覆蓋 global**（不是 merge）。
這是刻意的 — 允許使用者在特定專案用完全不同的人格框架（例如工作 vs 私人）。

### Persona 指引（E1–E8）

`MemoryTool` 的 prompt 附帶 8 條指引，告訴 agent 什麼時候適合寫
`USER.md`、寫什麼、不寫什麼。簡略：

- E1：使用者顯式說「我是 / 我喜歡 / 記住我 ...」→ 適合寫
- E2：明確的工作脈絡（環境、工具鏈、專案結構）→ 適合寫
- E3：臨時的任務細節 → **不**寫 USER.md（寫 todos）
- E4：八卦 / 非工作相關 → 不寫
- E5：他人代理資訊（不是使用者本人）→ 不寫
- E6：一次性事實（使用者自己會記得的）→ 不寫
- E7：推測 / 不確定的 → 不寫
- E8：若冒犯嫌疑 → 寧可不寫

---

## 相關架構

my-agent 採 ADR-003 — 不使用 feature flag，記憶機制（Session Recall /
Dynamic Prefetch / MemoryTool / User Modeling）皆預設啟用。
原 Claude Code 對應的 flag（`AGENT_MEMORY_SNAPSHOT` / `EXTRACT_MEMORIES`
/ `TEAMMEM`）僅供 [FEATURES.md](../FEATURES.md) 歷史對照。

---

## Troubleshooting

### SessionSearch 找不到東西
- 檢查索引：`bun scripts/rebuild-session-index.ts`
- 確認 session JSONL 存在於 `~/.my-agent/projects/<slug>/sessions/`
- 中文查詢失敗：改用 3 字以上的關鍵片段（trigram 最短 3）

### MemoryTool 寫入被拒絕
多半是 injection scan 命中。檢查內容：
- 有沒有疑似 exfiltration pattern（`curl $(...)`、`cat ~/.ssh/...`）
- 有沒有 live API key 直接寫進來

### USER.md 改完沒生效
`USER.md` 是 session 啟動時快照讀取（與 M-SP 同模式）。
改完需要重開一個新的 session 才會生效。

### 記憶檔案太多
memdir 不做自動清理 — 你要自己管。簡單做法：
```bash
ls -lh ~/.my-agent/memory/**/*.md | sort -k5 -h
```
看看哪些檔案大、舊、可以刪。或者跟 agent 說「幫我整理 memdir」。

---

## 相關設計文件

- `docs/context-architecture.md` — Context 完整組成（含 M-UM + M2 注入點）
- `docs/customizing-system-prompt.md` — M-SP 系統提示外部化
