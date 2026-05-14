# My Agent

> 一個建構在本地終端機中的互動式 AI 代理人。支援多家雲端 LLM 服務與本地模型、
> 具備跨 session 記憶、可自訂系統提示、可排程背景任務、可操作瀏覽器的通用 agent CLI。

**核心定位**：把你終端機裡的 agent 變成一個 *能持續工作* 的搭檔 — 不只是單次問答，
而是會記得上下文、能在背景按排程跑任務、能瀏覽網頁與執行工具、知道你是誰。

---

## 特色

- **多家 LLM 服務可選**：支援主流雲端 Messages API 閘道（Bedrock / Vertex /
  Azure Foundry）、OpenAI Codex API、以及**本地 llama.cpp server**（OpenAI 相容端點）。
  切換只要一個環境變數，不需改程式碼。
- **本地模型為一等公民**：完整串流、工具呼叫、思考鏈（reasoning_content）、多模態
  （Vision）都能走本地 llama.cpp；128K context 自動偵測與溢出復原；token 快取計量。
- **跨 session 記憶**：
  - **SessionSearch**：SQLite FTS5 索引所有歷史對話，可模糊與全文搜尋過去的工作紀錄。
  - **Dynamic Memory Prefetch**：每次 query 前依語意動態注入最相關的過去訊息，免得模型從頭講一次。
  - **MemoryTool + memdir**：`preferences` / `plans` / `projects` / `todos`
    四型結構化記憶，原子寫入、配額保護、寫入前 prompt-injection 掃描。
- **使用者建模（User Modeling）**：`USER.md` 雙層設計（global persona + per-project context），
  讓 agent 用你熟悉的術語、了解你的工作環境。
- **可自訂系統提示**：29 段 system prompt 全部外部化到 markdown 檔案，
  按 per-project > global > bundled 三層解析。改措辭不必改程式碼、不必 rebuild。
- **排程系統（Cron）**：8 個排程工具 + `/cron` 互動式 TUI、人性化排程語法
  （`30m` / `every 2h` / ISO timestamp / 5-field cron / 自然語言 via LLM 解析）、
  每個 job 可獨立指定模型、pre-run script 注入上下文、稽核 log、injection 防禦。
  進階：失敗重試 + exponential backoff、conditional 觸發（shell / lastRunOk / fileChanged）、
  per-task catchup 策略、結果通知（TUI toast + StatusLine badge）、run history 查詢。
- **Daemon 模式**：`my-agent daemon start` 起常駐 WS server，REPL 變 thin-client；
  單一 daemon 內活 N 個 ProjectRuntime（lazy load + idle unload），cron 移到 daemon 獨占跑；
  REPL 起/掛時透明切換 standalone ↔ attached。詳見 [docs/daemon-mode.md](./docs/daemon-mode.md)。
- **Discord 整合**：daemon 接 Discord bot，DM / guild channel 文字對話、8 個 slash commands
  （/status /list /help /mode /clear /interrupt /allow /deny）、permission mode 雙向同步、
  REPL 內 `/discord-bind` 一鍵建 per-project 頻道、turn 雙向鏡像、權限雙發 first-wins。
  詳見 [docs/discord-mode.md](./docs/discord-mode.md)。
- **網頁工具**：`WebFetch`（單頁）、`WebSearch`（搜尋）、`WebCrawl`（BFS + robots.txt 的多頁抓取，
  支援 Firecrawl backend）、`WebBrowser`（真實 Chromium via puppeteer-core，
  支援本地 / Browserbase / Browser Use provider + Vision 問答）。
- **Bundled Skills（~17 組）**：algorithmic-art、canvas-design、doc-coauthoring、
  docx / pdf / pptx / xlsx 文件製作、frontend-design、mcp-builder、skill-creator、
  slack-gif-creator、webapp-testing …… 內建可隨時載入的領域知識包。
- **Skill 自主建立（Self-Improving Loop）**：agent 可從經驗自動總結並寫入新 skill；
  安全掃描 + 閾值控管避免亂長。
