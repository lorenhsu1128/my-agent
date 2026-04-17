# Skill 自主建立：差異分析與整合方案

> **狀態**：M6b 已實作完成（2026-04-17）。SkillManageTool + SKILLS_GUIDANCE + Session Review 改造 + Nudge UI 閉環 + skillImprovement scanSkill + Dream 簡化 + 文件同步。

---

## 第一部分：差異分析

### 架構根本差異

| | Hermes | free-code (M6 現狀) |
|--|--------|-------------------|
| **建立方式** | Agent 在對話中呼叫 `skill_manage` **工具**（6 action） | Dream forked agent 直接**寫檔案**到 `.my-agent/skills/` |
| **安全掃描** | 程式碼層級，在工具內部每次 create/edit/patch/write_file 都執行 | scanSkill() 已實作（8 類 35 regex）但**生產路徑中零呼叫** |
| **掃描失敗處理** | 自動回滾（shutil.rmtree / 恢復原內容） | 無回滾機制 |
| **觸發→建立閉環** | 完整（nudge → 背景評審 → skill_manage → 掃描 → 通知） | **三個斷點**（見下方） |
| **System prompt 引導** | SKILLS_GUIDANCE 每 session 注入 | 未注入（M6-08 標為延後） |

### free-code 的三個斷點

#### 斷點 1：Skill Creation Nudge 無消費端

```
free-code:
  偵測候選 ✅ → 設 appState.pendingSkillCandidate ✅ → [無 UI 讀取] ❌

Hermes:
  計數器觸發 ✅ → _should_review_skills ✅ → _spawn_background_review ✅
  → fork agent 呼叫 skill_manage ✅ → 安全掃描 ✅ → 通知 "💾 Skill created" ✅
```

`pendingSkillCandidate` 設了但沒有對應的 React hook（類似 `useSkillImprovementSurvey`）消費。

#### 斷點 2：AutoDream Phase 7 驗證只在 Prompt 層級

```
free-code:
  Phase 7 prompt 說 "讀 skill-drafts/、驗證 3+ session" ✅
  Dream agent 是否真的執行？[無法確認] ❌
  執行後 scanSkill 驗證？[未呼叫] ❌

Hermes:
  skill_manage(action='create') 工具被呼叫 ✅
  工具內部：驗證 name + frontmatter + 大小 + 衝突 ✅
  工具內部：_security_scan_skill() 程式碼掃描 ✅
  掃描失敗？shutil.rmtree 自動回滾 ✅
```

#### 斷點 3：skillGuard 已實作但未整合

```
free-code:
  scanSkill() 函式：8 類威脅、35 regex ✅
  生產路徑呼叫次數：0 ❌
  autoDream.ts import 了但未呼叫 ❌
  sessionReview 產出 draft 時未掃描 ❌
  skillImprovement 修改 skill 時未掃描 ❌

Hermes:
  scan_skill()：15 類威脅、483 regex ✅
  skill_manage 每次 create/edit/patch/write_file 都呼叫 ✅
  掃描失敗自動回滾 ✅
```

### 功能逐項對比

| 功能 | Hermes | free-code |
|------|--------|-----------|
| Agent 直接建立 skill（對話中） | ✅ `skill_manage(action='create')` | ❌ 無對應工具 |
| Agent 修改 skill（patch） | ✅ `skill_manage(action='patch')` + 模糊匹配 | ⚠️ `applySkillImprovement` 全文重寫（僅已有 project skill） |
| Agent 刪除 skill | ✅ `skill_manage(action='delete')` | ❌ 無 |
| Agent 添加支持檔案 | ✅ `skill_manage(action='write_file')` | ❌ 無 |
| 背景評審 fork | ✅ daemon thread、max_iterations=8 | ✅ forkedAgent、maxTurns=8（Session Review） |
| Nudge → 建立的閉環 | ✅ 完整 | ❌ 斷開（nudge → appState → ???） |
| 安全掃描（程式碼層級） | ✅ 每次 create/edit/patch 都執行 | ❌ scanSkill 存在但未呼叫 |
| 掃描失敗自動回滾 | ✅ shutil.rmtree / 恢復原內容 | ❌ 無 |
| 跨 session 驗證 | ❌ 無（直接建立） | ⚠️ 設計了 3+ session 但只在 prompt 層級 |
| System prompt 引導 | ✅ SKILLS_GUIDANCE 每 session 注入 | ❌ 延後未實作 |
| 建立後通知用戶 | ✅ "💾 Skill created" 摘要 | ❌ 無 |
| 動態加載新 skill | ✅ 下次 session 重建 system prompt | ✅ chokidar 即時偵測 + reload |

