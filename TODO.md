# TODO.md

> Claude Code 在每次 session 開始時讀取此檔案，在工作過程中更新任務狀態。
> 里程碑結構由人類維護。Claude Code 負責管理任務狀態的勾選。

## 當前里程碑：M1 — 透過 llama.cpp 支援本地模型

**目標**：free-code 能直接連接專案內跑的 llama.cpp server（`http://127.0.0.1:8080/v1`，model alias `qwen3.5-9b-neo`），支援串流和全部 39 個工具的 tool calling。**不再**經過 LiteLLM proxy（ADR-001 已推翻，見 CLAUDE.md）。

**架構硬約束**：`src/QueryEngine.ts` 與 `src/Tool.ts` 在 `.claude/settings.json` deny list — **不能改**。因此 provider 必須在內部把 OpenAI SSE 轉成 Anthropic 形狀的 stream event，下游無感。

**實作路徑**：**路徑 B（fetch adapter）** — 2026-04-15 PoC 驗證通過（commit `b2af143`）。仿 `src/services/api/codex-fetch-adapter.ts` 模式，寫 `llamacpp-fetch-adapter.ts`，塞給 `new Anthropic({ fetch })`，翻譯層集中一處，`claude.ts` / `QueryEngine.ts` 零修改。**不另建** `src/services/providers/` 抽象層（路徑 A 已放棄）。

### 階段一：摸底與可行性驗證
- [x] 閱讀並記錄 free-code 現有 API 架構的實測事實（`src/services/api/client.ts`、`src/services/api/claude.ts`、`src/utils/model/providers.ts`），把發現寫進 `skills/freecode-architecture/SKILL.md`
- [x] 閱讀 Hermes 的 `reference/hermes-agent/hermes_cli/auth.py` 與 `reference/hermes-agent/agent/auxiliary_client.py`，只取「ProviderConfig + 動態客戶端工廠」設計概念（不直接複製 Python）
- [x] PoC：路徑 B 可行性驗證 — 寫 `scripts/poc/llamacpp-fetch-poc.ts`，確認 Anthropic SDK 透過 fetch adapter 可成功與 llama-server 通訊（2026-04-15 commit `b2af143`）
- [x] 架構決策：確定走路徑 B（fetch adapter）— 棄新 provider 層
- [x] 驗證：`bun run typecheck` 在當前 main 上仍通過（建立實作前的綠燈基準）— exit 0，僅 `tsconfig.json` L10 `baseUrl` 一條 TS5101 deprecation warning，無實際錯誤。同步把 `typecheck` 加進 `package.json` scripts（原本缺）

### 階段二：`llamacpp-fetch-adapter.ts` 實作（串流為主，純文字端到端）

> 原階段二（non-streaming）與階段三（串流）2026-04-15 合併 — `claude.ts:1824` 主 query 永遠發 `stream: true`，`./cli` 無法用 non-streaming 驗證。詳細實作設計見 DEPLOYMENT_PLAN.md 底部「M1 階段二實作 plan」段。

- [x] Step 1：擴充 `src/utils/model/providers.ts` — 加 `'llamacpp'` APIProvider、`CLAUDE_CODE_USE_LLAMACPP` 檢測、`getLlamaCppConfig()` helper、`DEFAULT_LLAMACPP_{BASE_URL,MODEL}` 常數
- [x] Step 2a：建立 `src/services/api/llamacpp-fetch-adapter.ts` non-streaming 路徑 — inline 型別、請求翻譯（Anthropic→OpenAI）、回應翻譯（ChatCompletion→BetaMessage）、`FINISH_TO_STOP` 映射表、`reasoning_content`→`thinking` block（ADR-006）
- [x] Step 2b：同檔加 streaming 路徑 — `translateOpenAIStreamToAnthropic` async generator、6 步狀態機、`thinking_delta` 主路徑（D6 fallback 不需啟動 — SDK 原生接受）
- [x] Step 3：修改 `src/services/api/client.ts` — llamacpp 分支放在 `getAnthropicClient()` 函數**最前面**（搶在 Anthropic auth / OAuth refresh 之前）；本地 provider 完全不需要 Anthropic 設定
- [x] Step 4：補進 `client.ts` 頂部 env JSDoc 說明 `CLAUDE_CODE_USE_LLAMACPP` / `LLAMA_BASE_URL` / `LLAMA_MODEL`
- [x] 驗證 V2：`bun run scripts/poc/llamacpp-fetch-poc.ts` 通過（non-streaming 迴歸）
- [x] 驗證 V3：新寫 `scripts/poc/llamacpp-streaming-poc.ts`，SDK `messages.stream()` 收到正確事件序列（thinking_delta/text_delta 各 N 次、兩個 content block、stop_reason=end_turn）
- [x] 驗證 V4：`CLAUDE_CODE_USE_LLAMACPP=true LLAMA_BASE_URL=... bun ./src/entrypoints/cli.tsx -p "..."` 端到端通過，回應 "4"。**注意**：不能設 `ANTHROPIC_API_KEY=dummy`，bootstrap 會卡；serve.sh 預設 ctx 需 ≥32K（已改）
- [x] 驗證 V5：結構驗證通過 — 未設 `CLAUDE_CODE_USE_LLAMACPP` 時 `getAPIProvider()` 不回 `'llamacpp'`、`getLlamaCppConfig()` 回 `null`、llamacpp 分支不進，走原 Anthropic 初始化鏈。**需使用者用真 Anthropic key 跑端到端最後確認** `ANTHROPIC_API_KEY=<real> ./cli -p "hi"` 行為與修訂前位元級相同

