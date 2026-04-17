# AutoDream × Hermes Self-Improving Loop 合併方案分析

> **狀態**：M6 全部三階段已實作完成（2026-04-17）。第一至四部分為設計階段的分析記錄，第五部分為實作結果，第六部分為最終系統架構總覽。

## Context

本文分析 free-code 現有的 AutoDream（背景記憶整合）與 Hermes Agent 的 self-improving loop（即時自我改進迴圈）合併的可行方案、效果差異，以及與原本 AutoDream 的對比。

---

## 第一部分：現有系統深度剖析

### 1.1 AutoDream — free-code 的記憶整合系統

#### 觸發機制（三重門，cheapest-first）

```
Gate 1: 時間門
  ├─ (Date.now() - lockFile.mtime) >= minHours (預設 24h)
  └─ 成本：1 次 stat() 呼叫

Gate 2: Session 計數門
  ├─ 掃描 transcript 目錄，找 mtime > lastConsolidatedAt 的 .jsonl 檔案
  ├─ 排除當前 session（mtime 總是最新）
  ├─ 需要 >= minSessions (預設 5)
  └─ 掃描限流：10 分鐘內不重複掃描（SESSION_SCAN_INTERVAL_MS = 600000）

Gate 3: 鎖定門
  ├─ 讀取 .consolidate-lock 內的 PID
  ├─ 檢查 PID 是否存活 (isProcessRunning)
  ├─ HOLDER_STALE_MS = 1 小時（防止 PID 重用）
  └─ 多進程競爭時最後寫入者獲勝
```

**禁止條件（無論何時直接 return）**：
- KAIROS mode 啟用
- Remote mode
- Auto-memory 未啟用
- `isAutoDreamEnabled()` 返回 false

#### 執行流程

```
stopHooks.ts:154  (fire-and-forget, 僅主執行序)
  └─ autoDream.ts: executeAutoDream()
      ├─ isGateOpen() → 三重門檢查
      ├─ tryAcquireConsolidationLock() → 搶鎖
      ├─ buildConsolidationPrompt() → 組裝 4 階段 prompt
      ├─ registerDreamTask() → 註冊到 Task UI
      └─ runForkedAgent({
           promptMessages: [consolidation prompt],
           cacheSafeParams: createCacheSafeParams(context),
           canUseTool: createAutoMemCanUseTool(memoryRoot),
           querySource: 'auto_dream',
           forkLabel: 'auto_dream',
           skipTranscript: true,    // 不記錄 sidechain
           maxTurns: undefined,     // 無硬上限
           onMessage: makeDreamProgressWatcher(taskId, setAppState),
           overrides: { abortController },
         })
```

#### Dream Prompt 的 4 階段

| 階段 | 動作 | 工具使用 |
|------|------|---------|
| Phase 1 — Orient | ls 記憶目錄、讀 MEMORY.md、掃過主題檔 | Bash(ls), Read |
| Phase 2 — Gather recent signal | 搜尋日誌、比對漂移事實、grep transcript JSONL | Bash(grep), Read |
| Phase 3 — Consolidate | 合併新信號到既有主題檔、轉換日期、刪矛盾 | Edit/Write (memory/) |
| Phase 4 — Prune and index | 維護 MEMORY.md ≤ 25KB/200行、去重、修剪 | Edit (MEMORY.md) |

#### 工具權限沙箱 (`createAutoMemCanUseTool`)

```
✅ 允許：Read, Grep, Glob, REPL（任意路徑）
✅ 允許：Bash（僅 isReadOnly = true 的指令：ls, find, grep, cat, stat, wc, head, tail）
✅ 允許：Edit/Write（僅 isAutoMemPath(file_path) = true 的路徑）
❌ 禁止：所有其他工具
```

#### Task UI（DreamTask）

```typescript
DreamTaskState = {
  type: 'dream',
  phase: 'starting' | 'updating',    // 有檔案修改時 flip
  sessionsReviewing: number,
  filesTouched: string[],             // 被 Edit/Write 的檔案路徑
  turns: DreamTurn[],                 // 最近 30 個回合（滑動窗口）
  abortController: AbortController,   // 可被用戶 kill
  priorMtime: number,                 // 用於回卷 lock
}
```

用戶可在 Shift+Down 對話框中按 `x` 停止進行中的 Dream，觸發 `abortController.abort()` + `rollbackConsolidationLock(priorMtime)`。

---

### 1.2 Hermes Self-Improving Loop — 完整剖析

#### 雙計數器 Nudge 系統

```python
# 記憶 Nudge
_turns_since_memory += 1              # 每個 user turn +1
if _turns_since_memory >= 10:         # 預設 10
    _should_review_memory = True
    _turns_since_memory = 0

# Skill Nudge  
_iters_since_skill += 1              # 每個 tool_use +1
if (_iters_since_skill >= 10          # 預設 10
    and "skill_manage" in valid_tool_names):
    _should_review_skills = True
    _iters_since_skill = 0

# 即時重置（工具實際使用時）
if function_name == "memory":    _turns_since_memory = 0
if function_name == "skill_manage": _iters_since_skill = 0
```

#### 三個 Review Prompt（原文）

**MEMORY_REVIEW_PROMPT**：
```
Review the conversation above and consider saving to memory if appropriate.

Focus on:
1. Has the user revealed things about themselves — their persona, desires, 
preferences, or personal details worth remembering?
2. Has the user expressed expectations about how you should behave, their work 
style, or ways they want you to operate?

If something stands out, save it using the memory tool. 
If nothing is worth saving, just say 'Nothing to save.' and stop.
```

**SKILL_REVIEW_PROMPT**：
```
Review the conversation above and consider saving or updating a skill if appropriate.

Focus on: was a non-trivial approach used to complete a task that required trial 
and error, or changing course due to experiential findings along the way, or did 
the user expect or desire a different method or outcome?

If a relevant skill already exists, update it with what you learned. 
Otherwise, create a new skill if the approach is reusable.
If nothing is worth saving, just say 'Nothing to save.' and stop.
```

**COMBINED_REVIEW_PROMPT**（當兩者同時觸發）：
```
Review the conversation above and consider two things:

**Memory**: Has the user revealed things about themselves — their persona, 
desires, preferences, or personal details? Has the user expressed expectations 
about how you should behave, their work style, or ways they want you to operate? 
If so, save using the memory tool.

**Skills**: Was a non-trivial approach used to complete a task that required trial 
and error, or changing course due to experiential findings along the way, or did 
the user expect or desire a different method or outcome? If a relevant skill 
already exists, update it. Otherwise, create a new one if the approach is reusable.

Only act if there's something genuinely worth saving. 
If nothing stands out, just say 'Nothing to save.' and stop.
```