- **Teammate 多代理系統**：同 process 內可 spawn 平行 teammate（可指定不同模型）
  做子任務，配合 cron 可做「每小時用較小模型先探測，若需要再升級」之類的成本控制。

---

## Quick start

```bash
# 1. 環境（建議 conda isolate）
conda activate aiagent        # 或你慣用的隔離方案

# 2. 安裝依賴
bun install                   # Bun >= 1.3.11

# 3. 建構
bun run build                 # 產出 ./cli
# 或
bun run build:dev             # ./cli-dev，dev 版本

# 4. 最簡冒煙測試
./cli -p "say hello"
```

互動模式（TUI）：

```bash
./cli                         # 進互動式介面
```

指定模型：

```bash
./cli --model qwen3.5-9b-neo  # 本地 llama.cpp 模型
./cli --model claude-opus-4-7 # 雲端 Messages API 模型（需 env var 配合 provider）
```

## 切換 provider（環境變數）

| 變數 | 用途 |
|---|---|
| `MY_AGENT_USE_LLAMACPP=1` | 本地 llama.cpp server（預設偵測） |
| `MY_AGENT_USE_BEDROCK=1` | AWS Bedrock |
| `MY_AGENT_USE_VERTEX=1` | Google Vertex |
| `MY_AGENT_USE_FOUNDRY=1` | Azure Foundry |
| `MY_AGENT_USE_OPENAI=1` | OpenAI Codex API |
| `ANTHROPIC_API_KEY` | Messages API 直連 API key |
| `ANTHROPIC_BASE_URL` | Messages API 的 base URL |
| `LLAMA_BASE_URL` | 本地 llama.cpp endpoint（預設 `http://127.0.0.1:8080/v1`） |
| `LLAMA_MODEL` | 本地模型名稱（或用 `~/.virtual-assistant-desktop/llamacpp.jsonc` 集中管理） |
| `LLAMACPP_CTX_SIZE` | 手動覆寫 llama.cpp context size（tokens；`/slots` 偵測失敗時使用） |
| `BROWSER_PROVIDER` | WebBrowser backend 顯式指定（`local` / `browserbase` / `browser-use`） |
| `BROWSERBASE_API_KEY` / `BROWSER_USE_API_KEY` | Cloud browser provider 認證（自動偵測） |
| `WEBCRAWL_BACKEND=firecrawl` + `FIRECRAWL_API_KEY` | WebCrawl 切到 Firecrawl 的 JS 渲染 backend |

完整設定方式見 [docs/providers.md](./docs/providers.md)。

---

## 本地模型棧（Local model stack）

my-agent 的本地模型 backend 走兩層 vendored fork — 一層 C++ 引擎、一層 TS binding，外加可選的 OpenAI 相容 server shim。整段 stack 全部 self-contained 在本 repo 內。

```
┌───────────────────────────────────────┐
│  my-agent (TS, this repo)             │  對話 / tool / memory / UI
└──────────────────┬────────────────────┘
                   │ 兩條 adapter 擇一
        ┌──────────┴──────────┐
        ↓                     ↓
   fetch adapter         embedded adapter
   (外部 OpenAI 相容)    (in-process binding)
        ↓                     ↓
   ┌────┴───────────┐         │
   ↓                ↓         │
TCQ-shim     llama-server     │
(bun, Qwen-aware) (C++ binary)│
   ↓                ↓         ↓
   └─────────┬──────┴─────────┘
             ↓
        node-llama-tcq
        (TS binding fork)
             ↓
        buun-llama-cpp
   (C++/CUDA llama.cpp fork — TCQ KV cache 核)
```

### 三個元件

