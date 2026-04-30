# llamacpp.jsonc 欄位參考

> 本檔由 `bun run docs:gen` 從 zod schema 自動產生表格部分。
> 表格區段以外的敘述請手寫在 AUTO-GENERATED 段落之外。

## 概覽

本檔是 my-agent TS 端與 `scripts/llama/serve.sh` shell 端**共用**的 llama.cpp 設定來源。

**來源優先序**（自上而下）：env var override → `~/.my-agent/llamacpp.jsonc` → schema default。


## Env 變數一覽

| Env | 覆蓋欄位 |
|---|---|
| `LLAMA_BASE_URL` | baseUrl |
| `LLAMA_MODEL` | model |
| `LLAMACPP_CTX_SIZE` | contextSize |
| `LLAMACPP_COMPACT_BUFFER` | autoCompactBufferTokens |
| `LLAMA_DEBUG` | debug |
| `LLAMACPP_CONFIG_PATH` | (整個檔案路徑) |
| `LLAMACPP_WATCHDOG_ENABLE` | watchdog.enabled (force on) |
| `LLAMACPP_WATCHDOG_DISABLE` | watchdog.enabled (force off, 優先) |
| `LLAMA_HOST` | server.host (shell 端) |
| `LLAMA_PORT` | server.port (shell 端) |
| `LLAMA_CTX` | server.ctxSize (shell 端) |
| `LLAMA_NGL` | server.gpuLayers (shell 端) |
| `LLAMA_ALIAS` | server.alias (shell 端) |
| `LLAMA_MODEL_PATH` | server.modelPath (shell 端) |
| `LLAMA_BINARY` | server.binaryPath (shell 端) |

## Schema 欄位

<!-- AUTO-GENERATED-START — 跑 `bun run docs:gen` 重新產生 -->

### `LlamaCppServerVisionSchema`

| 欄位 | 型別 | Default | Env override | 說明 |
|---|---|---|---|---|
| `mmprojPath` | `string` _(optional)_ | _(undefined)_ | — | mmproj（vision projector）GGUF 檔路徑。 相對 repo root 會被 serve.sh 補全；絕對路徑照用。 有值時 load-config.sh 會把 `--mmproj <path>` 塞進 LLAMA_EXTRA_ARGS_SHELL。 |

### `LlamaCppServerSchema`

| 欄位 | 型別 | Default | Env override | 說明 |
|---|---|---|---|---|
| `host` | `string` | `'127.0.0.1'` | — | llama-server 綁定的 IP（serve.sh --host） |
| `port` | `number` | `8080` | — | 綁定的 port（serve.sh --port） |
| `ctxSize` | `number` | `131072` | — | --ctx-size，KV cache 窗大小（tokens） |
| `gpuLayers` | `number` | `99` | — | --n-gpu-layers，送進 GPU 的層數；99 代表全部 |
| `modelPath` | `string` | `'models/Qwen3.5-9B-Q4_K_M.gguf'` | — | --model 路徑（相對 repo root 或絕對路徑） |
| `alias` | `string` | `'qwen3.5-9b'` | — | --alias，讓 OpenAI 相容客戶端用這名字呼叫模型 |
| `binaryPath` | `string` | `'buun-llama-cpp/build/bin/Release/llama-server.exe'` | — | llama-server binary 位置（相對 repo root 或絕對路徑） |
| `extraArgs` | `array<string>` | `[ '--flash-attn', 'on', '--cache-type-k', 'turbo4', '--cache-type-v', 'turbo4...` | — | 要額外帶的 flag（例 --jinja、--slots、--cache-reuse 1） |
| `vision` | `LlamaCppServerVisionSchema` | `{}` | — | Vision 相關設定（M-VISION）：僅 shell 端使用。 有 mmprojPath 才會對 llama-server 加 `--mmproj`。 |

### `LlamaCppWatchdogInterChunkSchema`

| 欄位 | 型別 | Default | Env override | 說明 |
|---|---|---|---|---|
| `enabled` | `boolean` | `false` | — | _(無)_ |
| `gapMs` | `number` | `30_000` | — | 兩個 SSE chunk 之間最大允許間隔（毫秒） |

### `LlamaCppWatchdogReasoningSchema`

| 欄位 | 型別 | Default | Env override | 說明 |
|---|---|---|---|---|
| `enabled` | `boolean` | `false` | — | _(無)_ |
| `blockMs` | `number` | `120_000` | — | 進 `<think>` 後最大允許滯留時間（毫秒）— 沒見 `</think>` 就 abort |

### `LlamaCppWatchdogTokenCapSchema`

| 欄位 | 型別 | Default | Env override | 說明 |
|---|---|---|---|---|
| `enabled` | `boolean` | `false` | — | _(無)_ |
| `default` | `number` | `16_000` | — | 主 turn ceiling — caller 可送更小但不能超此值 |
| `memoryPrefetch` | `number` | `256` | — | Memory prefetch（findRelevantMemories selector）ceiling |
| `sideQuery` | `number` | `1_024` | — | sideQuery ceiling |
| `background` | `number` | `4_000` | — | 背景呼叫（cron / extractMemories / NL parser）ceiling |

### `LlamaCppWatchdogSchema`

| 欄位 | 型別 | Default | Env override | 說明 |
|---|---|---|---|---|
| `enabled` | `boolean` | `false` | — | Master toggle — false 時三層全不啟動，無視各層自己的 enabled |
| `interChunk` | `LlamaCppWatchdogInterChunkSchema` | `{}` | — | _(無)_ |
| `reasoning` | `LlamaCppWatchdogReasoningSchema` | `{}` | — | _(無)_ |
| `tokenCap` | `LlamaCppWatchdogTokenCapSchema` | `{}` | — | _(無)_ |