#### SKILLS_GUIDANCE（注入 system prompt）

```
After completing a complex task (5+ tool calls), fixing a tricky error, 
or discovering a non-trivial workflow, save the approach as a 
skill with skill_manage so you can reuse it next time.
When using a skill and finding it outdated, incomplete, or wrong, 
patch it immediately with skill_manage(action='patch') — don't wait to be asked. 
Skills that aren't maintained become liabilities.
```

#### 背景評審 Agent（`_spawn_background_review`）

```python
review_agent = AIAgent(
    model=self.model,           # 使用相同的 LLM 模型
    max_iterations=8,           # 限制迭代次數
    quiet_mode=True,            # 無輸出到用戶
)
review_agent._memory_store = self._memory_store     # 共享記憶儲存
review_agent._memory_enabled = self._memory_enabled
review_agent._memory_nudge_interval = 0  # ← 防止遞迴！
review_agent._skill_nudge_interval = 0   # ← 防止遞迴！
```

**關鍵設計**：
- Daemon thread 執行，不阻塞主 agent
- 輸出重定向到 `/dev/null`
- 共享 `_memory_store`（寫入立即持久化到磁碟）
- 完成後掃描 `_session_messages` 提取成功的工具呼叫，輸出精簡摘要
- **沒有工具限制** — 背景 agent 能用所有標準工具（memory + skill_manage）

#### Skills Guard 安全掃描（`skills_guard.py`）

**信任層級**：
```python
INSTALL_POLICY = {
    #              safe    caution   dangerous
    "builtin":    ("allow", "allow",  "allow"),
    "trusted":    ("allow", "allow",  "block"),
    "community":  ("allow", "block",  "block"),
    "agent-created": ("allow", "allow", "ask"),  # ← AI 建立的 skill
}
```

**15 類威脅偵測（483 個正規表達式）**：

| 類別 | 範例 |
|------|------|
| 資料外洩 | curl/wget 帶密鑰、讀 .env/.ssh/.aws |
| 提示注入 | "ignore previous instructions"、"you are now" |
| 破壞性操作 | rm -rf /、chmod 777、mkfs |
| 持久化 | crontab 修改、.bashrc 注入、authorized_keys |
| 反向 Shell | nc -l、bash -i >/dev/tcp/、ngrok |
| 代碼混淆 | base64 -d \| bash、eval()、exec() |
| 路徑遍歷 | ../../.. 深層路徑、/etc/passwd |
| 供應鏈 | curl \| bash、pip install 無版本固定 |
| 權限提升 | sudo、setuid、NOPASSWD |
| Agent 配置修改 | 修改 CLAUDE.md、.cursorrules |
| 硬編碼機密 | API keys、私鑰、tokens |
| Jailbreak | "DAN mode"、"developer mode" |

**結構限制**：
- 最大檔案數：50
- 總大小上限：1MB
- 單檔上限：256KB

**判決邏輯**：
```python
has_critical → "dangerous"
has_high → "caution"
otherwise → "safe"
```

#### 記憶系統設計

**容量限制**：
- MEMORY.md：2,200 字元
- USER.md：1,375 字元
- Entry 分隔符：`§`（非換行）

**凍結快照設計**：
```python
def format_for_system_prompt(self, target):
    """回傳 load_from_disk() 時的快照，而非當前狀態。
    Mid-session 寫入不影響 system prompt。
    這確保 prefix cache 在整個 session 中穩定。"""
    return self._system_prompt_snapshot.get(target, "")
```

**含義**：mid-session 的 `memory` 工具呼叫會更新磁碟但不改當前 session 的 prompt。下個 session 才生效。

#### Skill Progressive Disclosure（三層披露）

```
Tier 1 (skills_list): 名稱 ≤64 chars + 描述 ≤1024 chars
Tier 2 (skill_view):  完整 SKILL.md 內容
Tier 3 (skill_view):  支援檔案（references/, templates/, scripts/）
```

---

### 1.3 free-code 已有的 Skill 生態系統

#### Skill 建立機制

| 機制 | 檔案 | 功能 | 觸發方式 |
|------|------|------|----------|
| **Skillify** | `src/skills/bundled/skillify.ts` | 分析 session 對話，4 輪訪談引導用戶建 SKILL.md | 用戶手動 `/skillify` |
| **Skill Creator** | `src/skills/bundled/skillCreator.ts` | 完整 skill 開發工具（含 eval 測試、基準測試） | 用戶手動 `/skill-creator` |
| **Skill Improvement** | `src/utils/hooks/skillImprovement.ts` | 每 5 個 user turn 偵測 project skill 改進需求 | 自動（postSamplingHook） |

#### Skill 載入/發現機制

| 機制 | 檔案 | 功能 |
|------|------|------|
| **loadSkillsDir** | `src/skills/loadSkillsDir.ts` | 從 managed/user/project/additional 四層來源載入 SKILL.md |
| **Dynamic Discovery** | `loadSkillsDir.ts:861` | 文件操作時向上走目錄樹發現新 `.my-agent/skills/` |
| **Conditional Skills** | `loadSkillsDir.ts:997` | `paths` frontmatter 支援路徑條件啟用 |
| **Skill Change Detector** | `src/utils/skills/skillChangeDetector.ts` | chokidar 監視 skill 目錄，300ms 防抖後自動重載 |
| **Bundled Skills** | `src/skills/bundledSkills.ts` | 編譯時內建的 skill，首次呼叫時提取到磁碟 |

#### 記憶機制

| 機制 | 檔案 | 功能 | 觸發方式 |
|------|------|------|----------|
| **extractMemories** | `src/services/extractMemories/` | session 結束時提取記憶到 `memory/` | 自動（stopHooks, forkedAgent, maxTurns=5） |
| **AutoDream** | `src/services/autoDream/` | 跨 session 記憶整合 | 自動（24h + 5 sessions, forkedAgent） |

**extractMemories 特有邏輯**：
- 互斥：若主線程已寫 memory（`hasMemoryWritesSince`），跳過
- Coalescing：執行中的 extraction 會 stash 新請求，完成後做 trailing run
- 節流：`tengu_bramble_lintel` 控制最小 turn 間隔

#### Hook 基礎設施