| 元件 | 路徑 | 上游基底 | 角色 |
|---|---|---|---|
| **buun-llama-cpp** | `vendor/node-llama-tcq/llama/llama.cpp/`（編譯用）<br>`buun-llama-cpp/`（純參考） | `ggerganov/llama.cpp` | C++/CUDA 引擎 + **TCQ KV cache 量化核**（kernel + codebooks + 5 個新 quant type：`TURBO3_0` / `TURBO4_0` / `TURBO2_0` / `TURBO3_TCQ` / `TURBO2_TCQ`） |
| **node-llama-tcq** | `vendor/node-llama-tcq/` | `withcatai/node-llama-cpp` | TS binding fork — 把 TCQ presets / mtmd 多模態 / speculative decoding 暴露給 JS；附 OpenAI 相容 server (`bun src/cli/cli.ts serve` = TCQ-shim) |
| **my-agent adapters** | `src/services/api/llamacpp-{fetch,embedded}-adapter.ts` | — | fetch adapter 接外部 server；embedded adapter lazy `import "node-llama-tcq"` 直接 in-process 呼叫 |

兩條 adapter 路徑職責切分見 [ADR-005 / ADR-021](./docs/adr.md)；兩層 fork 的詳細並排比較見 [docs/node-llama-tcq-vs-buun-llama-cpp.md](./docs/node-llama-tcq-vs-buun-llama-cpp.md)。

### 關鍵特性

- **TCQ KV cache 壓縮**：`TURBO4_0`(4.25 bpv) / `TURBO3_TCQ`(3.25) / `TURBO2_TCQ`(2.25) 三檔位，~3.8x 壓縮、65K context VRAM −58%（`vendor/node-llama-tcq/BENCHMARKS-LONGCTX.md`）。3.25 bpv 的 perplexity 還比 FP16 KV cache 略低（5.802 vs 5.805）。**macOS Metal 尚未實作**，`isTCQAvailable()` 在 macOS 回 false。
- **Qwen pythonic-XML tool 格式**：TCQ-shim `--enable-tools` 自動注入系統 prompt 的 `<tools>...</tools>` 區塊、解析 model 輸出的 `<tool_call>` XML，補齊 OpenAI tool-calling 對 Qwen3.5 系列的支援。
- **多模態（libmtmd）**：vision 43 tok/s、audio 35.9 tok/s（RTX 5070 Ti Laptop / Q4_K_M），`--mmproj <path>` 載入 projection；支援 file / RGB buffer / PCM audio 三種輸入。
- **Sampling preset 注入**：透過 Anthropic request `metadata.taskType` 觸發，4 組 Qwen 官方推薦預設（`thinking-general` / `thinking-coding` / `instruct-general` / `instruct-reasoning`），用 `appliesTo` glob 做 family gate 不污染 Claude/Llama。詳見 [docs/sampling-presets.md](./docs/sampling-presets.md)。
- **Watchdog 三層守門**：inter-chunk gap / reasoning-block / token cap 三層客戶端守護，防止 Qwen 等 reasoning 模型進 `<think>` block 後無止境吐 chain-of-thought。詳見 [docs/llamacpp-watchdog.md](./docs/llamacpp-watchdog.md)。

### 何時用哪條 adapter

| 情境 | 推薦 | 原因 |
|---|---|---|
| 開發 / debug 單一 model | **fetch + TCQ-shim** | shim 可獨立 kill/重啟、stderr log 清楚、my-agent 端可改 code 不影響 server |
| 並存多個 model alias | **fetch + 多 shim** | 各起一 port，切換 alias 不必重啟 my-agent |
| 完全 in-process（無 port、最小延遲） | **embedded** | 走 `node-llama-tcq` 直接 binding，無 fetch 開銷 |
| 用既有的 `buun-llama-cpp` `llama-server` binary | **fetch + buun-llama-server** | shim 可不啟動，my-agent 直接吃 OpenAI 相容端點（無 Qwen-aware 增強）|

### 本地 stack Quick start

```bash
# 1. 啟 TCQ-shim（terminal A）— 256K ctx + TURBO4 KV + Qwen tool format
cd vendor/node-llama-tcq
bun src/cli/cli.ts serve \
  --model ../../models/Qwen3.5-9B-Q4_K_M.gguf \
  --mmproj ../../models/mmproj-Qwen3.5-9B-F16.gguf \
  --host 127.0.0.1 --port 8081 \
  --ctx-size 262144 --gpu cuda --n-gpu-layers 999 \
  --cache-type-k turbo4 --cache-type-v turbo4 --flash-attn \
  --enable-tools --reasoning on --reasoning-format deepseek \
  --alias qwen3.5-9b

# 2. my-agent 連 shim（terminal B）— alias 對齊 shim --alias
./cli --model qwen3.5-9b
```

