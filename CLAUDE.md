# CLAUDE.md

> 本檔只放「session 一開就要立即記住的規則」。深入內容用連結指到 `docs/`。

## 專案概述

my-agent 已移除遙測、移除安全護欄、解鎖所有實驗功能。我們正在擴充它：多 provider 支援、本地模型、從 Hermes Agent（Nous Research）移植功能。

Hermes 原始碼在 `reference/hermes-agent/`（Python，唯讀）。閱讀以理解設計，然後用 TypeScript 在 my-agent 既有架構內重新實作 — 絕不直接複製。

## 黃金規則

1. **先啟動 conda 環境。** 每個 session、每條 shell 指令前都要 `conda activate aiagent`。Hook `pre-tool-use-conda.sh` 會驗證並阻擋未啟用的指令。
2. **保留既有程式碼。** 透過擴充新增功能，不刪除/重寫。修改現有檔案做最小必要更改。
3. **Hermes 僅供參考。** 用 TypeScript 重新實作以符合 my-agent 架構（React/Ink UI、Tool 基礎類別、services 模式）。
4. **本地模型走 fetch adapter。** llama.cpp 整合在 `src/services/api/llamacpp-fetch-adapter.ts`，不另建 providers 目錄。Anthropic 路徑零修改（ADR-005）。
5. **每次功能性修改後測試。** TS 變更跑 `bun run typecheck`；針對受影響模組跑整合測試；測試不存在就先寫。
6. **提交可運作的狀態。** 編譯+測試通過就 commit。約定式提交：`feat(...)` / `fix(...)` / `test(...)` / `docs:`。**Commit 訊息一律繁體中文**（前綴英文保留）。
7. **架構決策先停下來問。** 提 2-3 方案 + 取捨，等決定。例如：新模組位置、協議差異、是否加依賴。
8. **每次 session 開始讀 LESSONS.md。** 修 bug / 回退做法 / 發現非預期行為時立即追加一條。
9. **適時建立新 skill。** 完成複雜或重複性任務後評估：步驟不明顯？未來會再做？專屬本專案？符合就告知主題 + 內容摘要等確認，再建 `.claude/skills/<name>/SKILL.md`。
10. **規劃與開發必須跨 Windows / macOS 相容。** 第一輪規劃就要雙視角；不可避免時提供兩套方案並用 `process.platform` 或 `-windows` / `-macos` 後綴標示。文件範例預設 Unix shell 語法。
11. **Milestone 級修改先列 TODO.md。** plan → 更新 TODO.md（含「不在範圍 → 後續 milestone」）→ 才開始 code。
12. **回覆/註解一律繁體中文。** 識別字 / 指令 / npm 套件名保留英文。
13. **改 zod schema 後跑 `bun run docs:gen`。** `src/llamacppConfig/schema.ts` / `webConfig/schema.ts` / `discordConfig/schema.ts` 任一改動後要重新產生 `docs/config-*.md`，否則 `bun run docs:verify` 會 fail（CI 會擋）。

## 倉庫結構

```
my-agent/
├── CLAUDE.md              ← 本檔（短）
├── TODO.md                ← Milestone 進度真實狀態（真理來源）
├── LESSONS.md             ← 教訓記錄
├── docs/                  ← 深入文件（架構 / 設定 / ADR / dev log / 使用者指南）
│   ├── adr.md
│   ├── context-architecture.md
│   ├── config-reference.md
│   ├── dev-log/2026-Q2.md
│   └── ...（user-manual / cron / daemon-mode / discord-mode / web-mode / llamacpp-* 等）
├── src/
│   ├── vendor/my-agent-ai/   ← 內化的 Anthropic SDK（ADR-007）
│   ├── skills/bundled/       ← 17 個 bundled skills
│   ├── services/api/         ← API client + llamacpp-fetch-adapter
│   ├── services/sessionIndex/ ← FTS5 跨 session 搜尋
│   ├── services/memoryPrefetch/ ← query-driven 動態 prefetch
│   ├── tools/                ← agent 工具（含 SessionSearchTool / MemoryTool）
│   ├── commands/             ← slash 指令
│   ├── daemon/               ← daemon 模式（M-DAEMON / DISCORD / WEB 共用）
│   └── utils/model/          ← 模型設定、provider 偵測
├── reference/hermes-agent/   ← 唯讀 Hermes 原始碼（.gitignore）
├── tests/integration/        ← 整合測試
├── scripts/llama/            ← llama.cpp server 部署
└── .claude/                  ← Claude Code 設定
    ├── commands/             # slash 指令（/project-* 等）
    ├── agents/               # subagents（reviewer / tester）
    ├── hooks/                # 3 個 hook 腳本
    ├── skills/               # 專案開發 skills
    └── settings.json         # 權限與 hooks
```

