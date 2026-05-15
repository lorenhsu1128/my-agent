# Embedded 模式參考手冊

> **對應實作**：
> - `src/services/api/llamacpp-embedded-adapter.ts` — fetch-shaped adapter
> - `src/utils/model/embeddedRouting.ts` — 路由判定 + config 型別
> - `src/services/api/client.ts` — Anthropic SDK fetch 注入點 + jsonc parser
> - `vendor/node-llama-tcq/src/server/session.ts` — TCQ-shim ensureSession（共用）
> - `vendor/node-llama-tcq/src/server/chatCompletions.ts` — Qwen tool format core
>
> **最後對齊**：2026-05-15（直接重用 TCQ-shim ensureSession，完整 jsonc pipeline）

---

## 1. 設計目標

embedded 模式讓 my-agent 把 LLM 推論直接跑在 Node.js process 內（透過 `node-llama-tcq` native binding），不需要外部 `llama-server` 子進程。

桌寵（virtual-assistant-desktop）的 master toggle ON 時設 `MY_AGENT_LLAMACPP_EMBEDDED=1`，所有 LLM call 走 in-process 路徑：
- 啟動快（不需要 spawn 外部 binary、port 探測、heartbeat）
- 與 HTTP server 模式共用同一份 ensureSession，KV cache TCQ 壓縮 / Qwen tool format / sampling preset 行為完全等價
- 桌寵單一進程，shutdown 時完整釋放 GPU/CPU VRAM

---

## 2. 啟動條件

`decideEmbeddedRouting(modelConfig)` 判定優先序：

| 條件 | 行為 |
|---|---|
| `modelConfig.useEmbedded === true` | 強制走 embedded（最高優先級） |
| `MY_AGENT_LLAMACPP_EMBEDDED=1` env | 走 embedded（桌寵 master toggle ON 時設置） |
| `modelConfig.useEmbedded === false` | 強制走 fetch（外部 HTTP llama-server） |
| 都未設 | fetch（預設） |

啟用時若 `modelPath` 缺失 → 自動 fallback 到 fetch 並記錄 `reason: "embedded requested but modelPath missing"`。

---

## 3. Config 讀取鏈

```
~/.virtual-assistant-desktop/llamacpp.jsonc
        ↓ getLlamaCppConfigSnapshot()（mtime hot-reload）
        ↓
client.ts:130-180
  - snapshot.server.modelPath        → modelPath
  - snapshot.server.ctxSize          → contextSize
  - snapshot.server.gpuLayers        → gpuLayers
  - snapshot.server.vision.mmprojPath → mmprojPath
  - snapshot.server.extraArgs        → parseServerExtraArgs() 解析 CLI flag
  - snapshot.samplingPresets +
    snapshot.defaultSamplingPreset   → pickDefaultSamplerForModel() family-gated
  - snapshot.debug                   → debug
        ↓ decideEmbeddedRouting()
        ↓
EmbeddedRoutingConfig（21 個欄位）
        ↓ toSessionInitOptions()
        ↓
TCQ-shim SessionInitOptions
        ↓ tcqEnsureSession()（module-level singleton, withLock）
        ↓
ServerSession（llama / model / context / sequence / mtmdCtx）
```

**單一來源原則**：embedded 模式與 HTTP server 模式都讀同一份 `~/.virtual-assistant-desktop/llamacpp.jsonc`，使用者改設定後兩種模式行為一致。

---

## 4. CLI flag 解析（parseServerExtraArgs）

`snapshot.server.extraArgs` 是 llama-server CLI flag 陣列。embedded 模式不能直接 spawn binary，但 yargs 風格 flag 必須轉成 `SessionInitOptions` 欄位：

