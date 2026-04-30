# M-CONFIG-DOCTOR — Config 健康診斷與自動修復工具

## Context

**起因**：M-CONFIG-SEED-COMPLETE 完成後，發現以下情境仍需人工介入：

- 使用者誤刪 / 誤改 jsonc 導致 schema 驗證失敗 → 目前只 stderr warn 後走 DEFAULT，使用者沒被告知細節
- llamacpp.jsonc 的 `model` 與 `server.alias` 不一致 → server 拒請求，但 my-agent 不會主動驗證
- llamacpp template 加新欄位後，舊 jsonc 沒有那段繁中註解（schema validation 過但缺解釋）
- 跨平台搬遷後 binaryPath 副檔名不對（`.exe` on macOS）→ shell 端啟動失敗
- env var override 蓋掉了使用者 jsonc 設定，使用者不知道為何修改沒生效
- 5 個 backup 留在 `~/.my-agent/backups/` 但無 retention TUI

**目標**：一個 `/config doctor`（slash）+ `my-agent config doctor`（CLI）入口，
分 `--check`（純讀）/ `--fix`（自動修可修的）/ `--rewrite-with-docs`（重套模板）三模式，
覆蓋 5 個 jsonc + system-prompt/。

---

## 對齊決策（2026-04-30）

- **Q1=C**：slash command + CLI subcommand 兩者都做
- **Q2=B**：每次 session start 跑 `--check`（REPL + daemon 都跑）— 比建議的 A 更頻繁，要確保 check 跑得夠快（< 50ms）
- **Q3=A**：只 my-agent 5 個 jsonc + system-prompt/
- **Q4=A**：每次 `--fix` 寫前都備份到 `~/.my-agent/backups/`
- **Q5=A**：跨檔一致性檢查走警告級（mismatch 但不自動 fix）

---

## 原始決策題目

### Q1：命令位置
- **A**：只做 slash command `/config doctor`（REPL / Web / Discord 都可呼叫）
- **B**：只做 CLI subcommand `my-agent config doctor`（適合 CI / 自動化）
- **C**：兩者都做（slash 包 CLI），代價是兩個入口要維護
- **建議：C**，因為 daemon 自動 check 必須走 CLI 路徑（沒 REPL），同時 slash 對活躍 session 體驗最好

### Q2：自動執行時機
- **A**：daemon start 時自動跑 `--check`，發問題只 warn（不 block 啟動）
- **B**：每次 session start 跑 `--check`（REPL + daemon 都跑）
- **C**：完全 opt-in，使用者主動跑
- **建議：A**，因為 daemon 啟動是低頻事件，跑一次 check 開銷可接受；REPL 啟動每秒可能多次（CI / 一次性 prompt），不適合

### Q3：檢查範圍
- **A**：只 my-agent 5 個 jsonc + system-prompt/
- **B**：A + `.claude/settings.json`、`.my-agent/skills/*/SKILL.md`、`docs/dev-log/` 等周邊檔
- **C**：A + 使用者額外指定路徑
- **建議：A**，避免 scope creep；周邊檔由各模組自己驗

### Q4：backup 策略
- **A**：每次 `--fix` 寫前都備份到 `~/.my-agent/backups/<file>.<ts>`（已有機制）
- **B**：只 destructive 修復才備份（rewrite-with-docs / migration）
- **C**：完全不備份，靠 git
- **建議：A**，跟 saveConfigWithLock 既有 backup 邏輯一致，並沿用 5 個 retention

### Q5：跨檔一致性檢查嚴格度
- **A**：警告級（mismatch 但不 fix）— `model ≠ server.alias` 提示但不改
- **B**：自動修復（pick 一個來源為真理）
- **C**：互動式（doctor 問使用者選哪個）
- **建議：A**，自動修復可能改錯方向；互動式不適合 CLI 模式

---

## 設計：三模式 + 多層檢查

### 模式

| 模式 | 行為 | exit code | 用途 |
|---|---|---|---|
| `--check` | 純讀，列所有問題（含警告） | 0 = 全綠 / 1 = 有 ERROR / 2 = 有 WARNING | 預設模式；CI / 自動化 / 排查 |
| `--fix` | 自動修「可安全修」的（缺檔 seed / strict JSON migrate / 補檔） | 0 = 全修好 / 1 = 還剩 unfixable | 互動式 / 排查後執行 |
| `--rewrite-with-docs` | 強制套最新模板（保留使用者值，補回註解 + 新欄位） | 0 / 1 | 升級後重新落地註解 |

### 檢查項目（依嚴重度分級）

**ERROR（必須修才能正常運作）**
1. JSONC 解析失敗 → 顯示 offset + 建議 `--fix` 重 seed（會備份壞檔）
2. Schema 驗證失敗 → 列出每個 fail field + expected type + 建議補值
3. llamacpp.jsonc 的 `model ≠ server.alias` → 顯示兩值，建議改哪個
4. binaryPath 指向不存在的檔 + 副檔名與當前平台不符 → 提供 platform-correct 路徑

**WARNING（不影響運作但會踩到使用者）**
5. system-prompt/ 個別 section 檔不存在 → 走 bundled fallback；建議 seed 補回
6. env var override 覆蓋了 jsonc 中的非 default 值 → 列出哪個 env / 哪個 field / jsonc 值 / 實際值
7. bundled template 含使用者 jsonc 沒有的新欄位（schema 加了但模板沒同步落地）→ 建議 rewrite-with-docs
8. backup dir 超過 5 份 → 提示舊的會被自動清掉
9. `~/.my-agent/.my-agent.jsonc` 是 strict JSON（沒升級成 JSONC）→ 建議 fix（走 migration）

