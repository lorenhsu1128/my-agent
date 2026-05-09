# live-test-realistic-v3-myagent — 啟動參數完整參考

本文記錄 `vendor/node-llama-tcq/scripts/live-test-realistic-v3-myagent.ts` 端到端
測試所需的兩端啟動參數與相關設定（TCQ-shim server + my-agent CLI client +
sampling preset）。對應原始檔：

- 測試 driver：`vendor/node-llama-tcq/scripts/live-test-realistic-v3-myagent.ts`
- shim CLI：`vendor/node-llama-tcq/src/cli/commands/ServerCommand.ts`
- sampling preset schema：`src/llamacppConfig/schema.ts`
- adapter：`src/services/api/llamacpp-fetch-adapter.ts`

資料流：

```
test driver → my-agent CLI (-p --output-format stream-json)
            → llamacpp-fetch-adapter
            → http://127.0.0.1:8081  (TCQ-shim)
            → llama.cpp (Qwen3.5-9B + mmproj)
```

---

## 1. TCQ-shim（server，:8081）

於 `vendor/node-llama-tcq/` 內啟動：

```bash
cd vendor/node-llama-tcq
bun src/cli/cli.ts serve \
  --model   "../../models/Qwen3.5-9B-Q4_K_M.gguf" \
  --mmproj  "../../models/mmproj-Qwen3.5-9B-F16.gguf" \
  --host 127.0.0.1 --port 8081 \
  --ctx-size 262144 \
  --gpu cuda --n-gpu-layers 999 \
  --cache-type-k turbo4 --cache-type-v turbo4 \
  --flash-attn \
  --enable-tools \
  --reasoning on --reasoning-format deepseek \
  --alias qwen3.5-9b
```

> 開發/測試一律走 `bun src/cli/cli.ts serve`（= `bun run dev -- serve`），
> 不走 `npm run build` 後的 dist（feedback memory：TCQ-shim 用 bun run dev）。
> 重啟前必先 kill 舊 process + 確認 port 釋放，否則 VRAM 會爆
> （feedback memory：重啟 GPU server 前必殺舊 process）。

### 參數說明

| Flag | 值 | 說明 |
|---|---|---|
| `--model` | `../../models/Qwen3.5-9B-Q4_K_M.gguf` | 主 GGUF 路徑。專案 model 一律放在 `my-agent/models/`，不從 `~/models/` 找。Q4_K_M 量化 ≈ 5.5GB。|
| `--mmproj` | `../../models/mmproj-Qwen3.5-9B-F16.gguf` | 視覺編碼器（multimodal projector）。F16 ≈ 1.4GB。沒帶這個 vision case (D11/D12) 會失敗。|
| `--host` | `127.0.0.1` | 僅本機監聽。 |
| `--port` | `8081` | shim 監聽 port。my-agent baseUrl 對齊此值。 |
| `--ctx-size` | `262144` | KV cache 窗 = 256K tokens。Qwen3.5-9B 原生 256K，用滿。|
| `--gpu` | `cuda` | 用 CUDA backend（RTX 5070 Ti Laptop / Blackwell sm_120）。|
| `--n-gpu-layers` | `999` | full offload（所有 transformer 層放 GPU）。Q4_K_M + 256K turbo4 KV ≈ 11GB，剛好塞 12GB VRAM。|
| `--cache-type-k` | `turbo4` | TCQ K-cache 4.25 bpv 壓縮（≈ 3.8x），幾乎無品質損失。**TCQ-shim 專屬**，原生 llama.cpp 沒有這個值。|
| `--cache-type-v` | `turbo4` | 同上，V-cache。 |
| `--flash-attn` | （flag） | 啟用 Flash Attention，turbo4 KV 必須搭配 flash-attn。|
| `--enable-tools` | （flag） | 啟用 Qwen pythonic-XML tool 格式注入（系統 prompt 自動加 `<tools>...</tools>` 區塊 + 解析 model 輸出的 `<tool_call>` XML）。沒開的話 my-agent 收不到 tool_use block。|
| `--reasoning` | `on` | 強制 thinking 模式（不讓 model 自己決定）。可選值：`auto` / `on` / `off`。v3 測試固定 `on` 是因為要量測 thinking chars。|
| `--reasoning-format` | `deepseek` | **不是模型家族選項**，是「response payload 怎麼把 `<think>` 暴露出來」的協議格式。詳見 §1.1。 |
| `--alias` | `qwen3.5-9b` | OpenAI 相容層回給 client 的 model 名稱。**必須與 my-agent 端 `model` 欄位一致**，否則 server 拒請求。|

