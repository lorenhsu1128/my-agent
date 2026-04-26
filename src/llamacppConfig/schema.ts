/**
 * llama.cpp 設定檔 schema。
 *
 * 存放位置：~/.my-agent/llamacpp.json
 * 單一來源：my-agent TS 端 + scripts/llama/*.sh 都讀這份。
 *
 * 設計原則：
 *   - 所有欄位都 optional；缺欄位走 DEFAULTS
 *   - 解析失敗（JSON 壞 / schema 不符）→ 走 DEFAULTS + console.error 警告
 *   - env var override 優先於 config 檔（LLAMA_BASE_URL / LLAMACPP_CTX_SIZE 等維持）
 */
import { z } from 'zod'

export const LlamaCppServerVisionSchema = z.object({
  /**
   * mmproj（vision projector）GGUF 檔路徑。
   * 相對 repo root 會被 serve.sh 補全；絕對路徑照用。
   * 有值時 load-config.sh 會把 `--mmproj <path>` 塞進 LLAMA_EXTRA_ARGS_SHELL。
   */
  mmprojPath: z.string().optional(),
})

export const LlamaCppServerSchema = z.object({
  /** llama-server 綁定的 IP（serve.sh --host） */
  host: z.string().default('127.0.0.1'),
  /** 綁定的 port（serve.sh --port） */
  port: z.number().int().positive().default(8080),
  /** --ctx-size，KV cache 窗大小（tokens） */
  ctxSize: z.number().int().positive().default(131072),
  /** --n-gpu-layers，送進 GPU 的層數；99 代表全部 */
  gpuLayers: z.number().int().nonnegative().default(99),
  /** --model 路徑（相對 repo root 或絕對路徑） */
  modelPath: z
    .string()
    .default('models/Jackrong_Qwen3.5-9B-Neo-Q5_K_M.gguf'),
  /** --alias，讓 OpenAI 相容客戶端用這名字呼叫模型 */
  alias: z.string().default('qwen3.5-9b-neo'),
  /** llama-server binary 位置（相對 repo root 或絕對路徑） */
  binaryPath: z.string().default('llama/llama-server.exe'),
  /** 要額外帶的 flag（例 --jinja、--slots、--cache-reuse 1） */
  extraArgs: z.array(z.string()).default(['--flash-attn', 'auto', '--jinja']),
  /**
   * Vision 相關設定（M-VISION）：僅 shell 端使用。
   * 有 mmprojPath 才會對 llama-server 加 `--mmproj`。
   */
  vision: LlamaCppServerVisionSchema.default({}),
})

/**
 * M-LLAMACPP-WATCHDOG：三層 watchdog 設定。
 *
 * 設計原則：
 * - master `enabled` + 三層各自 `enabled` 雙層 AND 才生效（任一 off = 該層不存在）
 * - **全部預設 false**，安裝後不影響既有行為；使用者透過 `/llamacpp` opt-in
 * - env override：LLAMACPP_WATCHDOG_ENABLE=1 一鍵開全部；LLAMACPP_WATCHDOG_DISABLE=1
 *   強制關（無視 config）— 後者優先於前者
 *
 * 三層的責任：
 * - A. interChunk：SSE 連續無 token N ms → 連線真的 hung
 * - B. reasoning：進 `<think>` 後 N ms 仍未見 `</think>` → CoT 失控迴圈
 * - C. tokenCap：累積 token 超 ceiling[callSite] → 防失控總量；per call-site 分流
 */

export const LlamaCppWatchdogInterChunkSchema = z.object({
  enabled: z.boolean().default(false),
  /** 兩個 SSE chunk 之間最大允許間隔（毫秒） */
  gapMs: z.number().int().positive().default(30_000),
})

export const LlamaCppWatchdogReasoningSchema = z.object({
  enabled: z.boolean().default(false),
  /** 進 `<think>` 後最大允許滯留時間（毫秒）— 沒見 `</think>` 就 abort */
  blockMs: z.number().int().positive().default(120_000),
})

export const LlamaCppWatchdogTokenCapSchema = z.object({
  enabled: z.boolean().default(false),
  /** 主 turn ceiling — caller 可送更小但不能超此值 */
  default: z.number().int().positive().default(16_000),
  /** Memory prefetch（findRelevantMemories selector）ceiling */
  memoryPrefetch: z.number().int().positive().default(256),
  /** sideQuery ceiling */
  sideQuery: z.number().int().positive().default(1_024),
  /** 背景呼叫（cron / extractMemories / NL parser）ceiling */
  background: z.number().int().positive().default(4_000),
})

