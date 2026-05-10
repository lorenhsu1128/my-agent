# 自訂 System Prompt（M-SP）

## 什麼是 M-SP？

M-SP（System Prompt Externalization）把 my-agent 內部的 system prompt 文字從程式碼搬到 `~/.my-agent/system-prompt/` 目錄下的 `.md` 檔，讓你可以直接編輯。下一次 session 啟動時生效。

外部化涵蓋 **29 個 section**，包含：
- 身份宣告 / 任務準則 / 工具使用守則 / 風格規則
- Memory 系統說明
- Proactive 自主模式指示
- QueryEngine 錯誤訊息
- `<user-profile>` 外框、網安聲明

---

## 目錄結構

```
~/.my-agent/system-prompt/
├── README.md                   ← 首次啟動自動生成，含完整檔案清單
├── intro.md                    ← 開頭身份宣告
├── system.md                   ← # System 規則段
├── doing-tasks.md              ← # Doing tasks 準則
├── actions.md                  ← # Executing actions with care
├── using-tools.md              ← # Using your tools
├── tone-style.md               ← # Tone and style
├── output-efficiency.md        ← # Output efficiency
├── proactive.md                ← # Autonomous work（含 {TICK_TAG} / {SLEEP_TOOL_NAME} 插值）
├── skills-guidance.md          ← SkillManage 使用指引
├── numeric-length-anchors.md   ← 字數上限（USER_TYPE=ant 才注入）
├── token-budget.md             ← Token budget 模式
├── scratchpad.md               ← Scratchpad 指引（含 {scratchpadDir} 插值）
├── frc.md                      ← Function Result Clearing（含 {keepRecent} 插值）
├── summarize-tool-results.md
├── default-agent.md            ← subagent 的預設 prompt
├── cyber-risk.md               ← 預設空檔；補網安聲明會插回 intro
├── user-profile-frame.md       ← <user-profile> 外框 header
├── errors/                     ← QueryEngine 送給 LLM 的錯誤訊息
│   ├── max-turns.md            （含 {maxTurns}）
│   ├── max-budget.md           （含 {maxBudgetUsd}）
│   ├── max-structured-output-retries.md  （含 {maxRetries}）
│   └── ede-diagnostic.md       （含 {edeResultType} / {edeLastContentType} / {lastStopReason}）
└── memory/                     ← Memory 系統說明（不自動 seed，可手動建立）
    ├── types-combined.md
    ├── types-individual.md
    ├── what-not-to-save.md
    ├── drift-caveat.md
    ├── when-to-access.md
    ├── trusting-recall.md
    ├── frontmatter-example.md
    └── combined-template.md
```

---

## 首次啟動種檔

