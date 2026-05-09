# node-llama-tcq — fork 概況

`node-llama-cpp` 的私有 fork，整合 `spiritbuun/buun-llama-cpp` 的 **TCQ
（Trellis-Coded Quantization）KV cache 壓縮** + **libmtmd 多模態
（vision / audio）binding**。

> 上游 README 仍適用 — 本檔只描述 fork 新增的部分。

## 為什麼有這個 fork

| 需求 | 上游 node-llama-cpp | 本 fork |
|------|---------------------|---------|
| TCQ KV cache 壓縮（GGML_TYPE_TURBO*） | ❌ 無 GGML type | ✅ 完整 |
| libmtmd vision binding | ❌ Discussion #537 待包 | ✅ |
| libmtmd audio binding | ❌ 同上 | ✅ |
| Token-by-token streaming（vision/audio） | n/a | ✅ |
| TURBO_TCQ_* runtime env 旋鈕 | n/a | ✅ |
| DFlash / DDTree / CopySpec speculative | ❌ | ⏸ 規劃中 |

## 平台

| OS / GPU | 狀態 |
|----------|------|
| Windows 11 + CUDA 12.x | ✅ 主力（已驗證） |
| Linux + CUDA | 應可（CMakeLists 通用，未實測） |
| Linux + ROCm | 應可（buun 支援，未驗證） |
| macOS Metal | ❌ buun TCQ kernel 未實作 Metal |

## 安裝（vendored）

本 fork 不發 npm。在 my-agent 內：
- `vendor/node-llama-tcq/` 為 vendored source
- `node_modules/node-llama-tcq` junction → `vendor/node-llama-tcq`（用
  `scripts/setup-node-llama-tcq.ps1` 重建）

## 編譯

```powershell
cd vendor/node-llama-tcq
$env:NODE_LLAMA_CPP_CMAKE_OPTION_GGML_CUDA = "ON"
node ./dist/cli/cli.js source build --gpu cuda --noUsageExample
```

產出 `llama/localBuilds/win-x64-cuda-release-spiritbuun_buun-llama-cpp_aecbbd5/Release/llama-addon.node`（~622KB，含 mtmd vision/audio）。

完整編譯需要 25–35 分鐘（CUDA flash_attn template 模板量大）。
LongPaths 必須啟用（registry `HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem\LongPathsEnabled = 1` + `git config --system core.longpaths true`）。

## 用法

### TCQ KV cache（純文字）

```ts
import {getLlama, GgmlType, applyTCQCodebooks, TCQPresets} from "node-llama-tcq";

// 預設啟用 codebook（也接受自訂路徑與 14 個 runtime 旋鈕，見 TUNABLES.md）
applyTCQCodebooks();

const llama = await getLlama({gpu: "cuda"});
const model = await llama.loadModel({modelPath: "./models/Qwen3.5-9B-Q4_K_M.gguf"});
const ctx = await model.createContext({
    contextSize: 32768,
    flashAttention: true,
    ignoreMemorySafetyChecks: true,  // VRAM heuristic 不知 TCQ 壓縮，要旁路
    experimentalKvCacheKeyType: GgmlType.TURBO4_0,  // 或 TURBO3_TCQ / TURBO2_TCQ
    experimentalKvCacheValueType: GgmlType.TURBO4_0
});

const session = new LlamaChatSession({contextSequence: ctx.getSequence()});
const reply = await session.prompt("...", {
    maxTokens: 256,
    onTextChunk: (delta) => process.stdout.write(delta)  // streaming
});
```

### Vision（mtmd）

```ts
import {LlamaMtmdContext} from "node-llama-tcq";

const mtmdCtx = await LlamaMtmdContext.loadMmproj(model, {
    mmprojPath: "./models/mmproj-Qwen3.5-9B-F16.gguf",
    useGpu: true
});
console.log("vision=" + mtmdCtx.supportsVision +
    " audio=" + mtmdCtx.supportsAudio);

const chunks = await mtmdCtx.tokenize({
    text: `${mtmdCtx.defaultMarker}\nDescribe this image.`,
    media: [{type: "file", data: "./test.jpg"}]
});
const seq = ctx.getSequence();
const newNPast = await mtmdCtx.evalChunks(ctx, chunks, 0, {seqId: seq.sequenceId});

const sampler = new (model as any)._llama._bindings.AddonSampler((model as any)._model);
sampler.applyConfig({temperature: 0, topK: 40, topP: 0.95, minP: 0.05});

const result = await mtmdCtx.generate(ctx, sampler, newNPast, 200, {
    seqId: seq.sequenceId,
    onTextChunk: (delta) => process.stdout.write(delta)
});
console.log(result.text);
```