export const LlamaCppWatchdogSchema = z.object({
  /** Master toggle — false 時三層全不啟動，無視各層自己的 enabled */
  enabled: z.boolean().default(false),
  interChunk: LlamaCppWatchdogInterChunkSchema.default({}),
  reasoning: LlamaCppWatchdogReasoningSchema.default({}),
  tokenCap: LlamaCppWatchdogTokenCapSchema.default({}),
})

export const LlamaCppVisionSchema = z.object({
  /**
   * 是否啟用 vision 翻譯（M-VISION）。
   * true  → adapter 把 Anthropic image block 翻成 OpenAI `image_url`（data URL / URL）
   * false → adapter 走舊行為：image block 轉成 `[Image attachment]` 佔位符字串
   * 預設 false，保證純文字模型（Qwen3.5-9B-Neo 等）零迴歸。
   */
  enabled: z.boolean().default(false),
})

export const LlamaCppConfigSchema = z.object({
  /** my-agent TS 端連線的 OpenAI 相容 endpoint（含 /v1） */
  baseUrl: z.string().url().default('http://127.0.0.1:8080/v1'),
  /** my-agent 端送給 server 的 model 名稱（需與 server.alias 一致） */
  model: z.string().default('qwen3.5-9b-neo'),
  /** 用於 auto-compact 閾值計算；若 server /slots 查不到就用此值 */
  contextSize: z.number().int().positive().default(131072),
  /**
   * 觸發 auto-compact 前預留的 token 數（= 距離 context 上限還有多少就開始 compact）。
   * 預設 30000 — 比通用預設 13000 寬鬆，reasoning 模型（qwen3.5-9b-neo 等）
   * 常在 <thinking> 吃掉 5-15K tokens，13K 太緊會導致 content 沒空間生成。
   * env `LLAMACPP_COMPACT_BUFFER` 優先於此設定。
   */
  autoCompactBufferTokens: z.number().int().positive().default(30000),
  /** 開 stderr 偵錯輸出 */
  debug: z.boolean().default(false),
  /**
   * 會觸發 llamacpp 分支的 model 別名集合。
   * 當使用者下 `--model <alias>` 且 alias 命中此清單，即使沒設
   * MY_AGENT_USE_LLAMACPP env 也會走 llama.cpp。
   */
  modelAliases: z
    .array(z.string())
    .default(['qwen3.5-9b-neo', 'qwopus3.5-9b-v3']),
  /** llama-server 啟動相關參數（scripts/llama/serve.sh 讀） */
  server: LlamaCppServerSchema.default({}),
  /**
   * Vision 支援（M-VISION）。僅 TS client 端使用；shell 端看 `server.vision.mmprojPath`。
   * 詳見 M_VISION_PLAN.md。
   */
  vision: LlamaCppVisionSchema.default({}),
  /**
   * Watchdog 設定（M-LLAMACPP-WATCHDOG）。三層 client-side 守門防 llama.cpp
   * 失控生成（reasoning loop 等）。預設全關不影響既有行為。
   */
  watchdog: LlamaCppWatchdogSchema.default({}),
})

export type LlamaCppConfig = z.infer<typeof LlamaCppConfigSchema>
export type LlamaCppServerConfig = z.infer<typeof LlamaCppServerSchema>
export type LlamaCppServerVisionConfig = z.infer<typeof LlamaCppServerVisionSchema>
export type LlamaCppVisionConfig = z.infer<typeof LlamaCppVisionSchema>
export type LlamaCppWatchdogConfig = z.infer<typeof LlamaCppWatchdogSchema>
export type LlamaCppWatchdogTokenCapConfig = z.infer<
  typeof LlamaCppWatchdogTokenCapSchema
>
export type LlamaCppCallSite =
  | 'turn'
  | 'memoryPrefetch'
  | 'sideQuery'
  | 'background'

/** 完整預設值（所有欄位）。供 seed 寫檔 + fallback 使用。 */
export const DEFAULT_LLAMACPP_CONFIG: LlamaCppConfig =
  LlamaCppConfigSchema.parse({})
