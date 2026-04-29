# ADR — 架構決策記錄

> 從 CLAUDE.md 拆出。每條決策只記「結論 + 理由」，過程細節走當時的 dev log（`docs/dev-log/`）或 plan（`~/.claude/plans/`）。

## 索引（一行摘要）

| ADR | 結論 | 狀態 |
|---|---|---|
| ADR-001 | LiteLLM proxy 跑本地模型 | ❌ **已推翻**（改 ADR-005） |
| ADR-002 | 新 provider 放 `src/services/providers/` | ❌ **已被 ADR-005 取代** |
| ADR-003 | 新功能不使用 feature flag — 直接啟用 | ✅ 仍適用 |
| ADR-004 | Hermes 原始碼唯讀，TypeScript 重新實作 | ✅ |
| ADR-005 | Provider 內部做格式轉譯（OpenAI SSE → Anthropic stream_event）；不改 `QueryEngine.ts` / `StreamingToolExecutor.ts` | ✅ |
| ADR-006 | qwen3.5-Neo `reasoning_content` 映射 Anthropic `thinking` block | ✅ |
| ADR-007 | `@anthropic-ai/*` 全部 vendor 進 `src/vendor/my-agent-ai/` | ✅ |
| ADR-008 | System prompt 29 個 section 外部化到 `~/.my-agent/system-prompt/` | ✅ |
| ADR-009 | llamacpp context-overflow 三路修復（`/slots` warn / error regex / finish_reason warn） | ✅ |
| ADR-010 | llama.cpp 設定統一到 `~/.my-agent/llamacpp.json` 單一來源 | ✅ |
| ADR-011 | Browser 走 puppeteer-core，不走 playwright-core | ✅ |
| ADR-012 | M-DAEMON Path A — in-process QueryEngine 整合（非 spawn 子程序） | ✅ |
| ADR-013 | M-DISCORD 單 daemon 多 project；B-1 並行策略（turn mutex + chdir） | ✅ |
| ADR-014 | Memory prefetch selector llama.cpp 模式走本地 + safety-net fallback | ✅ |
| ADR-015 | llama.cpp watchdog 三層分層偵測 + hot-reload；預設關閉 | ✅ |
| ADR-016 | M-WEB F3 + K2 + G1 — 嵌 daemon 內 / 內部 protocol bridge / React 重寫 | ✅ |
| ADR-018 | M-WEB-SLASH 通用 `slashCommand.execute` 單 RPC + 5 result kind | ✅ |
| ADR-019 | M-WEB-SLASH-D 階段先做框架，48 個 local-jsx 真 port 留 D-FULL | ✅ |
| ADR-020 | M-LLAMACPP-REMOTE 雙固定槽 schema（local + remote）非 N endpoints | ✅ |
| ADR-021 | M-LLAMACPP-REMOTE routing 失敗硬性報錯，不 auto-fallback | ✅ |
| ADR-022 | llamacpp apiKey 寫 jsonc 為單一來源，不另設 env override | ✅ |

> 編號跳過 017：保留給未來 milestone。

---

## ADR-001 — LiteLLM 作為本地模型 proxy（❌ 已推翻 2026-04-15）

原案：LiteLLM 作為 Ollama / 本地模型 proxy。
推翻理由：直接跑 llama.cpp server（OpenAI 相容，`http://127.0.0.1:8080/v1`）— 部署已完成（見 `scripts/llama/`）、少一層中介、減少相依性。

## ADR-002 — 新 provider 放 `src/services/providers/`（❌ 已被 ADR-005 取代）

原案：另建 `src/services/providers/` 目錄。
取代理由：M1 改採 fetch adapter 模式，程式碼放在 `src/services/api/llamacpp-fetch-adapter.ts`，不另建目錄。

## ADR-003 — 新功能不用 feature flag（2026-04-15）

新功能直接啟用，不走 GrowthBook / feature() 路徑。

## ADR-004 — Hermes 原始碼唯讀

