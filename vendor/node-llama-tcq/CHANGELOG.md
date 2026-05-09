# node-llama-tcq Changelog

> 內部使用 fork，無 semver；以 my-agent 分支 commit 為準。

## 0.1.0-tcq.0 — 2026-05-03

### Milestone 1：純文字 TCQ
- vendor node-llama-cpp@57bea3d + buun-llama-cpp@aecbbd5
- `GgmlType` enum 擴 `TURBO3_0=42 / TURBO4_0=43 / TURBO2_0=44 / TURBO3_TCQ=45 / TURBO2_TCQ=46`
- `src/tcq/`：`applyTCQCodebooks` / `TCQPresets` / `assertTCQCompatibleHeadDim` / `isTCQAvailable`
- 36 unit tests
- benchmark：TURBO4 在 65K ctx 省 1.5GB vs F16

### Milestone 2：libmtmd vision + audio binding
- `AddonMtmd*` 封裝 mtmd_context / bitmap / chunks 三個 opaque type
- `mtmdTokenize` / `mtmdEvalChunks` / `mtmdGenerate` / `mtmdGenerateStep`
- TS `LlamaMtmdContext.loadMmproj/.tokenize/.evalChunks/.generate`
- `mtmdBitmapFromFile` 自動偵測 image (stb_image) / audio (miniaudio)
- `mtmdBitmapFromAudio` 接 PCM Float32 mono
- `mtmdBitmapFromBuffer` 接 RGB raw

### Phase F：token-by-token streaming
- `LlamaChatSession.prompt({onTextChunk})` 透傳 SSE
- `LlamaMtmdContext.generate({onTextChunk})` 用 `mtmdGenerateStep` 單步驅動
- F-perf：detokenize 視窗化（K=16 + prefix 滾動 + fallback）
  - vision 32.9 → **43.0 tok/s** (+30%)
  - audio 32.9 → **35.9 tok/s** (+9%)
- UTF-8 邊界處理：BPE byte fragment 不拆字、不出 U+FFFD

### Phase G1+G4：runtime tunables
- `TCQCodebookConfig` 加 14 個 env 旋鈕：
  - encode alpha：`alpha` / `alphaV` / `encodeAlpha`
  - decode alpha：`decodeAlphaK` / `decodeAlphaV`
  - kernel：`prefillVec` / `mmaFused` / `decodeNative` / `sharedBacktrace`
  - inner quant：`innerq` / `innerqMode` / `innerqStrength`
  - debug：`dumpErrors` / `qCalibrate`
- `TUNABLES.md` 全 env 對照表

### Phase H：audio 路徑
- `mtmd_get_audio_sample_rate()` → `MtmdContext.audioSampleRate`
- `MtmdMediaInput` 統一型別（`{file} | {rgb-buffer} | {audio-pcm}`）
- Gemopus mmproj 確認雙模態（vision + audio 同 mmproj）

### my-agent embedded adapter
- `src/services/api/llamacpp-embedded-adapter.ts` 平行於 fetch adapter
- routing：`MY_AGENT_LLAMACPP_EMBEDDED=1` 或 modelConfig.useEmbedded
- vision 路徑：`image_url` (data: / file:// / abs path)
- audio 路徑：`input_audio` (base64) / `audio_url` (URL)
- streaming：onTextChunk 即時推 SSE chunk
- 14 routing tests，不啟動 my-agent runtime、不載 .node

### Build & infra
- `/utf-8` MSVC flag（C/CXX only，CUDA 走 `-Xcompiler`）解 codepage 950 BIG5 切壞
- `LLAMA_INSTALL_VERSION` 預設 `0.0.0`（mtmd CMakeLists 要）
- `cpu_get_num_math` → `common_cpu_get_num_math`（buun API drift 修正）
- common → llama-common link target 改名
- `scripts/setup-node-llama-tcq.ps1`：重建 junction symlink

### Benchmarks
- `BENCHMARKS.md`：純文字 ctx=4K F16 vs Q8_0 vs TURBO4
- `BENCHMARKS-LONGCTX.md`：4K/16K/32K/65K KV 壓縮對比
- `BENCHMARKS-VISION.md`：1/2/4 圖 × F16 vs TURBO4

## 計畫中（未交付）

- **Phase G2 + G3**：speculative decoding（CopySpec / DDTree / DFlash）
  - 需要 `common_speculative_state` 主控迴圈
  - DFlash 需取得 drafter model 檔
  - 預估 3-5 天
