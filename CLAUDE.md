# CLAUDE.md

## 專案概述

本專案是 free-code — Claude Code（TypeScript/Bun）的可建構 fork 版本，已移除遙測、移除安全護欄、解鎖所有實驗功能。我們正在擴充它，加入多 provider 支援、本地模型能力，以及從 Hermes Agent（Nous Research）移植的功能。

Hermes Agent 的原始碼作為唯讀參考資料放在 `reference/hermes-agent/`。它是 Python — 閱讀它以理解設計和邏輯，然後用 TypeScript 在 free-code 的既有架構內重新實作。

## 黃金規則

1. **永遠先啟動 conda 環境。** 在執行任何指令之前 — 建構、測試、安裝或腳本執行 — 都要先執行 `conda activate aiagent`。這適用於每個 session 的每一條終端指令。如果開了新的 shell 或不確定環境是否啟用，在繼續之前再次執行 `conda activate aiagent`。

2. **保留 free-code 的既有程式碼。** 不要刪除或重寫現有檔案。透過擴充來新增功能，而非替換。當你需要修改現有檔案時，做最小必要的更改，並確保在新 provider 未啟用時原始行為完全不變。

3. **Hermes 程式碼僅供參考。** 絕不直接複製 Python 程式碼。閱讀 `reference/hermes-agent/` 以理解功能的設計和運作方式，然後撰寫符合 free-code 架構（React/Ink UI、Tool 基礎類別、services 模式等）的道地 TypeScript 程式碼。

4. **新的 provider 程式碼放在 `src/services/providers/`。** 這是用於多 provider 支援的新目錄。每個 provider 有自己的檔案。既有的 `src/services/api/` 保持不動，作為 Anthropic 原生路徑。

5. **每次功能性修改後都要測試。** TypeScript 變更後執行 `bun run typecheck`。針對受影響的 provider/工具執行整合測試。如果測試還不存在，先寫測試。

6. **提交可運作的狀態。** 每個邏輯單元的工作在編譯通過並通過測試後就提交。使用約定式提交格式：`feat(providers): ...`、`fix(proxy): ...`、`test(tools): ...`、`docs: ...`。

7. **遇到架構決策時，停下來問我。** 不要自行做結構性決定。提出 2-3 個方案及其取捨，等我選擇。例如：新模組放在哪裡、如何處理協議差異、是否要加新的依賴。

8. **每次 session 開始時讀取 LESSONS.md。** 此檔案記錄了過去犯過的錯誤和踩過的坑。在開始任何工作之前先讀取它，避免重蹈覆轍。當你在開發中修復了一個 bug、回退了一個錯誤做法、或發現了一個非預期的行為時，立即在 LESSONS.md 的對應分類下附加一條記錄。

9. **適時建立新的 skill。** 當你完成一個複雜或重複性高的任務後，評估這個經驗是否值得記錄成 skill。判斷標準：
   - 這個任務涉及了不明顯的步驟或陷阱嗎？
   - 未來可能會再次需要做類似的事嗎？
   - 這個知識是否專屬於本專案、不容易從外部文件查到？
   
   如果判斷值得建立 skill：
   - 先告訴我你打算建立什麼 skill、為什麼認為有價值、大致內容摘要
   - 等我確認後，在 `skills/` 下建立新目錄和 SKILL.md
   - 遵循既有 skill 的格式（說明、工具集、具體內容）
   - 在 TODO.md 的 session 日誌中記錄新建了哪個 skill
   
   人類也可以隨時指示你建立 skill，此時直接執行不需評估。

## 倉庫結構

```
free-code/
├── CLAUDE.md              ← 你正在讀的這份文件
├── TODO.md                ← 任務追蹤 — 你負責讀寫此文件
├── LESSONS.md             ← 教訓記錄 — 你和人類都可以讀寫
├── src/
│   ├── services/
│   │   ├── api/           ← 既有 — Anthropic 原生 API（不要重組）
│   │   └── providers/     ← 新增 — 多 provider 支援
│   │       ├── index.ts           # Provider 註冊表與工廠
│   │       ├── types.ts           # Provider 介面定義
│   │       ├── litellm.ts         # LiteLLM proxy provider
│   │       ├── anthropicAdapter.ts # 將既有 api/ 封裝為 provider
│   │       └── toolCallTranslator.ts # Anthropic ↔ OpenAI 工具格式轉譯
│   ├── tools/             ← 既有 — 39 個 agent 工具（擴充，不要替換）
│   ├── commands/           ← 既有 — slash 指令
│   ├── ...                ← 所有其他既有目錄
│   └── utils/
│       └── providers/     ← 新增 — provider 相關工具函式
├── reference/
│   └── hermes-agent/      ← 唯讀的 Hermes 原始碼（在 .gitignore 中）
├── tests/
│   └── integration/       ← 新增 — provider 和工具整合測試
├── skills/                ← Claude Code 專用的開發技能檔案
└── .claude/               ← Claude Code 設定、指令、hooks、agents
```

## 需要理解的關鍵檔案（free-code）

在修改任何東西之前，先閱讀這些以理解 free-code 的運作方式：

- `src/tools.ts` — 工具註冊表。所有 39 個工具在此註冊。使用 `feature()` 做 flag 控制。
- `src/Tool.ts` — 工具基礎介面（792 行）。所有工具都實作此介面。
- `src/QueryEngine.ts` — 核心 LLM 查詢引擎（1,295 行）。處理查詢分發、工具呼叫迴圈、用量追蹤。
- `src/services/api/client.ts` — 當前 API 客戶端（Anthropic SDK 封裝）。
- `src/services/api/claude.ts` — 串流處理和用量累計。
- `src/services/tools/StreamingToolExecutor.ts` — 串流工具執行（530 行）。
- `src/services/tools/toolExecution.ts` — 工具生命週期管理（1,745 行）。
- `src/utils/model/` — 模型設定、provider 偵測、驗證。
- `src/bootstrap/state.ts` — 應用程式初始化狀態（1,758 行）。