`reference/hermes-agent/` 為 Python 唯讀參考，閱讀理解後用 TypeScript 重新實作；絕不直接複製。

## ADR-005 — Provider 邊界轉譯（2026-04-15）

Provider 內部做格式轉譯（OpenAI SSE → Anthropic `stream_event`），保持 `QueryEngine.ts` 與 `StreamingToolExecutor.ts` 零修改。

理由：這兩個檔案在 `.claude/settings.json` 的 deny list；在 provider 邊界做轉譯讓下游主幹無感。

## ADR-006 — Qwen3.5-Neo reasoning_content（2026-04-15）

Qwen3.5-Neo 的 `reasoning_content` 映射為 Anthropic `thinking` content block。

理由：模型把 CoT 放 `reasoning_content`、答案放 `content`，對應到 Anthropic 的 thinking block 在語意上最貼近，也保留 UI 顯示 CoT 的能力。

## ADR-007 — Vendor `@anthropic-ai/*` SDK（2026-04-16）

`@anthropic-ai` 全部 7 個 npm 套件內化為專案原始碼（`src/vendor/my-agent-ai/`）。4 個有 TS 原始碼的（sdk / bedrock / vertex / foundry）直接 vendor `.ts` 檔；2 個只有編譯後 JS 的（mcpb / sandbox-runtime）vendor 可讀 JS + `.d.ts`；1 個（claude-agent-sdk）零 import 直接刪除。`tsconfig.json` paths 映射使既有 121 個 import 不需修改路徑。

理由：完全掌控 SDK 程式碼，可自由修改以支援多 provider；不再受上游版本更新影響。

## ADR-008 — System prompt 外部化（2026-04-19，M-SP）

29 個 section 外部化至 `~/.my-agent/system-prompt/` 下的 .md 檔。新增 `src/systemPromptFiles/` 模組。session 啟動凍結快照、per-project > global > bundled 三層解析、完全取代（不合併）、首次啟動自動 seed global 層。覆蓋 prompts.ts 全部 15 個 section + cyber-risk + user-profile 外框 + memory 系統 8 個常數 + QueryEngine 4 條錯誤訊息。使用者指南：`docs/customizing-system-prompt.md`。

理由：措辭調整不必改 code → rebuild；per-project 可做專案專屬客製化。

## ADR-009 — llamacpp 上下文長度偵測改善（2026-04-19，M-LLAMACPP-CTX）

三路修復：(1) `/slots` 查詢失敗時 `console.error` 一次性警告，提示 `LLAMACPP_CTX_SIZE=<tokens>` 手動覆蓋；(2) adapter error path 新增 context-overflow 關鍵字偵測（regex 對 `context|n_ctx|prompt|token` + `length|exceed|too long/large/many|out of`），命中則改寫為 `Prompt is too long (llama.cpp): ...` 觸發 reactive compaction；(3) streaming 收到 `finish_reason=length` + `output_tokens=0` 時記 warn。

理由：原先 128K 本地模型上下文溢出時會卡在「停止回應 + server 待機」，三路修復讓 llamacpp 與 Anthropic path 的錯誤復原行為一致。

## ADR-010 — llama.cpp 設定單一來源（2026-04-19，M-LLAMA-CFG）

本地 LLM server 設定統一到 `~/.my-agent/llamacpp.json`。新增 `src/llamacppConfig/` 模組（schema / paths / loader / seed / index），Zod schema 驗證；TS 端讀 snapshot 取 `baseUrl` / `model` / `modelAliases` / `contextSize`（env var override 仍優先）；Shell 端新增 `scripts/llama/load-config.sh`（jq 抽 env），`serve.sh` source 它。首次啟動 `setup.ts` seed 出預設 config + README。缺 jq / 缺檔 / JSON 壞 graceful fallback。

理由：原本 15 處散落（3 const、5 env var、serve.sh hard-code、`LLAMACPP_MODEL_ALIASES`）難維護；統一後 TS + shell 共用一份 source of truth。