| 機制 | 檔案 | 功能 |
|------|------|------|
| **apiQueryHookHelper** | `src/utils/hooks/apiQueryHookHelper.ts` | 142 行的輕量框架，包裝 `queryModelWithoutStreaming` 為可重用 hook |
| **postSamplingHooks** | `src/utils/hooks/postSamplingHooks.ts` | 71 行的 hook 註冊/執行系統 |
| **stopHooks** | `src/query/stopHooks.ts` | 查詢結束時的三個 fire-and-forget 背景任務 |

**stopHooks 執行順序**（全部 fire-and-forget，無等待依賴）：
```
if (!isBareMode()) {
  1. executePromptSuggestion()       // 門控：環境變數
  2. executeExtractMemories()        // 門控：feature flag + auto-memory
  3. executeAutoDream()              // 門控：isGateOpen (三重門)
}
// 全部條件：querySource === 'repl_main_thread' && !agentId
```

#### Skill Improvement 的完整模式（方案二的範本）

```typescript
// skillImprovement.ts — 已驗證的 apiQueryHook 模式

createApiQueryHook({
  name: 'skill_improvement',
  
  shouldRun: async (ctx) => {
    if (ctx.querySource !== 'repl_main_thread') return false
    if (!findProjectSkill()) return false           // ← 需要正在執行的 project skill
    const userCount = count(ctx.messages, m => m.type === 'user')
    return (userCount - lastAnalyzedCount) >= 5     // ← 每 5 個 user turn
  },
  
  buildMessages: (ctx) => [
    createUserMessage({
      content: `分析 <skill_definition> 和 <recent_messages>，
      找出用戶的更正、偏好、或步驟修改要求。
      輸出 <updates>[{section, change, reason}]</updates>`
    })
  ],
  
  systemPrompt: '...',
  useTools: false,                                   // ← 純文字回應
  
  parseResponse: (content) => {
    return jsonParse(extractTag(content, 'updates'))  // ← JSON 解析
  },
  
  logResult: (result, ctx) => {
    ctx.toolUseContext.setAppState(prev => ({
      ...prev,
      skillImprovement: { suggestion: { skillName, updates } }
    }))                                               // ← 設 appState 觸發 UI
  },
  
  getModel: getSmallFastModel,                        // ← 小模型，低成本
})

// 偵測到改進後，applySkillImprovement() 用 side-channel LLM 重寫 SKILL.md
```

---

## 第二部分：差距分析

### 兩個機制的本質差異

| 維度 | AutoDream（free-code） | Self-Improving Loop（Hermes） |
|------|----------------------|------------------------------|
| **觸發頻率** | 低頻（24h + 5 sessions） | 高頻（每 10 回合/迭代） |
| **改進範圍** | 僅記憶整合 | 記憶 + Skill + Prompt |
| **改進時機** | 事後（跨 session 回顧） | 即時（session 內偵測） |
| **主動性** | 被動整合既有信號 | 主動學習 + 主動修改行為 |
| **對行為的影響** | 間接（記憶影響下次 prompt） | 直接（skill 改變執行流程） |
| **安全模型** | 只寫 memory/ | 可寫 skills/ + memory/（有 guard） |
| **Prompt 穩定性** | 不影響當前 session | 凍結快照設計，下次 session 生效 |

簡單來說：**AutoDream 是「睡覺時整理記憶」，Hermes Loop 是「邊做邊學邊改」**。

### free-code 已覆蓋 vs 真正差距

| Hermes Loop 功能 | free-code 現狀 | 差距 |
|-----------------|---------------|------|
| 記憶 nudge（每 10 回合提醒保存偏好） | extractMemories 在 session 結束自動提取 | **缺 session 內即時 nudge** |
| Skill 建立 nudge（每 10 迭代提醒建 skill） | Skillify 需手動 `/skillify` | **缺自動偵測「該建 skill」的時機** |
| Skill 改進（主動 patch 過時 skill） | skillImprovement 每 5 turn 偵測 + 自動改寫 | ✅ **已覆蓋且更精緻** |
| SKILLS_GUIDANCE（prompt 引導主動改進） | 無 | **可透過 system prompt 注入** |
| 背景評審線程（fork agent 做完整評審） | 無 | **是方案三核心新增** |
| Skills Guard（安全掃描） | 無 | **方案三需要** |
| RL 軌跡保存 | 無 | 可選，非核心 |
| Progressive Disclosure（三層 skill 披露） | loadSkillsDir 有 Tier 1 (列表) + Tier 2 (SKILL.md) | Tier 3 (支援檔案) 已有支援 |

**結論：真正的差距是兩個「nudge」和一個「背景評審」。skill 改進已有，skill 建立工具已有，缺的是「自動偵測何時該做」的觸發機制。**

---

## 第三部分：合併方案

### 方案一：EnhancedDream — 擴展 Dream 的職責範圍

#### 核心概念
保持 AutoDream 的低頻觸發不變，但將 Dream prompt 從「純記憶整合」擴展為「記憶 + Skill 審計 + 行為偏好識別」。

#### 架構

**觸發**：完全沿用現有三重門（24h + 5 sessions + lock），不變。

**執行**：擴展 `consolidationPrompt.ts` 的 `buildConsolidationPrompt()`，在原有 4 階段後新增：

```markdown
## Phase 5 — Skill Audit

Scan `.my-agent/skills/` directory to see what skills already exist.
Then search recent transcripts for repeated multi-step workflows:

- grep for tool_use sequences that appear in 3+ different sessions
- Look for 5+ step patterns that aren't yet captured as skills
- Check if any existing skill's instructions contradict what actually worked

Write your findings to `skill-candidates.md` in the memory directory:
- Candidate name
- Observed pattern (which sessions, which tools)
- Why it's worth becoming a skill

## Phase 6 — Behavior Notes

Search recent transcripts for user corrections and preferences:
- "don't do X" / "always do Y" / "I prefer Z"
- Explicit rejections of proposed approaches
- Repeated steering toward specific methods

If found, write or update `user-behavior-notes.md` in the memory directory.
```

**產出**：
- `memory/skill-candidates.md` — 候選 skill 清單（普通記憶檔，被 `findRelevantMemories` 自動載入 prompt）
- `memory/user-behavior-notes.md` — 行為偏好記錄

**工具權限變更**：無需修改 `createAutoMemCanUseTool`。Dream agent 已有 Read/Grep/Glob 的全路徑讀取權限，可讀取 `.my-agent/skills/`。寫入仍限 memory/ 目錄。

#### 與現有系統的整合