啟動參數每個旗標的說明、E2E 測試 driver、常見排錯見 [docs/live-test-realistic-v3-setup.md](./docs/live-test-realistic-v3-setup.md)。

### 平台與硬體基準

| 項目 | 開發機基準 | 備註 |
|---|---|---|
| GPU | RTX 5070 Ti Laptop（Blackwell sm_120, 11.94GB VRAM） | mobile 變體；Q4_K_M + 256K turbo4 KV ≈ 11GB |
| CUDA | 12.8+ | sm_120 需 CUDA 12.8 以上 |
| OS | Windows 11（主開發） + macOS（vision/TCQ kernel 受限） | bun 1.3.11 |
| 模型存放 | `models/`（repo 內，不放 `~/models/`） | 路徑寫絕對 `$(pwd)/models/` |
| Build 時間 | CUDA 完整編譯 25–35 min（首次） | 不必 rebuild 除非改 C++ |

---

## 設定目錄結構

My Agent 把所有使用者設定放在兩個目錄：

```
~/.virtual-assistant-desktop/                          # 全域（使用者層級）
├── config.json                       # 一般設定
├── llamacpp.jsonc                    # 本地模型統一設定（M-LLAMA-CFG）
├── system-prompt/                    # 自訂 system prompt sections
│   └── *.md                          # 29 段可覆寫
├── USER.md                           # 使用者建模（全域 persona）
├── memory/                           # MemoryTool 結構化記憶
│   ├── preferences/*.md
│   ├── plans/*.md
│   ├── projects/*.md
│   └── todos/*.md
├── projects/<project-slug>/          # per-project 設定
│   ├── USER.md                       # 使用者建模（專案層覆寫）
│   └── memory/                       # 專案層記憶（覆蓋全域）
├── session-index.db                  # SQLite FTS5 跨 session 搜尋
├── skills/                           # 使用者自建 skills
├── commands/                         # 使用者自建 slash commands
├── agents/                           # 使用者自建 subagents
└── website-blocklist.yaml            # Web 工具封鎖清單

<project-root>/.virtual-assistant-desktop/             # 專案層（隨 repo 走）
├── scheduled_tasks.json              # 專案層 cron 任務
├── cron/output/<job-id>/             # cron 稽核 log
└── scheduler.lock                    # 排程互斥鎖（多 session 共用 cwd）
```

---

## 深度文件