**第一次跑 my-agent 時**，如果 `~/.my-agent/system-prompt/` 不存在，會自動建立並寫入 15 個預設 .md 檔（靜態段、動態段、cyber-risk、user-profile-frame、errors/*）加上一份 README.md。

> memory/* 有 8 個區段因內容龐大（每個 ~4K tokens），預設不 seed。你可以手動建立，或留空讓程式用內建值。

```bash
my-agent -p "hi"
# → 自動 seed 完成

ls ~/.my-agent/system-prompt/
cat ~/.my-agent/system-prompt/README.md   # 讀完整清單 + 時機說明
```

**已經有目錄的使用者**：升級到 M-SP 後不會覆蓋或補寫任何檔案。若要拿到最新預設，刪掉整個 system-prompt 目錄，重啟即可重新 seed。

---

## 解析優先序

每個 section 獨立判斷，順序：

1. `~/.my-agent/projects/<slug>/system-prompt/<filename>` — **Per-project 覆蓋**
2. `~/.my-agent/system-prompt/<filename>` — **Global 層**（通常由 seed 自動建立）
3. Bundled 預設 — 程式內建，永遠存在

**完全取代，不合併。** 檔案存在就整段採用；若要回到預設，刪檔即可。

---

## Per-project 覆蓋

只想在某個專案改提示，不動 global：

```bash
# Slug 是專案 git root 的 sanitized 路徑（與 memdir / USER.md 同一套規則）
SLUG="C--Users-LOREN-Documents--projects-my-agent"

mkdir -p ~/.my-agent/projects/$SLUG/system-prompt
cp ~/.my-agent/system-prompt/tone-style.md \
   ~/.my-agent/projects/$SLUG/system-prompt/

vim ~/.my-agent/projects/$SLUG/system-prompt/tone-style.md
```

Slug 的真實路徑可透過既有 M-UM / M2 機制看出（`~/.my-agent/projects/<slug>/USER.md` 的目錄）。

---

## 變數插值

少數 section 的預設內容帶有 `{var}` 佔位符，由程式注入 session-specific 值：

| Section | 插值變數 | 說明 |
|---------|---------|------|
| scratchpad | `{scratchpadDir}` | session 專屬暫存目錄絕對路徑 |
| frc | `{keepRecent}` | 保留最近幾筆 tool result |
| proactive | `{TICK_TAG}` / `{SLEEP_TOOL_NAME}` | 自主模式相關常數 |
| errors/max-turns | `{maxTurns}` | 遭遇上限的 turn 數 |
| errors/max-budget | `{maxBudgetUsd}` | 預算上限（USD） |
| errors/max-structured-output-retries | `{maxRetries}` | 重試次數 |
| errors/ede-diagnostic | `{edeResultType}` / `{edeLastContentType}` / `{lastStopReason}` | 診斷資訊 |

只識別白名單變數；其他 `{...}` 原樣保留。

---

## 編輯後生效時機

Session 啟動時凍結快照（與 USER.md / MEMORY.md 同一心智模型）。

**需要開新 session 才會套用編輯**。若你在 REPL 中改檔，不會影響當前對話——結束重開即可。

---

## 例外：程式仍會走原組裝的情境

極少數情況下，.md 會被略過，走程式端組裝：

| 檔案 | 例外條件 |
|------|---------|
| intro | outputStyle 啟用（需動態改措辭為 "Output Style"） |
| tone-style / output-efficiency / doing-tasks | `USER_TYPE=ant`（有額外 bullets） |
| using-tools | REPL 模式 / embedded search tools / 無 TaskCreate（工具集異於預設） |
| proactive | `BRIEF_PROACTIVE_SECTION` 尾段仍由程式條件 append（KAIROS-only） |

這些例外主要影響 Anthropic 內部 `ant` 模式與特殊 feature flag，在一般 my-agent 使用情境下都不會觸發。

---

## 驗證實際注入的內容

用 dump 腳本印出當前 session 會載入的全部 section：

```bash
bun scripts/dump-system-prompt.ts             # live：讀 snapshot（含 seed）
bun scripts/dump-system-prompt.ts --no-external  # bundled only
```

---

## 復原

### 回到某段的預設

```bash
rm ~/.my-agent/system-prompt/intro.md
# 下次啟動該段會走 bundled fallback；my-agent 不會補寫檔
```

### 完全重置

```bash
rm -rf ~/.my-agent/system-prompt
my-agent -p "hi"   # 重新 seed
```

> 刪個別檔不會重 seed；只有整個目錄不存在才會觸發。

---

## 注意事項

- 純 `.md` 文字，不支援 frontmatter / 條件語法。
- 寫空檔會注入空字串（合法覆蓋），**不會** fallback 回預設——若要 fallback 請刪檔。
- 程式內的條件分支（USER_TYPE、feature flag、isReplModeEnabled 等）仍在 TypeScript 決定；你編輯的是「要注入的字串」，不是組裝邏輯。
- 工具名（`Read` / `Edit` / `Bash` 等）在 .md 裡是字面字串；如果未來工具改名，.md 需手動同步（典型使用情境下工具名穩定）。

---

## 相關文件

- `docs/context-architecture.md` — 上下文組成整體架構
- `docs/archive/M_SP_PLAN.md` — M-SP 完整實作計畫（已歸檔）
- `docs/plans/M-SP-FULL.md` — M-SP-FULL（per-cwd snapshot + override.md + sub-LLM）
- `~/.my-agent/system-prompt/README.md` — seed 時自動寫入的使用者指引
- ADR-008-A — M-SP-FULL 補充修正（per-cwd snapshot bug 修復、override 機制、sub-LLM 範圍取捨）

---

## M-SP-FULL（2026-05-10）新增能力

### Per-cwd snapshot（修 daemon multi-project bug）

原 M-SP 的 snapshot 是 module-level singleton，daemon 模式下多 project 共用一份，per-project section 永不被讀。M-SP-FULL Phase 1 改成 `Map<projectKey, snapshot>`：daemon attach project 時自動載入該 cwd 的 snapshot；REPL 走 process cwd。**對使用者無感**——只是「per-project 設定真的能 work」。

### `system-prompt-override.md` / `system-prompt-append.md`（一檔換整套人格）

兩個 sibling 檔（與 `system-prompt/` 同層）：

```
~/.my-agent/system-prompt-override.md   ← 整段替代 default 主 prompt（global）
~/.my-agent/system-prompt-append.md     ← 追加在最後（global）
~/.my-agent/projects/<slug>/system-prompt-override.md  ← per-project
~/.my-agent/projects/<slug>/system-prompt-append.md    ← per-project
```

- **override.md**：首次啟動會 seed default 完整字串當編輯起點。整段替代後 my-agent 升級不會自動同步 default（要回到 default 就刪檔重啟）。
- **append.md**：預設不 seed，需要追加時自己建。
- 空字串 / 純 HTML 註解視為「未啟用」（不傳給 LLM）。
- 優先序：per-project > global > 無。
- 適合「桌寵伴侶」、「Linus 風格 reviewer」、「特定領域對話人格」等整套切換。
- **配套修正**：當 override / `--system-prompt` 啟用時，hardcoded CLI prefix（「You are a my-agent agent...」）會被自動跳過；llamacpp adapter 也會跳過 `streamWithRetryOnEmptyTool` 的 retry nudge，避免人格被預設行為蓋過。

### 5 個 Sub-LLM Prompt 外部化（`~/.my-agent/system-prompt/subllm/`）

| 檔名 | 用途 | 變數 |
|------|------|------|
| `cron-parser.md` | 自然語言 → 5-field cron 翻譯 | — |
| `memory-selector.md` | 記憶相關性挑選（Sonnet） | `{maxFiles}` |
| `verification-agent.md` | Verification subagent 系統提示 | `{BASH_TOOL_NAME}` `{WEB_FETCH_TOOL_NAME}` |
| `tool-use-summary.md` | ≤30 字元 git-commit 風格工具摘要 | — |
| `buddy-companion.md` | Buddy 伴侶介紹 | `{name}` `{species}` |

變數用單花括號 `{x}` 格式（snapshot.interpolate 處理；未識別的 key 維持原樣）。

**未外部化的 sub-LLM**（見 `docs/prompt-inventory.md` 的「M-SP 狀態」欄）：
- 已自有外部化機制：SessionMemory template/prompt（`~/.my-agent/session-memory/`）、MagicDocs prompt（`~/.my-agent/magic-docs/`）
- 動態 builder（不適合純 .md）：agent-tool prompt（200 行 9+ feature flag 分支）、extractMemories 4 條（composition + 6 個工具名插值）—— 留 M-SP-SUBLLM-COMPOSITION milestone

### 桌寵 / 多人格使用模式

完成 M-SP-FULL 後，桌寵與多人格切換的最簡解法：

```bash
# 桌寵的 daemon 用獨立 cwd
mkdir -p ~/.my-agent/mascot-workspace
echo "你是一隻名叫小橘的桌寵貓..." > ~/.my-agent/projects/<mascot-slug>/system-prompt-override.md

# 同時跑 REPL 程式助理（cwd 在專案目錄）+ 桌寵 daemon（cwd 在 mascot-workspace）
# 兩個 cwd 各自的 snapshot 獨立，零 my-agent 程式碼改動
```

---

最後更新：M-SP-FULL（2026-05-10）— 加入 per-cwd snapshot + override.md/append.md + 5 sub-LLM 外部化
