# Providers 設定指南

My Agent 支援多家 LLM 服務。切換 provider 只要設環境變數，不需改程式碼。

## 支援清單

| Provider | 切換旗標 | 協定 | 備註 |
|---|---|---|---|
| **llama.cpp**（本地） | `MY_AGENT_USE_LLAMACPP=1`（或自動偵測） | OpenAI 相容 | 一等公民；預設入口 |
| **Messages API 直連** | 不設任何 `MY_AGENT_USE_*` | Messages API | 走 `ANTHROPIC_API_KEY` + 可選 `ANTHROPIC_BASE_URL` |
| **AWS Bedrock** | `MY_AGENT_USE_BEDROCK=1` | Bedrock | 走 AWS 憑證鏈 |
| **Google Vertex** | `MY_AGENT_USE_VERTEX=1` | Vertex | 走 GCP ADC |
| **Azure Foundry** | `MY_AGENT_USE_FOUNDRY=1` | Foundry | 走 Azure identity |
| **OpenAI Codex** | `MY_AGENT_USE_OPENAI=1` | OpenAI Chat Completions | 特化模型清單 |

> `MY_AGENT_USE_*` 前綴是 provider 選擇開關；`ANTHROPIC_*` 前綴是 Messages API
> 協定層的 key 名稱（SDK 使用），不代表 provider 歸屬。

> **Browser 與 Web 工具的 provider 是另一套**（puppeteer-core local /
> Browserbase / Browser Use / Firecrawl backend），詳見
> [docs/web-tools.md](./web-tools.md) 與 ADR-011。本檔僅涵蓋 LLM provider。

## Provider 解析順序

`src/utils/model/providers.ts::detectProvider()`：

1. `MY_AGENT_USE_BEDROCK` → `bedrock`
2. `MY_AGENT_USE_VERTEX` → `vertex`
3. `MY_AGENT_USE_FOUNDRY` → `foundry`
4. `MY_AGENT_USE_OPENAI` → `openai`
5. `MY_AGENT_USE_LLAMACPP` → `llamacpp`
6. 如果 `ANTHROPIC_API_KEY` / 相容端點可連 → Messages API 直連
7. 否則 fallback 到 llamacpp（預設本地）

---

## 本地 llama.cpp 設定

本地模型是 My Agent 的預設路徑，採 fetch adapter 模式：provider 邊界
內部做 OpenAI SSE → Messages API `stream_event` 的協定轉譯，下游引擎無感。

### 部署

專案自帶部署腳本（`scripts/llama/`）：

```bash
bash scripts/llama/setup.sh     # 下載 llama.cpp binary + 模型（首次）
bash scripts/llama/serve.sh     # 啟動 llama-server（讀 llamacpp.json 設定）
bash scripts/llama/verify.sh    # 冒煙測試 OpenAI 相容端點
```

完整部署細節見 `scripts/llama/README.md`。

### 統一設定檔：`~/.my-agent/llamacpp.json`

所有 llama.cpp 相關設定集中在此，TS 與 shell 共用同一份來源：

```json
{
  "baseUrl": "http://127.0.0.1:8080/v1",
  "model": "qwen3.5-9b-neo",
  "modelAliases": {
    "qwopus": "qwen3.5-9b-neo"
  },
  "contextSize": 131072,
  "binary": "llama-b8829-temp/llama-server.exe",
  "modelPath": "models/qwen3.5-9b-neo-q5_k_m.gguf",
  "host": "127.0.0.1",
  "port": 8080,
  "ngl": 99,
  "alias": "qwen3.5-9b-neo"
}
```

- **首次啟動自動 seed**：找不到檔案會寫入預設值 + `llamacpp.README.md`。
- **Schema 驗證**：用 Zod 驗證；壞檔 graceful fallback 到內建預設，不崩潰。
- **Shell 端** 透過 `scripts/llama/load-config.sh` 抽出 env var；缺 `jq` 時
  fallback 到預設。