| 文件 | 內容 |
|---|---|
| [docs/providers.md](./docs/providers.md) | 各 provider 設定、llama.cpp 部署、多模態、context、token 計量 |
| [docs/memory.md](./docs/memory.md) | Session recall、dynamic prefetch、MemoryTool、使用者建模 |
| [docs/cron.md](./docs/cron.md) | 排程系統使用者指南（7 工具、DSL、生命週期、modelOverride、preRunScript） |
| [docs/web-tools.md](./docs/web-tools.md) | WebFetch / WebSearch / WebCrawl / WebBrowser 與共用安全層 |
| [docs/customizing-system-prompt.md](./docs/customizing-system-prompt.md) | 如何用 markdown 覆寫 29 段 system prompt |
| [docs/context-architecture.md](./docs/context-architecture.md) | Context 組成詳解：system prompt 注入、memory context、fence 機制 |
| [docs/daemon-mode.md](./docs/daemon-mode.md) | Daemon 模式（常駐 WS server、多 ProjectRuntime、cron 獨占執行） |
| [docs/discord-mode.md](./docs/discord-mode.md) | Discord 整合（DM / guild channel、slash commands、per-project 頻道） |
| [docs/cron-wave34.md](./docs/cron-wave34.md) | Cron 進階特性（Wave 3：NL/retry/condition/catchup/history/通知）+ Wave 4 `/cron` TUI |
| **本地模型棧** | |
| [docs/node-llama-tcq-vs-buun-llama-cpp.md](./docs/node-llama-tcq-vs-buun-llama-cpp.md) | 兩層 fork 並排比較 — 分層職責、API、build、平台支援 |
| [docs/live-test-realistic-v3-setup.md](./docs/live-test-realistic-v3-setup.md) | TCQ-shim + my-agent E2E 測試啟動參數逐項說明 + 排錯 |
| [docs/sampling-presets.md](./docs/sampling-presets.md) | Qwen 推薦 sampling preset、`appliesTo` family gate 機制 |
| [docs/sampling-preset-findings-2026-05-08.md](./docs/sampling-preset-findings-2026-05-08.md) | 4 組 preset 在 thinking 模型上的實測結果與失敗模式 |
| [docs/config-llamacpp.md](./docs/config-llamacpp.md) | `~/.virtual-assistant-desktop/llamacpp.jsonc` 完整 schema |
| [docs/llamacpp-remote.md](./docs/llamacpp-remote.md) | Remote llama.cpp server routing |
| [docs/llamacpp-watchdog.md](./docs/llamacpp-watchdog.md) | Inter-chunk / reasoning-block / token-cap 三層守門 |
| **進階模組** | |
| [docs/coordinator-mode.md](./docs/coordinator-mode.md) | Coordinator 模式（多 agent 協作、worker 派發、scratchpad） |
| [docs/remote-sessions.md](./docs/remote-sessions.md) | CCR 遠端 session（`claude assistant`、WS bridge、permission） |
| [docs/upstreamproxy-relay.md](./docs/upstreamproxy-relay.md) | CCR 容器 HTTPS 代理（CONNECT-over-WS + credential 注入） |
| [docs/native-ts-addons.md](./docs/native-ts-addons.md) | color-diff / file-index / yoga-layout 純 TS 取代 NAPI |
| [docs/ui-moreright-panel.md](./docs/ui-moreright-panel.md) | REPL right-side panel hook（外部 build stub） |
| **參考** | |
| [src/tools/ScheduleCronTool/README.md](./src/tools/ScheduleCronTool/README.md) | Cron 工具參考（action 表） |
| [src/tools/WebBrowserTool/README.md](./src/tools/WebBrowserTool/README.md) | WebBrowser 工具參考（action 表） |
| [docs/e2e-test-suite.md](./docs/e2e-test-suite.md) | E2E 測試套件（A–J 10 sections / 53 cases）— 開發者 |
| [docs/adr.md](./docs/adr.md) | 全部架構決策記錄（活的限制 + 已推翻決策） |
| [FEATURES.md](./FEATURES.md) | Feature flag 清單（建構時控制模組啟用） |

---

## 建構變體

| 指令 | 產出 | 用途 |
|---|---|---|
| `bun run build` | `./cli` | 正式版 |
| `bun run build:dev` | `./cli-dev` | 開發版（額外 debug 旗標） |
| `bun run build:dev:full` | `./cli-dev` | 全功能實驗版（啟用所有 working experimental flags） |
| `bun run compile` | `./dist/cli` | Standalone 單一執行檔（bytecode compile） |
| `bun run typecheck` | — | 僅 TypeScript 型別檢查 |
| `bun test` | — | 全部測試（單元 + 整合） |
| `bun run dev` | — | 熱重載開發模式，直接跑 `src/entrypoints/cli.tsx` |

---

## 常用 CLI 旗標

```bash
./cli -p "prompt"              # 一問式（print mode，完成即 exit）
./cli -p "prompt" --model X    # 指定模型
./cli                          # 互動式 TUI
./cli --continue               # 延續上次 session
./cli --resume <session-id>    # 續跑指定 session（FTS 可查）
./cli --verbose                # 詳細 log
./cli daemon start             # 啟動常駐 daemon（後續 REPL 自動 attach）
./cli daemon status            # 檢視 daemon 狀態
./cli daemon stop              # 關閉 daemon
```

---

## 授權與來源

本專案為獨立開源 agent CLI，原始碼放在本 repo。詳細的建構設定見
`package.json`，feature flag 清單見 `FEATURES.md`。
