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
- `~/.my-agent/system-prompt/README.md` — seed 時自動寫入的使用者指引

---

最後更新：M-SP-5（2026-04-19）— 29/29 section 全部外部化完成