- **Env var 覆蓋優先**：`LLAMA_BASE_URL` / `LLAMA_MODEL` / `LLAMACPP_CTX_SIZE`
  等環境變數仍高於 JSON。

### 支援的模型能力

| 能力 | 支援 | 備註 |
|---|---|---|
| **文字生成（串流）** | ✅ | OpenAI SSE → `stream_event` 完整翻譯 |
| **工具呼叫（tool_use）** | ✅ | SSE tool_use 事件合併成單一 chunk 避免跨 chunk 解析失敗 |
| **思考鏈（reasoning）** | ✅ | 模型若有 `reasoning_content`，映射成 `thinking` content block |
| **Vision（多模態）** | ✅ | 詳見下節；不支援的模型會 fallback 到文字 |
| **Token 用量計量** | ✅ | `prompt_tokens_details.cached_tokens` 映射成快取命中率指標 |
| **Context 長度偵測** | ✅ | 啟動時查 `/slots` 端點；自動算 auto-compact 閾值 |
| **Context 溢出復原** | ✅ | 偵測錯誤訊息關鍵字 → 改寫成可觸發 reactive compaction 的形式 |

### Vision（多模態）

`M-VISION` 把 llamacpp 的多模態支援接上：

- **支援判定**：啟動時偵測模型是否支援 image input；不支援則自動走「只傳文字描述」
  的 fallback 路徑，不會因為模型限制而整個失敗。
- **WebBrowser `vision` action**：對網頁截圖問問題時，會經過此路徑。
- **圖片格式**：PNG / JPEG base64 編碼走 `image_url` 欄位送 OpenAI 相容端點。

### Memory Prefetch 走本地模型（ADR-014 / M-MEMRECALL-LOCAL）

當 provider 是 llamacpp 時，memory prefetch 的 selector 會偵測並改走本地
`/v1/chat/completions`（不是寫死 Sonnet）。沒有 `ANTHROPIC_API_KEY` 的純
本地用戶因此能正常 recall 過去 memory。selector 失敗時 safety-net
fallback 帶最新 8 個 memory（按 mtime）。詳見 [docs/memory.md](./memory.md)
「llama.cpp 模式下的 selector」一節。

### 128K Context 自動復原

長時間 session 容易把 128K 模型的 context 塞滿。`M-LLAMACPP-CTX` 做了三層保險：

1. **啟動時**：查 `/slots` 拿實際 context size；失敗會印一次性警告提示
   `LLAMACPP_CTX_SIZE=<tokens>` 手動覆蓋。
2. **Error path**：llamacpp server 回報 context 溢出時，正則比對
   `context|n_ctx|prompt|token` + `length|exceed|too long/large/many|out of`
   命中後改寫為 `Prompt is too long (llama.cpp): ...`，讓上游的
   `isPromptTooLongMessage()` 辨識並觸發 reactive compaction。
3. **Streaming 早退**：若 server 回 `finish_reason=length` + `output_tokens=0`
   記 warn（典型 context 已滿徵兆，便於診斷）。

---

## Messages API 直連

適用於有 API key 且想走原生 Messages API 的情境。

```bash
export ANTHROPIC_API_KEY="sk-ant-..."
# 可選：
export ANTHROPIC_BASE_URL="https://api.anthropic.com"
```

模型由 `--model` 參數 或 `ANTHROPIC_MODEL` env var 指定。

### 相關 env vars

| 變數 | 用途 |
|---|---|
| `ANTHROPIC_API_KEY` | API key |
| `ANTHROPIC_AUTH_TOKEN` | OAuth token（如有） |
| `ANTHROPIC_BASE_URL` | API base URL |
| `ANTHROPIC_MODEL` | 預設模型 |
| `ANTHROPIC_SMALL_FAST_MODEL` | 小任務用的快速模型（haiku 級） |
| `ANTHROPIC_DEFAULT_OPUS_MODEL` | opus 別名解析目標 |
| `ANTHROPIC_DEFAULT_SONNET_MODEL` | sonnet 別名解析目標 |

