# M-VISION — llamacpp 路徑多模態（Vision）支援 + 文字模型 fallback

## Context

目前 my-agent 的 llamacpp 路徑只吃文字：`src/services/api/llamacpp-fetch-adapter.ts:213-214` 看到 Anthropic `image` block 就轉成字串佔位符 `[Image attachment]` 丟給模型。使用者想接 Gemopus-4-E4B-it（基於 Gemma-4-E4B-it 的多模態 GGUF）讓本地模型真的能看圖，但切回 Qwen3.5-9B-Neo 這類純文字模型時不能炸、也不該把圖塞給它。

要解決三件事：
1. **Adapter 會轉 OpenAI `image_url`** — base64 / URL image block 翻成 `{type:"image_url", image_url:{url:"data:image/…;base64,…"}}`
2. **llama-server 帶 `--mmproj`** — vision 模型必要條件，文字模型則不帶
3. **Fallback 由 config 宣告** — 不做 runtime probing；使用者在 `~/.my-agent/llamacpp.json` 宣告當前模型是否支援 vision，adapter 依此決定翻譯 or 佔位符

**預期結果**：使用者把 `llamacpp.json` 的 `vision.enabled` 設 `true` + 填 `mmprojPath`，重啟 llama-server 後丟截圖進 TUI，模型能描述圖片內容；切回 Neo（`vision.enabled: false`）時舊行為（佔位符）完全不變。

## 設計決策

- **Capability 由 config 宣告，不 runtime probe**：與 ADR-010（config 單一來源）一致。probing `/v1/models` 也不會告訴你 mmproj 有無載入，還會增加啟動延遲。
- **Schema 新增 `vision` 子物件不動既有欄位**：`vision?: {enabled: boolean, mmprojPath?: string}`，所有既有 config 檔保持可讀（Zod default 補齊）。
- **Adapter 行為分支乾淨切**：`translateMessagesToOpenAI(messages, {vision: boolean})` 多吃一個旗標；關閉時走現行 `[Image attachment]` 佔位符（**不改既有語意**，保證純文字模型不壞）。
- **serve.sh 用 extraArgs 機制追加 `--mmproj`**：沿用既有 `LLAMA_EXTRA_ARGS_SHELL` pattern，load-config.sh 解析 `server.vision.mmprojPath` → 追加 `--mmproj <absPath>`。不新增 `--mmproj` 獨立 env var，維持 extraArgs 為唯一追加點。
- **URL image block**：直接放 `image_url.url`；base64 block 組成 data URL。媒體類型對應 `media_type`（image/jpeg / png / gif / webp）。
- **assistant history 裡的圖片**：現狀 assistant 不產圖，user/tool_result 才有 — 只需處理 user role 分支。

## 關鍵檔案（要改動）

1. `src/llamacppConfig/schema.ts`
   - `LlamaCppServerSchema` 內加 `vision: z.object({ mmprojPath: z.string().optional() }).optional()`
   - Top-level `LlamaCppConfigSchema` 加 `vision: z.object({ enabled: z.boolean().default(false) }).default({})`
   - 拆兩層是因為 TS client 只需要知道要不要翻譯；shell 端只需要 mmproj 路徑
   - 更新 `DEFAULT_LLAMACPP_CONFIG` 註釋 + README seed

2. `src/llamacppConfig/index.ts`（或 snapshot 模組）
   - 暴露 `isVisionEnabled()` 從 snapshot 讀 `vision.enabled`，供 adapter 使用

3. `src/services/api/llamacpp-fetch-adapter.ts`
   - Import `isVisionEnabled()` 或從建構時傳入 flag
   - `translateMessagesToOpenAI` 改成接受 `{vision: boolean}` 選項
   - user role 分支：若 `vision=true` 且 `msg.content` 含 image block，改產出 OpenAI multi-part content array `[{type:"text",text:...}, {type:"image_url",image_url:{url:...}}]`；否則維持佔位符字串合併行為
   - 新增 helper `imageBlockToOpenAIPart(block)` 處理 base64 / url 兩種 source

