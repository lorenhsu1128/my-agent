# REPL 即時 tool 開關：`/tools` picker

## Context

使用者想在 TUI 裡即時關掉／打開特定 tool（例：qwen 9B 愛亂呼叫 curl，想把 Bash 關掉一段時間；或暫時關掉 WebBrowser 省資源）。目前 my-agent 只有 permission rule 系統能「deny tool 使用」，沒有「從 tool array 拿掉」的機制。

**使用者對齊後的決策**：
1. **持久化範圍**：session / per-project / global 三種都要，優先序 session > per-project > global > 預設（全開）
2. **UI**：多選 picker（方向鍵選、空白鍵切換、Enter 確認）
3. **影響層**：本 REPL client 獨立 — daemon 不知道；Discord / cron 的 turn 不受影響
4. **核心 tool 不可關**：`FileRead` / `FileWrite` / `FileEdit` / `Bash` / `Glob` / `Grep` 灰色不可選
5. **對 LLM 可見性**：完全隱藏（從 tool array 拿掉），LLM 不知道關掉的 tool 存在

## 架構：「註冊」vs「組裝」兩個層級

**關鍵理解**：my-agent 的 tool 有兩層 — **註冊**（編譯時靜態）和**組裝**（runtime 動態）。我們只改第二層。

### 註冊層（不動）

`src/tools.ts:getAllBaseTools()`（line 198-260）列出所有 41 個 tool，硬寫在 code 裡。這是「tool 存在本身」的定義 — 編譯時決定，改這層要 rebuild。

```ts
function getAllBaseTools(): Tool[] {
  return [
    AgentTool, AskUserQuestionTool, BashTool, BriefTool, ...
    WebBrowserTool, WebCrawlTool, WebFetchTool, ...
  ]
}
```

### 組裝層（runtime，即時生效）

每個 REPL turn 開始前，`src/hooks/useMergedTools.ts` 的 React hook 會重新「組裝」tool list：

```ts
return useMemo(() => {
  const assembled = assembleToolPool(toolPermissionContext, mcpTools)
  return mergeAndFilterTools(initialTools, assembled, ...)
}, [initialTools, mcpTools, toolPermissionContext, ...])
```

`assembleToolPool` 內部呼叫 `getTools()`，會做：
1. 從 `getAllBaseTools()` 拿完整清單
2. 濾掉 `REPL_ONLY_TOOLS`（若在 print mode）
3. 套 `permissionContext.alwaysDenyRules`
4. 呼叫每個 tool 的 `.isEnabled()`
5. **← 我們在這裡加一個新 filter step**：`tool => !disabledTools.has(tool.name) || UNTOGGLEABLE_TOOLS.has(tool.name)`

### 即時替換機制

tool list 每 turn 都重新組裝，所以「改 AppState → 下個 turn 立即生效」是免費的：

```
使用者按 space 切 WebCrawl → Picker Enter
  ↓
setAppState(s => ({ ...s, disabledTools: new Set([...s.disabledTools, 'WebCrawl']) }))
  ↓
useMergedTools 的 useMemo 重跑（因為 dep 裡 disabledTools 變了）
  ↓
React 重 render，新 tool array 進 REPL state
  ↓
下個 turn（使用者下一次打 prompt）送給 LLM 的 tools field 就不含 WebCrawl
```

**不需要**：
- rebuild（tool 定義沒改）
- restart daemon（AppState 是 REPL client 本地的 React state）
- 新開 REPL（同一 REPL session 內 live 更新）

**生效點**：`QueryEngine.ask()` 每次開 turn 時從 props 讀 current tools array — 因為 React 已經把新 array 往下傳了，下一個 turn 自然拿到新的。

### 資料流

```
~/.my-agent/settings.json                  (globalDisabledTools)
~/.my-agent/projects/<slug>/settings.json  (projectDisabledTools)
    ↓ bootstrap 合併（project 蓋 global）
AppState.disabledTools: Set<string>         (session override from picker)
    ↓ 讀取
useMergedTools hook  →  assembleToolPool(permCtx, { disabledTools })
    ↓ 過濾
getTools → filter out names in disabledTools（UNTOGGLEABLE 集合永遠不過濾掉）
    ↓ 給 QueryEngine 的 tool array（LLM 看到的）
```

### 儲存 schema

Global `~/.my-agent/settings.json`：
```json
{
  "disabledTools": ["WebCrawl", "Notebook"]
}
```

Per-project `~/.my-agent/projects/<slug>/settings.json`：同格式 `disabledTools: string[]`。

### Picker UI

