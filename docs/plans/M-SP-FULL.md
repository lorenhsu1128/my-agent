# Plan C — 系統提示根本性外部化（M-SP-FULL）

## Context

**起因**：使用者要把 my-agent 同時作為 REPL 程式助理 + 桌寵伴侶大腦。設定檔只有一組，桌寵連線時人格不適當。先把「系統提示外部化」這層做徹底，讓未來（桌寵方案）可以「換 cwd → 換 persona」零侵入解決，不必動 my-agent 程式碼。

**現況實話**（與既有 ADR-008 / `docs/customizing-system-prompt.md` 宣稱的有落差）：

1. M-SP（29 個 section 外部化）在 REPL 模式下確實能 per-project，但 **daemon 模式下 per-project 是壞的**：
   - `src/systemPromptFiles/snapshot.ts:18` `cachedSnapshot` 是 module-level singleton，process 內只載一次。
   - `src/setup.ts:309-310` 在 daemon 啟動時呼叫 `loadSystemPromptSnapshot()`，當下 cwd 算出 project slug 凍結。
   - 多個 project（不同 cwd）attach 到同一個 daemon 後，**全部讀同一份 snapshot**，per-project section 檔案永遠不被讀取。

2. `customSystemPrompt` / `appendSystemPrompt` 鉤子在 daemon 模式**沒有任何來源**：
   - `src/daemon/queryEngineRunner.ts:69-70` 兩個欄位存在，傳給 `ask()`（vendor SDK 路徑，非 QueryEngine.ts，合 ADR-005）。
   - `src/daemon/projectRuntimeFactory.ts:89-94` 建 runner 時兩欄都不傳。REPL 走 `buildEffectiveSystemPrompt()`（`src/utils/systemPrompt.ts:41`）解決優先序，daemon 完全沒接。

3. `docs/prompt-inventory.md` 記錄 13+ 條 sub-LLM prompt（cron NL parser / queryHaiku / memory selector / persona editor / extract memories / verification agent / agent tool / SessionMemory / MagicDocs / toolUseSummary / coordinator / buddy）全部 hardcoded，使用者無法外部化。

**目標**：把這三層全部修掉，使用者只要編輯 `~/.virtual-assistant-desktop/projects/<slug>/` 下的 markdown 檔，就能在不改程式、不重 build 的前提下，完全替換 / 追加 / 微調系統提示與 sub-LLM 提示。

## 既有可重用設施

- **`loadSystemPromptSection(id)`**（`src/systemPromptFiles/loader.ts:37`）：per-project > global > bundled fallback，已 production-ready。
- **`getSystemPromptProjectDir()`**（`src/systemPromptFiles/paths.ts:28`）：依 cwd 算 slug，重用 memdir。
- **`loadSystemPromptSnapshot()` / `getSection()`**（`src/systemPromptFiles/snapshot.ts`）：snapshot 模式（一次讀完凍結，per-turn 同步存取）。
- **`buildEffectiveSystemPrompt()`**（`src/utils/systemPrompt.ts:41`）：override > coordinator > agent > custom > default + append 的優先序組裝器，REPL 已用。
- **`bootstrapDaemonContext()`**（`src/daemon/sessionBootstrap.ts:94`）：daemon 每個 project attach 時呼叫，是注入 per-project snapshot 的天然點。
- **`createQueryEngineRunner()` 的 `customSystemPrompt`/`appendSystemPrompt` opts**：傳給 `ask()`，`ask()` 內 `customSystemPrompt` 完全替代 default、`appendSystemPrompt` 接在最後（`src/services/api/queryContext.ts:62-73`）。

## 三階段實作

### Phase 1 — Snapshot 改 per-cwd Map（修 daemon bug）

**目的**：讓 daemon 多 project 共存時，每個 project 看到自己 cwd 對應的 M-SP 檔。

**程式碼變動**（`src/systemPromptFiles/snapshot.ts`）：