4. `scripts/llama/load-config.sh`
   - 新增讀 `.server.vision.mmprojPath`
   - 若有值：`resolve` 成絕對路徑（相對 repo root 補全）後加到 `LLAMA_EXTRA_ARGS_SHELL`：`--mmproj '<path>'`
   - 沒值：維持現狀不動

5. `scripts/llama/serve.sh`
   - **不用改**（`LLAMA_EXTRA_ARGS_SHELL` 已串在 eval exec 尾巴）

6. 測試
   - `tests/integration/llamacpp/vision-adapter-smoke.ts`（新增）：單元測試 `translateMessagesToOpenAI` 兩種模式
     - `vision:false` + image block → 輸出含 `[Image attachment]` 字串
     - `vision:true` + base64 block → 輸出 multi-part content，含 `type:"image_url"` + `data:image/png;base64,`
     - `vision:true` + url block → 輸出 `image_url.url` 直接帶 url
   - `tests/integration/llamacpp/vision-e2e.ts`（新增，opt-in via env）：丟 `tests/fixtures/vision/tiny-red-square.png` 問模型「這張圖是什麼顏色」，驗證回應含「red」。`MYAGENT_VISION_E2E=1` 才跑，CI 上跳過。

## 不做的事

- **不改 Anthropic 原生路徑**（`src/services/api/claude.ts`）— 它本來就支援 image block
- **不加 per-request capability override** — 全靠 config；要切模型就改 config + 重啟 llama-server
- **不 probe `/v1/models` 或 `/health`** — 使用者宣告即正確
- **不做 image resize / compression** — 交給模型端；my-agent 的 `src/utils/imageValidation.ts` 已有 size 檢查

## Verification

```bash
# 1. Schema + unit test 綠
bun run typecheck
bun test tests/integration/llamacpp/vision-adapter-smoke.ts

# 2. 文字模型回歸（vision:false）— 確認舊行為 zero diff
# 編輯 ~/.my-agent/llamacpp.json 確認沒有 vision.enabled 或為 false
./cli --model qwen3.5-9b-neo -p "hello"   # 不應報錯
# 丟一張圖：開 TUI，drag image，觀察模型收到「[Image attachment]」

# 3. Vision 模型端到端
# 下載 Gemopus-4-E4B-it GGUF + 對應 mmproj*.gguf 到 models/
# 編輯 ~/.my-agent/llamacpp.json：
#   server.modelPath = "models/Gemopus-4-E4B-it-Preview-Q5_K_M.gguf"
#   server.vision.mmprojPath = "models/mmproj-Gemopus-4-E4B-it-f16.gguf"
#   server.alias = "gemopus-4-e4b"
#   model = "gemopus-4-e4b"
#   modelAliases += "gemopus-4-e4b"
#   vision.enabled = true
bash scripts/llama/serve.sh   # 觀察 log 有 --mmproj 被帶入
MYAGENT_VISION_E2E=1 bun test tests/integration/llamacpp/vision-e2e.ts

# 4. 手動 TUI 驗證
./cli --model gemopus-4-e4b
# 貼一張照片，問「描述這張圖」，模型應真的描述內容（而非回「收到 Image attachment 但看不到」）
```

## 風險與假設

- **假設 llama.cpp 的 server binary 接 `image_url` 是 OpenAI-compatible 的**：新版 llama-server 已支援（有 `--mmproj` 的情況下），若版本太舊需升級。scripts/llama/setup.sh 目前綁的版本要驗證相容。
- **mmproj 檔案來源**：Jackrong 的 GGUF repo 不一定附，可能要從上游 `ggml-org/gemma-4-E4B-it-GGUF` 抓。此為使用者側工作，非 code 改動。
- **Token 成本**：圖片會吃 vision tokens（512+），本地 ctx 131072 仍夠用；若將來支援影片或連續多張圖要再評估。
