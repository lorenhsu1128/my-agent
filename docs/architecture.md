# My Agent 架構總覽

> 一個建構在本地終端機中的互動式 AI 代理人，支援多家雲端 LLM 服務與本地模型、具備跨 session 記憶、可自訂系統提示、可排程背景任務、可操作瀏覽器的通用 agent CLI。

## 📚 專案定位

My Agent 的核心定位是將 AI agent 變成一個**能持續工作**的搭檔，而不只是單次問答工具。它具備：

- **跨 session 記憶**：記住上下文、歷史對話、使用者偏好
- **排程背景任務**：即使離開也能執行定期任務
- **多模型支援**：雲端 API + 本地模型無縫切換
- **工具整合**：瀏覽器操作、檔案系統、Git、網路搜尋等
- **自適應行為**：根據使用者建模調整互動風格

---

## 🏗️ 核心架構圖

```
┌─────────────────────────────────────────────────────────────────────────┐
│                              My Agent 架構                                 │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │                      Entry Points                                 │  │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐          │  │
│  │  │ CLI (print)  │  │ REPL (TUI)   │  │ Daemon (WS)  │          │  │
│  │  └──────────────┘  └──────────────┘  └──────────────┘          │  │
│  └──────────────────────────────────────────────────────────────────┘  │
│                                │                                         │
│                                ▼                                         │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │                     Bootstrap Layer                               │  │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐          │  │
│  │  │ Provider     │  │ Config       │  │ State        │          │  │
│  │  │ Detection    │  │ Loading      │  │ Initialization│        │  │
│  │  └──────────────┘  └──────────────┘  └──────────────┘          │  │
│  └──────────────────────────────────────────────────────────────────┘  │
│                                │                                         │
│                                ▼                                         │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │                      Core Loop                                    │  │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐          │  │
│  │  │ QueryEngine  │  │ ToolExecutor │  │ Context      │          │  │
│  │  │ (decision)   │  │ (execution)  │  │ Management   │          │  │
│  │  └──────────────┘  └──────────────┘  └──────────────┘          │  │
│  └──────────────────────────────────────────────────────────────────┘  │
│                                │                                         │
│            ┌───────────────────┼───────────────────┐                    │
│            ▼                   ▼                   ▼                    │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐         │
│  │   Tools         │  │   Memory        │  │   Skills        │         │
│  │   (actions)     │  │   (context)     │  │   (capabilities)│         │
│  └─────────────────┘  └─────────────────┘  └─────────────────┘         │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 📁 目錄結構

```
my-agent/
├── src/                          # 核心原始碼
│   ├── vendor/                   # 內化的第三方庫（如 Anthropic SDK）
│   ├── skills/bundled/           # 內建 skills（~17 個）
│   ├── services/                 # 服務層
│   │   ├── api/                  # API clients
│   │   ├── sessionIndex/         # SQLite FTS5 搜尋
│   │   ├── memoryPrefetch/       # 動態記憶預取
│   │   └── mcp/                  # MCP servers
│   ├── tools/                    # Agent 工具（~30+ 個）
│   ├── commands/                 # Slash commands
│   ├── daemon/                   # Daemon 模式
│   ├── discord/                  # Discord 整合
│   ├── memdir/                   # 結構化記憶系統
│   ├── userModel/                # 使用者建模
│   ├── context/                  # Context 管理
│   ├── query/                    # 查詢邏輯
│   ├── repl/                     # TUI REPL
│   ├── entrypoints/              # 入口點
│   ├── bootstrap/                # 啟動邏輯
│   ├── utils/                    # 工具函式
│   ├── constants/                # 常數
│   ├── types/                    # 型別定義
│   ├── components/               # React 組件
│   ├── ink/                      # Ink 終端 UI
│   ├── screens/                  # TUI 畫面
│   └── outputStyles/             # 輸出樣式
│
├── docs/                         # 深度文件
│   ├── adr.md                    # 架構決策記錄
│   ├── context-architecture.md   # Context 組成詳解
│   ├── memory.md                 # 記憶系統
│   ├── cron.md                   # 排程系統
│   ├── daemon-mode.md            # Daemon 模式
│   ├── discord-mode.md           # Discord 整合
│   ├── customizing-system-prompt.md  # 系統提示客製化
│   └── ...
│
├── tests/                        # 測試套件
│   ├── e2e/                      # 端對端測試
│   └── integration/              # 整合測試
│
├── .claude/                      # Claude Code 設定
│   ├── commands/                 # 自訂 slash commands
│   ├── agents/                   # Subagents
│   ├── skills/                   # 專案 skills
│   └── hooks/                    # Hook 腳本
│
├── scripts/                      # 工具腳本
│   └── llama/                    # llama.cpp 部署
│
├── package.json                  # 專案設定
├── CLAUDE.md                     # Session 規則
├── TODO.md                       # Milestone 進度
├── FEATURES.md                   # Feature flags
└── README.md                     # 使用者指南
```

---

## 🎯 核心架構優點

### 1. **多 Provider 支援（無縫切換）**

**設計理念**：所有 LLM 互動統一透過 `QueryEngine`，provider 邊界只做格式轉譯。

**優勢**：
- 使用者只需設定環境變數即可切換雲端/本地模型
- 本地模型（llama.cpp）支援串流、思考鏈、多模態、128K context
- 雲端模型（Anthropic/Bedrock/Vertex/Azure）自動支援
- 程式碼不需要知道底層 provider，只與抽象介面互動

**關鍵檔案**：
- `src/services/api/llamacpp-fetch-adapter.ts` — llama.cpp fetch adapter
- `src/QueryEngine.ts` — 核心查詢引擎（deny list，修改前先問）

---

### 2. **跨 Session 記憶系統（三層架構）**

**設計理念**：記憶分層管理，從即時上下文到長期記憶，各有不同存取策略。

**三層架構**：

| 層級 | 機制 | 儲存 | 更新頻率 |
|------|------|------|----------|
| Session Recall | SQLite FTS5 | `~/.my-agent/session-index.db` | 每次寫入 JSONL 時增量更新 |
| Dynamic Prefetch | Query-driven | 無 persist | 每 turn 依語意動態注入 |
| MemoryTool + memdir | 結構化 markdown | `~/.my-agent/memory/` | 使用者或 agent 寫入 |

**優勢**：
- **搜尋能力**：可模糊搜尋所有歷史對話，找回過往決策脈絡
- **自動注入**：每次 query 前自動附上最相關的過去訊息
- **結構化**：preferences/plans/projects/todos 四型分類，精確記憶
- **使用者可控**：memdir 是純 markdown，可直接用任意編輯器編輯

---

### 3. **使用者建模（User Modeling）**

**設計理念**：雙層 USER.md 設計，區分全域人格與專案特定人格。

**雙層儲存**：

```
~/.my-agent/USER.md                      # 全域人格（跨專案）
~/.my-agent/projects/<slug>/USER.md      # 專案特定人格（覆寫）
```

**優勢**：
- **一致性**：agent 用你熟悉的術語、了解你的工作環境
- **靈活性**：不同專案可用不同人格框架（工作 vs 私人）
- **持久化**：人格偏好跨 session 保持
- **可編輯**：USER.md 是 markdown，可直接編輯調整

---

### 4. **系統提示外部化（M-SP）**

**設計理念**：29 個 system prompt section 全部外部化到 markdown 檔，使用者可直接編輯。

**解析鏈**：
1. `~/.my-agent/projects/<slug>/system-prompt/<filename>` — per-project 覆蓋
2. `~/.my-agent/system-prompt/<filename>` — global
3. Bundled 預設 — 程式內建 fallback

**優勢**：
- **無重編譯**：改 prompt 不用改程式碼、不用 rebuild
- **可自訂**：每 section 獨立調整，精準控制 agent 行為
- **專案隔離**：不同專案可有不同的 system prompt 設定
- **版本控制**：system prompt 可放 Git，團隊共享最佳實踐

---

### 5. **Daemon 模式（常駐服務）**

**設計理念**：QueryEngine + cron scheduler 常駐在背景程序，多個 REPL/Discord/cron job 共享對話狀態。

**架構**：
```
┌─────────────────────────────────────────┐
│           Daemon Server                  │
│  ┌─────────────┐  ┌─────────────┐       │
│  │   Input     │  │  Runner     │       │
│  │   Queue     │  │   Engine    │       │
│  └─────────────┘  └─────────────┘       │
│  ┌─────────────┐  ┌─────────────┐       │
│  │   Broker    │  │  Permission │       │
│  │   (multi-   │  │   Router    │       │
│  │   client)   │  └─────────────┘       │
│  └─────────────┘                         │
└─────────────────────────────────────────┘
         ▲            ▲            ▲
         │            │            │
    ┌────┴────┐  ┌───┴────┐  ┌────┴────┐
    │  REPL   │  │ Discord│  │ Cron    │
    │  Client │  │ Client │  │  Job    │
    └─────────┘  └────────┘  └─────────┘