- `cachedSnapshot: SystemPromptSnapshot | null` → `snapshotsByProjectKey: Map<string, SystemPromptSnapshot>`。
- `projectKey` = 由 cwd 算出的 slug（重用 `getSystemPromptProjectDir()` 的 slug 邏輯，新 export 一個 `getProjectSlugForCwd(cwd)`）。
- `loadSystemPromptSnapshot(cwd?)`：未提供 cwd 走 `process.cwd()`（向後相容 REPL）。
- `getSection(id, cwd?)`：未提供 cwd 走 `process.cwd()`。Daemon 路徑必須帶 cwd。
- `_resetSystemPromptSnapshotForTests()`：清整個 Map。

**呼叫端調整**：

- `src/daemon/sessionBootstrap.ts:94` `bootstrapDaemonContext()` 內加 `await loadSystemPromptSnapshot(opts.cwd)`，把 snapshot 物件存入 `DaemonSessionContext`（新欄位 `systemPromptSnapshot`）。
- `src/constants/prompts.ts` 內的 `getExternalSection(id)` 呼叫點（L195/217/235/308/324/485/500/595/611/627/847/899/923/973/980 等 17 處）改成接受 cwd / context 參數。**這裡有風險**：`getSystemPrompt()` 簽名要新增 `cwd` 參數（或讓 `ask()` 把當前 cwd 灌進 thread-local）。
  - **較乾淨方案**：在 `src/services/api/queryContext.ts:fetchSystemPromptParts()` 內把 `cwd` 透過 `AsyncLocalStorage` 設好，prompts.ts 內 `getExternalSection(id)` 從 ALS 讀；不影響函數簽名。
  - 不能做的：把 cwd 寫進 module-level 變數（會競態，多 project 同時 ask 互蓋）。
- `src/setup.ts:309-310` 維持現狀（REPL 啟動 cwd），但不再是 daemon 的權威來源。
- `scripts/dump-system-prompt.ts:42-43`：加 `cwd` 參數驗證 per-project 載入。

**ADR 影響**：補一條 ADR-008-A（per-cwd snapshot 修正），不推翻 ADR-008。

### Phase 2 — Project-level override / append 兩個新檔

**目的**：使用者不需開 29 個 section 檔，丟一個 markdown 就能換整套人格 / 加一段話。

**新增檔案約定**（`src/systemPromptFiles/paths.ts`）：

```
~/.virtual-assistant-desktop/projects/<slug>/system-prompt-override.md   ← 完全替代 default
~/.virtual-assistant-desktop/projects/<slug>/system-prompt-append.md     ← 追加在最後
~/.virtual-assistant-desktop/system-prompt-override.md                   ← global 層 override
~/.virtual-assistant-desktop/system-prompt-append.md                     ← global 層 append
```

優先序：per-project > global > 無。Override 與 append 各自獨立解析（兩者可同時存在）。

**新 API**（`src/systemPromptFiles/overrides.ts`，新檔）：

```typescript
export interface ProjectPromptOverrides {
  override?: string  // 整段替代 default（對應 customSystemPrompt）
  append?: string    // 追加到最後（對應 appendSystemPrompt）
}
export async function loadProjectPromptOverrides(cwd: string): Promise<ProjectPromptOverrides>
export function getProjectPromptOverrides(cwd: string): ProjectPromptOverrides  // sync from snapshot
```

整合進現有 snapshot：把 overrides 存進 `SystemPromptSnapshot`（新欄位 `overrides: ProjectPromptOverrides`），跟 sections 一起 per-cwd 快取。

**daemon 接線**（`src/daemon/projectRuntimeFactory.ts:89-94`）：

```typescript
const overrides = getProjectPromptOverrides(cwd)
const rawRunner = createQueryEngineRunner({
  context,
  canUseTool: permissionRouter.canUseTool,
  projectId,
  customSystemPrompt: overrides.override,
  appendSystemPrompt: overrides.append,
})
```

**REPL 接線**（`src/main.tsx` 與 `src/utils/systemPrompt.ts`）：`buildEffectiveSystemPrompt()` 已支援 `customSystemPrompt`/`appendSystemPrompt` 參數。改 caller（`main.tsx`）讓 `--system-prompt` flag 為空時改讀 `getProjectPromptOverrides(cwd).override`，append 同理。優先序：CLI flag > 檔案 > 無。