---

## AWS Bedrock

```bash
export MY_AGENT_USE_BEDROCK=1
export AWS_REGION=us-west-2
# AWS 憑證走標準 credential provider chain
# （~/.aws/credentials、env vars、IAM role、SSO …）
```

可選：
- `ANTHROPIC_BEDROCK_BASE_URL` 覆寫 Bedrock endpoint

---

## Google Vertex

```bash
export MY_AGENT_USE_VERTEX=1
export CLOUD_ML_REGION=us-east5
export ANTHROPIC_VERTEX_PROJECT_ID=your-gcp-project
# 憑證走 GCP Application Default Credentials
```

---

## Azure Foundry

```bash
export MY_AGENT_USE_FOUNDRY=1
export AZURE_OPENAI_ENDPOINT=https://your-resource.openai.azure.com
# 憑證走 @azure/identity（DefaultAzureCredential）
```

---

## OpenAI Codex

```bash
export MY_AGENT_USE_OPENAI=1
export OPENAI_API_KEY="sk-..."
```

僅使用 OpenAI 的特化 code 模型清單；模型對照在
`src/utils/model/providers.ts` 的 `ALL_MODEL_CONFIGS`。

---

## 認證模型（重要）

My Agent 的憑證模型刻意做得極簡：

- **不讀系統 keychain / credential manager**。所有 API key / token 只從
  環境變數讀取。
- **不走 OAuth 登入流程**。沒有 `/login` / `/logout` 指令（歷史 CLI 子指令
  執行後會印 `not supported` 並 exit 1）。
- **不查訂閱層級、速率限制 tier、組織資訊**。`getSubscriptionType()` 恆
  回傳空值；這些欄位在 UI 層也移除了。

實務影響：

- 切 provider 就是設 env var；沒有 UI 登入流程。
- API key 失效就是跑不動，沒有背景刷新 token 的機制。
- 如果你需要多帳號切換，用 shell 的 env 管理工具（`direnv` / `dotenv` / 自寫
  wrapper script）。

---

## Troubleshooting

### `All models must have a non-empty name`
`ALL_MODEL_CONFIGS` 裡的 llamacpp 分支沒填。檢查
`src/utils/model/providers.ts`，每個 provider 都要有 `name` 和 `lookup`
兩個欄位。

### `stream interrupted` / llamacpp 卡住
- 檢查 `LLAMA_BASE_URL` 是否正確
- 看 server log：`scripts/llama/serve.sh` 的輸出
- 若是 context 滿了：設 `LLAMACPP_CTX_SIZE=<實際 ctx>` 暫時 override

### TUI 顯示 Anthropic 預設模型而非本地模型
這是 `M-TUI` / `M-BRAND` 已修過的老問題。若仍發生，確認：
- `MY_AGENT_USE_LLAMACPP=1` 或 llamacpp endpoint 實際可連
- 重新建構 `./cli`（banner 顯示邏輯在 build time 決定字串）

### `Failed to parse tool call`
llamacpp adapter 的 SSE 解析沒對齊。檢查
`src/services/api/llamacpp-fetch-adapter.ts` 的 `parseToolCall`。
9B 級模型偶爾會吐格式怪異的 tool call，adapter 會盡量容錯但並非 100%。

---

## 進階：自己加 provider

1. 在 `src/utils/model/providers.ts` 新增 `APIProvider` 的 enum 值。
2. 補全 `ALL_MODEL_CONFIGS` 的 `lookup` fallback（沒補會炸在啟動時）。
3. 在 `src/services/api/client.ts` 新增對應的客戶端邏輯（若協定不同於既有）。
4. 若協定與 Messages API 不同，在 `src/services/api/` 下寫一個 fetch adapter
   做 SSE / request / response 轉譯（參考 `llamacpp-fetch-adapter.ts`）。
5. 測所有工具呼叫能通。
