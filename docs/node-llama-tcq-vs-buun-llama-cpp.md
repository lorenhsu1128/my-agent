# node-llama-tcq vs buun-llama-cpp 詳細比較

兩者**不是競品**，是**同一條技術棧的上下兩層**：

- **buun-llama-cpp** = `ggerganov/llama.cpp` 的研究 fork，純 C++/CUDA 引擎層，新增 TCQ KV cache 量化核（kernel + codebooks + quant types）。
- **node-llama-tcq** = `withcatai/node-llama-cpp` 的私有 fork，整合 buun-llama-cpp 為底層引擎，並在 TS/Node 綁定層暴露 TCQ、補上 mtmd 多模態、speculative decoding、streaming、benchmark 等能力。

> 兩者目前同步點：node-llama-cpp `57bea3da9...`、buun-llama-cpp `aecbbd5d...`（2026-05-03 sync）。

## 在 my-agent 內的實體路徑

| Repo / 角色 | 路徑 | git HEAD | 是否被編譯使用 |
|---|---|---|---|
| node-llama-tcq（TS 綁定 fork，工作副本） | `vendor/node-llama-tcq/` | node-llama-tcq 分支 | ✅ |
| buun-llama-cpp（**vendored 工作副本**，已疊 node-llama-tcq patches） | `vendor/node-llama-tcq/llama/llama.cpp/` | `aecbbd5d`（README-tcq.md 標註 sync 點） | ✅（addon 編譯來源） |
| buun-llama-cpp（**獨立 upstream 對照組，未變更**） | `buun-llama-cpp/`（repo root） | `72d130e` "Merge SD-084v2: defer recurrent state backup cells during prefill" — **比 vendored 版較新** | ❌ 純參考 |
| 上層 patch / 黏合（CMake、addon C++） | `vendor/node-llama-tcq/llama/` | — | ✅ |
| TCQ codebooks（.bin） | `vendor/node-llama-tcq/codebooks/` | — | ✅ |
| TCQ TS 入口 | `vendor/node-llama-tcq/src/tcq/` | — | ✅ |
| Mtmd context | `vendor/node-llama-tcq/src/evaluator/LlamaMtmdContext.ts` | — | ✅ |
| my-agent 端整合 | `src/services/api/llamacpp-embedded-adapter.ts`（lazy `import "node-llama-tcq"`） | — | ✅ |

**`buun-llama-cpp/` vs `vendor/node-llama-tcq/llama/llama.cpp/` 差別**：

- `buun-llama-cpp/` 是**獨立 clone 的 upstream，未變更**，當對照組／reference 用，不被任何 my-agent 程式碼引用。
- `vendor/node-llama-tcq/llama/llama.cpp/` 是**實際編譯用的工作副本**，內容仍是 buun-llama-cpp，但：
  1. sync 點較舊（`aecbbd5d` vs upstream `72d130e`）；
  2. ggml/src 內 30+ 檔被 node-llama-tcq fork 改過（CMakeLists、`ggml-backend.cpp`、`ops.cpp`、新增 `ggml-backend-meta.cpp` 等 build/binding 黏合 patch）。
- 兩個目錄名稱都叫 `llama.cpp`，但 `apply_turbo_cuda_v2.py` / `buunslamma.png` / `codebooks/` 等 buun fork 標記檔在兩邊都有，所以不能用檔名辨識，要看路徑。

---

## 1. 分層職責

| 層級 | 上游基底 | 此 fork | 它在 stack 裡負責什麼 |
|------|---------|---------|----------------------|
| C++ 引擎 / CUDA kernel | `ggerganov/llama.cpp` | **buun-llama-cpp** | 張量運算、量化核、KV cache、speculative 機制、libmtmd 視覺/音訊 |
| Node 原生綁定（TS API） | `withcatai/node-llama-cpp` | **node-llama-tcq** | JS 物件模型、Llama/Context/Sequence、tokenizer、grammar、外部 tool API、預編譯 binary 發佈 |
| 應用層（my-agent，in-process） | — | `src/services/api/llamacpp-embedded-adapter.ts` | lazy `import "node-llama-tcq"`，直接呼叫 `getLlama` / `LlamaChatSession` / `LlamaMtmdContext` / `applyTCQCodebooks` |
| 應用層（my-agent，外部 server） | — | `src/services/api/llamacpp-fetch-adapter.ts` + `llamacppWatchdog.ts` | 連外部 llama.cpp server，走 OpenAI 相容 fetch（**這條與 node-llama-tcq 無關**，是 ADR-005 對 Anthropic 路徑的隔離） |

---

## 2. node-llama-tcq 完整功能清單

來源：`vendor/node-llama-tcq/`（README-tcq.md、CHANGELOG.md、TUNABLES.md、BENCHMARKS-*.md、`src/`、`scripts/`）。

