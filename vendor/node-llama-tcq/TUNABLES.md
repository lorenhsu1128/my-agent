# buun-llama-cpp Runtime Tunables (TCQ + DFlash)

This is a `node-llama-cpp` fork (`node-llama-tcq`) integrating the
`spiritbuun/buun-llama-cpp` C++ tree, which adds:

- **TurboQuant (TCQ)**: KV cache compression with custom GGML types
  (TURBO3_0=42, TURBO4_0=43, TURBO2_0=44, TURBO3_TCQ=45, TURBO2_TCQ=46)
- **DFlash**: cross-attention drafter for speculative decoding
- **DDTree** / **CopySpec**: alternative speculative strategies

Most behavior is gated by environment variables read once during kernel
init. The `applyTCQCodebooks(cfg)` helper in `src/tcq/codebooks.ts`
sets the most common ones from a typed config object.

## TCQ codebook & cache (already exposed via `TCQCodebookConfig`)

| Env var | TS field | Effect |
|---------|----------|--------|
| `TURBO_TCQ_CB` | `threeBit` | 3-bit codebook .bin path |
| `TURBO_TCQ_CB2` | `twoBit` | 2-bit codebook .bin path |
| `TURBO_LAYER_ADAPTIVE` | `layerAdaptive` | Per-layer adaptive precision |

## TCQ encode / decode alpha

| Env var | TS field | Effect |
|---------|----------|--------|
| `TURBO_TCQ_ALPHA` | `alpha` | Encode K-axis quantization alpha |
| `TURBO_TCQ_ALPHA_V` | `alphaV` | Encode V-axis (defaults to `alpha`) |
| `TURBO_TCQ_ENCODE_ALPHA` | `encodeAlpha` | Encode mode: `"context"` (context-adaptive) or numeric |
| `TURBO_TCQ_DECODE_ALPHA_K` | `decodeAlphaK` | Decode K-axis alpha override |
| `TURBO_TCQ_DECODE_ALPHA_V` | `decodeAlphaV` | Decode V-axis alpha override |

## TCQ kernel switches

| Env var | TS field | Effect |
|---------|----------|--------|
| `TURBO_PREFILL_VEC` | `prefillVec` | Use vector kernel during prefill |
| `GGML_TURBO_MMA_FUSED` | `mmaFused` | Fused MMA kernel (Turing+) |
| `GGML_TURBO_DECODE_NATIVE` | `decodeNative` | Skip dequant during decode |
| `TURBO_TCQ_SHARED_BT` | `sharedBacktrace` | Shared-memory trellis backtrace (default on) |

## Inner quantization

| Env var | TS field | Effect |
|---------|----------|--------|
| `TURBO_INNERQ` | `innerq` | Master switch for inner quant |
| `TURBO_INNERQ_MODE` | `innerqMode` | Mode: `"static"` / `"dynamic"` |
| `TURBO_INNERQ_STRENGTH` | `innerqStrength` | Strength 0.0–1.0 |

## Debug

| Env var | TS field | Effect |
|---------|----------|--------|
| `TURBO_TCQ_DUMP_ERRORS` | `dumpErrors` | Dump per-block quantization error |
| `TURBO_Q_CALIBRATE` | `qCalibrate` | Calibration mode |

## DFlash (speculative decoding) — not yet wrapped in TS

These are read by buun directly; setting them via `process.env` before
`getLlama()` will affect behavior, but TS-side wrappers are pending
(Phase G3).

| Env var | Effect |
|---------|--------|
| `GGML_DFLASH_GPU_RING` | GPU ring buffer for cross-attention drafter |
| `GGML_DFLASH_MAX_CTX` | Hard cap on drafter context window |
| `GGML_NO_TREE_VERIFY` | Disable tree verify on multi-GPU |

CLI flags exposed by `llama-server`/`llama-cli` (not relevant here since
we use in-process binding) for reference:

- `--draft-model <path>` — drafter GGUF
- `--draft-max <n>` — speculative window
- `--tree-budget <n>` — DDTree budget (0 = flat)
- `--dflash-max-slots <n>` — DFlash slot count
- `--spec-type {dflash|copyspec|external|off}` — speculative type

## Usage example (TS)

```ts
import {applyTCQCodebooks, TCQPresets, getLlama, GgmlType} from "node-llama-tcq";

// Set env BEFORE loading llama (kernels getenv at init)
applyTCQCodebooks({
    layerAdaptive: true,
    encodeAlpha: "context",
    mmaFused: true,
    decodeNative: false
});

const llama = await getLlama({gpu: "cuda"});
const model = await llama.loadModel({modelPath: "..."});
const ctx = await model.createContext({
    contextSize: 8192,
    flashAttention: true,
    experimentalKvCacheKeyType: GgmlType.TURBO4_0,
    experimentalKvCacheValueType: GgmlType.TURBO4_0
});
```