```
                    ┌─────────────────────────────────────────┐
                    │              AutoDream                  │
                    │  Phase 1-4: 記憶整合（不變）              │
                    │  Phase 5: Skill Audit（新增）            │
                    │  Phase 6: Behavior Notes（新增）         │
                    └───────────┬─────────────────────────────┘
                                │ 產出
                    ┌───────────▼─────────────────────────────┐
                    │   memory/skill-candidates.md             │
                    │   memory/user-behavior-notes.md          │
                    └───────────┬─────────────────────────────┘
                                │ 下次 session 載入
                    ┌───────────▼─────────────────────────────┐
                    │   findRelevantMemories → system prompt   │
                    │   用戶看到候選清單，手動 /skillify 建立    │
                    └─────────────────────────────────────────┘
```

#### 效果對比

| | 純 AutoDream | EnhancedDream |
|--|-------------|---------------|
| 記憶整合 | ✅ | ✅（不變） |
| Skill 候選識別 | ❌ | ✅ 跨 session 分析後建議 |
| 行為偏好追蹤 | ❌ | ✅ 寫入記憶供下次載入 |
| 即時學習 | ❌ | ❌ 仍然是事後（24h+ 延遲） |
| Token 消耗增量 | — | 低（Dream agent 多跑 2 階段） |

#### 複雜度與風險
- **實作量**：低（改一個 prompt 字串，`consolidationPrompt.ts` 唯一修改檔案）
- **風險**：極低，完全在現有管線和權限沙箱內運作
- **與 Skillify 的關係**：互補——Dream 產出候選清單，用戶下次 session 看到後可手動 `/skillify` 或 `/skill-creator` 來建立
- **局限**：沒有 session 內即時學習能力；需等待 24h + 5 sessions 的門檻

#### 關鍵修改檔案
- `src/services/autoDream/consolidationPrompt.ts` — 擴展 prompt（唯一修改）

---

### 方案二：DualLoop — 即時 Nudge + 延遲 Dream 的雙迴圈

#### 核心概念

在現有 `skillImprovement` hook（改進已有 skill）旁邊，新增兩個 `postSamplingHook`：
- **memoryNudge**：即時偵測用戶偏好/修正，nudge 保存到記憶
- **skillCreationNudge**：即時偵測可 skill 化的重複 workflow，nudge 建立新 skill

這不是從零開始——是推廣 `skillImprovement.ts` 這個已驗證模式到更多場景。同時可選擇性套用方案一的 Dream prompt 擴展。

#### 架構

**memoryNudgeHook**（基於 `apiQueryHookHelper`）：

```typescript
createApiQueryHook({
  name: 'memory_nudge',
  
  shouldRun: async (ctx) => {
    if (ctx.querySource !== 'repl_main_thread') return false
    const userCount = count(ctx.messages, m => m.type === 'user')
    return (userCount - lastAnalyzedCount) >= 8    // 每 8 個 user turn
  },
  
  buildMessages: (ctx) => {
    // 借鑑 Hermes MEMORY_REVIEW_PROMPT 的判斷邏輯
    const recentMessages = ctx.messages.slice(lastAnalyzedIndex)
    return [createUserMessage({
      content: `Review the recent conversation. Look for:
      1. User corrections: "don't do X", "always do Y", "I prefer Z"
      2. User expectations about behavior or work style
      3. Personal details worth remembering for future sessions
      
      <recent_messages>
      ${formatRecentMessages(recentMessages)}
      </recent_messages>
      
      Output <memories>[{content, type, reason}]</memories>
      Output <memories>[]</memories> if nothing worth saving.`
    })]
  },
  
  parseResponse: (content) => jsonParse(extractTag(content, 'memories')),
  
  logResult: (result, ctx) => {
    if (result.type === 'success' && result.result.length > 0) {
      ctx.toolUseContext.setAppState(prev => ({
        ...prev,
        pendingMemoryNudge: { memories: result.result }
      }))
      // UI 提示："Noticed preferences — save to memory?"
    }
  },
  
  getModel: getSmallFastModel,
})
```

**與 extractMemories 的差異**：
- extractMemories 在 session 結束時自動提取**所有**記憶（forkedAgent, maxTurns=5）
- memoryNudge 在 session 中即時偵測**修正性**偏好（side-channel LLM 判定，不用 forkedAgent）
- 兩者互補：memoryNudge 抓即時修正，extractMemories 做全面掃描

**skillCreationNudgeHook**（基於 `apiQueryHookHelper`）：

```typescript
createApiQueryHook({
  name: 'skill_creation_nudge',
  
  shouldRun: async (ctx) => {
    if (ctx.querySource !== 'repl_main_thread') return false
    // 計算最近的 tool_use 數量
    const recentToolUses = countRecentToolUses(ctx.messages, lastAnalyzedIndex)
    return recentToolUses >= 15    // 非平凡 workflow (15+ 工具呼叫)
  },
  
  buildMessages: (ctx) => {
    // 借鑑 Hermes SKILL_REVIEW_PROMPT 的判斷邏輯
    const recentMessages = ctx.messages.slice(lastAnalyzedIndex)
    return [createUserMessage({
      content: `Review the recent tool usage sequence. Consider:
      - Was a non-trivial approach used (5+ steps)?
      - Did it require trial and error or changing course?
      - Would this workflow be useful to repeat in future sessions?
      
      <tool_sequence>
      ${formatToolSequence(recentMessages)}
      </tool_sequence>
      
      Output <candidate>{isCandidate: boolean, name: string, description: string, 
      steps: string[]}</candidate>`
    })]
  },
  
  parseResponse: (content) => jsonParse(extractTag(content, 'candidate')),
  
  logResult: (result, ctx) => {
    if (result.type === 'success' && result.result.isCandidate) {
      ctx.toolUseContext.setAppState(prev => ({
        ...prev,
        pendingSkillCandidate: result.result
      }))
      // UI 提示："This looks like a reusable workflow — create a skill?"
      // 確認後自動呼叫 Skillify 邏輯
    }
  },
  
  getModel: getSmallFastModel,
})
```

**與 Skillify 的關係**：
- Skillify 需用戶記得呼叫 `/skillify`
- skillCreationNudge 自動偵測並提醒——確認後可直接引導到 Skillify 的建立流程
- 兩者互補：nudge 解決「何時該建」，Skillify 解決「怎麼建」

**慢迴圈**：沿用現有 AutoDream，可選擇性套用方案一的 prompt 擴展。