```

**優勢**：
- **多視角共享**：同一 daemon 內可開啟 N 個 REPL，共享對話狀態
- **資源效率**：單一 daemon 內活 N 個 ProjectRuntime，lazy load + idle unload
- **Cron 獨占**：cron 移到 daemon 獨占跑，避免多 REPL 重複觸發
- **透明切換**：TUI 自動偵測 daemon 狀態，無需手動切換

---

### 6. **排程系統（Cron）**

**設計理念**：8 個排程工具 + `/cron` 互動式 TUI，人性化排程語法。

**功能**：
- 4 種排程格式：時長 / 間隔 / 5-field cron / ISO timestamp
- 每任務獨立模型指定（可用小模型探測，需要時升級）
- Pre-run script 注入上下文
- 失敗重試 + exponential backoff
- Conditional 觸發（shell / lastRunOk / fileChanged）
- 結果通知（TUI toast + StatusLine badge）

**優勢**：
- **人性化**：`每 2 小時`、`30 分鐘後`、`每天早上 9 點`
- **靈活性**：每任務獨立設定，精確控制
- **可靠**：失敗重試、條件觸發確保任務正確執行
- **可稽核**：每 job 有獨立的 audit log

---

### 7. **工具系統（Tools）**

**設計理念**：30+ 個工具，涵蓋常用操作場景，統一 Tool 介面。

**工具分類**：

| 分類 | 工具 | 用途 |
|------|------|------|
| 記憶 | `MemoryTool` | 讀寫結構化記憶 |
| 搜尋 | `SessionSearchTool` | 跨 session 搜尋 |
| 排程 | `Cron*` 系列 | 排程管理 |
| 網頁 | `WebFetch` / `WebCrawl` / `WebBrowser` | 網頁操作 |
| 檔案 | `Edit` / `Read` / `Glob` | 檔案操作 |
| 系統 | `Bash` / `Grep` | 系統命令 |
| AI | `AgentTool` | 呼叫子代理 |

**優勢**：
- **統一介面**：所有工具實作 `Tool` 介面，可交換
- **權限控制**：每工具可獨立設定 allow/deny 規則
- **結果注入**：tool_result 自動注入下一 turn 的 context
- **可測試**：工具可 mock，方便測試

---

### 8. **Skill 自主建立（Self-Improving Loop）**

**設計理念**：agent 可從經驗自動總結並寫入新 skill，形成自適應能力。

**流程**：
1. 完成複雜或重複性任務
2. 評估是否符合 skill 建立條件（步驟不明顯？未來會再做？專屬本專案？）
3. 安全掃描 + 閾值控管避免亂長
4. 寫入 `.claude/skills/<name>/SKILL.md`

**優勢**：
- **自適應**：agent 可從經驗學習，越用越懂你
- **模組化**：新 skill 可獨立載入/卸載
- **安全**：安全掃描避免注入攻擊
- **可擴展**：使用者可建立自訂 skill

---

### 9. **上下文管理（Context Management）**

**設計理念**：精心設計的上下文注入機制，平衡資訊量與 token 預算。

**上下文組成**：

```
System Prompt = Static + Dynamic
Static:        # 可快取
  - Simple Intro
  - System Rules
  - Output Efficiency
  