### Hermes skill_manage 工具的完整介面

```
action: create | edit | patch | delete | write_file | remove_file
name: string (小寫, ≤64 字, /^[a-z0-9][a-z0-9._-]*$/)
content: string (create/edit 必須, YAML frontmatter + markdown)
old_string: string (patch 必須)
new_string: string (patch 必須)
replace_all: boolean (patch 可選, 預設 false)
file_path: string (write_file/remove_file 必須, 限 references/templates/scripts/assets/)
file_content: string (write_file 必須)
```

**每個 action 的流程**：
- `create`：驗證 name → 檢查衝突 → 驗證 frontmatter（name+description 必須）→ 驗證大小（≤100K 字元）→ 原子寫入 → **安全掃描** → 失敗回滾
- `edit`：讀取現有 → 備份 → 驗證新內容 → 原子寫入 → **安全掃描** → 失敗恢復
- `patch`：讀取 → fuzzy find-and-replace → 驗證結果 → 原子寫入 → **安全掃描** → 失敗恢復
- `delete`：確認存在 → 刪除整個目錄
- `write_file`：驗證子目錄 → 寫入 → **安全掃描** → 失敗清理
- `remove_file`：驗證存在 → 刪除

### Hermes 背景評審的完整流程

```python
# 觸發：_iters_since_skill >= 10（每 10 次工具呼叫）
# 執行：fork AIAgent（同模型、同工具、max_iterations=8）
# 提示：SKILL_REVIEW_PROMPT
# 結果：掃描 tool results，提取成功操作
# 通知：safe_print("💾 Skill created · Memory updated")
# 防遞迴：review_agent._skill_nudge_interval = 0
```

---

## 第二部分：整合方案

### 可重用的 free-code 既有程式碼

| 既有模組 | 重用方式 |
|---------|---------|
| `MemoryTool` | 工具架構範本（call/inputSchema/atomicWrite/injection scan/路徑驗證） |
| `buildTool()` | 工具構建 |
| `scanSkill()` | 安全掃描（已實作，只需接入） |
| `parseSkillFrontmatterFields()` | frontmatter 驗證 |
| `skillChangeDetector` | 新 skill 建立後自動偵測 + reload |
| `useSkillImprovementSurvey` | appState → UI 確認的範本 |
| `applySkillImprovement()` | side-channel LLM 重寫 SKILL.md 的範本 |
| `createAutoMemCanUseTool()` | canUseTool 權限控制範本 |
| `appendSystemMessage` + `createMemorySavedMessage()` | 背景任務通知用戶 |

### 實作步驟

#### Step 1 — 新增 SkillManageTool

**新增**：`src/tools/SkillManageTool/SkillManageTool.ts` + `prompt.ts` + `UI.tsx`

仿照 `MemoryTool` 模式，6 個 action，每個 create/edit/patch/write_file 都在寫入後呼叫 `scanSkill()`，掃描失敗自動回滾。

**修改**：`src/tools.ts` — 註冊（無 feature flag）

#### Step 2 — 注入 SKILLS_GUIDANCE 到 system prompt

在 system prompt 組裝位置加入引導文字，只在 SkillManageTool 可用時注入。

#### Step 3 — Session Review 改為呼叫 SkillManageTool

**修改**：`src/services/selfImprove/sessionReview.ts` + `sessionReviewPrompt.ts`

擴展權限讓 Session Review Agent 可呼叫 SkillManageTool，prompt 引導用 SkillManage(create) 直接建立（取代寫草稿）。完成後通知用戶。

#### Step 4 — Skill Creation Nudge → UI 確認

**新增**：`src/hooks/useSkillCreationSurvey.ts`

仿照 `useSkillImprovementSurvey` 讀取 `appState.pendingSkillCandidate`，用戶確認後呼叫 SkillManageTool 的 create action。

#### Step 5 — skillImprovement 加入安全掃描

**修改**：`src/utils/hooks/skillImprovement.ts` — `applySkillImprovement()` 寫入後呼叫 `scanSkill()` 驗證。

---

## 第三部分：與 AUTODREAM_HERMES_MERGE_ANALYSIS.md 的衝突分析

### M6 已實作的內容（AUTODREAM_HERMES_MERGE_ANALYSIS.md 記錄）