| Flag | 對應欄位 | 備註 |
|---|---|---|
| `--flash-attn on/off`、`-fa` | `flashAttention` | bare flag 視為 `on` |
| `--cache-type-k <name>`、`-ctk` | `cacheTypeK` | 接受 `turbo4` / `turbo3_tcq` / `f16` / `q8_0` 等 |
| `--cache-type-v <name>`、`-ctv` | `cacheTypeV` | 同上 |
| `-b <n>`、`--batch-size <n>` | `batchSize` | |
| `-ub <n>`、`--ubatch-size <n>` | `ubatchSize` | |
| `--threads <n>`、`-t <n>` | `threads` | |
| `--no-mmap` | `noMmap = true` | bare flag |
| 其他（`-np`、`--threads-batch`、`--jinja` 等） | 忽略 | embedded 模式不需要或由 binding 自動處理 |

行為與 TCQ-shim `ServeCommand` 的 yargs 解析等價，確保兩種模式對同一份 extraArgs 表現一致。

---

## 5. SessionInitOptions 完整對照（送進 tcq-shim ensureSession）

| 欄位 | 來源 | Default |
|---|---|---|
| `modelPath` | jsonc `server.modelPath` | 必填，缺則 throw |
| `mmprojPath` | jsonc `server.vision.mmprojPath` | undefined（純文字模式） |
| `contextSize` | jsonc `server.ctxSize` | 4096 |
| `gpuLayers` | jsonc `server.gpuLayers`（或 `"max"`/`"auto"`） | 99（全層 offload） |
| `gpu` | client.ts 硬設 `"cuda"` | `"auto"` |
| `threads` | extraArgs `--threads` | undefined（llama.cpp 自動） |
| `batchSize` | extraArgs `-b` | undefined（512 預設） |
| `ubatchSize` | extraArgs `-ub` | undefined |
| `cacheTypeK` | extraArgs `--cache-type-k` | `f16` |
| `cacheTypeV` | extraArgs `--cache-type-v` | `f16` |
| `flashAttention` | extraArgs `--flash-attn` | `true` |
| `noMmap` | extraArgs `--no-mmap` | `false` |
| `debug` | jsonc `debug` 或 `LLAMA_DEBUG=1` | `false` |
| `reasoning` | embedded 預設 | `"auto"` |
| `samplerDefaults` | jsonc `samplingPresets[defaultSamplingPreset]` + family gate | undefined |

---

## 6. tcq-shim ensureSession 內部行為（embedded 自動繼承）

1. **KV cache 解析**：`resolveCacheType("turbo4")` → `{type: GgmlType.TURBO4_0, isTcq: true}`；macOS 等不支援 TCQ 的平台自動 fallback `F16` 並 log warning
2. **TCQ codebook auto-apply**：偵測 `kCache.isTcq || vCache.isTcq` 自動呼叫 `applyTCQCodebooks()`（必須在 `getLlama()` 之前）
3. **withLock singleton**：第二次以後 `ensureSession` 直接拿既有 `_session`，不重複載 model / 重建 context
4. **`ignoreMemorySafetyChecks: isTcq`**：TCQ 用時自動跳過 VRAM 估算（upstream estimator 不知道 turbo4 ~3.5x、turbo2 ~7x 壓縮率，否則會誤判 OOM）
5. **sequence pre-acquire**：`context.getSequence()` 拿到單一 slot，per-request `LlamaChatSession` 重用同一個
6. **mtmdCtx 載入**：有 `mmprojPath` 時自動載 vision projector

---

## 7. Qwen 模型專屬處理（tcq-shim core 共用）

| 功能 | 實作 |
|---|---|
| Qwen 偵測 | `tcqIsQwenModel(modelLabel)` 認 `qwen*` |
| Tool 格式 | Hermes XML：`<tool_call><function=NAME><parameter=K>V</parameter></function></tool_call>` |
| `tcqPackMessages` | 把 OpenAI messages + tools 組成 systemPrompt（含 `<tools>` 區塊）+ history（含過去 tool_call XML）+ lastUserPrompt |
| `buildQwenToolsReminder` | 若 Qwen 在最後 user prompt 前缺 reminder → 自動加 |
| `parseQwenToolCalls` | 解析 Qwen XML 輸出回 OpenAI `tool_calls` 結構 |
| `extractToolCallsForFormat` | 從 LLM 輸出中提取 tool calls |
| `tcqRunCoreNonStreaming` | 單一入口跑 promptWithMeta + 解析 + 組 OpenAI ChatCompletion JSON |
| `formatReasoning` / `resolveReasoning` | `<think>` block 處理（reasoning model 用） |