**可選：注入 SKILLS_GUIDANCE 到 system prompt**：
在 `prompt_builder` 或 `state.ts` 中，將 Hermes 的 SKILLS_GUIDANCE 文本注入 system prompt，引導 agent 在 session 中主動意識到 skill 改進的時機。這是零成本的改動（只加幾行文字到 prompt）。

#### 系統整合流程圖

```
User Turn
    │
    ├─[postSamplingHook] skillImprovement (每 5 turn)
    │   └─ 偵測已有 project skill 的改進需求 → 自動重寫 SKILL.md
    │
    ├─[postSamplingHook] memoryNudge (每 8 turn) ← 新增
    │   └─ 偵測修正性偏好 → appState → UI 確認 → 寫入 memory/
    │
    ├─[postSamplingHook] skillCreationNudge (每 15 tool_use) ← 新增
    │   └─ 偵測可 skill 化的 workflow → appState → UI 確認 → Skillify
    │
    └─[stopHooks] session 結束
        ├─ extractMemories → 全面記憶提取 (forkedAgent, maxTurns=5)
        └─ AutoDream → 跨 session 記憶整合 (forkedAgent, 三重門)
              └─ (可選) Phase 5-6 skill audit + behavior notes
```

#### 效果對比

| | 純 AutoDream | DualLoop |
|--|-------------|----------|
| 記憶整合 | 事後 | 即時 nudge + 事後 extract + 跨 session dream |
| Skill 建立 | 手動（/skillify） | ✅ 自動偵測 + 用戶確認 + Skillify 引導 |
| Skill 改進 | 自動（skillImprovement） | 自動（不變） |
| 行為偏好 | 事後提取 | ✅ 即時偵測修正性偏好 |
| SKILLS_GUIDANCE | 無 | ✅ 注入 system prompt |
| 用戶控制 | 被動 | 半主動（建議需確認） |
| Token 消耗 | 低 | 中（每 8 turn 一次 `getSmallFastModel()` 呼叫） |

#### 複雜度與風險

- **實作量**：中（2 個新 hook 檔案 + UI 確認邏輯 + 可選 prompt 注入）
- **風險**：
  - `queryModelWithoutStreaming` 需確認 llamacpp adapter 支援非串流模式（`skillImprovement` 已在用，理論上已通過）
  - `getSmallFastModel()` 在本地 llama.cpp 環境下可能返回主模型（非小模型），需確認行為和 token 成本
  - Nudge 太頻繁可能打擾用戶 → 加入「拒絕後本 session 降頻」邏輯（Hermes 的 counter 重置設計）
  - 所有 nudge 需要用戶確認，不會自動寫入不想要的東西
- **優勢**：完全利用已驗證的框架（apiQueryHookHelper + postSamplingHooks + Skillify）

#### 關鍵修改/新增檔案
- 新增 `src/utils/hooks/memoryNudge.ts`
- 新增 `src/utils/hooks/skillCreationNudge.ts`
- 修改 `src/utils/backgroundHousekeeping.ts` — 加入初始化呼叫
- 可選：修改 system prompt 注入點 — 加入 SKILLS_GUIDANCE
- 可選：套用方案一的 `consolidationPrompt.ts` 擴展

---

### 方案三：FullLoop — 完整的三層自改進系統

#### 核心概念

三層改進系統，形成完整的學習迴圈：

```
┌────────────────────────────────────────────────────────────────┐
│ 微觀層（turn 級）— 已有 + 新增                                   │
│   skillImprovement (每 5 turn)     → 改進已有 skill              │
│   memoryNudge (每 8 turn)          → 即時偵測偏好 [新增]         │
│   skillCreationNudge (每 15 tool)  → 偵測該建 skill [新增]       │
│   SKILLS_GUIDANCE (system prompt)  → 引導主動改進 [新增]         │
├────────────────────────────────────────────────────────────────┤
│ 中觀層（session 級）— 新增                                       │
│   Session Review Agent             → 軌跡分析 + skill 草稿      │
│   extractMemories                  → 全面記憶提取（已有）         │
├────────────────────────────────────────────────────────────────┤
│ 宏觀層（跨 session）— 增強                                       │
│   AutoDream                        → 記憶整合 + skill 自動建立   │
│   skillGuard                       → 安全掃描 [新增]             │
└────────────────────────────────────────────────────────────────┘
```

#### 中觀層 — Session Review Agent（核心新增）

**觸發條件**（在 `stopHooks.ts` 新增，位於 `executeAutoDream` 之後）：
```
1. querySource === 'repl_main_thread' && !agentId
2. 本 session tool_use 數 >= 15（非平凡 session）
3. 距離上次 review >= 2 小時（防止頻繁觸發）
```

**執行方式**：
```typescript
runForkedAgent({
  promptMessages: [createUserMessage({ content: sessionReviewPrompt })],
  cacheSafeParams: createCacheSafeParams(context),
  canUseTool: createSessionReviewCanUseTool(memoryRoot),
  querySource: 'session_review',
  forkLabel: 'session_review',
  skipTranscript: true,
  maxTurns: 8,                    // 與 Hermes 的 max_iterations=8 對齊
  onMessage: makeReviewProgressWatcher(taskId, setAppState),
})
```

**Session Review Prompt**（借鑑 Hermes COMBINED_REVIEW_PROMPT + SKILL_REVIEW_PROMPT）：
```markdown
# Session Review

You are reviewing this session's work to extract reusable knowledge.

## Task 1 — Skill Drafts

Analyze the tool usage patterns in this session:
- Were there non-trivial workflows (5+ steps) that required trial and error?
- Did the approach change mid-stream due to discoveries?
- Would this workflow be useful to repeat?

For each candidate workflow, write a skill draft to `memory/skill-drafts/<name>.md`:
---
name: <skill-name>
description: <one-line>
observed-sessions: 1
first-seen: <today's date>
---
## Steps
<observed steps>
## Why
<why this is worth becoming a skill>

## Task 2 — Trajectory Summary

Write a brief trajectory summary to `memory/trajectories/YYYY-MM-DD.md`:
- What was attempted
- What succeeded / failed
- Key tool sequences used
- Lessons learned

## Task 3 — Behavior Notes

If the user corrected the agent or expressed preferences, 
update `memory/user-behavior-notes.md`.
```

**工具權限**：
```
✅ 與 createAutoMemCanUseTool 相同的讀取權限
✅ Edit/Write: memory/ 目錄（含 skill-drafts/, trajectories/ 子目錄）
❌ 不能直接修改 .my-agent/skills/（只有 Dream 在宏觀層做）
```