M6 建立了以下程式碼，本整合方案會修改其中部分：

#### 會被修改的 M6 檔案

| M6 檔案 | 本方案的修改 | 衝突性質 |
|---------|------------|---------|
| `sessionReview.ts` | 擴展 canUseTool 權限（允許 SkillManageTool）、改 prompt | **邏輯變更**：從「寫 skill-drafts/」改為「呼叫 SkillManage 建立」。原本的草稿路徑不再使用 |
| `sessionReviewPrompt.ts` | 重寫 Task 1 的引導文字 | **內容替換**：「寫 skill-drafts/<name>.md」改為「呼叫 SkillManage(action='create')」 |
| `consolidationPrompt.ts` | 簡化 Phase 7-8 | **邏輯簡化**：Phase 7（Skill Draft Review）和 Phase 8（Safety Checklist）變為不必要，因為 skill 建立已移至 Session Review 的 SkillManageTool 路徑。Phase 7 可改為「清理殘留的 skill-drafts/」，Phase 8 移除 |
| `autoDream.ts` | `createEnhancedDreamCanUseTool` 的 `.my-agent/skills/` 寫入權限可能不再需要 | **可選移除**：如果 Dream 不再負責升級 skill（由 Session Review + SkillManageTool 接管），Dream 就不需要寫入 skills/ 的權限 |
| `skillImprovement.ts` | `applySkillImprovement()` 後加 `scanSkill()` 呼叫 | **純新增**：不衝突，只是補上安全掃描 |

#### 不需修改的 M6 檔案（無衝突）

| M6 檔案 | 原因 |
|---------|------|
| `memoryNudge.ts` | 記憶 nudge 與 skill 建立無關 |
| `skillCreationNudge.ts` | 偵測邏輯不變，只是消費端（UI hook）會新增 |
| `skillGuard.ts` | 掃描器本身不變，只是會被 SkillManageTool 呼叫 |
| `trajectoryStore.ts` | 軌跡讀寫不變 |
| `SessionReviewTask.ts` | Task UI 不變 |
| `thresholds.ts` | 閾值讀取不變 |
| `AppStateStore.ts` | `pendingSkillCandidate` 型別不變 |
| `backgroundHousekeeping.ts` | 初始化順序不變 |
| `stopHooks.ts` | sessionReview 的觸發方式不變 |
| `Task.ts` | TaskType 不變 |

#### 測試影響

| 測試檔 | 影響 |
|--------|------|
| `enhanced-dream.test.ts` | **需更新**：Phase 7-8 的文字會變 |
| `enhanced-dream-permissions.test.ts` | **需更新**：Phase 7-8 的斷言會變 |
| `session-review.test.ts` | **需更新**：prompt 內容會變 |
| `m6-full-e2e.test.ts` | **需更新**：管線模擬中的 skill-drafts → Dream 升級路徑會被 SkillManageTool 取代 |
| 其餘 6 個測試檔 | **無影響** |

### 衝突解決策略

#### 衝突 1：Session Review 的產出路徑變更

**M6 設計**：Session Review → 寫 `memory/skill-drafts/` → Dream Phase 7 驗證 3+ session → 升級到 `.my-agent/skills/`

**新方案**：Session Review → 呼叫 SkillManageTool → 工具內 scanSkill → 直接建立到 `.my-agent/skills/`

**解決**：
- `memory/skill-drafts/` 目錄保留，但用途從「暫存待升級的草稿」變為「記錄候選的來源」（可選，非必須）
- `trajectoryStore` 不變（仍記錄 session 軌跡，但不再用於 3+ session 計數驗證）
- Dream Phase 7 改為：如果 `memory/skill-drafts/` 有殘留檔案，清理掉（因為 Session Review 已經直接建立了）

#### 衝突 2：Dream 的 skill 寫入權限

**M6 設計**：`createEnhancedDreamCanUseTool` 允許 Dream 寫入 `.my-agent/skills/`

**新方案**：Dream 不再負責建立 skill（由 Session Review + SkillManageTool 接管）

**解決**：兩個選項
- **選項 A**：保留 `createEnhancedDreamCanUseTool`（不移除功能），Dream 仍可在 Phase 5 Skill Audit 時直接建議性寫入。但 Phase 7-8 的主要升級路徑移至 SkillManageTool
- **選項 B**：移除 `.my-agent/skills/` 寫入權限，Dream 恢復為純記憶整合。所有 skill 建立都走 SkillManageTool