### 1.1 `--reasoning-format` 三個選項

定義在 `vendor/node-llama-tcq/src/cli/commands/ServerCommand.ts:220-225`，沿襲
upstream `llama-server` 旗標命名（所以沒有 `qwen` 這個值）：

| 值 | 行為 | 何時用 |
|---|---|---|
| `none` | `<think>...</think>` raw tag 留在 `content` 內 | 想自己 parse / debug 時 |
| `deepseek`（**default**） | 拆出來放到 OpenAI delta 的 `reasoning_content` 欄位 | **my-agent 必須用這個** — adapter 期待從 `delta.reasoning_content` 收 thinking、`delta.content` 收可見文字，才能對映到 Anthropic `thinking_delta` block |
| `deepseek-legacy` | 拆出來 + 同時保留 `<think>` tag 在 content | 給需要兩邊都吃的舊 client |

> Qwen3.5 與 DeepSeek-R1 的 thinking 標記同樣是 `<think>...</think>`，所以
> `deepseek` 這個 split 邏輯天然適用 Qwen。「Qwen 專屬」的部分（pythonic-XML
> tool 格式、`<think>` prefix/suffix 等）走 `--enable-tools` + `QwenChatWrapper`
> + `qwenToolFormat.ts`，與此旗標無關。

### 1.2 啟動前必檢

1. `conda activate aiagent`（CLAUDE.md 黃金規則 1）。
2. 確認 8081 沒有舊 process：`netstat -ano | findstr :8081`，有就 kill。
3. `models/Qwen3.5-9B-Q4_K_M.gguf` 與 `models/mmproj-Qwen3.5-9B-F16.gguf` 存在。
4. RTX 5070 Ti Laptop 12GB：`nvidia-smi` 確認 VRAM 至少剩 11.5GB。

---

## 2. my-agent CLI（client）

由 `live-test-realistic-v3-myagent.ts` 對每個 case spawn 一次：

```bash
# 預設（USE_PREBUILT_CLI 未設）走 TS 直跑：
bun <REPO_ROOT>/src/entrypoints/cli.tsx \
  --print \
  --output-format stream-json \
  --include-partial-messages \
  --verbose \
  --allow-dangerously-skip-permissions \
  --disallowed-tools "Edit Write NotebookEdit" \
  --model qwen3.5-9b \
  --no-session-persistence \
  -p "<case prompt>"
```

### 參數說明

| Flag | 值 | 說明 |
|---|---|---|
| `--print` (`-p`) | — | 一次性輸出模式（非互動 TTY），prompt 由 `-p` 直接帶入。|
| `--output-format` | `stream-json` | 每行一個 JSON event。對應 `stream_event` / `result` 等 event type，driver 用此抓 ttft / token / tool_use。|
| `--include-partial-messages` | （flag） | 把 `content_block_delta`（text_delta / thinking_delta）也 emit 出來。沒開只會收到完整 message，量不到 ttft。|
| `--verbose` | （flag） | 多 emit 內部 event。|
| `--allow-dangerously-skip-permissions` | （flag） | 跳過所有 tool 權限提示（測試環境必開）。|
| `--disallowed-tools` | `"Edit Write NotebookEdit"` | 禁止寫檔 tool — 測試只用 Read / Glob / Grep / Bash。防止 case 副作用污染 repo。|
| `--model` | `qwen3.5-9b` | 對應 shim `--alias`。my-agent 比對 `modelAliases` 清單觸發 llamacpp 分支。|
| `--no-session-persistence` | （flag） | 每 case 全新 session，不寫 `~/.my-agent/sessions/`。|
| `-p` | `<prompt>` | case prompt（測試 driver 帶入）。 |

### 2.1 driver 內部行為

從 `live-test-realistic-v3-myagent.ts`：

- **CLI 路徑切換**：預設 `bun src/entrypoints/cli.tsx`（直跑 TS）；`USE_PREBUILT_CLI=1` 才走編譯後的 `./cli`。FIXUP-8 驗證需求 — binary 不會 pick up 修改中的 TS。
- **MODEL env**：`MODEL=qwen3.5-9b`（預設），可覆寫成其他 alias。
- **timeout**：每 case 預設 360s wall-clock；D10 multi-step 給 600s。超時 `killTree` 整棵子樹（Windows 用 `taskkill /T`）。
- **跳過控制**：
  - `SKIP_EARLY=1` 跳過 D1–D8（vision-only 重跑）。
  - `ONLY_VISION=1` 跳過 D9–D10（只跑 vision case）。
