# M-CONFIG-DOCS-ALIGN — Schema default / env override / 文件對齊

## Context

**起因**：M-CONFIG-SEED-COMPLETE 調查發現：

- 5 個 config 的 schema 加新欄位後，使用者文件（README / bundledTemplate 註解 / docs/config-reference.md）容易漏更新
- env var 命名前綴不統一（`LLAMACPP_*` / `MYAGENT_WEB_*` / `DISCORD_*` / `LLAMA_*` 混用），使用者每次要去翻 source 才知道哪個能蓋哪個
- 沒有「中央索引」可一次看到「config 欄位 vs default 值 vs env override vs 來源優先序」
- 有些 env var 已 deprecated 但還在 README 提到（維護負擔）
- `~/.my-agent/<config>.README.md` 與 `docs/config-reference.md` 內容部分重疊但不一致

**目標**：自動產生器 + CI 檢查，讓 schema → 文件單向同步；同時統一 env var 命名 + 來源優先序文件。

---

## 待決策（動工前對齊）

### Q1：產生方式
- **A**：完全自動產生 — 跑 `bun run docs:gen` 從 schema → markdown，使用者改 schema → 跑 script → commit
- **B**：手動維護 + CI 檢查 — `docs/config-reference.md` 手寫，CI 跑 `verify-docs.ts` 檢查欄位完整性
- **C**：A + B 結合 — 自動產生主表（欄位 / type / default / env），手動補敘述（why / 範例）
- **建議：C**，純自動產生太死板（缺 why / 範例），純手動會 drift；混合最平衡

### Q2：文件位置
- **A**：集中 `docs/config-reference.md`（一份大文件，含所有 config）
- **B**：各 config 一份（`docs/config-llamacpp.md` / `config-web.md` ...）
- **C**：A 主索引 + B 細節
- **建議：C**，主索引方便 grep，細節分檔避免單檔過大

### Q3：env var 命名統一
- **A**：保持現狀（`LLAMACPP_*` / `MYAGENT_WEB_*` / `DISCORD_*` 混用）+ 補文件說清楚
- **B**：全部統一為 `MYAGENT_<MODULE>_<FIELD>`（破壞向下相容，需 migration）
- **C**：新增統一前綴版，舊的保留為 deprecated alias，3 個版本後移除
- **建議：C**，避免一次性 break；deprecated 期可長可短

### Q4：產生器 trigger 時機
- **A**：手動跑 `bun run docs:gen`，commit 進 git
- **B**：pre-commit hook 自動跑
- **C**：CI 跑驗證，不一致 → fail
- **建議：A + C**，保持 commit 顯式（B 對 contributor 不友善），CI 防漏

### Q5：來源優先序文件化
- 目前實際優先序：`env override > <config>.jsonc > schema default`
- 是否所有 5 個 config 都遵循？還是有例外？
- **建議**：在 `docs/config-reference.md` 開頭明文寫死這條規則，所有 config 必須一致；違反者算 bug

---

## 設計

### 自動產生器

新檔 `scripts/gen-config-docs.ts`：

```typescript
// 對每個 config 模組：
//   1. import schema (LlamaCppConfigSchema 等)
//   2. 走訪 schema._def 的所有欄位
//   3. 對每個欄位產出：name / zod type / default / env override / 註解（從 schema.describe()）
//   4. 渲染為 markdown 表格寫到 docs/config-<module>.md
```

**輸出格式範例（docs/config-llamacpp.md）**：

```markdown
<!-- AUTO-GENERATED — 跑 bun run docs:gen 重新產生。手寫敘述放在 ## 設計考量 下面。 -->

# llamacpp.jsonc 欄位參考

## 欄位表

| 欄位 | 型別 | Default | Env override | 說明 |
|---|---|---|---|---|
| `baseUrl` | string | `http://127.0.0.1:8080/v1` | `LLAMA_BASE_URL` | OpenAI 相容 endpoint |
| `model` | string | `qwen3.5-9b` | `LLAMA_MODEL` | 必須與 server.alias 一致 |
| `contextSize` | number | `131072` | `LLAMACPP_CTX_SIZE` | auto-compact 閾值計算用 |
| ... | | | | |

## 設計考量（手寫，不會被產生器覆蓋）

