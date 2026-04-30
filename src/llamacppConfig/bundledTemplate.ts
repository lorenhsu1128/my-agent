/**
 * llama.cpp 設定檔 JSONC 模板（bundled）。
 *
 * 用途：
 *   - 首次 seed 時寫入 ~/.my-agent/llamacpp.jsonc（使用者看到帶繁中註解版本）
 *   - Migration 時作為新格式基底（既有值會覆蓋模板預設值）
 *
 * 同步規則（schema.ts 改動時需同步本檔）：
 *   - 每次 LlamaCppConfigSchema 加欄位 → 模板補對應註解區塊
 *   - 每次改預設值 → 模板 value 同步
 *   - 每次標 deprecated → 模板註解補標記
 */

export const LLAMACPP_JSONC_TEMPLATE = `{
  // ═══════════════════════════════════════════════════════════════════
  // llama.cpp 本地模型設定（~/.my-agent/llamacpp.jsonc）
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

    // llama-server 執行檔路徑（相對 repo root 或絕對）。Windows 要含 .exe 副檔名。
    // buun-llama-cpp（TCQ KV cache 壓縮 fork）支援 turbo4 cache type。
    "binaryPath": "buun-llama-cpp/build/bin/Release/llama-server.exe",

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
  }
}
`
