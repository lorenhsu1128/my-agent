/**
 * llama.cpp 設定檔 schema。
 *
 * 存放位置：~/.my-agent/llamacpp.json
 * 單一來源：free-code TS 端 + scripts/llama/*.sh 都讀這份。
 *
 * 設計原則：
 *   - 所有欄位都 optional；缺欄位走 DEFAULTS
 *   - 解析失敗（JSON 壞 / schema 不符）→ 走 DEFAULTS + console.error 警告
 *   - env var override 優先於 config 檔（LLAMA_BASE_URL / LLAMACPP_CTX_SIZE 等維持）
 */
import { z } from 'zod'

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
})

export const LlamaCppConfigSchema = z.object({
  /** free-code TS 端連線的 OpenAI 相容 endpoint（含 /v1） */
  baseUrl: z.string().url().default('http://127.0.0.1:8080/v1'),
  /** free-code 端送給 server 的 model 名稱（需與 server.alias 一致） */
  model: z.string().default('qwen3.5-9b-neo'),
  /** 用於 auto-compact 閾值計算；若 server /slots 查不到就用此值 */
  contextSize: z.number().int().positive().default(131072),
  /** 開 stderr 偵錯輸出 */
  debug: z.boolean().default(false),
  /**
   * 會觸發 llamacpp 分支的 model 別名集合。
   * 當使用者下 `--model <alias>` 且 alias 命中此清單，即使沒設
   * CLAUDE_CODE_USE_LLAMACPP env 也會走 llama.cpp。
   */
  modelAliases: z
    .array(z.string())
    .default(['qwen3.5-9b-neo', 'qwopus3.5-9b-v3']),
  /** llama-server 啟動相關參數（scripts/llama/serve.sh 讀） */
  server: LlamaCppServerSchema.default({}),
})

export type LlamaCppConfig = z.infer<typeof LlamaCppConfigSchema>
export type LlamaCppServerConfig = z.infer<typeof LlamaCppServerSchema>

/** 完整預設值（所有欄位）。供 seed 寫檔 + fallback 使用。 */
export const DEFAULT_LLAMACPP_CONFIG: LlamaCppConfig =
  LlamaCppConfigSchema.parse({})