## 需要參考的關鍵檔案（Hermes Agent）

實作 provider 功能時，研讀以下 Hermes 檔案：

- `reference/hermes-agent/agent/auxiliary_client.py` — 多 provider 客戶端抽象
- `reference/hermes-agent/hermes_cli/auth.py` — Provider 註冊表、ProviderConfig、憑證處理
- `reference/hermes-agent/agent/model_metadata.py` — 上下文長度偵測鏈
- `reference/hermes-agent/run_agent.py` — Hermes 如何路由到不同 provider

## 建構與測試指令

```bash
conda activate aiagent           # 每個 session 一定要先執行這個
bun install                      # 安裝依賴
bun run build                    # 正式建構
bun run build:dev                # 開發建構
bun run typecheck                # 僅型別檢查
bun test                         # 執行測試
./cli -p "hello"                 # 快速冒煙測試
./cli --model qwen3.5:9b         # 使用本地模型測試（M1 完成後）
```

## 自訂 Slash 指令

使用這些指令取代打冗長的 prompt：

| 指令 | 功能 |
|------|------|
| `/project:next` | 找到 TODO.md 中下一個未完成的任務並開始執行。載入相關 skill、讀取 Hermes 程式碼（如需要）、執行、測試、提交。 |
| `/project:status` | 顯示專案進度（TODO 計數、最近 commit、typecheck 結果、服務健康狀態）。唯讀 — 不修改任何東西。 |
| `/project:test` | 執行完整測試套件（typecheck → 單元測試 → 整合測試 → 建構檢查）。報告結果但不自動修復。 |
| `/project:review-hermes` | 分析 Hermes Agent 的指定模組（provider、memory、tools、cron、gateway、skills、agent）。唯讀分析 — 提出設計方案等我決定。 |
| `/project:create-skill` | 手動建立新 skill。指定主題後，Claude Code 在 `skills/` 下建立目錄和 SKILL.md。 |

## Agents

用 `/agent:名稱` 切換到專門角色：

| Agent | 角色 |
|-------|------|
| `/agent:reviewer` | 僅做程式碼審查。檢查架構合規性、程式碼品質、整合安全性、測試覆蓋。不寫程式碼。 |
| `/agent:tester` | 僅做 QA 測試。驗證功能、找 bug、測試邊界情況。提供含重現步驟的測試報告。 |

## Hooks（自動執行 — 不需手動介入）

這些透過 `.claude/settings.json` 自動運作：

| Hook | 觸發時機 | 動作 |
|------|---------|------|
| `pre-tool-use-conda.sh` | 任何 Bash/Terminal 指令執行前 | 驗證 `conda activate aiagent` 已啟用。未啟用則阻擋執行。 |
| `post-tool-use-typecheck.sh` | 任何 .ts/.tsx 檔案被編輯後 | 自動執行 `bun run typecheck`。報告通過/失敗。 |
| `notification-session-end.sh` | Session 結束時 | 將 session 摘要附加到 TODO.md。發送桌面通知。 |

## 權限設定（`.claude/settings.json`）

已預先核准的操作（不會彈出確認提示）：
- 任何檔案的讀取操作
- 在 `src/services/providers/`、`src/utils/providers/`、`tests/`、`TODO.md` 的寫入/編輯
- Shell 指令：conda、bun、git、curl localhost、ollama、litellm、cat/ls/find/grep 等

已封鎖的操作（會被拒絕）：
- `rm -rf`、`sudo`、`chmod`
- 寫入 `src/QueryEngine.ts`、`src/Tool.ts`（核心檔案 — 先問我）
- 寫入 `reference/`（唯讀的 Hermes 原始碼）

## 當前開發狀態

### 已完成
（尚無 — 專案剛開始）

### 進行中
（參見 TODO.md）

### 已做出的架構決策
- ~~ADR-001：使用 LiteLLM 作為本地模型的 proxy（不是直接整合 Ollama）~~ **已推翻（2026-04-15）** — 改為直接跑 llama.cpp server（OpenAI 相容，`http://127.0.0.1:8080/v1`）。理由：部署已完成（見 `scripts/llama/`）、少一層中介、減少相依性。
- ADR-002：新的 provider 程式碼放在 `src/services/providers/`，不修改 `src/services/api/`
- ADR-003：新功能不使用 feature flag — 所有功能直接啟用
- ADR-004：Hermes 原始碼作為唯讀參考，用 TypeScript 重新實作
- ADR-005（2026-04-15）：provider 內部做格式轉譯（OpenAI SSE → Anthropic `stream_event`），保持 `QueryEngine.ts` 與 `StreamingToolExecutor.ts` 零修改。理由：這兩個檔案在 `.claude/settings.json` 的 deny list；在 provider 邊界做轉譯讓下游主幹無感。
- ADR-006（2026-04-15）：Qwen3.5-Neo 的 `reasoning_content` 映射為 Anthropic `thinking` content block。理由：模型把 CoT 放 `reasoning_content`、答案放 `content`，對應到 Anthropic 的 thinking block 在語意上最貼近，也保留 UI 顯示 CoT 的能力。

---

## 開發日誌

> Claude Code：在這行下方附加你的 session 摘要。
> 格式：`### YYYY-MM-DD — Session 標題`
> 包含：你做了什麼、修改了哪些檔案、還剩什麼、遇到的問題。

---
