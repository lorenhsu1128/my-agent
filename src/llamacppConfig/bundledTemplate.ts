/**
 * llama.cpp 設定檔 JSONC 模板（bundled）。
 *
 * 用途：
 *   - 首次 seed 時寫入 ~/.virtual-assistant-desktop/llamacpp.jsonc（使用者看到帶繁中註解版本）
 *   - Migration 時作為新格式基底（既有值會覆蓋模板預設值）
 *
 * 同步規則（schema.ts 改動時需同步本檔）：
 *   - 每次 LlamaCppConfigSchema 加欄位 → 模板補對應註解區塊
 *   - 每次改預設值 → 模板 value 同步
 *   - 每次標 deprecated → 模板註解補標記
 */

export const LLAMACPP_JSONC_TEMPLATE = `{
  // ═══════════════════════════════════════════════════════════════════
  // llama.cpp 本地模型設定（~/.virtual-assistant-desktop/llamacpp.jsonc）
  //
  // 本檔為 my-agent 與 scripts/llama/serve.sh **共用**的單一來源：
  //   - my-agent TS 端：透過 src/llamacppConfig/loader.ts 讀取，session 啟動時凍結快照
  //   - shell 端：透過 scripts/llama/load-config.sh 以 jq 抽出 env vars
  //
  // 編輯後：
  //   - TS 端需開新 session 才生效（凍結快照語意）
  //   - shell 端每次 bash scripts/llama/serve.sh 都重讀
  //
  // 壞檔（JSON 語法錯 / schema 不符）→ stderr 警告並走內建預設，不 crash
  // 復原：直接刪掉此檔，下次啟動會重新 seed（註解會回來）
  // ═══════════════════════════════════════════════════════════════════

  // ═══ Client 層（my-agent TS 連線設定）═══

  // my-agent 連接的 OpenAI 相容 endpoint（含 /v1 路徑）。
  // env \`LLAMA_BASE_URL\` 覆蓋此欄位。
  "baseUrl": "http://127.0.0.1:8080/v1",

  // 送給 server 的模型名稱（必須與 server.alias 一致，否則 server 拒請求）。
  // env \`LLAMA_MODEL\` 覆蓋此欄位。
  "model": "qwen3.5-9b",

  // 估算用的 context 長度（tokens）。用途：auto-compact 閾值計算。
  // 優先順序：server /slots 實際值 → env \`LLAMACPP_CTX_SIZE\` →
  // 本欄位 → 128K 硬預設。一般與 server.ctxSize 設相同值。
  "contextSize": 131072,

  // 距離 context 上限還剩多少 tokens 時觸發 auto-compact。
  // reasoning 模型（qwen3.5-9b-neo 的 <thinking> 會吃 5-15K）建議 30K 以上。
  // env \`LLAMACPP_COMPACT_BUFFER\` 覆蓋。
  "autoCompactBufferTokens": 30000,

  // 開 adapter stderr 偵錯輸出。平常 false；排查 tool call 翻譯問題時開 true。
  "debug": false,

  // 命中時自動走 llamacpp 分支的 model 別名清單。
  // 使用者下 --model <alias> 且 alias 在此清單 → 即使沒設 MY_AGENT_USE_LLAMACPP
  // 也會走 llama.cpp（讓本地模型跟 Anthropic 模型可並存切換）。
  "modelAliases": [
    "qwen3.5-9b",
    "qwen3.5-9b-neo",
    "qwopus3.5-9b-v3"
  ],

  // ═══ Server 層（scripts/llama/serve.sh 啟動 llama-server 用）═══

  "server": {
    // 綁定的 IP。127.0.0.1 僅本機存取；若要區網可改 0.0.0.0（注意安全）。
    // env \`LLAMA_HOST\` 覆蓋。對應 --host。
    "host": "127.0.0.1",

    // 綁定的 port。env \`LLAMA_PORT\` 覆蓋。對應 --port。
    "port": 8080,

    // llama-server --ctx-size，KV cache 窗大小（tokens）。
    // 需 >= client 端 contextSize，否則 compact 時機會算錯。
    // env \`LLAMA_CTX\` 覆蓋。
    "ctxSize": 131072,

    // --n-gpu-layers：送進 GPU 的層數。99 = 全部；VRAM 不夠降低此值。
    // env \`LLAMA_NGL\` 覆蓋。
    "gpuLayers": 99,

    // --model：GGUF 檔路徑。相對 repo root 或絕對路徑。
    "modelPath": "models/Qwen3.5-9B-Q4_K_M.gguf",

    // --alias：OpenAI 相容層回給 client 的模型名。必須與 client 端 model 一致。
    // env \`LLAMA_ALIAS\` 覆蓋。
    "alias": "qwen3.5-9b",

    // llama-server 執行檔路徑。僅當 binaryKind === "buun" 時才被執行；
    // "tcq" 模式忽略此欄位（改跑 vendor/node-llama-tcq/src/cli/cli.ts serve）。
    // buun-llama-cpp（TCQ KV cache 壓縮 fork）支援 turbo4 cache type。
    "binaryPath": "vendor/node-llama-tcq/src/cli/cli.ts",

    // Server 實作種類：
    //   "tcq"（預設）= bun vendor/node-llama-tcq/src/cli/cli.ts serve（TCQ-shim sidecar）
    //   "buun"       = 執行 binaryPath 指定的 buun-llama-cpp llama-server 原生 binary
    // TCQ-shim 規格與 buun llama-server 對齊（M-TCQ-SHIM）；切換不影響 baseUrl /
    // model / OpenAI 相容性。
    "binaryKind": "tcq",

    // 額外傳給 llama-server 的 CLI flag。
    // turbo4 = buun TCQ KV cache 壓縮（4.25 bpv，~3.8x），幾乎無品質損失。
    "extraArgs": [
      "--flash-attn", "on",
      "--cache-type-k", "turbo4",
      "--cache-type-v", "turbo4",
      "-b", "2048",
      "-ub", "512",
      "-np", "1",
      "--threads", "12",
      "--threads-batch", "12",
      "--no-mmap",
      "--jinja"
    ],

    // Vision 相關（shell 端用；對應 --mmproj flag）。
    "vision": {
      // mmproj（vision projector）GGUF 檔路徑。只有支援多模態的模型需要。
      // 設了才會把 --mmproj 加到 llama-server 啟動參數。
      "mmprojPath": "models/mmproj-Qwen3.5-9B-F16.gguf"
    }
  },

  // ═══ Vision 支援（M-VISION；client 端用）═══

  "vision": {
    // true  → adapter 把 Anthropic image block 翻成 OpenAI image_url（data URL / URL）
    //         僅在模型有 vision 能力時開啟（例如 Qwen3.5-9B + mmproj）
    // false → adapter 把 image 轉 [Image attachment] 文字佔位符
    //         純文字模型（Qwen3.5-9B-Neo 等）必須保持 false，否則 server 報錯
    "enabled": true
  },

  // ═══ Remote endpoint（M-LLAMACPP-REMOTE；可選）═══
  //
  // 若你有第二台機器跑更大的模型（例如 32B / 70B），這裡填遠端 server 連線資訊；
  // 配合下面 routing 表把指定 callsite 指向 'remote'。
  // 預設 enabled=false → 整個 remote 區塊靜默；routing 仍可全 'local' 安全執行。
  // 安全提醒：apiKey 寫在這個檔即為唯一來源；建議家目錄已隔離且 chmod 600。
  "remote": {
    "enabled": false,
    "baseUrl": "http://127.0.0.1:8080/v1",
    "model": "qwen3.5-9b",
    // "apiKey": "sk-...",
    "contextSize": 131072
  },

  // ═══ Per-callsite routing（M-LLAMACPP-REMOTE；可選）═══
  //
  // 把不同呼叫情境分流到 local / remote。缺欄位 = 'local'。
  // 改了下個 turn 立刻生效（沿用 mtime hot-reload 機制）。
  //
  // callsite 對應：
  //   - turn           主對話（chat）— 通常你的「主腦」
  //   - sideQuery      旁路查詢（queryHaiku、cron NL parser 等小型 LLM 呼叫）
  //   - memoryPrefetch findRelevantMemories selector（query-driven memory 召回）
  //   - background    背景任務（extractMemories 等；目前未顯式傳遞）
  //   - vision        圖像理解（VisionClient → llama.cpp 多模態模型）
  //
  // 若 routing 指 'remote' 但 remote.enabled=false → 該 callsite 觸發時會
  // throw 顯式錯誤（不 silent fallback，避免 debug 時誤判）。
  "routing": {
    "turn": "local",
    "sideQuery": "local",
    "memoryPrefetch": "local",
    "background": "local",
    "vision": "local"
  },

  // ═══ Watchdog（M-LLAMACPP-WATCHDOG；client-side 守門）═══
  //
  // 三層 watchdog 守門 llama.cpp 失控生成（reasoning loop、SSE hang 等）。
  // 全部預設 false → 不影響既有行為；要用透過 \`/llamacpp\` opt-in 或直接改本檔。
  // master \`enabled\` + 三層各自 \`enabled\` 雙層 AND；env LLAMACPP_WATCHDOG_DISABLE=1
  // 強制關（無視 config），LLAMACPP_WATCHDOG_ENABLE=1 一鍵全開。
  //
  // 三層責任：
  //   A. interChunk — SSE 連續無 token N ms = 連線真的 hung
  //   B. reasoning  — 進 <think> 後 N ms 仍未見 </think> = CoT 失控迴圈
  //   C. tokenCap   — 累積 token 超 ceiling[callSite] = 防失控總量
  "watchdog": {
    "enabled": false,
    "interChunk": {
      "enabled": false,
      // 兩個 SSE chunk 間最大允許間隔（毫秒）
      "gapMs": 30000
    },
    "reasoning": {
      "enabled": false,
      // 進 <think> 後最大滯留時間（毫秒）
      "blockMs": 120000
    },
    "tokenCap": {
      "enabled": false,
      // 主 turn ceiling — caller 可送更小但不能超此值
      "default": 16000,
      // memory prefetch（findRelevantMemories selector）ceiling
      "memoryPrefetch": 256,
      // sideQuery（queryHaiku / cron NL parser）ceiling
      "sideQuery": 1024,
      // 背景呼叫（extractMemories 等）ceiling
      "background": 4000
    }
  },

  // ═══ Sampling preset 庫（M-TCQ-SHIM-SAMPLER；可選）═══
  //
  // caller 在 Anthropic request 帶 metadata.taskType: '<key>' 即觸發；沒帶就走
  // defaultSamplingPreset；仍無則不注入。優先序：request body > preset > shim
  // CLI default > engine 內建。preset 只填 body 沒帶的欄位（caller 顯式覆蓋永遠贏）。
  //
  // Schema 內建 4 組 Qwen 推薦 preset（key 名稱可在此檔覆寫；缺項走內建）：
  //   - "thinking-general"    溫和創意：temp 1.0  / top_p 0.95 / presence 1.5
  //   - "thinking-coding"     嚴格穩定：temp 0.6  / top_p 0.95 / presence 0.0
  //   - "instruct-general"    通用對話：temp 0.7  / top_p 0.8  / presence 1.5
  //   - "instruct-reasoning"  推理任務：temp 1.0  / top_p 0.95 / presence 1.5
  //
  // 4 組都標 appliesTo: ['qwen*', '*qwen*'] family gate — 不會誤套 Claude / Llama / GPT-OSS。
  // 改了下個 turn 立刻生效（mtime hot-reload）。
  "samplingPresets": {
    // 範例：覆寫 thinking-coding 為 Qwen 官方 coding 嚴格版
    // "thinking-coding": {
    //   "appliesTo": ["qwen*", "*qwen*"],
    //   "params": {
    //     "temperature": 0.6,
    //     "top_p": 0.8,
    //     "top_k": 20,
    //     "min_p": 0.0,
    //     "presence_penalty": 1.0,
    //     "repetition_penalty": 1.05
    //   }
    // }
  },

  // 沒帶 metadata.taskType 時的 fallback preset key（仍會經過 family gate）。
  // 不設 = 不注入 sampler。常用值："thinking-coding" / "instruct-general"。
  // "defaultSamplingPreset": "thinking-coding"
}
`
