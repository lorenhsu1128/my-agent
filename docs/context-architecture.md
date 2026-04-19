# free-code 上下文組成詳解

## 📋 System Prompt 注入架構

Free-code 的 system prompt 採用**模組化、可快取的設計**，透過 `src/constants/prompts.ts` 的 `getSystemPrompt()` 函式組裝。

### 架構圖

```
┌─────────────────────────────────────────────────────────────────┐
│                     SYSTEM PROMPT 組成                           │
├─────────────────────────────────────────────────────────────────┤
│  1. 靜態內容 (Static - 可快取)                                  │
│     ├── Simple Intro (You are my-agent...)                      │
│     ├── System Rules (Tools, Actions, Tone)                     │
│     └── Output Efficiency (Be concise...)                       │
├─────────────────────────────────────────────────────────────────┤
│  2. 邊界標記 (Boundary)                                        │
│     └── SYSTEM_PROMPT_DYNAMIC_BOUNDARY                          │
├─────────────────────────────────────────────────────────────────┤
│  3. 動態內容 (Dynamic - 每 turn 更新)                            │
│     ├── Session Guidance (工具使用提示)                          │
│     ├── User Profile (USER.md persona)                          │
│     ├── Memory Context (memdir files)                           │
│     ├── MCP Instructions (已連接的 MCP servers)                 │
│     ├── Language (繁體中文)                                    │
│     ├── Output Style (output style config)                      │
│     └── Environment (CWD, git, OS, platform, model)             │
└─────────────────────────────────────────────────────────────────┘
```

### 關鍵檔案

| 檔案 | 功能 | 重要性 |
|------|------|--------|
| `src/constants/prompts.ts` | 主組裝邏輯，條件式注入 | ⭐⭐⭐ |
| `src/userModel/prompt.ts` | User Profile 區塊格式化 | ⭐⭐ |
| `src/memdir/memdir.js` | Memory Context 載入 | ⭐⭐ |
| `src/utils/settings/settings.js` | 設定讀取 | ⭐ |

### 範例注入順序（簡化）

```typescript
// src/constants/prompts.ts L445-585
return [
  // 1. 靜態內容
  getSimpleIntroSection(outputStyleConfig),
  getSimpleSystemSection(),
  getOutputEfficiencySection(),
  
  // 2. 邊界標記
  ...(shouldUseGlobalCacheScope() ? [SYSTEM_PROMPT_DYNAMIC_BOUNDARY] : []),
  
  // 3. 動態內容
  ...resolvedDynamicSections,  // 包含：
    // - session_guidance (工具使用)
    // - user_profile (USER.md) ← M-UM
    // - memory (memdir files) ← M2
    // - env_info (環境資訊)
    // - ...
].filter(s => s !== null)
```

---

## 1. M-UM User Modeling 雙層設計

### 雙層儲存架構

```
┌─────────────────────────────────────────────────────────────┐
│                    USER.md 雙層設計                          │
├─────────────────────────────────────────────────────────────┤
│  Global USER.md (跨專案)                                    │
│  └─ 位置：~/.my-agent/USER.md                                │
│  └─ 內容：個人身份、語言偏好、工作風格                         │
│  └─ 範例：                                                   │
│     - 主要語言：繁體中文                                      │
│     - Shell: PowerShell (Windows 11)                         │
│     - 偏好：簡潔回應，不冗長                                  │
├─────────────────────────────────────────────────────────────┤
│  Per-Project USER.md (專案專屬)                              │
│  └─ 位置：~/.my-agent/projects/{slug}/USER.md                │
│  └─ 內容：專案特定角色、目標、約束                             │
│  └─ 範例：                                                   │
│     - 本專案用 Bun 而非 Node                                 │
│     - 角色：PM (review 設計，不寫程式)                         │
│     - 專案截止日：2026-05-01                                  │
└─────────────────────────────────────────────────────────────┘
```

### 合併邏輯

```typescript
// src/userModel/userModel.ts L54-59
function buildCombined(global: string, project: string): string {
  const blocks: string[] = []
  if (global) blocks.push(global)
  if (project) blocks.push(`### Project-specific\n\n${project}`)
  return blocks.join('\n\n')
}
```

### 範例輸出

```markdown
<user-profile>
# About the user

The following is a curated profile of the user you are talking to. Treat it as durable context that applies throughout the session.

- 主要語言：繁體中文 (Traditional Chinese)
- Shell: PowerShell (Windows 11)
- 偏好：簡潔回應，不冗長

### Project-specific