**Seed**（`src/systemPromptFiles/seed.ts`）：

- Global 層 `~/.virtual-assistant-desktop/system-prompt-override.md` 與 `system-prompt-append.md` **首次啟動 seed 真檔案**（不用 `.example` 後綴）。
- `system-prompt-override.md` seed 內容：**把 default 29 個 section 依 `getSystemPrompt()` 的順序拼成完整字串寫入**，當作使用者改寫的起點。
  - 實作：在 seed 階段呼叫一個新 helper `composeFullDefaultPrompt()`，把 `BUNDLED_DEFAULTS` 內 29 個 section 依 `SECTIONS` 排序串接（含 dynamic boundary 標記與 section 之間空行）。
  - 注意：seed 出來的字串是「snapshot 當下的 bundled default 組合」，my-agent 後續升級改了 bundled default，使用者的 override.md **不會自動跟上**（這是 override 機制的本質；REPL 與 daemon 都同樣）。README 必須明寫此語義。
- `system-prompt-append.md` seed 內容：純註解模板（`<!-- 在這裡寫要追加到 system prompt 末尾的內容 -->\n`），預設不啟用任何追加（內容只有註解，trim 後會是空字串 → 但既然檔案存在，loader 會視為「明確覆蓋為純註解」=> 註解本身會進 prompt）。
  - **修正方案**：append.md seed 內容改為**真正的空字串 + 一行註解**，但要在 `loadProjectPromptOverrides()` 內把純註解 / 空字串視為「無 append」（不傳給 runner）。
  - 或更簡單：append.md 不 seed，使用者要用就自己建（與 override 不對稱，但安全）。
  - **採用後者**（append 不 seed），保留 override seed。
- Per-project 層 `~/.virtual-assistant-desktop/projects/<slug>/` 不自動 seed 任何 override / append 檔，維持 lazy（與現行 per-project section 同語義）。
- README.md（`seedSystemPromptDirIfMissing()` 寫入的）章節更新：
  - 解釋 override.md 是 default 拷貝，可直接編輯做客製。
  - 警告：override.md 存在會 bypass 整個 default 組裝；my-agent 升級時 default 改了，override.md 不會自動同步，要手動 diff / 刪檔回 default。
  - 解釋 append.md 沒 seed，要追加就自建，內容會接在 system prompt 最後。
  - 解釋 per-project 覆寫：把檔複製到 `~/.virtual-assistant-desktop/projects/<slug>/` 同名位置即優先生效。

**文件**：`docs/customizing-system-prompt.md` 加 §override-and-append 章節，並加範例（桌寵伴侶人格、code review 人格等）。

### Phase 3 — Sub-LLM Prompts 全面外部化（M-SP-SUBLLM）

**目的**：讓 cron parser、memory selector、verification agent 等 13+ 條目前 hardcoded 的 prompt 也走 loader。

**新增 sections**（`src/systemPromptFiles/sections.ts` 加 entries，路徑用 `subllm/` 子目錄；`src/systemPromptFiles/bundledDefaults.ts` 把現有 hardcoded 字串搬進來）：

| 新 SectionId | 來源檔案 | 對應 .md |
|---|---|---|
| `subllm/cron-parser` | `src/utils/cronNlParser.ts:30` | `subllm/cron-parser.md` |
| `subllm/memory-selector` | `src/memdir/findRelevantMemories.ts:69` | `subllm/memory-selector.md` |
| `subllm/persona-editor` | `src/services/extractMemories/prompts.ts:36` | `subllm/persona-editor.md` |
| `subllm/extract-opener` | `src/services/extractMemories/prompts.ts:61` | `subllm/extract-opener.md` |
| `subllm/extract-auto-only` | `src/services/extractMemories/prompts.ts:82` | `subllm/extract-auto-only.md` |
| `subllm/extract-combined` | `src/services/extractMemories/prompts.ts:134` | `subllm/extract-combined.md` |
| `subllm/verification-agent` | `src/tools/AgentTool/built-in/verificationAgent.ts:10` | `subllm/verification-agent.md` |
| `subllm/agent-tool` | `src/tools/AgentTool/prompt.ts:14-112` | `subllm/agent-tool.md` |
| `subllm/session-memory-template` | `src/services/SessionMemory/prompts.ts:11` | `subllm/session-memory-template.md` |
| `subllm/session-memory-update` | `src/services/SessionMemory/prompts.ts:43` | `subllm/session-memory-update.md` |
| `subllm/magic-docs-update` | `src/services/MagicDocs/prompts.ts:8` | `subllm/magic-docs-update.md` |
| `subllm/tool-use-summary` | `src/services/toolUseSummary/toolUseSummaryGenerator.ts:15` | `subllm/tool-use-summary.md` |
| `subllm/coordinator-user-context` | `src/coordinator/coordinatorMode.ts:79` | `subllm/coordinator-user-context.md` |
| `subllm/buddy-companion` | `src/buddy/prompt.ts:7` | `subllm/buddy-companion.md` |