### Audio（mtmd）

完全一樣，把 mmproj 換成 audio-capable 的（如 Gemopus / Qwen3-Audio
/ Whisper）即可。`mtmd_helper_bitmap_init_from_file` 自動偵測 mp3/wav。

```ts
const chunks = await mtmdCtx.tokenize({
    text: `${mtmdCtx.defaultMarker}\nWhat is in this audio?`,
    media: [{type: "file", data: "./speech.mp3"}]
});
// 後續同 vision
```

也支援 PCM Float32 mono 直接傳：
```ts
media: [{type: "audio-pcm", data: pcmFloat32, sampleRate: 16000}]
```

## Smoke 測試（獨立於 my-agent）

```powershell
cd vendor/node-llama-tcq
# 純文字
$env:TEST_MODEL_TEXT='..\..\models\Qwen3.5-9B-Q4_K_M.gguf'
node_modules/.bin/vite-node scripts/smoke-turbo4.ts

# vision streaming
$env:TEST_MMPROJ='..\..\models\mmproj-Qwen3.5-9B-F16.gguf'
node_modules/.bin/vite-node scripts/smoke-vision-turbo4.ts

# audio streaming
$env:TEST_MODEL_TEXT='..\..\models\Gemopus-4-E4B-it-Preview-Q5_K_M.gguf'
$env:TEST_MMPROJ='..\..\models\mmproj-Gemopus-4-E4B-it.gguf'
node_modules/.bin/vite-node scripts/smoke-audio-turbo4.ts
```

## Benchmark（已驗證）

詳見 `BENCHMARKS.md` / `BENCHMARKS-LONGCTX.md` / `BENCHMARKS-VISION.md`。

| 場景 | F16 baseline | TURBO4 | 省 |
|------|--------------|--------|-----|
| Qwen3.5-9B ctx=4K | 5682 MB | 5580 MB | -102 MB |
| Qwen3.5-9B ctx=16K | 6084 MB | 5710 MB | **-374 MB (-36%)** |
| Qwen3.5-9B ctx=32K | 6604 MB | 5850 MB | **-754 MB (-48%)** |
| Qwen3.5-9B ctx=65K | 7620 MB | 6106 MB | **-1514 MB (-58%)** |
| Vision 1-4 imgs ctx=16K | ~7028 MB | ~6656 MB | -370 MB |

Streaming throughput（TURBO4 + CUDA, RTX 5070 Ti Laptop）：
| modality | tok/s |
|----------|-------|
| vision (Qwen3.5-9B) | 43.0 |
| audio (Gemopus 4) | 35.9 |

## API 重點

- `GgmlType.TURBO3_0=42 / TURBO4_0=43 / TURBO2_0=44 / TURBO3_TCQ=45 / TURBO2_TCQ=46`
- `applyTCQCodebooks(cfg)` — set TURBO_* env vars (見 TUNABLES.md)
- `TCQPresets.{TURBO4, TURBO3_TCQ, TURBO2_TCQ, ASYMMETRIC_275}`
- `assertTCQCompatibleHeadDim(headDim)` — TCQ 要求 head_dim % 128 === 0
- `isTCQAvailable()` — 平台支援檢查（macOS 一律 false）
- `LlamaMtmdContext.loadMmproj(model, {mmprojPath, useGpu, nThreads})`
- `LlamaMtmdContext.{supportsVision, supportsAudio, audioSampleRate, defaultMarker}`
- `LlamaMtmdContext.tokenize({text, media})` — media 接受 `{file}` `{rgb-buffer}` `{audio-pcm}`
- `LlamaMtmdContext.evalChunks(ctx, chunks, nPast, {seqId})` — vision encoder + decode
- `LlamaMtmdContext.generate(ctx, sampler, nPast, max, {seqId, onTextChunk})` — token-by-token streaming

## 上游同步

`UPSTREAM.txt`：

```
node-llama-cpp: 57bea3da9ffa78955e8b25f195ce6cc714980cb5
buun-llama-cpp: aecbbd5daa47abd4229fb2c0906e8f102d814022
```

## License

繼承上游 — node-llama-cpp MIT、llama.cpp MIT、buun-llama-cpp MIT。