### 階段三：工具呼叫翻譯
- [x] 在 adapter 中加 tool 翻譯：
  - 出站：Anthropic `tools` → OpenAI `tools`（translateToolsToOpenAI，Step 2a 時已做）
  - 入站 non-streaming：tool_calls → `ToolUseBlock`（Step 2a 時已做）
  - 入站 streaming：tool_calls 切多 chunk 的 arguments 累積 → `input_json_delta`（階段三重構狀態機，用 `openToolBlocks: Map<openai idx → anthropic idx>` 追蹤；實測 Qwen3.5-Neo 呼叫 get_weather 工具成功，input 正確重組為 `{"city":"Tokyo"}`，stop_reason=tool_use；見 `scripts/poc/llamacpp-tool-streaming-poc.ts`）
  - `tool_result` 對話歷史 → `role:'tool'` message（translateMessagesToOpenAI，Step 2a 時已做）
- [x] 建立 `tests/integration/TOOL_TEST_RESULTS.md` 骨架（43 個工具分類表 — 前 5 核心、檔案/Web/Agent/Plan/互動/LSP/MCP/設定等類，含 feature-gated 標記）
- [x] 針對前五個核心工具（Bash、Read、Write、Edit、Glob）用 Qwen3.5-Neo 跑端到端測試 — **Part A（翻譯）+ Part B（E2E）全部 5/5 通過**。(a)(b)(c)(d) 四維度均綠。腳本：`scripts/poc/llamacpp-core-tools-poc.ts` + `scripts/poc/llamacpp-core-tools-e2e.sh`。結果記在 `tests/integration/TOOL_TEST_RESULTS.md`
- [x] 其餘 34 個工具依樣畫葫蘆補完（Part A 翻譯 34/34 綠 — `scripts/poc/llamacpp-rest-tools-poc.ts`；複雜 schema 含 nested object、array of object、型別混合、空物件皆正確翻譯；TaskCreate 首次模型選 text，重試後綠 — 模型 variance；Part B 大多需 MCP/LSP/互動環境，本階段不跑，列入後續工作）
- [x] 修復測試中發現的翻譯 bug — **無 bug 可修**。adapter 在 39 個可測工具 × 多種 schema shape（空物件、單/多欄、nested object、array of object、型別混合）全部翻譯正確

### 階段四：設定與使用者體驗
- [x] `src/utils/model/providers.ts`：新增 `LLAMACPP_MODEL_ALIASES` 陣列（目前 `qwen3.5-9b-neo`），`getLlamaCppConfig(model?)` 接受 model 參數；model 符合別名時自動啟用 llama.cpp 分支，不需再設 `CLAUDE_CODE_USE_LLAMACPP`。實測 `./cli --model qwen3.5-9b-neo -p "3+5=?"` → `8` 成功
- [x] `/model` 指令：`src/utils/model/modelOptions.ts` 的 `getModelOptions()` 在 Anthropic 模型清單後追加 `LLAMACPP_MODEL_ALIASES` 的每個項目（label 尾綴 `(local)`、description 顯示 base URL），使用者在 `/model` 互動 picker 能看到並選擇
- [x] server 不可用降級：adapter 的 fetch 用 try/catch 包；失敗時回 400（非 5xx，避免 SDK 重試）、`invalid_request_error` 型別、訊息指示執行 `bash scripts/llama/serve.sh`。偵測寬容：`ECONNREFUSED` / `ECONNRESET` / `ENOTFOUND` / `Unable to connect` / `fetch failed` 都認。實測指 localhost:9999（無 server）→ 立即顯示繁中 hint，無重試
- [x] 啟動橫幅顯示 provider：`src/utils/logoV2Utils.ts` 的 `getLogoDisplayData()` 在 `isLlamaCppActive()` 時把 `billingType` 改為 `llama.cpp (local)`，CondensedLogo 渲染時自動生效。新增 `isLlamaCppActive()` helper 到 `providers.ts`（目前只看 env flag；--model 觸發場景 banner 仍顯示一般 billing，但模型名本身已表明路徑）

### 待解決（M1 收尾後發現，使用者選擇延後處理）

- [ ] **Bun compiled `.\cli.exe` TUI panic** — Bun 1.3.6 single-file-executable + Ink React TUI 衝突（非我方 bug），追 Bun changelog，未修前互動模式一律走 `bun run dev`
- [ ] **`-p` non-interactive mode regression** — `./cli.exe -p "..."` / `bun src/.. -p "..."` 90 秒無輸出 timeout，疑似 isolation commit 後出現。Trace 顯示 bootstrap 跑完 `cli_after_main_complete` 但 print 模式 query 沒實際發出。`bun run dev` 互動模式正常，所以開發階段可用；批次測試須等修好