對每個原始呼叫點：
- 改成 `getSection('subllm/xxx', cwd) ?? FALLBACK_HARDCODED`（fallback 保留以防 snapshot 未載）。
- 帶變數的（如 MagicDocs 的 `{{docPath}}`、SessionMemory `{{section}}`）改用 `getSectionInterpolated()`（snapshot.ts 已支援，但要擴白名單；目前 regex 限 `[A-Za-z_][A-Za-z0-9_]*`，雙花括號 `{{x}}` 要不要支援是設計選擇——建議保持單花括號 `{x}` 統一，外部化時把 `{{x}}` 改 `{x}`，因為這是內部約定不影響外部 API）。

**範圍取捨**：
- 包含的 13 條：高 ROI、使用者最可能想客製的（記憶/驗證/工具摘要/buddy 風格等）。
- 不包含：tool descriptions（41 個）與 bundled skills（27 個）— 量太大且 schema 本身是 LLM API 契約，留作獨立 milestone（M-TOOL-PROMPT-EXTERNALIZE / M-SKILL-EXTERNALIZE）。
- 不包含：`computeSimpleEnvInfo()`（`prompts.ts:733`）— 環境資訊本來就是動態填值，不適合純 markdown。

**Seed**：所有 13 個 sub-LLM prompt 都 seed 進 `~/.virtual-assistant-desktop/system-prompt/subllm/`（與現行 29 section 一致）。預期容量 ~15KB，使用者用不到 sub-LLM 客製就維持預設。

## 檔案清單（要改 / 新增）

### 新增
- `src/systemPromptFiles/overrides.ts` — `loadProjectPromptOverrides()` / `getProjectPromptOverrides()`
- `tests/integration/systemPromptFiles/per-project-snapshot.test.ts` — 多 cwd snapshot 隔離驗證
- `tests/integration/systemPromptFiles/overrides.test.ts` — override / append 載入 + 優先序
- `tests/integration/systemPromptFiles/subllm-externalization.test.ts` — 13 條 sub-LLM fallback + 覆寫