**Task UI**：新增 `SessionReviewTask`（類似 `DreamTask`）
```typescript
SessionReviewTaskState = {
  type: 'session_review',
  phase: 'analyzing' | 'writing',
  toolUsesReviewed: number,
  skillDraftsCreated: string[],
  trajectoryWritten: boolean,
}
```

#### 宏觀層 — 增強版 AutoDream

**Dream Prompt 新增 Phase 5-7**：

```markdown
## Phase 5 — Skill Draft Review

Scan `memory/skill-drafts/` for candidate skills:
- Read each draft's `observed-sessions` count
- Cross-reference with `memory/trajectories/` to verify the pattern appeared in 3+ sessions
- If a draft has been observed in 3+ sessions:
  1. Validate the steps still make sense
  2. Run the content through the skill safety checklist (see below)
  3. If safe, create the formal skill at `.my-agent/skills/<name>/SKILL.md`
  4. Delete the draft from `memory/skill-drafts/`

## Phase 6 — Skill Safety Checklist

Before creating any skill, verify:
- [ ] No shell commands that modify system state destructively
- [ ] No hardcoded credentials or API keys
- [ ] No network calls to external services
- [ ] No attempts to modify agent configuration files
- [ ] File size < 10KB
- [ ] Total skill count stays < 50

If any check fails, keep the draft in skill-drafts/ and add a warning note.

## Phase 7 — Trajectory Pruning

Prune `memory/trajectories/` to keep only the last 30 days of entries.
Remove trajectories that are fully captured in skills or memories.
```

**工具權限擴展**（`autoDream.ts`）：
```typescript
// 擴展 createAutoMemCanUseTool，新增 .my-agent/skills/ 寫入權限
// 僅在 FullLoop 模式下啟用
if ((tool.name === FILE_EDIT_TOOL_NAME || tool.name === FILE_WRITE_TOOL_NAME) &&
    'file_path' in input) {
  const filePath = input.file_path
  if (typeof filePath === 'string' && 
      (isAutoMemPath(filePath) || isSkillsPath(filePath)))
    return { behavior: 'allow', updatedInput: input }
}
```

**安全掃描（`skillGuard.ts`）**：
借鑑 Hermes `skills_guard.py` 的 15 類威脅偵測，但簡化為 TypeScript 版本：

```typescript
// 核心威脅模式（精選最關鍵的類別）
const THREAT_PATTERNS = {
  exfiltration: [/curl.*\$\{?\w*(KEY|TOKEN|SECRET)/i, ...],
  injection: [/ignore\s+(previous|all)\s+instructions/i, ...],
  destructive: [/rm\s+-rf\s+\//i, /chmod\s+777/i, ...],
  persistence: [/crontab/i, /\.bashrc/i, ...],
  obfuscation: [/base64\s+-d\s*\|\s*bash/i, /eval\(/i, ...],
}

// 結構限制
const MAX_SKILL_SIZE_KB = 10
const MAX_TOTAL_SKILLS = 50

// 判決
function scanSkill(content: string): 'safe' | 'caution' | 'dangerous'
```

**信任層級**：
```typescript
// agent-created skills 使用較寬鬆但仍有保護的策略
// safe → allow, caution → allow, dangerous → block (不是 ask，因為無人確認)
```

#### 與 Skillify 的完整關係

```
Discovery Paths:
  1. skillCreationNudge → UI 確認 → Skillify 引導建立     （即時，用戶控制）
  2. Session Review → skill-drafts/ → Dream → 自動建立     （延遲，全自動）
  3. 用戶手動 /skillify                                     （手動）

Improvement Path:
  skillImprovement hook → 自動重寫 SKILL.md                  （已有）

Discovery 路徑 1 和 2 會互相去重：
  - 如果 nudge 已建立某 skill，Session Review 不會重複建草稿
  - 如果 Dream 已自動建立某 skill，nudge 不會再提醒
  - 去重依據：skill name + description 相似度
```

#### 資源競爭管理

本地 llama.cpp 同時跑多個背景任務的問題需要管理：

```
序列化策略（推薦）：
  stopHooks 中的背景任務加入簡單的互斥鎖：
  1. extractMemories (maxTurns=5, 先跑)
  2. 等待 extractMemories 完成
  3. sessionReview (maxTurns=8, 再跑)
  4. 等待 sessionReview 完成
  5. autoDream (三重門判斷後才跑)

  原因：llama.cpp server 是單 slot，並行會排隊。
  序列化能避免 GPU 隊列擁塞和 timeout。
```

#### 效果對比

| | 純 AutoDream | FullLoop |
|--|-------------|----------|
| 記憶整合 | 事後 | 三層（即時 nudge + session 級 extract + 跨 session dream） |
| Skill 建立 | 手動 | ✅ 雙路徑：即時 nudge + 自動（3 session 驗證 + 安全掃描） |
| Skill 改進 | 自動 | 自動（不變） |
| 軌跡分析 | ❌ | ✅ 成功/失敗記錄用於 Dream 決策 |
| 行為改進 | 間接 | 直接（skill 修改執行流程） |
| 自主性 | 被動 | 完全自主（微觀需確認，宏觀全自動） |
| SKILLS_GUIDANCE | 無 | ✅ 引導主動改進意識 |

#### 複雜度與風險

- **實作量**：高（8+ 新檔案，4+ 修改，涉及 forked agent、task registry、skill 載入、安全掃描等多個子系統）
- **風險**：
  - **安全**：自動寫入 `.my-agent/skills/` 是信任邊界突破。緩解措施：skillGuard + 3 session 驗證 + Dream agent 的有限工具權限 + 結構限制（≤10KB, ≤50 skills）
  - **資源**：llama.cpp 序列化背景任務增加 session 結束時的等待時間
  - **重疊管理**：Session Review 與 extractMemories 的記憶功能重疊 → Session Review 限定只做 skill-drafts + trajectories
  - **skillChangeDetector**：Dream 自動建立的 skill 會觸發 chokidar 重載 → 這是好事（自動生效），但需確認重載不會 race condition

#### 關鍵修改/新增檔案

**新增**：
- `src/services/selfImprove/sessionReview.ts` — Session Review Agent
- `src/services/selfImprove/sessionReviewPrompt.ts` — Review prompt builder
- `src/services/selfImprove/skillGuard.ts` — 安全掃描（借鑑 Hermes skills_guard.py）
- `src/services/selfImprove/trajectoryStore.ts` — 軌跡讀寫
- `src/tasks/SessionReviewTask/SessionReviewTask.ts` — Task UI
- 方案二的 `memoryNudge.ts` + `skillCreationNudge.ts`