- 本專案用 Bun 而非 Node
- 角色：PM (review 設計，不寫程式)
- 專案截止日：2026-05-01
</user-profile>
```

### 注入位置

```typescript
// src/constants/prompts.ts L497
systemPromptSection('user_profile', () => loadUserProfilePrompt())
```

---

## 2. M2 Memory System 記憶上下文

### 記憶載入流程

```
┌─────────────────────────────────────────────────────────────────┐
│                    Memory Context 載入                          │
├─────────────────────────────────────────────────────────────────┤
│  1. FTS5 搜尋歷史對話                                         │
│     └─ src/services/sessionIndex/SQLite FTS5                    │
│        └─ 索引所有 session JSONL 檔案                            │
│        └─ 搜尋關鍵字：query = "上次我們怎麼處理 X"               │
│        └─ 回傳相關片段 (snippets)                               │
├─────────────────────────────────────────────────────────────────┤
│  2. memdir 檔案再排名 (re-rank)                               │
│     └─ src/memdir/四型分類檔案                                 │
│        └─ user_*.md (使用者資訊)                                │
│        └─ feedback_*.md (指導原則)                              │
│        └─ project_*.md (專案決策)                               │
│        └─ reference_*.md (外部系統)                             │
│     └─ Token overlap / 關鍵字匹配再排名                          │
├─────────────────────────────────────────────────────────────────┤
│  3. 構建 Memory Fence                                         │
│     └─ src/memoryPrefetch/budget.ts                             │
│        └─ 預算：2000 tokens (~6000 chars)                        │
│        └─ 格式：<memory-context>[past-sessions]</memory-context> │
├─────────────────────────────────────────────────────────────────┤
│  4. 注入 System Prompt                                        │
│     └─ src/constants/prompts.ts L498                            │
│        └─ 在 user_profile 之後，memory 之前                       │
└─────────────────────────────────────────────────────────────────┘
```

### 範例 Memory Fence

```markdown
<memory-context>[past-sessions]
從歷史對話中找到的相關資訊：

[session-2026-04-18-15-33]
- 用戶問：「上次我們開發了甚麼新功能？」
- 答覆：「最近完成 M-UM 使用者建模，包括雙層 USER.md 和三路開關」

[session-2026-04-18-16-13]
- 用戶：「幫我測試這些新功能」
- 答覆：「M2 記憶系統測試全部通過，126/126」

相關 memdir 檔案：
- user_model.md: 使用者建模指引
- feedback_memory.md: 記憶寫入規則
</memory-context>
```

---

## 3. 完整 System Prompt 範例

### 實際注入的 System Prompt 片段

```markdown
# System

You are an interactive agent that helps users with software engineering tasks.
IMPORTANT: You must NEVER generate or guess URLs for the user unless you are confident...
[更多系統規則...]

# Environment

You have been invoked in the following environment:
Primary working directory: C:\Users\LOREN\Documents\_projects\free-code
Is a git repository: true
Platform: win32
Shell: bash (use Unix shell syntax, not Windows...)
OS Version: Windows 11 Home 10.0.26200

You are powered by the model named qwen3.5-9b-neo. The exact model ID is qwen3.5-9b-neo.

<user-profile>
# About the user

The following is a curated profile of the user you are talking to. Treat it as durable context that applies throughout the session.

- 主要語言：繁體中文 (Traditional Chinese)
- Shell: PowerShell (Windows 11)
- 偏好：簡潔回應，不冗長

### Project-specific

- 本專案用 Bun 而非 Node
- 角色：PM (review 設計，不寫程式)
</user-profile>

<memory-context>[past-sessions]
從歷史對話中找到的相關資訊：
[相關片段...]
</memory-context>

# Tone and style