非 Qwen 模型（Llama / GPT-OSS / Claude 等）自動跳過 Qwen 特化路徑，走標準 chat wrapper。

---

## 8. 輸入 / 輸出格式

embedded adapter 提供「fetch-shaped function」給 Anthropic SDK 注入：

### 輸入（Anthropic SDK 傳進來）

- POST `/v1/messages` 格式
- `body.model` / `body.messages` / `body.tools` / `body.system` / `body.stream` / `body.max_tokens`
- `init.signal`（AbortController）

### 內部翻譯流程

1. **Anthropic → OpenAI**：`translateRequestToOpenAI(anthropicBody)`
2. **Qwen tool format**：`tcqPackMessages` 組 prompt
3. **推論**：`tcqRunCoreNonStreaming(runCtx)` 跑 native binding
4. **OpenAI → Anthropic**：`translateChatCompletionToAnthropic(result.completion, "tcq")`（`tcq` mode 跳過下游 leak parser，因為 server-side parse 已等價）

### 輸出

- **Non-streaming**：JSON `application/json`，Anthropic Message shape（id / content blocks / usage / stop_reason）
- **Streaming SSE**：以 `text/event-stream` 自訂序列化
  - `message_start`
  - per block: `content_block_start` → `content_block_delta` → `content_block_stop`
    - 支援 `text` / `tool_use`（轉 `input_json_delta`）/ `thinking`（轉 `thinking_delta`）
  - `message_delta`（stop_reason / usage）
  - `message_stop`
- **錯誤回應**：
  - `499` aborted
  - `413` context overflow

---

## 9. Vision / Audio multimodal 路徑

當 `body.messages` 含 `image_url` / `audio_url` / `input_audio` block 且 `state.mtmdCtx != null`：

1. `extractMediaInput()` 把 data URL / `file://` / 絕對路徑解析成檔案路徑陣列，base64 寫 temp 檔
2. `mtmdCtx.tokenize({text, media})` → chunks
3. `mtmdCtx.evalChunks(context, chunks, 0, {seqId})`
4. `AddonSampler` + `mtmdCtx.generate()` 一次性產出 reply
5. temp 檔在 `finally` block 清理

**限制**：vision 路徑目前不走 TCQ-shim core，tools 不會被解析；v2 整合到 `runChatCompletionCoreNonStreaming`。

---

## 10. Sampler / 推論參數（Qwen 預設 preset）

jsonc 內建 4 組 Qwen 推薦 preset（family-gated `qwen*`）：

| Preset | temp | top_p | top_k | min_p | presence_penalty |
|---|---|---|---|---|---|
| `thinking-general` | 1.0 | 0.95 | 20 | 0.0 | 1.5 |
| `thinking-coding` | 0.6 | 0.95 | 20 | 0.0 | 0.0 |
| `instruct-general` | 0.7 | 0.8 | 20 | 0.0 | 1.5 |
| `instruct-reasoning` | 1.0 | 0.95 | 20 | 0.0 | 1.5 |

**優先序**：request body > preset > shim CLI default > engine 內建

**注入規則**：preset 只填 body 沒帶的欄位（caller 顯式覆蓋永遠贏）。

**Family gate**：每個 preset 自帶 `appliesTo` glob，model id 命中才注入；確保 Qwen 特化值不會誤套到 Claude / Llama / GPT-OSS。

---

## 11. Cache / Singleton 行為

| 層級 | 機制 |
|---|---|
| 模組層 | `_moduleCache` 只 `import 'node-llama-tcq'` 一次 |
| TCQ-shim 層 | `_session` module-level singleton（withLock guard）；首次 `ensureSession` 載 model + 建 context + 取 sequence；之後直接拿既有 session |
| Per-request | 每次 fetchFn 都建新的 `LlamaChatSession` wrap 同一個 sequence。`setChatHistory(history)` 自動處理 KV cache 增量 prefill / evict |