## ADR-011 — Browser 走 puppeteer-core（2026-04-19）

bun + Windows 下 playwright-core 的 `--remote-debugging-pipe` transport 無限 hang，`ignoreDefaultArgs` + `remote-debugging-port` + `connectOverCDP` 也 hang。puppeteer-core 預設 WebSocket CDP 在同環境秒連。本地 / Browserbase / Browser Use 三個 provider 共用 puppeteer-core。Vision 走 vendored `my-agent-ai/sdk`，interface 保留換後端空間。Firecrawl 不當 browser provider，改為 `WebCrawlTool` 的 optional fetcher backend。Provider 選擇以 runtime env 決定（`BROWSER_PROVIDER` 顯式 > API key 偵測 > fallback local）。

## ADR-012 — M-DAEMON Path A in-process（2026-04-20）

`my-agent daemon start` 起常駐 Bun.serve WS server（loopback only `127.0.0.1`、OS 指派 port、bearer token auth、pid.json heartbeat）；QueryEngineRunner 包 `ask()` 成 SessionRunner 跑真實 LLM turn；InputQueue 狀態機（IDLE/RUNNING/INTERRUPTING）+ 混合 intent 策略；sessionBroker 廣播 turnStart/turnEnd/runnerEvent；permissionRouter 路由到 source client，timeout 5min auto-allow；cron scheduler 搬進 daemon 獨占跑（`isDaemonAliveSync()` 讓 REPL/headless 跳過）；REPL 側 thin-client 透明切換。**Path A 完整 in-process** 不是 Path B 的 spawn `./cli --print` 子程序。

理由：狀態共享、單一 process 方便 debug、未來 Discord/cron 可同 AppState 搬動任務；代價：daemon bootstrap 要複製 main.tsx 的 headless 分支。使用者指南：`docs/daemon-mode.md`。

## ADR-013 — M-DISCORD 單 daemon 多 project（2026-04-20）

一個 daemon process 內活 N 個 `ProjectRuntime`（各自 AppState / broker / runner / permissionRouter / cron / session JSONL），透過 `ProjectRegistry` 管理 lifecycle（lazy load / hasAttachedRepl-aware idle unload / onLoad/onUnload listeners）。並行策略 **B-1**：daemon 全域 turn mutex + `wrapRunnerWithProjectCwd` 切 `process.cwd()` 與 `STATE.originalCwd` 序列化跨 project turn（接受「後到者排隊」UX）；`Project` singleton 改 `Map<cwd, Project>`。REPL thin-client WS handshake 帶 `?cwd=`。Discord gateway 以 `~/.my-agent/discord.json` 為入口。discord.js v14 DM 坑（MESSAGE_CREATE 缺 `channel.type`）workaround：啟動 pre-fetch whitelist users DM + 'raw' event fallback。8 個 slash commands + permissionMode 雙向同步 + Home channel 鏡像。**不含**：voice / Slack-Telegram / button UX / 多使用者 guild。使用者指南：`docs/discord-mode.md`。

## ADR-014 — Memory prefetch llama.cpp 模式（2026-04-24，M-MEMRECALL-LOCAL）

`selectRelevantMemories` 在 `isLlamaCppActive()` 為 true 時改走新 `selectViaLlamaCpp()`，直接 fetch `${cfg.baseUrl}/chat/completions`（OpenAI 相容、不依賴 structured-output beta、prompt 引導 JSON array），響應交給 `extractFilenamesFromText` 容錯解析。不污染 `sideQuery`（後者仍純 Anthropic）。Selector 任何原因回 `[]` 時 fallback 帶最新 `FALLBACK_MAX_FILES=8` 個 memory（按 mtime）。

理由：M2 的 `tengu_moth_copse=true` 預設會把 MEMORY.md 從 system prompt 過濾改走 query-driven prefetch；prefetch 又寫死 Sonnet → 純 llamacpp 用戶 silent 401 → memory 機制等於關閉。不動 `sideQuery` 整體 provider-aware（爆炸面太大，立 M-SIDEQUERY-PROVIDER 後續處理）。

