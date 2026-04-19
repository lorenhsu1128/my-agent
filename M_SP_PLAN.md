# M-SP（System Prompt Externalization）實作計畫

## Context

free-code 目前約 **15–16K tokens** 的 system prompt 文字直接寫死在 TypeScript 程式碼裡（`src/constants/prompts.ts` 8 大段 + `src/memdir/memoryTypes.ts`/`teamMemPrompts.ts` 記憶系統說明 + `src/userModel/prompt.ts` 外框）。任何措辭調整都必須改 code → typecheck → build → 重啟，迭代成本高。

本計畫把這些文字外部化到 `~/.my-agent/` 下的 `.md` 檔，使用者可直接編輯並在下一 turn 生效。採用**缺檔用內建、存在就完全取代**的覆蓋語義（與既有 USER.md / MEMORY.md 一致），並支援 **global + per-project** 雙層（`~/.my-agent/projects/<slug>/system-prompt/` 可覆蓋 global）。

**不外部化**（寫死在程式碼內）：
- `SYSTEM_PROMPT_DYNAMIC_BOUNDARY`（`prompts.ts:114`）——cache 架構常數
- 模型 ID 映射表、knowledge cutoff（`prompts.ts:119-126`）——程式邏輯依賴
- 條件分支本身（`USER_TYPE === 'ant'`、`feature('TOKEN_BUDGET')`）——程式碼判斷

**外部化**：`CYBER_RISK_INSTRUCTION`（現為空字串）、`QueryEngine.ts` 4 條錯誤訊息也一併納入。

---

## 目錄結構

```
~/.my-agent/
├── system-prompt/                          # Global 層
│   ├── README.md                           # seed 時自動生成，說明每個檔的用途/時機
│   ├── intro.md                            # prompts.ts:176-185
│   ├── system.md                           # prompts.ts:187-198
│   ├── doing-tasks.md                      # prompts.ts:200-254
│   ├── actions.md                          # prompts.ts:256-268
│   ├── using-tools.md                      # prompts.ts:270-315
│   ├── tone-style.md                       # prompts.ts:431-443
│   ├── output-efficiency.md                # prompts.ts:404-429
│   ├── proactive.md                        # prompts.ts:868-922
│   ├── skills-guidance.md                  # prompts.ts:527
│   ├── numeric-length-anchors.md           # prompts.ts:542
│   ├── token-budget.md                     # prompts.ts:556
│   ├── scratchpad.md                       # prompts.ts:810-826
│   ├── frc.md                              # prompts.ts:829-847
│   ├── summarize-tool-results.md           # prompts.ts:849
│   ├── default-agent.md                    # prompts.ts:766
│   ├── cyber-risk.md                       # cyberRiskInstruction.ts:24（預設空檔）
│   ├── user-profile-frame.md               # userModel/prompt.ts:28-34
│   ├── errors/
│   │   ├── max-turns.md                    # QueryEngine.ts:874
│   │   ├── max-budget.md                   # QueryEngine.ts:1003
│   │   ├── max-structured-output-retries.md # QueryEngine.ts:1047
│   │   └── ede-diagnostic.md               # QueryEngine.ts:1116
│   └── memory/
│       ├── types-combined.md               # memoryTypes.ts:37-106
│       ├── types-individual.md             # memoryTypes.ts:113-178
│       ├── what-not-to-save.md             # memoryTypes.ts:183-195
│       ├── drift-caveat.md                 # memoryTypes.ts:201-202
│       ├── when-to-access.md               # memoryTypes.ts:216-222
│       ├── trusting-recall.md              # memoryTypes.ts:240-256
│       ├── frontmatter-example.md          # memoryTypes.ts:261-271
│       └── combined-template.md            # teamMemPrompts.ts:22-100
│
└── projects/<slug>/system-prompt/          # Per-project 層（使用者主動 opt-in）
```

## 核心行為

- **首次啟動種子**：`~/.my-agent/system-prompt/` 不存在 → 自動 mkdir + 寫入完整預設 + README.md。已存在則不動，不補寫缺檔。
- **路徑解析**：per-project > global > bundled fallback。每個 section 獨立判斷。
- **完全取代**：使用者檔案存在就整段取代，不做三層合併。
- **快取**：session 啟動凍結，per-turn 無 IO。編輯需開新 session 生效。

## 實作模組

新增 `src/systemPromptFiles/`：
- `paths.ts` — global/project 路徑計算，複用 `memdir/paths.ts:sanitizePath`
- `loader.ts` — `loadSystemPromptSection(sectionId)` per-project > global > bundled
- `bundledDefaults.ts` — 所有預設字串 + README 模板
- `sections.ts` — sectionId 常數表 + metadata
- `seed.ts` — 首次啟動種檔
- `snapshot.ts` — 沿用 `userModel.ts` 的 `loadSnapshot/getSnapshot/invalidate` 模式

## 分階段交付（總計 ~9–10 天）

- **M-SP-1（~3.5 天）**：基礎設施 + 8 大靜態段 + seed + README
- **M-SP-2（~1 天）**：動態段 fallback 字串（skills_guidance / numeric_length / token_budget / scratchpad / frc / summarize / default_agent / proactive）
- **M-SP-3（~0.5 天）**：user-profile-frame + cyber-risk
- **M-SP-4（~3 天）**：memory 系統 8 個常數
- **M-SP-4.5（~0.5 天）**：QueryEngine.ts 4 條錯誤訊息 + `{var}` 插值
- **M-SP-5（~1 天）**：per-project 驗證 + 文件

## 驗證

- **回歸**：`./cli -p "hi"` 首次啟動 byte-level diff = 0（用 `scripts/dump-system-prompt.ts` 腳本）
- `bun run typecheck` 綠
- 既有整合測試：memory 154 個、user-model 27 個全綠
- **新功能**：
  1. 建立 `~/.my-agent/system-prompt/intro.md` 寫自訂內容 → 下一 session 生效
  2. per-project 覆蓋 global 順序正確
  3. 刪除檔案回到 bundled
  4. 空檔 / 超長檔案不 crash
  5. 刪除整個目錄重啟會重新 seed

## 風險

| 風險 | 緩解 |
|------|------|
| 搬字串 typo | dump + diff 腳本逐 commit 比對 |
| Memory 常數多處 import | 先 grep 所有引用點 |
| 使用者寫空檔 | 文件明示；空字串是合法覆蓋 |
| Windows BOM | readFileSafe 剝 BOM |
| 編輯後不即時生效 | 文件明寫「需新 session」，與 USER.md 一致 |

## 不做

- 不做 frontmatter / 條件語法（保持純 .md）
- 不做熱重載
- 不做三層合併 / append 語義
- 不外部化 `SYSTEM_PROMPT_DYNAMIC_BOUNDARY`、模型映射表、knowledge cutoff
- `Tool.ts` 不動（無 prompt 文字）
- 條件分支留在 TS

## 使用者體驗

```bash
./cli -p "hi"                                    # 首次啟動自動 seed
cat ~/.my-agent/system-prompt/README.md          # 先讀說明
vim ~/.my-agent/system-prompt/intro.md           # 改語氣
rm ~/.my-agent/system-prompt/intro.md            # 回到該段預設
rm -rf ~/.my-agent/system-prompt && ./cli -p "hi"  # 全重置
```