**INFO（純資訊）**
10. 列出每個 config 的實際載入路徑 + env override 來源
11. 列出當前 platform / contextSize / model 等關鍵摘要

### Fix 動作對照表

| 檢查 | --check 行為 | --fix 行為 |
|---|---|---|
| 1 JSONC 解析失敗 | report ERROR | 備份壞檔 → 重 seed |
| 2 Schema 失敗 | report ERROR + diff | **不自動 fix**（值是使用者意圖） |
| 3 alias mismatch | report ERROR | **不自動 fix**（不知道哪個是真理） |
| 4 binaryPath 副檔名 | report ERROR | 改寫為 platform-correct 路徑 + 備份 |
| 5 system-prompt 缺檔 | report WARNING | 補檔（seedSystemPromptDirIfMissing 已支援，P3 修復） |
| 6 env override | report WARNING | **不 fix**（env 是合法 override） |
| 7 template 落後 | report WARNING | 走 rewrite-with-docs（保留使用者值，補回註解 + 新欄位） |
| 8 backup 累積 | report INFO | 自動清掉超過 5 份的 |
| 9 strict JSON | report WARNING | 走 migration（既有 seed.ts 已支援） |

---

## 實作策略

### 模組結構

新檔 `src/configDoctor/`：
- `index.ts`：對外 API `runConfigDoctor({ mode })`
- `checks/llamacppCheck.ts`、`webCheck.ts`、`discordCheck.ts`、`globalCheck.ts`、`systemPromptCheck.ts`：每個 config 一個檢查器，回傳 `Issue[]`
- `report.ts`：把 Issue 結果格式化（plain / json）
- `fixers/`：每個 fix action 一支函式，以 dry-run + actual 兩模式呼叫

複用：
- 既有 `parseJsonc` / `LlamaCppConfigSchema.safeParse` 等 schema 驗證
- `forceRewriteJsoncFile` / `writeJsoncPreservingComments`
- `forceRewriteGlobalConfigWithDocs`（已有，用作 rewrite-with-docs 的全域版）
- `seedXxxIfMissing` / `seedSystemPromptDirIfMissing`

### Slash command 接入

新檔 `src/commands/configDoctor.tsx`：
- `/config doctor` 預設 `--check`
- `/config doctor fix` → `--fix`
- `/config doctor rewrite` → `--rewrite-with-docs`
- 輸出走 plain text（彩色 markdown），結果直接顯示在 REPL

### CLI 接入

新增 subcommand 在 `src/cli.tsx` commander 註冊：
```
my-agent config doctor [--check|--fix|--rewrite-with-docs] [--json]
```

`--json` 模式給 CI / 自動化用，輸出結構化 issue 列表。

### Daemon 自動 check

`src/daemon/main.ts` 在所有 seed/load 完成後加一行：
```ts
if (await runConfigDoctor({ mode: 'check' })).hasErrors) {
  console.warn('[config-doctor] 偵測到設定問題，跑 my-agent config doctor --fix 嘗試修復')
}
```

### 跨平台

- macOS / Linux：`process.platform !== 'win32'` 時 binaryPath 期望無 `.exe`
- Windows：`.exe` 期望必存在
- 路徑分隔符 normalize 用 `path.normalize`

---

## 任務分解（待決策後排序）

- [ ] DOCTOR-1：建 `src/configDoctor/` 骨架 + 基本 Issue 型別 + `runConfigDoctor` 函式
- [ ] DOCTOR-2：實作 5 個 `checks/`（llamacpp / web / discord / global / systemPrompt）
- [ ] DOCTOR-3：實作 `fixers/` + dry-run 模式
- [ ] DOCTOR-4：`report.ts` 格式化（plain + json）
- [ ] DOCTOR-5：slash command `/config doctor` + 子命令
- [ ] DOCTOR-6：CLI subcommand `my-agent config doctor`
- [ ] DOCTOR-7：daemon start 自動 `--check`
- [ ] DOCTOR-8：整合測試 `tests/integration/configDoctor/` — 每個 check 一個 test，每個 fix action 一個 test
- [ ] DOCTOR-9：典型故障情境黑箱測（壞 JSON / schema 不符 / 跨平台 binaryPath）
- [ ] DOCTOR-10：docs + LESSONS + commit + push

預估 ~12-18 小時實作 + 4 小時測試。

---

## 完成標準

- `my-agent config doctor` 在乾淨環境跑 → exit 0
- 故意製造 9 種問題情境，doctor 都正確識別 + 分級
- `--fix` 跑完後再跑 `--check` → 全綠（除了不可自動修的 ERROR）
- 整合測試覆蓋率 ≥ 90%（每個 check + 每個 fix action）

## 不在範圍 → 後續

- 互動式 fix（TUI 問使用者選哪個值）— `/config doctor` slash 內可加，但 CLI 模式不做
- 跨 session config sync（多台機器）— 不同 milestone
- env var 命名統一（LLAMACPP_/MYAGENT_/DISCORD_ 前綴）— M-CONFIG-DOCS-ALIGN 處理
- Skill / hook / mcp config 的健康檢查 — 各自模組負責