**建議選項 B**——職責清晰：Dream 管記憶，SkillManageTool 管 skill。

#### 衝突 3：安全掃描的執行點

**M6 設計**：`scanSkill()` 被 import 但未呼叫，安全檢查在 Phase 8 prompt 文字

**新方案**：`scanSkill()` 在 SkillManageTool 內部程式碼層級呼叫

**解決**：無衝突。SkillManageTool 的程式碼層級掃描完全取代 Phase 8 的 prompt 層級指示。Dream prompt 的 Phase 8 可移除。

### AUTODREAM_HERMES_MERGE_ANALYSIS.md 需同步更新的內容

整合方案實作後，AUTODREAM_HERMES_MERGE_ANALYSIS.md 第六部分的以下段落需要更新：

1. **觸發架構圖**：加入「對話中 agent 呼叫 SkillManageTool」路徑；Session Review 的產出從 `memory/skill-drafts/` 改為 SkillManageTool
2. **Dream Phase 清單**：Phase 7-8 簡化/移除
3. **權限矩陣**：Dream 的 `.my-agent/skills/` 寫入權限移除（如果選方案 B）
4. **安全掃描段落**：標記 scanSkill 已在 SkillManageTool 中被實際呼叫

---

## 第四部分：修改後的完整觸發架構

```
User Turn（每次 query 的模型回應完成後）
    │
    ├─[postSamplingHook] skillImprovement (每 5 user turn)
    │   └─ 改進已有 skill → applySkillImprovement → scanSkill 驗證 ← 補上掃描
    │
    ├─[postSamplingHook] memoryNudge (每 8 user turn)
    │   └─ 偵測偏好 → appState.pendingMemoryNudge
    │
    ├─[postSamplingHook] skillCreationNudge (每 15 tool_use)
    │   └─ 偵測 workflow → appState → useSkillCreationSurvey UI ← 新增 UI
    │       └─ 確認 → SkillManage(create) ← 閉環接通
    │
    ├─[對話中] agent 主動呼叫 SkillManageTool ← 新增（SKILLS_GUIDANCE 引導）
    │   └─ create/edit/patch/delete/write_file/remove_file
    │       → 驗證 + scanSkill + 回滾
    │
    └─[stopHooks] 每次 query 結束
        ├─ extractMemories → 全面記憶提取
        ├─ sessionReview → 呼叫 SkillManage(create) 直接建立 ← 變更
        │   └─ 通知用戶 "Skill created: ..." ← 新增
        └─ autoDream → Phase 1-6 記憶整合 + Phase 9 軌跡修剪
              （Phase 7-8 簡化：Dream 不再負責升級 skill） ← 變更
```

## 第五部分：修改檔案清單

### 新增檔案

| 檔案 | 功能 |
|------|------|
| `src/tools/SkillManageTool/SkillManageTool.ts` | 核心工具（6 action + scanSkill + 回滾） |
| `src/tools/SkillManageTool/prompt.ts` | 工具描述和觸發條件 |
| `src/tools/SkillManageTool/UI.tsx` | 工具結果渲染 |
| `src/hooks/useSkillCreationSurvey.ts` | Nudge → UI 確認 hook |

### 修改檔案

| 檔案 | 修改內容 |
|------|---------|
| `src/tools.ts` | 註冊 SkillManageTool |
| `src/services/selfImprove/sessionReview.ts` | 擴展權限（SkillManageTool）+ 改產出路徑 |
| `src/services/selfImprove/sessionReviewPrompt.ts` | Task 1 改為引導呼叫 SkillManage |
| `src/services/autoDream/consolidationPrompt.ts` | Phase 7-8 簡化 |
| `src/services/autoDream/autoDream.ts` | 移除 `.my-agent/skills/` 寫入權限（選項 B） |
| `src/utils/hooks/skillImprovement.ts` | applySkillImprovement 後加 scanSkill |
| system prompt 注入點 | 加入 SKILLS_GUIDANCE |
| `tests/integration/self-improve/enhanced-dream.test.ts` | 更新 Phase 7-8 斷言 |
| `tests/integration/self-improve/enhanced-dream-permissions.test.ts` | 更新斷言 |
| `tests/integration/self-improve/session-review.test.ts` | 更新 prompt 斷言 |
| `tests/integration/self-improve/m6-full-e2e.test.ts` | 更新管線模擬 |
| `AUTODREAM_HERMES_MERGE_ANALYSIS.md` | 同步更新觸發架構圖和模組清單 |