**修改**：
- `src/services/autoDream/consolidationPrompt.ts` — Phase 5-7
- `src/services/autoDream/autoDream.ts` — 擴展 canUseTool 到 `.my-agent/skills/`
- `src/query/stopHooks.ts` — 加入 Session Review + 序列化邏輯
- `src/utils/backgroundHousekeeping.ts` — 初始化

---

## 第四部分：總覽比較

| 維度 | 方案一 EnhancedDream | 方案二 DualLoop | 方案三 FullLoop |
|------|---------------------|----------------|----------------|
| 實作複雜度 | 低（1 天） | 中（3-5 天） | 高（2-3 週） |
| 新增檔案數 | 0 | 2-3 | 8+ |
| 修改檔案數 | 1 | 2-3 | 5+ |
| 安全風險 | 極低 | 低 | 中（有 skillGuard 緩解） |
| 改進範圍 | 記憶 + 候選清單 | 記憶 + 偏好 + skill 建議 | 記憶 + skill 自動建立 + 軌跡 |
| 自主性 | 被動建議 | 半主動（需確認） | 全自動（微觀需確認，宏觀自動） |
| 即時性 | 24h+ 延遲 | session 內即時 | session 內即時 + 跨 session 深度 |
| 與現有系統衝突 | 無 | 無 | 寫入邊界擴展 |
| 利用的現有基礎設施 | AutoDream | + apiQueryHookHelper + postSamplingHooks + Skillify | + forkedAgent + Task registry + skillChangeDetector |
| 建議實施順序 | 第一步 | 第二步 | 第三步（視需要） |

### 與原本 AutoDream 的核心差異

原本的 AutoDream 是一個**純記憶整合系統**——它只做「整理已有記憶」，不產出任何行動建議，不修改 skill，不追蹤行為模式。它的哲學是「被動的圖書館管理員」。

合併後的系統增加了**「學會新東西」的能力**，其哲學轉變為：

| 方案 | 哲學 | 比喻 |
|------|------|------|
| 純 AutoDream | 被動整理 | 圖書館管理員整理書架 |
| 方案一 | 被動整理 + 被動建議 | 管理員整理書架時順手寫下「該買哪些新書」 |
| 方案二 | 被動整理 + 即時偵測 + 半主動行動 | 管理員 + 隨時觀察讀者需求的助手 |
| 方案三 | 被動整理 + 即時偵測 + 全自動行動 + 軌跡追蹤 | 管理員 + 助手 + 會自己寫書摘和訂書的系統 |

### 建議實施路徑

**方案一 → 方案二 → 方案三**（漸進式，每步驗證效果後再決定是否繼續）

方案二是性價比最高的甜蜜點——它完全利用已驗證的框架，不突破安全邊界，且透過用戶確認保證品質。方案三的全自動 skill 建立雖然最接近 Hermes 的完整能力，但需要額外的安全基礎設施（skillGuard）和資源管理，適合在方案二穩定運作後再考慮。

---

## 第五部分：實作結果（2026-04-17 完成）

三個階段全部實作完成。以下是最終系統的精確狀態。

---

## 第六部分：最終系統架構總覽

### 觸發架構圖

```
User Turn（每次 query 的模型回應完成後）
    │
    ├─[postSamplingHook] skillImprovement (每 5 user turn)          ← 既有
    │   └─ 偵測已有 project skill 的改進需求 → 自動重寫 SKILL.md
    │   └─ 檔案：src/utils/hooks/skillImprovement.ts
    │
    ├─[postSamplingHook] memoryNudge (每 8 user turn)              ← M6 新增
    │   └─ 偵測修正性偏好 → appState.pendingMemoryNudge
    │   └─ 檔案：src/utils/hooks/memoryNudge.ts
    │
    ├─[postSamplingHook] skillCreationNudge (每 15 tool_use)       ← M6 新增
    │   └─ 偵測可 skill 化的 workflow → appState.pendingSkillCandidate
    │   └─ 檔案：src/utils/hooks/skillCreationNudge.ts
    │
    └─[stopHooks] 每次 query 結束（不只 session 結束）
        │
        ├─ promptSuggestion → 提示建議                              ← 既有
        │
        ├─ extractMemories → 全面記憶提取                            ← 既有
        │   (forkedAgent, maxTurns=5, fire-and-forget)
        │
        │  ┌─ llamacpp 環境：序列化（await 前一個完成再跑下一個）
        │  └─ 非 llamacpp：fire-and-forget（並行）
        │
        ├─ sessionReview → 軌跡分析 + skill 草稿                    ← M6 新增
        │   (forkedAgent, maxTurns=8)
        │   門控：tool_use ≥ 15 + 距上次 ≥ 2h
        │         + 非 agentId + 非 remote + auto-memory 啟用
        │   產出：memory/skill-drafts/*.md + memory/trajectories/*.md
        │   檔案：src/services/selfImprove/sessionReview.ts
        │
        └─ autoDream → 跨 session 記憶整合 + skill 升級             ← 增強
            (forkedAgent, 三重門：24h + 5 sessions + lock)
            Phase 1-4：記憶整合（原有）
            Phase 5：Skill Audit — 掃描 .my-agent/skills/ + transcript（M6）
            Phase 6：Behavior Notes — 偵測用戶修正寫入記憶（M6）
            Phase 7：Skill Draft Review — 3+ session 驗證後升級（M6）
            Phase 8：Safety Checklist — 安全檢查清單（M6）
            Phase 9：Trajectory Pruning — 保留最近 30 天（M6）
            檔案：src/services/autoDream/consolidationPrompt.ts
                  src/services/autoDream/autoDream.ts
```

### 初始化順序（`backgroundHousekeeping.ts`）

```
startBackgroundHousekeeping()
  1. initMagicDocs()
  2. initSkillImprovement()          ← 既有
  3. initMemoryNudge()               ← M6 新增
  4. initSkillCreationNudge()        ← M6 新增
  5. initExtractMemories()           ← 既有（feature gated）
  6. initAutoDream()                 ← 既有
  7. initSessionReview()             ← M6 新增
  8. autoUpdateMarketplacesAndPluginsInBackground()
```

### 模組清單

#### M6 新增檔案（10 個原始碼 + 9 個測試）