...
```

### Schema 增強

每個 config 的 zod schema 加 `.describe()` 與自訂 metadata：

```typescript
// src/llamacppConfig/schema.ts
export const LlamaCppConfigSchema = z.object({
  baseUrl: z
    .string()
    .default('http://127.0.0.1:8080/v1')
    .describe('OpenAI 相容 endpoint（含 /v1 路徑）')
    .superRefine(...)  // 已有的驗證
    // 自訂 metadata for docs gen
    .meta({ env: 'LLAMA_BASE_URL' }),
  ...
})
```

需要評估 zod v3 是否支援 `.meta()` — 如果沒有，用 wrapper 函式：
```typescript
function envField<T extends z.ZodType>(schema: T, env: string): T {
  ;(schema as any)._envOverride = env
  return schema
}
```

### CI 驗證

新檔 `scripts/verify-config-docs.ts`：

1. 跑 `gen-config-docs.ts` 產出 fresh markdown 到 tmp
2. 比對 `docs/config-*.md` 的 AUTO-GENERATED 區段
3. 不一致 → exit 1 + diff 輸出
4. 加進 `bun run typecheck` chain 或獨立 script

### Env var 命名統一（Q3 = C）

**Phase 1（本 milestone）**：新前綴 `MYAGENT_LLAMACPP_*` / `MYAGENT_WEB_*` / `MYAGENT_DISCORD_*` / `MYAGENT_GLOBAL_*` 全部支援；舊的 `LLAMA_*` / `LLAMACPP_*` / `DISCORD_*` 保留 deprecated alias，呼叫到時 stderr warn `[config] LLAMA_BASE_URL 已 deprecated，請改用 MYAGENT_LLAMACPP_BASE_URL`

**Phase 2（後續 milestone）**：3 個版本後（或 6 個月）移除 deprecated alias

**保留：** `CLAUDE_CONFIG_DIR`（家目錄路徑，與官方 Claude Code 對齊）

### 來源優先序文件

`docs/config-reference.md` 開頭固定段落：

```markdown
## 來源優先序（所有 my-agent config 一致）

1. **Env var override**（最高）— 若對應 env 存在且非空字串
2. **`~/.my-agent/<config>.jsonc` 檔案值**
3. **Schema default**（最低）

讀檔 / parse / schema validation 任一失敗 → fallback 到 schema default 並 stderr warn 一次。
```

---

## 任務分解

- [ ] DOCS-1：盤點 5 個 config 所有 env var override，建對照表（含 deprecated）
- [ ] DOCS-2：每個 schema 加 `.describe()` + env metadata
- [ ] DOCS-3：寫 `scripts/gen-config-docs.ts` 自動產生器
- [ ] DOCS-4：產出 `docs/config-llamacpp.md` / `config-web.md` / `config-discord.md` / `config-global.md` / `config-system-prompt.md`
- [ ] DOCS-5：更新 `docs/config-reference.md` 主索引（連結到各 config + 來源優先序）
- [ ] DOCS-6：寫 `scripts/verify-config-docs.ts` CI 驗證
- [ ] DOCS-7：env 命名統一 Phase 1 — 新前綴支援 + deprecated alias warn
- [ ] DOCS-8：清掉 5 個 `~/.my-agent/<config>.README.md` 中與主文件重複的內容（保留跨檔資訊）
- [ ] DOCS-9：整合測試 — env 新舊前綴都能用 + deprecated warn 出現
- [ ] DOCS-10：CLAUDE.md 加「改 schema 後跑 `bun run docs:gen`」的提醒
- [ ] DOCS-11：commit + push + dev log

預估 ~10-14 小時。

---

## 完成標準

- `bun run docs:gen` 跑完，5 份 config doc + 主索引同步
- `bun run docs:verify` 在無修改時 exit 0
- 故意改 schema 不跑 gen → CI fail
- 新 env var prefix 全 5 個 config 都支援，舊的觸發 deprecated warn
- `docs/config-reference.md` 開頭明文「env > file > default」優先序

## 不在範圍 → 後續

- 設定檔本身的內容寫成「教學」（範例 / FAQ / 故障排除）— 維持 README sidecar 即可
- 國際化（英文版文件）— 本專案規約全繁中
- Skill / hook / mcp 文件對齊 — 各自模組負責
- env var 命名 Phase 2 移除 deprecated alias — 至少 6 個月後再做