```
┌─ Tools (space=toggle, enter=save session, p=save project, g=save global, esc=cancel) ─┐
│ [✓] AskUserQuestion                                                                    │
│ [ ] Bash                [core, locked]                                                 │
│ [ ] Brief                                                                              │
│ [ ] ConfigTool                                                                         │
│ [✓] CronCreate                                                                         │
│ ...                                                                                    │
│ [ ] FileRead            [core, locked]                                                 │
│ [ ] FileWrite           [core, locked]                                                 │
│ [✓] WebBrowser                                                                         │
│ [✗] WebCrawl            [disabled via global settings]                                 │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

- `[✓]` 啟用、`[ ]` 關閉、`[✗]` 目前已關且來自持久化設定
- `[core, locked]` tag：屬於 `UNTOGGLEABLE_TOOLS` 的 tool
- footer hint：`Enter=session save  p=save project  g=save global  r=reset  esc=cancel`

Enter 只寫回 AppState（session-only）。`p` / `g` 做完 session 改後額外 persist 到對應 settings.json。`r` 清空 session + 兩個 persist 層（一鍵全開）。

## 關鍵檔案

### 新增

- **`src/commands/tools/index.ts`** — command 註冊（type: `local-jsx`）
- **`src/commands/tools/ToolsPicker.tsx`** — picker UI，沿用 `src/commands/model/ModelPicker.tsx` pattern
- **`src/constants/untoggleableTools.ts`** — `UNTOGGLEABLE_TOOLS: Set<string>` 固定清單：
  ```ts
  export const UNTOGGLEABLE_TOOLS = new Set([
    'FileRead', 'FileWrite', 'FileEdit', 'Bash', 'Glob', 'Grep',
  ])
  ```
- **`src/hooks/useDisabledTools.ts`**（可選）— 封裝讀／寫 AppState + settings.json 的 hook

### 修改

- **`src/state/AppStateStore.ts`**（`~/src/state/AppStateStore.ts:89-449`）
  - 加欄位 `disabledTools: ReadonlySet<string>`（預設由 bootstrap 填入持久化合併值）
  - 加 action `setDisabledTools(next: Set<string>)`

- **`src/bootstrap/state.ts`**
  - 啟動時讀 global settings + project settings 的 `disabledTools`，merge（project 取代 global），filter 掉 UNTOGGLEABLE 裡的名字（防止設定檔誤塞核心 tool），存進 initial AppState

- **`src/tools.ts`**（`src/tools.ts:280-336` 的 `getTools`，或更上層 `assembleToolPool`）
  - 新增參數 `opts?: { disabledTools?: ReadonlySet<string> }`
  - 加一個 filter step，位置在 permission deny 之後、`.isEnabled()` 之前
  - filter 邏輯：`!disabledTools.has(tool.name) || UNTOGGLEABLE_TOOLS.has(tool.name)`（core 永遠通過）

- **`src/hooks/useMergedTools.ts`**
  - 用 `useAppState(s => s.disabledTools)` 取值
  - 傳給 `assembleToolPool` / `mergeAndFilterTools`

- **`src/commands.ts`**
  - 註冊新的 `tools` command

- **`src/utils/config.ts`** 或 settings 模組
  - settings schema 加 `disabledTools?: string[]`（Zod schema 驗證）
  - 暴露 `readDisabledTools(scope: 'global' | 'project')` / `writeDisabledTools(scope, list)` helper

### 不改

- 不改 `Tool.ts` 的介面（`isEnabled` 維持既有用途 — 那是 tool 自己決定自己可用，不是使用者關開關）
- 不改 daemon / WS protocol — per-user-request decision（user 在 REPL 改，daemon 不知道；Discord / cron 不受影響）
- 不改 permission system — 這是另一個正交系統（它決定「tool 能不能用」，我們這個是「tool 在不在 tool list」）

## 參考 pattern

- `/model` 的 picker（`src/commands/model/`）— arrow keys + enter 的標準範本
- `/mcp` 的 toggle pattern（`src/commands/mcp/mcp.tsx:63-84`）— 動態改 AppState
- `useMcpToggleEnabled()` hook — mutation hook 範本

## 邊界情況 / 決策備忘

- **關掉 tool 後 live turn**：下次 tool array 重組才生效（useMergedTools memoize 重算）。不會中斷當前執行中的 tool call
- **tool 名稱變更**：settings.json 裡寫死名稱。若未來 rename tool，舊 settings 的名字會變 no-op（tool 已經不存在），不會炸。Merge 時會自動忽略
- **UNTOGGLEABLE 被設定檔誤塞**：bootstrap 時 filter 掉，不生效；不拋錯
- **空 list vs undefined**：settings.json 沒寫 key、寫 `[]`、寫 `null` 都一致處理成「全開」
- **project scope 判定**：用現有 `getOriginalCwd()` + project slug（沿用 ~/.my-agent/projects/<slug>/）
- **Discord / cron 不受影響**：這是明確的設計選擇（user 決策 #3）。未來若要擴展到 daemon-wide，新增 WS frame `disabledToolsChanged` 加上 daemon-side 的 `ProjectRuntime.disabledTools`

## 驗證

1. `bun run typecheck` 綠
2. `bun run build` 綠
3. `./cli daemon stop && bun run build && ./cli daemon start`
4. REPL 打 `/tools` → 彈出 picker，看到所有 tool，core tool 有 `[core, locked]` tag 不可選
5. 空白切換 WebCrawl → Enter → 退出 picker
6. REPL 確認 `/tools` 再進去 WebCrawl 仍是關的（session 內持久）
7. 打 `/tools` 再按 `p` → 檢查 `~/.my-agent/projects/<slug>/settings.json` 有 `"disabledTools": ["WebCrawl"]`
8. 關 REPL 重開 → `/tools` 應維持 WebCrawl 關閉（per-project 生效）
9. 刪掉 per-project settings，寫 global `~/.my-agent/settings.json` 加 `"disabledTools": ["WebCrawl"]` → 重開 REPL 也關
10. per-project 同時寫 `["WebBrowser"]`、global 寫 `["WebCrawl"]` → picker 顯示 WebBrowser 關（per-project 蓋過 global）
11. `/tools` 按 `r` → 清空所有層 → 下次開全開
12. 關掉 WebBrowser 後叫 agent「打開 example.com」 → LLM 不該提到 WebBrowser（它不在 tool list），會退到 WebFetch 或 Bash
13. 單元測試：`src/tools.ts` 的 `getTools` 加 `disabledTools` 後的 filter behavior、UNTOGGLEABLE 永遠通過的 guard

## 不做（scope 外）

- daemon-wide 廣播（Discord / cron 不受影響是設計決策）
- 在 picker 裡用滑鼠點擊（純鍵盤，TUI 環境一致）
- per-tool 用量統計 / 歷史（可以未來加 `/tools stats`）
- 從 LLM 那端暴露「切換 tool」的能力（防止 agent 自己關掉 tool 自救失敗）