### 2.1 TCQ KV cache 壓縮（fork 主訴求）
- **核心 API**：`applyTCQCodebooks(cfg)`、`TCQPresets`、`isTCQAvailable()`、`assertTCQCompatibleHeadDim()`
  - `src/tcq/codebooks.ts`：14 個 runtime tunable（encode/decode alpha、kernel 開關、inner quant）
  - `src/tcq/presets.ts`：`TURBO4`(4.25 bpv)/`TURBO3_TCQ`(3.25)/`TURBO2_TCQ`(2.25)/`ASYMMETRIC_275`
  - `src/tcq/compatibility.ts`：macOS 直接回 false、head dim 必須 % 128 == 0
- **量化類型擴展**（`src/gguf/types/GgufTensorInfoTypes.ts`）：`TURBO3_0=42`、`TURBO4_0=43`、`TURBO2_0=44`、`TURBO3_TCQ=45`、`TURBO2_TCQ=46`
- **Codebooks**：`codebooks/cb_50iter_finetuned.bin`（3-bit）、`tcq_2bit_100iter_s99.bin`（2-bit）
- **驗證**：65K context VRAM -1.5GB / -58%（`BENCHMARKS-LONGCTX.md`）

### 2.2 Multimodal bindings（libmtmd 包裝）
- `src/evaluator/LlamaMtmdContext.ts`：`loadMmproj` / `tokenize` / `evalChunks` / `generate`
- 三種媒體輸入：`{type: "file"}`（圖/音自動辨識）、`{type: "rgb-buffer"}`、`{type: "audio-pcm"}`
- C++ 綁定：`mtmdTokenize` / `mtmdEvalChunks` / `mtmdGenerateStep` / `mtmdGenerate` / `mtmdBitmapFromFile|Buffer|Audio`
- **Phase F streaming 優化**：detokenize windowing(K=16) 避免 O(n²)、UTF-8 邊界（防 U+FFFD）
- 吞吐：vision 43.0 tok/s、audio 35.9 tok/s（RTX 5070 Ti）

### 2.3 Speculative decoding（Phase G2/G3 進行中）
- `SpeculativeOpts` interface（`src/bindings/AddonTypes.ts`）
- 支援變體：
  - **Model-free**：`ngram_simple` / `ngram_map_k` / `ngram_cache` / `suffix` / `copyspec` / `recycle`
  - **Model-based**：`draft` / `eagle3` / `dflash`（drafter API ready，待整合）
- 可調：`nMax/nMin`、`treeBudget`、`dflashMaxSlots`、`pSplit/pMin`、`copyspecGamma`
- API：`generateWithSpeculative({tokens, nPast, nDrafted, nAccepted})`
- 驗證：`BENCHMARKS-SPECULATIVE.md`、`scripts/smoke-speculative-copyspec.ts`、`scripts/benchmark-speculative*.ts`

### 2.4 Runtime tunables（`TUNABLES.md`）
14 個環境變數：`TURBO_TCQ_ALPHA[_V]`、`TURBO_TCQ_ENCODE_ALPHA`、`TURBO_TCQ_DECODE_ALPHA_K/V`、`TURBO_PREFILL_VEC`、`GGML_TURBO_MMA_FUSED`、`GGML_TURBO_DECODE_NATIVE`、`TURBO_INNERQ[_MODE/_STRENGTH]`、`TURBO_TCQ_DUMP_ERRORS`、`TURBO_Q_CALIBRATE`、`TURBO_TCQ_SHARED_BT`。

### 2.5 Build / 平台
- `llama/CMakeLists.txt` patch：C++17、MSVC `/utf-8`、CUDA/MSVC interop、`common_cpu_get_num_math` rename
- `LLAMA_INSTALL_VERSION` 預設 0.0.0（mtmd CMake 修補）
- Windows 需 LongPaths；CUDA 編譯 25–35 分鐘
- 安裝腳本：`scripts/setup-node-llama-tcq.ps1`

### 2.6 Tests / Benchmarks
- Smoke：`smoke-turbo4.ts`、`smoke-vision-turbo4.ts`、`smoke-audio-turbo4.ts`、`smoke-addon-load.ts`、`smoke-speculative-copyspec.ts`
- Benchmarks：`BENCHMARKS.md`（F16/Q8_0/TURBO4 文字）、`BENCHMARKS-LONGCTX.md`（4K~65K）、`BENCHMARKS-VISION.md`（1/2/4 圖）、`BENCHMARKS-SPECULATIVE.md`
- 約 36 unit tests（codebook/compat）

### 2.7 繼承自 node-llama-cpp 上游
- chat completion / completion / embedding / reranking
- JSON schema 約束、GBNF grammar
- Function calling
- Auto hardware detection
- 預編譯 binary 矩陣：`@node-llama-cpp/{win-x64,win-x64-cuda,win-x64-cuda-ext,win-x64-vulkan,win-arm64,linux-x64,linux-x64-cuda,linux-x64-cuda-ext,linux-x64-vulkan,linux-arm64,linux-armv7l,mac-arm64-metal,mac-x64}`

---

## 3. buun-llama-cpp 提供的功能（node-llama-tcq 的下層）

