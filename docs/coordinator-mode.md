# Coordinator Mode（多 agent 協作模式）

> 對應目錄：`src/coordinator/`
> Feature flag：`COORDINATOR_MODE`（`bun:bundle`）
> 啟用：`MY_AGENT_COORDINATOR_MODE=1`

進 coordinator 模式後，主 LLM 不再直接執行 tool，而是當「協調者」用 `Agent` tool 派 worker 執行研究、實作、驗證；自己只做 synthesize 與對使用者溝通。適合長任務、多檔案重構、並行研究這種會塞爆單一 context 的工作。

## 啟用條件

兩個 gate 都要過：

1. `feature('COORDINATOR_MODE')` — bundle-level flag，editor build 才打開。
2. `MY_AGENT_COORDINATOR_MODE` env var truthy — runtime opt-in。

實作見 `coordinatorMode.ts:35` `isCoordinatorMode()`。

## 與 normal mode 的差異

| 面向 | Normal | Coordinator |
|---|---|---|
| 主 LLM 角色 | 直接執行 tool | 派 worker、synthesize |
| 預設 system prompt | 一般 agent prompt | `getCoordinatorSystemPrompt()`（300+ 行協作守則）|
| 主 LLM 可用工具 | 全部 enabled tool | `Agent` / `SendMessage` / `TaskStop` 為主，加 PR 訂閱 tool |
| Worker 工具集 | n/a | `ASYNC_AGENT_ALLOWED_TOOLS`（扣掉 4 個 internal worker tool）|
| `MY_AGENT_SIMPLE` 模式下 worker 工具 | n/a | 只給 Bash / Read / Edit |
| Scratchpad | 不用 | Workers 共用 scratchpad dir 寫入 cross-worker 知識 |
| Session 標記 | `mode: 'normal'` | `mode: 'coordinator'`（resume 時自動切回）|

## Worker 系統

Coordinator 透過 `Agent` tool 派 worker（`subagent_type: 'worker'`），prompt 必須**自包含**（worker 看不到 coordinator 的對話）。

Worker 完成後送回 `<task-notification>` XML 包在 user-role message 內（**不是真使用者**）：

```xml
<task-notification>
<task-id>agent-a1b</task-id>
<status>completed|failed|killed</status>
<summary>...</summary>
<result>...</result>
<usage>
  <total_tokens>N</total_tokens>
  <tool_uses>N</tool_uses>
  <duration_ms>N</duration_ms>
</usage>
</task-notification>
```

Coordinator 用 `SendMessage({ to: 'agent-a1b', message: ... })` 接續同一 worker，或 `TaskStop({ task_id })` 中止後再 `SendMessage` 給新指令。

### Continue vs. spawn fresh

| 場景 | 建議 | 原因 |
|---|---|---|
| 研究剛好涵蓋要改的檔 | Continue | 檔案還在 context |
| 研究範圍廣、實作範圍窄 | Spawn fresh | 避免拖著 exploration 雜訊 |
| 修正失敗 / 延伸剛剛工作 | Continue | error context 還在 |
| 驗證另一個 worker 寫的 code | Spawn fresh | reviewer 該帶新眼光 |
| 完全無關的新任務 | Spawn fresh | 沒有可重用 context |

## Session resume：mode 自動對齊

`matchSessionMode(sessionMode)`（`coordinatorMode.ts:48`）：resume session 時若記錄的 mode 與當前 env 不一致，會 flip env var 並回傳警示訊息。讓使用者把 coordinator session resume 在 normal env 也能正常運作。

## Scratchpad

當 coordinator mode + scratchpad gate 開啟時，`getCoordinatorUserContext()` 會在 user message 注入：

```
Workers spawned via the Agent tool have access to these tools: ...
Scratchpad directory: <path>
Workers can read and write here without permission prompts.
```

`scratchpadDir` 由 `QueryEngine.ts` 透過 dependency injection 傳入（`coordinatorMode.ts:21` 註解：直接 import filesystem.ts 會 circular dep）。

## 觀測

切換 coordinator mode 會送 analytics event：

```
tengu_coordinator_mode_switched { to: 'coordinator' | 'normal' }
```

實作於 `coordinatorMode.ts:70`。

## 物件路徑

| 檔案 | 內容 |
|---|---|
| `src/coordinator/coordinatorMode.ts` | `isCoordinatorMode()` / `matchSessionMode()` / `getCoordinatorUserContext()` / `getCoordinatorSystemPrompt()` |
| `src/constants/tools.ts` | `ASYNC_AGENT_ALLOWED_TOOLS` worker 工具白名單 |
| `src/tools/AgentTool/` | `Agent` tool 本體（worker 派發） |
| `src/tools/SendMessageTool/` | `SendMessage` tool（接續 worker） |
| `src/tools/TaskStopTool/` | `TaskStop` tool（中止 worker） |
| `src/tools/SyntheticOutputTool/` | worker 內部工具（用於合成輸出） |

## 注意事項

- **不要 set worker 的 `model` 參數**：worker 需要預設 model 才能勝任 substantive task（system prompt 明文要求）。
- **Read-only task 並行、write-heavy 串行**：避免多 worker 同時改同一批檔。
- **Worker prompt 必含完整 spec**：file path、line number、error message、done 條件、要不要 commit。lazy delegation（「based on your findings, fix the bug」）是反模式。
- **Verification 要 prove，不只 confirm exist**：跑 test、查 typecheck error、試 edge case。