## ADR-015 — llamacpp Watchdog 三層分層偵測（2026-04-26）

三層偵測：A 30s（連線 hung） / B 120s（reasoning loop） / C 16000 主 turn / 4000 背景（總量 cap）。**預設關閉**，opt-in via `/llamacpp` 或 env；master + 該層雙層 enabled AND 才生效。Hot-reload via mtime check。

理由：固定 wall-clock 對 legit 長 turn 誤殺率太高；三層各管不同失控模式；hot-reload 讓 opt-in 成本極低；client 端斷連 → server 自動釋放 slot 是 HTTP 標準，比 server 端 cancel 更通用。

## ADR-016 — M-WEB F3 + K2 + G1（2026-04-26）

F3（嵌 daemon 內額外開 port）+ K2（內部 protocol bridge）+ G1（完全 React 重寫）的組合決策。F3 換來零 IPC + broker reference 共用；K2 的乾淨對外 schema 讓 browser code 不被 daemon 內部協議改動牽連；G1 長期維護乾淨但前期投入大（4 phases / ~10 週）。WS frame 命名採點分隔（`turn.start`、`project.added`），與 daemon thin-client camelCase frame 解耦。使用者指南：`docs/web-mode.md`。

## ADR-018 — Web slash command 通用 RPC（2026-04-26）

通用 `slashCommand.execute` 走單一 WS RPC frame、回 5 種 result kind（text / prompt-injected / jsx-handoff / web-redirect / skip），由 web 端 frame handler 路由到對應 UI 行為（toast / setRightTab / openCommandDispatcher）。

理由：87 個命令各開 RPC 維護成本爆表；三類 webKind 處理邏輯只在 daemon 跟 web 各 1 處集中；新 plugin / skill 命令自動就在 list 結果出現；jsx-handoff 由 web 端查 store metadata 而非 daemon 端塞 React node（daemon 是 headless）。

## ADR-019 — M-WEB-SLASH D 階段先做框架（2026-04-26）

D 階段先做框架（GenericLocalJsxModal 顯示 metadata + 分類 hint + TUI fallback 引導），48 個 local-jsx 的真 per-command React port 推遲到 M-WEB-SLASH-D-FULL。

理由：完整 port 48 個元件需 6-10 天工作量；本 milestone 主交付物（87 個命令在 web 都可被觸發 + 顯示有意義回饋）已達；CommandDispatcher.tsx 的 switch 點預留給 D-FULL 逐個替換。

## ADR-020 — llamacpp 雙固定槽 schema（2026-04-28）

M-LLAMACPP-REMOTE 採雙固定槽 schema（`local` + `remote`）而非 N endpoints array。

理由：(a) 個人使用場景 80% 是「主腦 + 副腦」雙槽結構；(b) UI 直觀（不需 dropdown 選 endpoint id）；(c) routing 表 key 用 `'local'/'remote'` 字串對使用者 mental model 更清楚；(d) 未來真要 N 個再開 `M-LLAMACPP-MULTI`，schema 可平滑擴成 `endpoints: [...]` + routing 指 id。

## ADR-021 — Routing 失敗硬性報錯（2026-04-28）

Routing 失敗硬性報錯不 auto-fallback。訊息前綴 `[llamacpp routing=<callsite>→<target>]`。

理由：M-MEMRECALL-LOCAL 教訓 — silent fallback 會讓使用者誤以為功能正常但實際走錯 endpoint；显式 throw 讓 debug 路徑清楚。若使用者要 fallback 行為，手動把該 callsite 改回 `'local'` 即可。

## ADR-022 — apiKey 單一來源（2026-04-28）

llamacpp apiKey 寫 jsonc 為單一來源，不另設 env override。Web GET 回傳 masked、PUT 留空 = 不變更。

理由：(a) 多處設定容易產生不一致；(b) `~/.my-agent/` 家目錄已隔離；(c) 避免 UI 上無意覆蓋。