- **量測欄位**：
  - `timeMs`：spawn → `result` event 抵達。
  - `ttftMs`：第一個 `content_block_delta` 或 `tool_use` start。
  - `inputTokens` / `outputTokens` / `numTurns` / `durationApiMs` / `costUsd`：從 `result` event 抓。
  - `thinkingChars` / `textChars`：累計 `thinking_delta` / `text_delta`。
  - `toolUseCount`：`content_block_start` with `type=tool_use`。

### 2.2 Test cases（D1–D12）

| ID | 類型 | 重點驗證 |
|---|---|---|
| D1 | pure-knowledge | 純知識題不該呼 tool（薛丁格時間演化算符）|
| D2 | math-think | 純數學推理（100 以內 4 質因數）|
| D3 | read-file | 讀 `qwenToolFormat.ts` 列 exports |
| D4 | grep | `Grep` 工具找字串次數 |
| D5 | glob-read | `Glob` → `Read` 多步 |
| D6 | analyze | 讀 + thinking 分析 `QwenChatWrapper` |
| D7 | shell | `Bash` 跑 `git log --oneline -3` |
| D8 | refusal | 訂機票要拒絕，且不能呼 Bash |
| D9 | ambiguity | 「修一下那個 bug」要澄清 |
| D10 | multi-step | git log → 挑 .ts → Read → 摘要（10min timeout）|
| D11 | vision | NYT 登月圖描述（Apollo / 1969）|
| D12 | vision+tool | 看圖認年份 → Bash 算差距 |

---

## 3. my-agent 端設定 `~/.my-agent/llamacpp.jsonc`

完整 schema 在 `src/llamacppConfig/schema.ts`，產生文件 `docs/config-llamacpp.md`。
此處列 v3 測試會走到的關鍵欄位。

### 3.1 Client 層

| 欄位 | 值 | 說明 |
|---|---|---|
| `baseUrl` | `http://127.0.0.1:8081/v1` | shim endpoint（含 `/v1`）。env `LLAMA_BASE_URL` 覆寫。|
| `model` | `qwen3.5-9b` | 對應 shim `--alias`。env `LLAMA_MODEL` 覆寫。|
| `contextSize` | `262144` | 估算用 ctx 長度，影響 auto-compact 閾值。優先序：server `/slots` 實際值 → env `LLAMACPP_CTX_SIZE` → 此欄位 → 128K 硬預設。|
| `autoCompactBufferTokens` | `30000` | 距 ctx 上限剩多少 tokens 觸發 compact。reasoning 模型 `<thinking>` 會吃 5-15K，建議 ≥ 30K。|
| `debug` | `false` | 開 adapter stderr 偵錯（排查 tool call 翻譯時開 true）。|
| `modelAliases` | `["qwen3.5-9b", "qwen3.5-9b-neo"]` | 命中時自動走 llamacpp 分支，不必設 `MY_AGENT_USE_LLAMACPP`。|

### 3.2 Server 層（給 `scripts/llama/serve.sh` 用，v3 測試**不**走這條）

v3 測試 server 是手動起 TCQ-shim（§1），不經過 `serve.sh`。但這段設定仍會被
`scripts/llama/load-config.sh` 讀，env vars 對齊：

| 欄位 | 值 |
|---|---|
| `server.host` / `port` | `127.0.0.1` / `8081` |
| `server.ctxSize` | `262144` |
| `server.gpuLayers` | `99` |
| `server.modelPath` | `models/Qwen3.5-9B-Q4_K_M.gguf` |
| `server.alias` | `qwen3.5-9b` |
| `server.binaryPath` | `buun-llama-cpp/build/bin/Release/llama-server.exe` |
| `server.extraArgs` | `--flash-attn on --cache-type-k turbo4 --cache-type-v turbo4 -b 2048 -ub 512 -np 1 --threads 12 --threads-batch 12 --no-mmap --jinja` |

> v3 測試走 TCQ-shim（`bun src/cli/cli.ts serve`）而非 `buun-llama-cpp`
> binary。兩者都支援 turbo4，但 TCQ-shim 多 `--enable-tools` 與 Qwen-aware
> chat wrapper 邏輯。差異見 `docs/node-llama-tcq-vs-buun-llama-cpp.md`。

### 3.3 Routing

```jsonc
"routing": {}
```

空 = 全部 callsite 走 `local`。callsite enum：

- `turn` — 主對話
- `sideQuery` — queryHaiku、cron NL parser
- `memoryPrefetch` — findRelevantMemories selector
- `background` — extractMemories
- `vision` — VisionClient