### 修改
- `src/systemPromptFiles/snapshot.ts` — singleton → per-cwd Map
- `src/systemPromptFiles/sections.ts` — 加 14 個 `subllm/*` SectionId
- `src/systemPromptFiles/bundledDefaults.ts` — 搬進 13 條 sub-LLM 字串
- `src/systemPromptFiles/paths.ts` — 加 override / append 路徑 helper + `getProjectSlugForCwd(cwd)` export
- `src/systemPromptFiles/seed.ts` — README.md 加 override/append 說明；seed sub-LLM defaults
- `src/services/api/queryContext.ts` — `AsyncLocalStorage` 設 cwd（給 `getExternalSection` 讀）
- `src/constants/prompts.ts` — `getExternalSection()` 改從 ALS 讀 cwd（17 處不動，loader 內部處理）
- `src/daemon/sessionBootstrap.ts` — `bootstrapDaemonContext()` 加 `await loadSystemPromptSnapshot(cwd)` + 把 snapshot ref 放進 context
- `src/daemon/projectRuntimeFactory.ts:89-94` — 讀 overrides 注入 runner
- `src/utils/cronNlParser.ts:30` — 改用 `getSection('subllm/cron-parser')`
- `src/memdir/findRelevantMemories.ts:69` — 改用 `getSection('subllm/memory-selector')`
- `src/services/extractMemories/prompts.ts` — 4 條改用 sub-LLM section
- `src/tools/AgentTool/built-in/verificationAgent.ts:10` — 改用 section
- `src/tools/AgentTool/prompt.ts` — 改用 section
- `src/services/SessionMemory/prompts.ts` — 2 條改用 section
- `src/services/MagicDocs/prompts.ts:8` — 改用 section
- `src/services/toolUseSummary/toolUseSummaryGenerator.ts:15` — 改用 section
- `src/coordinator/coordinatorMode.ts:79` — 改用 section
- `src/buddy/prompt.ts:7` — 改用 section
- `src/main.tsx` — REPL 路徑接 `getProjectPromptOverrides(cwd)`
- `scripts/dump-system-prompt.ts` — 加 `--cwd` 參數驗 per-project
- `docs/customizing-system-prompt.md` — §override-and-append + §sub-llm-prompts 章節
- `docs/prompt-inventory.md` — 標註 13 條 sub-LLM 已外部化
- `docs/adr.md` — 新增 ADR-008-A（per-cwd snapshot）
- `CLAUDE.md` — 規則 13 之後補一條：sub-LLM prompts 也走 M-SP loader
- `TODO.md` — M-SP-FULL milestone 條目

### 刻意不動
- `src/QueryEngine.ts` — ADR-005 deny list
- `src/services/tools/StreamingToolExecutor.ts` — ADR-005 deny list
- 41 個 `src/tools/<Name>/prompt.ts` — 留作獨立 milestone
- 27 個 `src/skills/bundled/*.ts` — 留作獨立 milestone

## 工作量估計

- **Phase 1**: ~300 行（snapshot.ts 改寫 + AsyncLocalStorage 接線 + 測試）。1 天。
- **Phase 2**: ~200 行（overrides.ts + paths.ts + seed.ts 文件 + daemon/REPL 接線 + 測試）。0.5 天。
- **Phase 3**: ~600 行（14 個 SectionId + bundledDefaults 搬字串 + 14 個呼叫點改造 + 測試）。1.5 天。
- **文件**：customizing-system-prompt.md / prompt-inventory.md / adr.md / CLAUDE.md 同步。0.5 天。

合計 ~3.5 天。

## 跨平台

- 路徑全用 `path.join`，不寫死 `/`。
- `~` 解析走既有 `getMemoryBaseDir()`（已支援 Windows）。
- `readFileSafe` 已剝 BOM（`loader.ts:20`）。
- `AsyncLocalStorage`：Node 14+/Bun 全支援。
- Windows / macOS 預期完全等價（Phase 1-3 都不依賴 OS 行為）。

## 驗證 / 測試

### 單元
- `tests/integration/systemPromptFiles/per-project-snapshot.test.ts`：兩個假 cwd（`/tmp/proj-a`、`/tmp/proj-b`）各放不同 `tone-style.md`，呼叫 `getSection('tone-style', cwdA)` 與 cwdB 拿到不同字串。
- `tests/integration/systemPromptFiles/overrides.test.ts`：放 override.md → 取代 default；放 append.md → 接在最後；同時放 → 既取代又追加。
- `tests/integration/systemPromptFiles/subllm-externalization.test.ts`：每個 sub-LLM section 都有 fallback 路徑 + 覆寫路徑。

### 整合
- `tests/integration/daemon/persona-per-project.test.ts`（新）：起 daemon，attach project A（普通）+ project B（system-prompt-override.md = 「你是貓」），各送一句 `Hi`，驗 B 的 system prompt 含「你是貓」、A 不含。
- `bun run typecheck` 綠。
- `bun run docs:gen` 不必跑（這 milestone 不動 zod schema）。