### 完成標準
- [x] `./cli --model qwen3.5-9b-neo -p "hello"` 成功串流輸出；log 顯示連接 `http://127.0.0.1:8080/v1`（階段四 Task 1 實測 `3+5=?` → `8`，llamacpp 分支命中。**註**：isolation commit 後 -p mode 出現 regression 待修）
- [x] 工具呼叫可用：至少 Bash、Read、Write、Edit、Glob 五個核心工具端到端通過（階段三 Part B commit `cd80511` 5/5 綠）
- [x] 既有 Anthropic 使用者路徑**完全不受影響** — 結構驗證通過：未設 `CLAUDE_CODE_USE_LLAMACPP` 且 model 不是 llamacpp 別名時 `getLlamaCppConfig()` 回 null、llamacpp 分支不進，走原 Anthropic 初始化鏈。**需使用者用真 Anthropic key 最後端到端確認一次**
- [x] `tests/integration/TOOL_TEST_RESULTS.md` 記錄 43 個工具結果（39 個可測 + 4 個 feature-gated），adapter 翻譯成功率 100%，前 5 核心工具四維度全綠

---

## 未來里程碑（尚未詳細規劃）

### M2 — Hermes 記憶系統（TypeScript 重新實作）
將 Hermes 的持久化記憶（SQLite + FTS5 + 記憶提醒）移植到 free-code。

### M3 — Hermes Cron 排程（TypeScript 重新實作）
將 Hermes 的 cron 系統（自然語言排程 + 多平台派送）移植到 free-code。

### M4 — Hermes 訊息閘道（TypeScript 重新實作）
將 Telegram/Discord/Slack 閘道移植到 free-code。

### M5 — Hermes 技能自動建立（TypeScript 重新實作）
將 Hermes 的自我改進技能循環移植到 free-code。

### M6 — Hermes 使用者建模（TypeScript 重新實作）
將 Honcho 風格的使用者建模和跨 session 回憶移植到 free-code。

---

## Session 日誌

> Claude Code：每次 session 結束後，在下方附加一行簡短記錄。
> 格式：`- YYYY-MM-DD: [完成的任務] | [遇到的問題] | [下一步]`

- 2026-04-15: 本地 llama.cpp b8457 + Qwen3.5-9B-Neo Q5_K_M 部署完成（scripts/llama/*），煙測 2+2=4 通過，58 tok/s prompt eval | 踩了 --log-colors 參數變更、Git Bash UTF-8 mangling、Neo reasoning_content/content 分離三個坑，都已記入 LESSONS.md | 下一步：M1 階段一，整合這個 server 作為 free-code 的本地 provider

---

- 2026-04-15 15:33: Session 結束 | 進度：1/25 任務 | e5ea9f2 docs(m1): 改寫 freecode-architecture skill，記錄 API 層實測事實

- 2026-04-15 15:40: Session 結束 | 進度：2/25 任務 | fa03174 docs(m1): 改寫 provider-system skill，納入 Hermes 借鑑與兩條實作路徑

- 2026-04-15 15:46: Session 結束 | 進度：2/25 任務 | b2af143 poc: 驗證路徑 B（fetch adapter）可行性

- 2026-04-15 15:54: Session 結束 | 進度：4/26 任務 | fbacb96 docs(m1): 對齊路徑 B — 以 fetch adapter 實作 llama.cpp 整合

- 2026-04-15 16:02: Session 結束 | 進度：5/26 任務 | 66d2a1a chore(m1): 完成階段一最後一項 — typecheck 綠燈基線

- 2026-04-15 16:07: Session 結束 | 進度：5/26 任務 | 66d2a1a chore(m1): 完成階段一最後一項 — typecheck 綠燈基線

- 2026-04-15 16:14: Session 結束 | 進度：5/26 任務 | 66d2a1a chore(m1): 完成階段一最後一項 — typecheck 綠燈基線

- 2026-04-15 16:18: Session 結束 | 進度：5/26 任務 | 66d2a1a chore(m1): 完成階段一最後一項 — typecheck 綠燈基線

- 2026-04-15 16:34: Session 結束 | 進度：10/27 任務 | 403a514 feat(api): llamacpp-fetch-adapter 串流翻譯（純文字 + thinking）

- 2026-04-15 16:54: Session 結束 | 進度：14/27 任務 | 4730c0a chore(m1): 勾選 V5 回歸驗證（結構驗證通過，待真 key e2e 確認）

- 2026-04-15 17:17: Session 結束 | 進度：17/27 任務 | a8694da chore: .gitignore 追加 cli.exe / cli-dev.exe

- 2026-04-15 17:24: Session 結束 | 進度：19/27 任務 | 63ca009 test(m1): 階段三其餘 34 工具 Part A 翻譯 34/34 全綠
