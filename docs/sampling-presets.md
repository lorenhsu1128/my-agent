# Sampling Preset 使用指南（M-TCQ-SHIM-SAMPLER）

本文件說明 my-agent 在 llama.cpp 路徑下的 sampling preset 機制：caller 如何透過
`metadata.taskType` 觸發任務專屬 sampling 參數、preset 庫如何擴充、以及與 TCQ-shim
端 server-side default 的搭配關係。

## 為什麼需要 Preset

不同類型的任務適合不同 sampling 參數。Qwen3.5 官方推薦：

| 任務類型 | temperature | top_p | top_k | min_p | presence_penalty |
|----------|-------------|-------|-------|-------|------------------|
| Thinking 通用     | 1.0  | 0.95 | 20 | 0.0 | 1.5 |
| Thinking 程式碼   | 0.6  | 0.95 | 20 | 0.0 | 0.0 |
| Instruct 通用     | 0.7  | 0.8  | 20 | 0.0 | 1.5 |
| Instruct 推理     | 1.0  | 0.95 | 20 | 0.0 | 1.5 |

過去 my-agent 只 forward `temperature` / `top_p` 兩欄，且 caller 沒辦法依任務類型切換。
本 milestone 補完 `top_k` / `min_p` / `presence_penalty` / `frequency_penalty` /
`repetition_penalty`，並加入 preset 機制。

## 優先序

```
request body > my-agent preset > shim CLI default > engine 內建
```

caller 在 Anthropic request body 顯式帶的欄位永遠贏；preset 只填 body 缺的欄位；
preset 不命中或未注入時走 shim 啟動時的 `--temp / --min-p ...` CLI default；
都沒設就用底層 node-llama-cpp 內建。

## 觸發 Preset

caller 在 Anthropic request 帶 `metadata.taskType`：

```ts
const res = await client.messages.create({
  model: 'qwen3.5-9b',
  max_tokens: 4096,
  messages: [...],
  metadata: { taskType: 'thinking-coding' }, // ← 觸發 preset
})
```

沒帶 `metadata.taskType` 時會 fallback 到 config 的 `defaultSamplingPreset`（若有設）；
仍沒設就完全不注入。

## Family Gate（重要）

**每個 preset 自帶 `appliesTo` glob 陣列**，只在 request 的 model id 命中任一 pattern
時才注入。預設 4 組 Qwen preset 都標 `['qwen*', '*qwen*']` — Qwen 推薦值不會誤套到
Claude / Llama / GPT-OSS 等其他模型。

```jsonc
{
  "samplingPresets": {
    "thinking-coding": {
      "appliesTo": ["qwen*", "*qwen*"],   // 只套 Qwen 系列
      "params": { "temperature": 0.6, "top_p": 0.95, "min_p": 0 }
    }
  }
}
```

不命中 → 靜默跳過（屬正常路徑，不 warn）。

支援 `*` 萬用字元：
- `qwen*` 命中 `qwen3.5-9b-neo`、`qwen3-32b`
- `*qwen*` 命中 `my-finetune-qwen`
- `llama-3*` 只命中 Llama 3 系列
- `*` 命中所有

## 自訂 Preset

在 `~/.my-agent/llamacpp.jsonc` 加 key（與預設 dict merge — 但 zod record default 在
使用者覆蓋時整個被取代，要重列預設項目，或只覆蓋部分時純加新 key）：

```jsonc
{
  "samplingPresets": {
    "creative-writing": {
      "appliesTo": ["*"],     // 所有模型都套
      "params": {
        "temperature": 1.3,
        "top_p": 0.92,
        "presence_penalty": 0.5
      }
    }
  },
  "defaultSamplingPreset": "instruct-general"
}
```

> **注意**：zod 的 `z.record(...).default(...)` 行為是「使用者提供 → 完全取代預設」。
> 要保留 4 組 Qwen 預設加新 key，建議 config 內把 4 組也明確列出，或在
> `applySamplingPreset` 呼叫前做 dict merge（目前 helper 不主動 merge — 由 schema 層
> 決定整個 record）。

## 與 TCQ-shim CLI Default 的關係

兩端互補：

- **my-agent preset**：caller 知道任務類型時用（顯式 `metadata.taskType` 或 fallback default）
- **TCQ-shim CLI default**：startup-time 設定，不知道 caller 是誰時的後備

優先序見上。典型部署：

```bash
# Shim 端：通用安全值當底
bun vendor/node-llama-tcq/src/cli/cli.ts serve \
  --model models/Qwen3.5-9B-Q4_K_M.gguf \
  --temp 0.7 --top-p 0.95 --top-k 20 --min-p 0

# my-agent caller：依任務挑 preset 蓋掉部分欄位
metadata: { taskType: 'thinking-coding' }  // → temperature=0.6 蓋過 shim 的 0.7
```

## 不在範圍

- `enable_thinking` / reasoning 開關 — 由 model capability + `--reasoning` CLI flag 控制，
  不在 preset 範疇
- caller 端自動判 taskType（heuristic / slash command 綁定）— 後續 milestone
- 未知 taskType 改 fail-hard — 目前是 warn + 不注入；下個 milestone 視需求加 strict mode env var

## 相關檔案

- `src/llamacppConfig/schema.ts` — `SamplingPresetSchema` / `samplingPresets` 欄位
- `src/llamacppConfig/applySamplingPreset.ts` — 注入純函式（含 `matchesPattern` glob helper）
- `src/services/api/llamacpp-fetch-adapter.ts` — `translateRequestToOpenAI` 內呼叫注入
- `vendor/node-llama-tcq/src/cli/commands/ServerCommand.ts` — shim CLI flag 定義
- `vendor/node-llama-tcq/src/server/samplerCoalesce.ts` — shim body coalesce
- `tests/integration/llamacpp/sampling-preset.test.ts` — 18 個 case

## 延伸閱讀

- `docs/sampling-preset-findings-2026-05-08.md` — 4 組 preset 在 thinking 模型上的實測通過率與失敗模式分析
- `docs/live-test-realistic-v3-setup.md` — TCQ-shim + my-agent E2E 測試啟動參數參考