| 檔案 | 功能 | 行數 |
|------|------|------|
| `src/utils/hooks/memoryNudge.ts` | 每 8 turn 偵測修正性偏好 | ~130 |
| `src/utils/hooks/skillCreationNudge.ts` | 每 15 tool_use 偵測可 skill 化 workflow | ~150 |
| `src/services/selfImprove/skillGuard.ts` | 安全掃描（8 類約 35 regex + 結構限制） | ~155 |
| `src/services/selfImprove/trajectoryStore.ts` | 軌跡讀寫/修剪/統計 | ~160 |
| `src/services/selfImprove/sessionReview.ts` | Session Review Agent（forkedAgent） | ~120 |
| `src/services/selfImprove/sessionReviewPrompt.ts` | Session Review prompt builder | ~60 |
| `src/tasks/SessionReviewTask/SessionReviewTask.ts` | Task UI 生命週期 | ~70 |
| `tests/integration/self-improve/enhanced-dream.test.ts` | Dream prompt Phase 驗證 | 4 tests |
| `tests/integration/self-improve/memory-nudge.test.ts` | Nudge 解析驗證 | 5 tests |
| `tests/integration/self-improve/skill-creation-nudge.test.ts` | Nudge 解析 + 工具函式 | 5 tests |
| `tests/integration/self-improve/skill-guard.test.ts` | 安全掃描全類別覆蓋 | 8 tests |
| `tests/integration/self-improve/trajectory-store.test.ts` | 軌跡 CRUD + 修剪 | 3 tests |
| `tests/integration/self-improve/session-review.test.ts` | Prompt 結構 + 權限 | 3 tests |
| `tests/integration/self-improve/enhanced-dream-permissions.test.ts` | Phase 7-9 + 權限矩陣 | 4 tests |
| `tests/integration/self-improve/full-loop-smoke.test.ts` | 端到端結構驗證 | 4 tests |
| `tests/integration/self-improve/m6-full-e2e.test.ts` | **完整端到端管線測試** | 40 tests |

#### M6 修改的既有檔案（6 個）

| 檔案 | 修改內容 |
|------|---------|
| `src/services/autoDream/consolidationPrompt.ts` | Phase 5-9 新增（~80 行 prompt 文本） |
| `src/services/autoDream/autoDream.ts` | `createEnhancedDreamCanUseTool` + `isSkillsPath` + import scanSkill（~50 行） |
| `src/state/AppStateStore.ts` | `pendingMemoryNudge` + `pendingSkillCandidate` 型別和預設值（+10 行） |
| `src/utils/backgroundHousekeeping.ts` | 3 import + 3 init 呼叫（+6 行） |
| `src/query/stopHooks.ts` | `executeSessionReview` + llamacpp 序列化邏輯（+20 行） |
| `src/Task.ts` | `'session_review'` TaskType + `'s'` prefix（+2 行） |

### 安全掃描（skillGuard）規則摘要

| 類別 | 模式數 | 嚴重度 | 範例 |
|------|--------|--------|------|
| `exfiltration` | 4 | critical/high | curl + $API_KEY、cat ~/.ssh |
| `injection` | 6 | critical | "ignore instructions"、"you are now" |
| `destructive` | 5 | critical/high | rm -rf /、chmod 777、mkfs |
| `persistence` | 5 | critical/high | crontab、~/.bashrc、authorized_keys |
| `obfuscation` | 6 | critical/high | base64 \| bash、eval()、__import__('os') |
| `supply_chain` | 4 | critical/high | curl \| bash、pip install 無版本 |
| `credential_exposure` | 2 | critical | 私鑰、硬編碼 API key |
| `agent_config_mod` | 3 | high | CLAUDE.md、.cursorrules、settings |
| `structure` | 動態 | high | > 10KB 大小限制 |

判決邏輯：`critical` finding → `dangerous`（阻擋）；僅 `high` findings → `caution`（允許）；無 finding → `safe`。

### 權限矩陣

| 操作 | extractMemories | Session Review | AutoDream (Enhanced) |
|------|----------------|----------------|---------------------|
| Read/Grep/Glob（任意路徑）| ✅ | ✅ | ✅ |
| Bash（唯讀：ls/grep/cat/stat 等）| ✅ | ✅ | ✅ |
| Edit/Write（memory/ 目錄）| ✅ | ✅ | ✅ |
| Edit/Write（.my-agent/skills/）| ❌ | ❌ | ✅ ← M6 新增 |
| Edit/Write（其他路徑）| ❌ | ❌ | ❌ |

### 門控條件摘要

| 機制 | 條件 | 頻率 |
|------|------|------|
| memoryNudge | `repl_main_thread` + 每 8 user turn | 每 session 約 2-5 次 |
| skillCreationNudge | `repl_main_thread` + 每 15 tool_use | 每 session 0-2 次 |
| sessionReview | `!agentId` + `!remote` + `autoMem` + tool_use ≥ 15 + 距上次 ≥ 2h | 每 2h 最多 1 次 |
| autoDream | `!kairos` + `!remote` + `autoMem` + `enabled` + 24h + 5 sessions + lock | 每 24h 最多 1 次 |

### AppState 新增欄位

```typescript
pendingMemoryNudge: {
  memories: { content: string; type: string; reason: string }[]
} | null   // 預設 null

pendingSkillCandidate: {
  isCandidate: boolean
  name?: string
  description?: string
  steps?: string[]
} | null   // 預設 null
```

### 測試統計

| 測試檔 | tests | expects | 說明 |
|--------|-------|---------|------|
| `enhanced-dream.test.ts` | 4 | 12 | Dream prompt Phase 1-9 |
| `memory-nudge.test.ts` | 5 | 7 | 解析 + 邊界案例 |
| `skill-creation-nudge.test.ts` | 5 | 12 | 解析 + 工具計數 + 格式化 |
| `skill-guard.test.ts` | 8 | 13 | 8 類威脅 + 結構限制 |
| `trajectory-store.test.ts` | 3 | 7 | 寫讀修剪 |
| `session-review.test.ts` | 3 | 9 | Prompt 結構 |
| `enhanced-dream-permissions.test.ts` | 4 | 8 | Phase 7-9 + 權限 |
| `full-loop-smoke.test.ts` | 4 | 7 | 端到端結構 |
| **`m6-full-e2e.test.ts`** | **40** | **137** | **完整管線模擬** |
| **合計** | **76** | **212** | |

全部使用 `bun test`，不依賴外部框架。76 tests / 9 files / 212+ expects 全綠。