來源：`spiritbuun/buun-llama-cpp`（GitHub 公開），實體位於 `vendor/node-llama-tcq/llama/llama.cpp/`。

- **TCQ kernel + codebooks**：fork 主要創作物，在 ggml CUDA 算子內把 KV cache 改用 trellis-coded quantization（O(1) decode、品質達/超 FP16）。
- **新增 ggml type**：`TURBO3_0/TURBO4_0/TURBO2_0/TURBO3_TCQ/TURBO2_TCQ` 等量化類型（被 node-llama-tcq 在 TS 端對映）。
- **CMake / build 改動**：使 fork 與 node-llama-cpp 的 in-tree CMake 共處（`common_cpu_get_num_math` 等命名）。
- **保留全部 llama.cpp 上游能力**：CLI 工具（llama-bench / quantize / mtmd / server / perplexity / imatrix / cli）、`tools/mtmd`（vision+audio）、所有 GPU backend（CUDA/Metal/Vulkan/SYCL/MUSA）、所有上游 sampler / speculative example。
- **不提供**：JS/TS 綁定、JS 應用層 API、預編譯 npm 套件 → 那是 node-llama-tcq 的責任。

---

## 4. 兩者並排比較

| 維度 | buun-llama-cpp（C++ 引擎） | node-llama-tcq（TS 綁定） |
|------|---------------------------|--------------------------|
| 語言 / 介面 | C++17 + CUDA / CMake / CLI | TypeScript + node-addon-api / npm |
| TCQ kernel | ✅ 實作於 ggml CUDA | ❌ 不實作；透過 `applyTCQCodebooks` 把 codebook 路徑 + 14 個旗標傳進 C++ 層 |
| TCQ presets | 只有 raw 量化 type 編號（42–46） | ✅ `TURBO4` / `TURBO3_TCQ` / `TURBO2_TCQ` / `ASYMMETRIC_275` 高階組合 |
| 多模態 | ✅ libmtmd（C++ + CLI） | ✅ `LlamaMtmdContext` + streaming K=16 windowing + UTF-8 邊界 |
| Speculative | ✅ 上游 + buun 新核 | ✅ `SpeculativeOpts`：6 model-free + 3 model-based 全暴露給 JS |
| Chat / completion / embedding / grammar / function call | CLI 工具層級 | ✅ TS 高階 API（`LlamaChatSession` 等） |
| GPU backend | CUDA / Metal / Vulkan / SYCL / MUSA / CPU | 預編譯涵蓋 win-x64-{cuda,cuda-ext,vulkan}、linux 同左、mac-arm64-metal |
| TCQ 平台支援 | macOS Metal kernel **缺**、CUDA OK | 對應地 `isTCQAvailable()` macOS 回 false |
| Tunable 表面 | 環境變數（kernel 啟動讀取） | 同 14 個變數，但可透過 `applyTCQCodebooks(cfg)` JS 設定 |
| Benchmarks | llama-bench CLI | `BENCHMARKS-*.md` + `scripts/benchmark-*.ts`（vision / longctx / speculative） |
| 套件發佈 | 不發 npm | npm 預編譯矩陣（13 個平台 sub-package） |
| 與 my-agent 整合點 | 不直接接，必經 node-llama-tcq | `src/services/api/llamacpp-embedded-adapter.ts` 走 **in-process binding**（lazy `import "node-llama-tcq"`，使用 `getLlama` / `LlamaChatSession` / `LlamaMtmdContext` / `applyTCQCodebooks` / `isTCQAvailable` / `GgmlType`）；`embeddedRouting.ts` 透過 env 切換到此路徑。**不是**走 fetch adapter — fetch adapter（`llamacpp-fetch-adapter` / `llamacpp-watchdog`）是另一條獨立路徑，連外部 llama.cpp server，與 node-llama-tcq 無關。 |
| 開發位置 | upstream `spiritbuun/buun-llama-cpp` | `vendor/node-llama-tcq/`（node-llama-tcq 分支，main 不接） |

---

## 5. 一句話總結

> **buun-llama-cpp 把 TCQ 寫進 ggml CUDA 核**；**node-llama-tcq 把 TCQ + mtmd + speculative 包成可從 TypeScript 用的綁定**，並在 streaming / preset / benchmark 層補完 buun-llama-cpp 沒提供的 JS 應用面。沒有 buun-llama-cpp 就沒有 TCQ kernel；沒有 node-llama-tcq 就沒有 JS 端的 TCQ/mtmd/speculative 統一 API。

---

## 6. 後續可延伸（不在本次比較範圍）

- Phase G3 model-based drafter（`draft`/`eagle3`/`dflash`）的整合驗證 — TODO.md 已列。
- macOS Metal TCQ kernel 移植（目前 `isTCQAvailable()` 直接 false）。
- 兩條 adapter 路徑（embedded vs fetch）的職責切分是否要在 ADR 補一條（embeddedRouting.ts 已有 env 切換但未文件化）。
- `applyTCQCodebooks` preset 在 embedded 路徑的暴露面（目前 adapter 已 import，但對外 config 是否要加開關）。