### `LlamaCppRemoteSchema`

| 欄位 | 型別 | Default | Env override | 說明 |
|---|---|---|---|---|
| `enabled` | `boolean` | `false` | — | 啟用 remote endpoint；false 時 routing 指 'remote' 會 throw 顯式錯誤 |
| `baseUrl` | `string` | `'http://127.0.0.1:8080/v1'` | `LLAMA_BASE_URL` | OpenAI 相容 endpoint（含 /v1） |
| `model` | `string` | `'qwen3.5-9b'` | `LLAMA_MODEL` | 送給 server 的 model 名稱 |
| `apiKey` | `string` _(optional)_ | _(undefined)_ | — | Bearer token（optional）；有值時 fetch 加 Authorization header |
| `contextSize` | `number` | `131072` | `LLAMACPP_CTX_SIZE` | 估算用 context 長度（tokens）；用於 watchdog token-cap 判斷 |

### `LlamaCppRoutingSchema`

| 欄位 | 型別 | Default | Env override | 說明 |
|---|---|---|---|---|
| `turn` | `?` | `'local'` | — | _(無)_ |
| `sideQuery` | `?` | `'local'` | — | _(無)_ |
| `memoryPrefetch` | `?` | `'local'` | — | _(無)_ |
| `background` | `?` | `'local'` | — | _(無)_ |
| `vision` | `?` | `'local'` | — | _(無)_ |

### `LlamaCppVisionSchema`

| 欄位 | 型別 | Default | Env override | 說明 |
|---|---|---|---|---|
| `enabled` | `boolean` | `false` | — | 是否啟用 vision 翻譯（M-VISION）。 true  → adapter 把 Anthropic image block 翻成 OpenAI `image_url`（data URL / URL） false → adapter 走舊行為：image block 轉成 `[Image attachment]` 佔位符字串 預設 false，保證純文字模型（Qwen3.5-9B-Neo 等）零迴歸。 |

### `LlamaCppConfigSchema`

| 欄位 | 型別 | Default | Env override | 說明 |
|---|---|---|---|---|
| `baseUrl` | `string` | `'http://127.0.0.1:8080/v1'` | `LLAMA_BASE_URL` | my-agent TS 端連線的 OpenAI 相容 endpoint（含 /v1） |
| `model` | `string` | `'qwen3.5-9b'` | `LLAMA_MODEL` | my-agent 端送給 server 的 model 名稱（需與 server.alias 一致） |
| `contextSize` | `number` | `131072` | `LLAMACPP_CTX_SIZE` | 用於 auto-compact 閾值計算；若 server /slots 查不到就用此值 |
| `autoCompactBufferTokens` | `number` | `30000` | `LLAMACPP_COMPACT_BUFFER` | 觸發 auto-compact 前預留的 token 數（= 距離 context 上限還有多少就開始 compact）。 預設 30000 — 比通用預設 13000 寬鬆，reasoning 模型（qwen3.5-9b-neo 等） 常在 <thinking> 吃掉 5-15K tokens，13K 太緊會導致 content 沒空間生成。 env `LLAMACPP_COMPACT_BUFFER` 優先於此設定。 |
| `debug` | `boolean` | `false` | `LLAMA_DEBUG` | 開 stderr 偵錯輸出 |
| `modelAliases` | `array<string>` | `['qwen3.5-9b', 'qwen3.5-9b-neo', 'qwopus3.5-9b-v3']` | — | 會觸發 llamacpp 分支的 model 別名集合。 當使用者下 `--model <alias>` 且 alias 命中此清單，即使沒設 MY_AGENT_USE_LLAMACPP env 也會走 llama.cpp。 |
| `server` | `LlamaCppServerSchema` | `{}` | `LLAMA_HOST`<br>`LLAMA_PORT`<br>`LLAMA_CTX`<br>`LLAMA_NGL`<br>`LLAMA_ALIAS`<br>`LLAMA_MODEL_PATH`<br>`LLAMA_BINARY` | llama-server 啟動相關參數（scripts/llama/serve.sh 讀） |
| `vision` | `LlamaCppVisionSchema` | `{}` | — | Vision 支援（M-VISION）。僅 TS client 端使用；shell 端看 `server.vision.mmprojPath`。 詳見 M_VISION_PLAN.md。 |
| `watchdog` | `LlamaCppWatchdogSchema` | `{}` | `LLAMACPP_WATCHDOG_ENABLE`<br>`LLAMACPP_WATCHDOG_DISABLE` | Watchdog 設定（M-LLAMACPP-WATCHDOG）。三層 client-side 守門防 llama.cpp 失控生成（reasoning loop 等）。預設全關不影響既有行為。 |
| `remote` | `LlamaCppRemoteSchema` | `{}` | — | Remote endpoint（M-LLAMACPP-REMOTE）。預設 enabled=false 不影響既有行為。 啟用後配合 routing 表把指定 callsite 指向遠端機器。 |
| `routing` | `LlamaCppRoutingSchema` | `{}` | — | Per-callsite routing（M-LLAMACPP-REMOTE）。缺欄位 = 'local'。 改了下個 turn 立刻生效（沿用 mtime hot-reload）。 |

<!-- AUTO-GENERATED-END -->