Only use emojis if the user explicitly requests it. Avoid using emojis...
Your responses should be short and concise.
When referencing specific functions... include file_path:line_number
[更多風格指引...]
```

---

## 4. 上下文更新時機

| 事件 | 更新的上下文部分 | 機制 |
|------|-----------------|------|
| Session 開始 | 所有動態部分 + 快照凍結 | `loadSnapshot()` |
| 每 turn | Memory + MCP + Language | `resolveSystemPromptSections()` |
| User 寫入 USER.md | User Profile | `writeUserModel()` |
| 索引重建 | Memory Context | `ensureReconciled()` |
| MCP 連接 | MCP Instructions | `getMcpInstructionsSection()` |

---

## 5. 性能優化設計

### Prefix Cache 保護

```typescript
// src/constants/prompts.ts L114-116
export const SYSTEM_PROMPT_DYNAMIC_BOUNDARY = '__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__'
```

- **邊界前**：靜態內容，可快取 (`scope: 'global'`)
- **邊界後**：動態內容，不進入 fast prefix cache

### 預算控制

```typescript
// src/userModel/prompt.ts L11
export const USER_PROFILE_SOFT_LIMIT = 1500
```

- User Profile 超過 1500 chars 時附警告
- Memory Context 嚴格限制 2000 tokens

---

## 6. 測試驗證

所有上下文注入機制都有完整測試：

| 測試套件 | 測試數 | 狀態 |
|----------|--------|------|
| `user-model-smoke.ts` | 27 | ✅ 全部通過 |
| `m2-22-smoke.ts` | 61 | ✅ 全部通過 |
| `recall-and-prefetch.ts` | 14 | ✅ 全部通過 |
| `memory-tool-injection.ts` | 52 | ✅ 全部通過 |

---

## 7. 總結表格

| 層級 | 來源 | 更新頻率 | 大小限制 | 主要功能 |
|------|------|----------|----------|----------|
| 靜態 | `prompts.ts` | 每次啟動 | - | 系統規則、行為指引 |
| User Profile | `USER.md` | 每次 turn | 1500 chars | 個人身份、偏好 |
| Memory Context | FTS5 + memdir | 每 turn | 2000 tokens | 歷史對話、檔案指引 |
| Environment | 系統資訊 | 每 turn | - | CWD、git、OS、模型 |
| MCP | MCP servers | 每連接 | - | 外部工具指令 |

這個設計實現了：
- ✅ **穩定性**：靜態內容可快取，減少 API 成本
- ✅ **動態性**：每 turn 更新相關上下文
- ✅ **安全性**：預算控制、邊界保護、injection 防護
- ✅ **可測試性**：完整自動化測試覆蓋

---

## 檔案位置

本文檔已保存至：
- `C:\Users\LOREN\Documents\_projects\free-code\docs\context-architecture.md`

相關源檔案：
- `src/constants/prompts.ts` - 主組裝邏輯
- `src/userModel/prompt.ts` - User Profile 格式化
- `src/memdir/memdir.js` - Memory Context 載入
- `src/services/sessionIndex/` - FTS5 索引系統
- `src/memoryPrefetch/` - Memory fence 生成
- `src/tools/MemoryTool/` - MemoryTool 寫入介面
- `src/systemPromptFiles/` - **M-SP 新增**：system prompt 外部化載入

---

## 8. M-SP — System Prompt 外部化（2026-04-19）

原本寫死在 `prompts.ts` / `memoryTypes.ts` / `QueryEngine.ts` 等檔案的 **29 個 system prompt section**，已全部搬到 `~/.my-agent/system-prompt/` 下的 `.md` 檔，使用者可直接編輯、下一 session 生效。

### 架構

```
bootstrap（setup.ts）
  └─ seedSystemPromptDirIfMissing()   ← 首次啟動自動 seed 15 個檔 + README
  └─ loadSystemPromptSnapshot()        ← session 凍結快照

prompts.ts / memoryTypes.ts / QueryEngine.ts
  └─ getSection(id)                    ← 同步讀凍結快照
  └─ 缺檔 fallback 回各自的 bundled DEFAULT 字串
```

### 解析鏈（每個 section 獨立判斷）

1. `~/.my-agent/projects/<slug>/system-prompt/<filename>` — per-project 覆蓋
2. `~/.my-agent/system-prompt/<filename>` — global（通常由 seed 寫入）
3. Bundled 預設 — 程式內建 fallback

### 變數插值

少數 section 帶 `{var}` 佔位符（如 `{maxTurns}` / `{scratchpadDir}` / `{TICK_TAG}`），由呼叫端透過 `interpolate(template, vars)` 注入。

### 覆蓋的 29 個 section

- **靜態段 8 個**：intro / system / doing-tasks / actions / using-tools / tone-style / output-efficiency / proactive
- **動態條件段 7 個**：skills-guidance / numeric-length-anchors / token-budget / scratchpad / frc / summarize-tool-results / default-agent
- **框架/聲明 2 個**：cyber-risk / user-profile-frame
- **QueryEngine 錯誤訊息 4 個**：errors/max-turns / errors/max-budget / errors/max-structured-output-retries / errors/ede-diagnostic
- **Memory 系統 8 個**：memory/types-combined / memory/types-individual / memory/what-not-to-save / memory/drift-caveat / memory/when-to-access / memory/trusting-recall / memory/frontmatter-example / memory/combined-template

### 詳細使用方法

參見 `docs/customizing-system-prompt.md`（使用者指南）與 `M_SP_PLAN.md`（完整計畫）。