### 手測
- `./cli -p "what are you"` 在 my-agent repo cwd → 預設程式助理人格。
- `mkdir -p ~/.virtual-assistant-desktop/projects/$(pwd-slug)/system-prompt-override.md`，寫「你是 Linus Torvalds」→ 同 cwd 再跑 `./cli -p "what are you"` 驗變身。
- `./cli daemon` + 兩個不同 cwd 同時 attach（用 web mode 或 mascot WS 驗），每個 project 收到自己的 override。
- `bun run scripts/dump-system-prompt.ts --cwd /path/to/proj-a` 驗 dump 內容反映 per-project 檔案。

### 冒煙
- 既有 17 個 system prompt section + 主對話功能不退化（跑現有 `tests/integration/bootstrap/seed-coverage.test.ts`、E2E 的 `tests/e2e/decouple-comprehensive.sh`）。
- 13 條 sub-LLM 對應功能（cron parse / memory recall / verification agent / tool summary / buddy）各跑一次手動冒煙。

### Commit 前必跑（規則 5 + memory `feedback_commit_smoke_test`）
- `bun run typecheck`
- `bun run build:dev` + `./cli -p "hello"` 冒煙
- 新增的整合測試
- M-DECOUPLE E2E（如有觸及 OAuth/品牌邊界，本 milestone 不動，但保險起見跑 `tests/e2e/decouple-comprehensive.sh`）

## 風險 / 邊角

1. **AsyncLocalStorage 漏網**：若有 `getExternalSection()` 呼叫不在 `ask()` 觸發鏈內（例如 startup banner），ALS 會空，回 process.cwd()。需要 grep 全部 17 處呼叫一一驗證。
2. **REPL `--system-prompt` flag 與檔案優先序**：必須 CLI flag 高於檔案，且明確記在 docs。
3. **多 daemon project 同時 ask**：AsyncLocalStorage 自動 scope 到 async chain，理論安全；測試要包含並發兩個 project 各跑一個 turn。
4. **sub-LLM 字串裡若含 `{var}`**：搬出去前先檢查是不是 hardcoded 變數（如 cronNlParser 的 `${nowLocal}`），這些要保留 template 形式並用 `getSectionInterpolated()`。
5. **ADR-005**：QueryEngine.ts / StreamingToolExecutor.ts 完全不動。所有變動在 daemon / vendor SDK 邊界外圍與 prompts.ts / loader 層。
6. **ADR-008**：保留現有 per-project > global > bundled 語義；只是把 snapshot 從 singleton 改成 Map。新加的 ADR-008-A 補充而非推翻。
7. **Seed 後 override.md 與 default 漂移**：`system-prompt-override.md` 首次啟動 seed = 當下 default 拼出來的整段字串。後續 my-agent 升級若改了 bundled default，使用者的 override.md 仍是 seed 當下版本（不會跟隨升級）。這是 override 語義的必然代價（一旦使用者要客製，default 升級就不該偷偷套用）。**緩解**：README seed 內容明寫此語義 + 提供一句「想回到 default 就刪 override.md」+ 升級時 changelog 提示「若有手動同步需求，可重 seed 並 diff」。
8. **Append.md 不 seed**：與 override.md seed 不對稱（override seed default 拷貝、append 不 seed）。理由：append 沒有「拿 default 當起點」的需求（append 預期是少量追加文字），seed 空檔又會踩「空字串是合法覆蓋」陷阱。README 寫清楚兩者差異即可。

## 與後續桌寵方案的銜接

完成 Plan C 後，桌寵方案最簡解法：
- desktop 端 spawn daemon 時把 cwd 設成 `~/.virtual-assistant-desktop/mascot-workspace/`（新建空目錄）。
- 在 `~/.virtual-assistant-desktop/projects/<mascot-slug>/system-prompt-override.md` 寫桌寵伴侶人格。
- 在 `~/.virtual-assistant-desktop/projects/<mascot-slug>/.virtual-assistant-desktop.jsonc` 設 `allowedTools` 限縮工具集（這是既有 config 機制，不在 Plan C 範圍）。
- REPL 使用者的 cwd 是專案目錄，看到的是程式助理人格；桌寵 cwd 不同 → 看到桌寵人格。**單一 daemon 多 project 並存，零 my-agent 程式碼改動**。

桌寵方案還會用到的另一塊（B4 source-aware tool filter）獨立於 Plan C，作為桌寵專屬 milestone。
