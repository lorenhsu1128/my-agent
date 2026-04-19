/**
 * 首次啟動種檔。
 *
 * ~/.my-agent/llamacpp.json 不存在時，寫入 DEFAULT_LLAMACPP_CONFIG
 * 加上 README 註解檔 llamacpp.README.md。
 * 已存在則完全不動（尊重使用者編輯）。
 */
import { existsSync } from 'fs'
import { mkdir, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import { getLlamaCppConfigPath } from './paths.js'
import { DEFAULT_LLAMACPP_CONFIG } from './schema.js'
import { logForDebugging } from '../utils/debug.js'

const README_FILENAME = 'llamacpp.README.md'

const README_CONTENT = `# ~/.my-agent/llamacpp.json

本檔為 free-code 與 \`scripts/llama/serve.sh\` **共用**的本地 LLM server 設定來源。

- free-code TS 端透過 \`src/llamacppConfig/loader.ts\` 讀取，session 啟動時凍結快照。
- shell 端透過 \`scripts/llama/load-config.sh\` 以 \`jq\` 抽出 env vars，再由 \`serve.sh\` 啟動 llama-server 時使用。

編輯後：
- TS 端需**開新 session** 才生效（凍結快照語意）。
- shell 端每次 \`bash scripts/llama/serve.sh\` 都重讀。

## 欄位說明

### Client 層（free-code 連線）

| 欄位 | 用途 | 預設 |
|------|------|------|
| \`baseUrl\` | OpenAI 相容 endpoint | \`http://127.0.0.1:8080/v1\` |
| \`model\` | 送給 server 的模型名稱（需與 \`server.alias\` 一致） | \`qwen3.5-9b-neo\` |
| \`contextSize\` | 用於 auto-compact 閾值；若 \`/slots\` 可查到就用 server 實際值 | \`131072\` |
| \`debug\` | 印 \`[LLAMA_DEBUG]\` 到 stderr | \`false\` |
| \`modelAliases\` | 命中時自動走 llamacpp 分支的 model 名清單 | \`["qwen3.5-9b-neo", "qwopus3.5-9b-v3"]\` |

### Server 層（scripts/llama/serve.sh 啟動參數）

| 欄位 | 用途 | 預設 |
|------|------|------|
| \`server.host\` | \`--host\` | \`127.0.0.1\` |
| \`server.port\` | \`--port\` | \`8080\` |
| \`server.ctxSize\` | \`--ctx-size\`（需 ≥ \`contextSize\`） | \`131072\` |
| \`server.gpuLayers\` | \`--n-gpu-layers\` | \`99\` |
| \`server.modelPath\` | \`--model\`（相對 repo root 或絕對路徑） | \`models/Jackrong_Qwen3.5-9B-Neo-Q5_K_M.gguf\` |
| \`server.alias\` | \`--alias\`（OpenAI 相容層回的模型名） | \`qwen3.5-9b-neo\` |
| \`server.binaryPath\` | llama-server 執行檔路徑 | \`llama/llama-server.exe\` |
| \`server.extraArgs\` | 額外 flag 陣列，例 \`["--cache-reuse", "1"]\` 啟用 prefix cache | \`["--flash-attn", "auto", "--jinja"]\` |

## Env var 覆蓋

下列 env var 仍然可暫時覆蓋（優先於檔案）：

| Env | 覆蓋欄位 |
|-----|---------|
| \`LLAMA_BASE_URL\` | baseUrl |
| \`LLAMA_MODEL\` | model |
| \`LLAMACPP_CTX_SIZE\` | contextSize（僅 client 端） |
| \`LLAMA_DEBUG\` | debug |
| \`LLAMA_HOST\` / \`LLAMA_PORT\` / \`LLAMA_CTX\` / \`LLAMA_NGL\` / \`LLAMA_ALIAS\` | server.* 對應欄位（僅 shell 端） |
| \`LLAMACPP_CONFIG_PATH\` | 整個設定檔路徑 |

## 復原

- 刪掉 \`llamacpp.json\` → 下次啟動會自動重新 seed。
- 刪掉這份 README 不影響功能。

## 注意

- \`server.ctxSize\` 與 client 的 \`contextSize\` 若不一致可能觸發 auto-compact 時機錯誤；一般應設相同值。
- 編輯 JSON 若壞掉（語法錯或 schema 不符），free-code 會 stderr 警告並走內建預設，不 crash。
`

export async function seedLlamaCppConfigIfMissing(): Promise<void> {
  const path = getLlamaCppConfigPath()
  if (existsSync(path)) return
  try {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(
      path,
      JSON.stringify(DEFAULT_LLAMACPP_CONFIG, null, 2) + '\n',
      'utf-8',
    )
    await writeFile(
      join(dirname(path), README_FILENAME),
      README_CONTENT,
      'utf-8',
    )
    logForDebugging(`[llamacpp-config] seeded ${path}`)
  } catch (err) {
    logForDebugging(
      `[llamacpp-config] seed 失敗，繼續走內建預設：${err instanceof Error ? err.message : String(err)}`,
      { level: 'warn' },
    )
  }
}