ADR-021：routing 指 `remote` 但 `remote.enabled=false` → 該 callsite 觸發時硬性 throw，不 silent fallback。

---

## 4. Sampling Preset

定義在 `src/llamacppConfig/schema.ts:253-270`，套用邏輯在
`src/llamacppConfig/applySamplingPreset.ts`。

### 4.1 觸發路徑

1. Anthropic request 帶 `metadata.taskType: '<key>'` → adapter 查
   `samplingPresets['<key>']`。
2. 經 `appliesTo` glob 對 model alias 過濾（family gate，不污染非 Qwen 模型）。
3. 把 `params` 內的欄位注入到 llama.cpp body。
4. 沒帶 `taskType` → 走 `defaultSamplingPreset`（留空 = 不注入）。
5. **Body 顯式欄位永遠優先**於 preset。

> Hot-reload：改 `~/.my-agent/llamacpp.jsonc` 後**下個 turn** 立刻生效（mtime 監測），不用重啟 my-agent / shim。
>
> 改 schema.ts 內建 default 值要跑 `bun run docs:gen` 重新產 `docs/config-llamacpp.md`，否則 CI `bun run docs:verify` 會 fail（CLAUDE.md 規則 13）。

### 4.2 內建 4 組 preset（schema default）

全部 `appliesTo: ['qwen*', '*qwen*']`。

| Preset | temp | top_p | top_k | min_p | presence | rep | 適用 |
|---|---|---|---|---|---|---|---|
| `thinking-general` | 1.0 | 0.95 | 20 | 0.0 | 1.5 | 1.0 | thinking 模式一般 QA / 分析 |
| `thinking-coding` | 0.6 | 0.95 | 20 | 0.0 | 0.0 | 1.0 | thinking 模式 code / 算法 |
| `instruct-general` | 0.7 | 0.8 | 20 | 0.0 | 1.5 | 1.0 | non-thinking 一般任務 |
| `instruct-reasoning` | 1.0 | 0.95 | 20 | 0.0 | 1.5 | 1.0 | non-thinking 推理 |

> Qwen 系列 sampling 來源：Qwen3 官方推薦值（HF model card）。
> thinking-coding 強項在算法 / code review / tool 鏈；refusal / 含糊澄清類
> 不適合用 thinking-coding，要用 thinking-general（feedback memory 紀錄）。

### 4.3 本機 override（v3 測試實際使用）

`~/.my-agent/llamacpp.jsonc` 末尾：

```jsonc
"samplingPresets": {
  // Qwen 官方 coding 嚴格版：低 top_p + presence/rep penalty 抑制重複輸出。
  "thinking-coding": {
    "appliesTo": ["qwen*", "*qwen*"],
    "params": {
      "temperature": 0.6,
      "top_p": 0.8,
      "top_k": 20,
      "min_p": 0.0,
      "presence_penalty": 1.0,
      "repetition_penalty": 1.05
    }
  }
},

"defaultSamplingPreset": "thinking-coding"
```

差異對照（vs schema default）：

| 欄位 | schema default | 本機 override | 影響 |
|---|---|---|---|
| `top_p` | 0.95 | **0.8** | 候選 token 池更窄，輸出更收斂 |
| `presence_penalty` | 0.0 | **1.0** | 抑制已出現過的 token，避免重複 |
| `repetition_penalty` | 1.0 | **1.05** | 同上，輕微懲罰重複 |
| 其他 | — | 不變 | — |

`defaultSamplingPreset: thinking-coding` 表示：沒帶 `metadata.taskType` 時也套
thinking-coding。v3 測試 driver **沒帶** `taskType`，所以全部 case 都吃這組
override（前提：model alias 對得上 `qwen*` glob）。

### 4.4 Family gate（appliesTo）

`appliesTo` 是 glob 陣列，比對的是 Anthropic request 的 `model` 欄位（也就是
my-agent CLI `--model` 帶進去的值）：

- `qwen*` 匹配 `qwen3.5-9b`、`qwen3.5-9b-neo`、`qwen2.5-coder` 等。
- `*qwen*` 額外匹配 `claude-via-qwen-proxy` 這種包裝。
- 寫 `claude-*` 就只套 Claude，完全不影響 Qwen。

**不要拿掉 family gate** — 不然 preset 會打到 Anthropic / Llama 模型上面，
sampling 完全錯位（feedback memory：sampling preset 預設只套 Qwen）。

---

## 5. 跑測試