## 建構與測試指令

```bash
conda activate aiagent           # 每 session 必先
bun install                      # 依賴
bun run build                    # 正式建構
bun run build:dev                # 開發建構（產 cli-dev）
bun run typecheck                # 型別檢查
bun test                         # 全部測試
./cli -p "hello"                 # 冒煙
./cli --model qwen3.5-9b-neo     # 本地模型
```

## 自訂 Slash 指令

| 指令 | 功能 |
|------|------|
| `/project-next` | 找 TODO.md 下一個未完成任務並執行（含載入 skill / 讀 Hermes / 測試 / 提交）。 |
| `/project-status` | 顯示專案進度（唯讀）。 |
| `/project-test` | 跑完整測試套件（typecheck → unit → integration → build）。 |
| `/project-review-hermes` | 分析 Hermes 指定模組（唯讀，提方案等決定）。 |
| `/project-create-skill` | 手動建立新 skill。 |

## Subagents

`.claude/agents/` 下：`reviewer`（程式碼審查 / 不寫 code）與 `tester`（QA 驗證 / 寫測試報告）。Claude Code 依任務內容自動調度。

---

## 進階文件索引

| 主題 | 路徑 |
|------|------|
| **ADR 完整列表**（含已推翻） | `docs/adr.md` |
| **架構深入 + 關鍵原始碼檔案** | `docs/context-architecture.md` |
| **設定檔 / hooks / 權限** | `docs/config-reference.md` |
| **開發日誌 2026 Q2** | `docs/dev-log/2026-Q2.md` |
| **從官方 Claude Code 遷移** | `docs/migrating-from-claude-code.md` |
| **使用者手冊** | `docs/user-manual.md` |
| **Daemon 模式** | `docs/daemon-mode.md` |
| **Discord 模式** | `docs/discord-mode.md` |
| **Web 模式** | `docs/web-mode.md` |
| **Memory / Session** | `docs/memory.md`、`docs/session-and-memory-management.md` |
| **Cron** | `docs/cron.md`、`docs/cron-wave34.md` |
| **llama.cpp（remote / watchdog）** | `docs/llamacpp-remote.md`、`docs/llamacpp-watchdog.md` |
| **System prompt 客製化** | `docs/customizing-system-prompt.md` |

## 關鍵 ADR 摘要（活的限制）

完整內容見 `docs/adr.md`。日常開發要記得：

- **ADR-005**：不修改 `src/QueryEngine.ts` / `src/services/tools/StreamingToolExecutor.ts`（在 deny list）。Provider 邊界做格式轉譯。
- **ADR-003**：新功能不用 feature flag，直接啟用。
- **ADR-004**：Hermes 唯讀，TypeScript 重寫。
- **ADR-007**：`@anthropic-ai/*` 改 import 自 vendor，不要碰真的 npm 套件。
- **ADR-010**：llama.cpp 設定唯一來源 `~/.my-agent/llamacpp.json`。
- **ADR-011**：Browser 用 puppeteer-core，不用 playwright-core。
- **ADR-021**：llamacpp routing 失敗硬性報錯，不 silent fallback。

## 開發日誌格式

新 session 摘要寫到 `docs/dev-log/<year>-Q<n>.md` 末尾，格式：

```
### YYYY-MM-DD — Session 標題

**範圍**：...
**修改**：...
**踩坑 / 教訓**：...
**未做**：...
```

包含：你做了什麼、修改哪些檔案、還剩什麼、遇到的問題。Milestone 進度走 `TODO.md` 不放 dev log。