KV cache 不會在 request 之間漂移；長對話會被 context shift 自動 trim。

---

## 12. Shutdown / 釋放（桌寵 Master Toggle OFF 觸發）

呼叫 `tcqDisposeSession()`：

1. `context.dispose()` → 釋放 KV cache（GPU/CPU VRAM）
2. `model.dispose()` → 釋放 model weights
3. `_session = null`

桌寵 master toggle OFF 時 `AgentRuntime.disable()` 呼叫，回到「無 AI 模式」零 LLM 開銷（RSS 接近 v0.3 桌寵基線）。

---

## 13. Debug log（`LLAMA_DEBUG=1` 觸發）

啟動：
```
[embedded] session ready: gpuLayers=33/33 vramUsed=5708MiB
           k=turbo4 v=turbo4 ctx=131072 batch=2048 threads=12
           flashAttn=true noMmap=true
```

每次 fetchFn 呼叫：
```
[embedded] #1 tools=12 qwen=true sysLen=77674 histLen=0 userLen=705 stream=true
```

錯誤：
```
[embedded] fetchFn #N threw: <err>
  at <stack frame 1>
  at <stack frame 2>
  ...（前 6 行）
```

---

## 14. 已知限制 / 後續工作

| 項目 | 狀態 |
|---|---|
| Vision / audio 純文字以外路徑 | 不走 TCQ-shim core，tools 不解析（v2 整合） |
| Streaming 真正 token-by-token push | v1 一次拿完整 reply 再序列化成 SSE events；v2 整合 `runChatCompletionCoreStreaming` |
| Token cap / interChunk / reasoning watchdog | jsonc 有 schema 但 embedded 路徑沒接（Watchdog 目前是 fetch adapter 專屬） |
| macOS Metal TCQ | node-llama-tcq fork 尚未實作；fallback `f16` |
| 多 model 同時載入 | TCQ-shim 是單 slot singleton，切換 model 必須先 dispose；embedded 自動繼承此限制 |
| 跨進程 daemon WS（opt-in） | M-MASCOT-EMBED Phase 4 已完成 Bun.serve → Node ws+http 抽象 |

---

## 15. 驗證測試（virtual-assistant-desktop repo）

| 測試 | 路徑 | 用途 |
|---|---|---|
| `gpuSanityCheck.mjs` | `tests/integration/` | 繞過 my-agent，直接用 node-llama-tcq 載入跑推論，驗證 binding GPU 行為 |
| `gpuProofE2E.mjs` | `tests/integration/` | 端到端透過 AgentEmbedded 觸發推論，nvidia-smi 100ms 採樣驗證 GPU util / VRAM 對比 |
| `agentScenariosE2E.mjs` | `tests/integration/` | 10 個對話情境（中英 / 顯式 tool / 隱式 tool / 多步 chain / 拒絕 tool / 閒聊 / 模糊指示） |

最近驗證結果（Windows / CUDA / Qwen3.5-9B-Q4_K_M）：
- `gpuSanityCheck`：GPU peak 95%, avg 64.5%, VRAM 5708 MiB
- `gpuProofE2E`：GPU peak 65%, VRAM 7968 MiB，debug log 顯示 `k=turbo4 v=turbo4 batch=2048 threads=12 flashAttn=true noMmap=true`
- `agentScenariosE2E`：10/10 PASS（含 S7 multi-step 16 dispatch）

---

## 16. 相關文件

- `docs/mascot-integration.md` — 桌寵整合（v0.4 M-MASCOT-EMBED）
- `docs/sampling-presets.md` — Qwen 推薦值與 family gate
- `docs/config-llamacpp.md` — `~/.virtual-assistant-desktop/llamacpp.jsonc` 完整 schema
- `docs/prompt-inventory.md` — System prompt / sub-LLM prompt 全索引
- `vendor/node-llama-tcq/src/server/session.ts` — `SessionInitOptions` 權威來源
- `vendor/node-llama-tcq/src/tcq/presets.ts` — TCQ KV cache 預設