### 5.1 起 shim（terminal A）

```bash
conda activate aiagent
cd vendor/node-llama-tcq
# 先確認 port 釋放
netstat -ano | findstr :8081
# 啟動
bun src/cli/cli.ts serve \
  --model ../../models/Qwen3.5-9B-Q4_K_M.gguf \
  --mmproj ../../models/mmproj-Qwen3.5-9B-F16.gguf \
  --host 127.0.0.1 --port 8081 \
  --ctx-size 262144 --gpu cuda --n-gpu-layers 999 \
  --cache-type-k turbo4 --cache-type-v turbo4 --flash-attn \
  --enable-tools --reasoning on --reasoning-format deepseek \
  --alias qwen3.5-9b
```

等 stdout 出現 `Server listening on http://127.0.0.1:8081` 再進下一步。

### 5.2 跑 driver（terminal B）

```bash
conda activate aiagent
cd vendor/node-llama-tcq
bun scripts/live-test-realistic-v3-myagent.ts 2>&1 | tee live-test-realistic-v3-myagent.log
```

可選 env：

```bash
USE_PREBUILT_CLI=1 bun scripts/live-test-realistic-v3-myagent.ts   # 用 ./cli 而非 TS 直跑
MODEL=qwen3.5-9b-neo bun scripts/...                                # 換 model alias
SKIP_EARLY=1 bun scripts/...                                        # 跳 D1–D8
ONLY_VISION=1 bun scripts/...                                       # 只跑 D11–D12
```

### 5.3 結果欄位對照

每行 case 結果格式：

```
✅ D3.1 讀 qwenToolFormat.ts 列 exports     12345ms ttft= 1234ms  in=  3456t  out= 234t/18.9t/s  think=1234ch text=567ch turns=1 tools=[Read] text~/(buildQwenToolsSystemBlock|...)/
```

末尾彙總分 type 顯示 pass rate / total time / token rate / avg ttft / avg turns。

---

## 6. 常見排錯

| 症狀 | 原因 | 解法 |
|---|---|---|
| 全部 case 0 ttft / 0 token | shim 沒起 / port 不對 | `curl http://127.0.0.1:8081/v1/models` |
| Vision case D11/D12 fail | `--mmproj` 沒帶 | 重起 shim 加 `--mmproj` |
| 全部 case 走 Anthropic 而非 Qwen | model alias 沒在 `modelAliases` | 確認 `~/.my-agent/llamacpp.jsonc` 內 `modelAliases` 含 `qwen3.5-9b` |
| Sampling preset 沒套 | `appliesTo` 沒 match model 名 | 確認 glob；開 `"debug": true` 看 adapter stderr |
| Tool call 沒被解析 | shim 沒帶 `--enable-tools` | 重起 shim 加 |
| thinking_delta 拿不到 | `--reasoning-format` 不是 `deepseek` | 改回 `deepseek` |
| `No sequences left` / `Eval has failed` | TCQ sequence reclaim race | 已知問題，用 `resetSessionSequence` helper（drain context lock 再 getSequence）|
| VRAM 爆 | 重啟前沒殺舊 shim | kill + verify port 釋放再起 |

---

## 附：關鍵原始檔索引

| 路徑 | 內容 |
|---|---|
| `vendor/node-llama-tcq/scripts/live-test-realistic-v3-myagent.ts` | 測試 driver |
| `vendor/node-llama-tcq/src/cli/commands/ServerCommand.ts` | shim CLI 旗標定義 |
| `vendor/node-llama-tcq/src/server/chatCompletions.ts` | reasoning split / OpenAI 相容層 |
| `vendor/node-llama-tcq/src/server/qwenToolFormat.ts` | Qwen pythonic-XML tool 格式 |
| `vendor/node-llama-tcq/src/chatWrappers/QwenChatWrapper.ts` | Qwen chat template wrapper |
| `src/llamacppConfig/schema.ts` | my-agent llamacpp.jsonc zod schema + sampling preset default |
| `src/llamacppConfig/applySamplingPreset.ts` | preset 套用 + family gate 邏輯 |
| `src/services/api/llamacpp-fetch-adapter.ts` | Anthropic ↔ OpenAI 翻譯層 |
| `~/.my-agent/llamacpp.jsonc` | 本機設定（含 sampling preset override）|
| `docs/sampling-preset-findings-2026-05-08.md` | sampling preset E2E 驗證紀錄 |
| `docs/node-llama-tcq-vs-buun-llama-cpp.md` | TCQ-shim vs buun-llama-cpp binary 差異 |