Dynamic:       # 每 turn 更新
  - Session Guidance
  - User Profile (USER.md)
  - Memory Context (memdir + FTS5)
  - MCP Instructions
  - Environment Info
```

**優勢**：
- **性能優化**：靜態內容可快取，減少 API 成本
- **動態性**：每 turn 更新相關上下文，保持新鮮度
- **預算控制**：嚴格限制各部分大小（User Profile < 1500 chars, Memory Context < 2000 tokens）
- **邊界保護**：靜態/動態間有邊界標記，避免 prefix cache 污染

---

### 10. **Discord 整合**

**設計理念**：Daemon 接 Discord bot，DM / guild channel 文字對話、8 個 slash commands。

**功能**：
- 8 個 slash commands：`/status` / `list` / `help` / `mode` / `clear` / `interrupt` / `allow` / `deny`
- Per-project 頻道自動建立
- Turn 雙向鏡像（Discord → REPL → Discord）
- 權限雙發 first-wins

**優勢**：
- **多平台**：不需開終端，Discord 直接互動
- **整合**：權限、設定雙向同步
- **專案隔離**：per-project 頻道，不同專案不同頻道

---

## 🚀 建構與開發

### 建構變體

| 指令 | 產出 | 用途 |
|------|------|------|
| `bun run build` | `./cli` | 正式版 |
| `bun run build:dev` | `./cli-dev` | 開發版 |
| `bun run compile` | `./dist/cli` | Standalone 單一執行檔 |

### 常用指令

```bash
./cli -p "prompt"              # 一問式
./cli                          # 互動式 TUI
./cli --model qwen3.5-9b-neo   # 指定本地模型
./cli daemon start             # 啟動 daemon
./cli daemon status            # 檢視 daemon 狀態
```

---

## 📊 技術棧

- **語言**：TypeScript
- **打包工具**：Bun
- **UI 框架**：React + Ink（終端 UI）
- **資料庫**：SQLite（Session 搜尋）
- **本地模型**：llama.cpp（OpenAI 相容端點）
- **雲端 API**：Anthropic Messages API（支援 Bedrock/Vertex/Foundry）

---

## 🎓 設計原則

1. **本地模型為一等公民**：完整串流、工具呼叫、思考鏈、多模態都能走本地
2. **使用者可控**：設定、system prompt、記憶全部可編輯
3. **模組化**：工具、skills、provider 可交換
4. **可測試**：完整測試套件覆蓋核心功能
5. **安全**：prompt injection 掃描、權限控制、配額保護
6. **跨平台**：Windows/macOS/Linux 相容

---

## 📖 相關文件

- [README.md](./README.md) — 使用者指南
- [CLAUDE.md](./CLAUDE.md) — Session 規則
- [docs/context-architecture.md](./docs/context-architecture.md) — Context 組成詳解
- [docs/memory.md](./docs/memory.md) — 記憶系統
- [docs/cron.md](./docs/cron.md) — 排程系統
- [docs/daemon-mode.md](./docs/daemon-mode.md) — Daemon 模式
- [docs/customizing-system-prompt.md](./docs/customizing-system-prompt.md) — 系統提示客製化

---

**最後更新**：2026-04-30
