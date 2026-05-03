# Long-context benchmark — Qwen3.5-9B-Q4_K_M.gguf

Model: Qwen3.5-9B-Q4_K_M.gguf
Hardware: NVIDIA GeForce RTX 5070 Ti Laptop GPU
Runtime: node-llama-tcq + buun-llama-cpp (CUDA, flash_attn, ignoreMemorySafetyChecks=true)

Each (variant, ctxSize) cell runs in a fresh child process.

## VRAM (MB) by context size

| Variant | ctx=4096 | ctx=16384 | ctx=32768 | ctx=65536 |
|---------|-----|-----|-----|-----|
| F16 | 5708 (kv=682) | 6084 (kv=1058) | 6604 (kv=1578) | 7620 (kv=2594) |
| TURBO4 | 5610 (kv=580) | 5710 (kv=680) | 5850 (kv=820) | 6106 (kv=1076) |

## Detailed table

| Variant | ctx | VRAM model | VRAM KV | VRAM total | createCtx (ms) | prompt (ms) | reply.len |
|---------|-----|-----------|---------|-----------|----------------|-------------|-----------|
| F16 | 4096 | 5000 | 682 | 5708 | 15 | 2544 | 0 |
| F16 | 16384 | 5000 | 1058 | 6084 | 23 | 2492 | 0 |
| F16 | 32768 | 5000 | 1578 | 6604 | 35 | 2488 | 0 |
| F16 | 65536 | 5000 | 2594 | 7620 | 55 | 2514 | 0 |
| TURBO4 | 4096 | 5000 | 580 | 5610 | 18 | 2212 | 0 |
| TURBO4 | 16384 | 5000 | 680 | 5710 | 24 | 2340 | 0 |
| TURBO4 | 32768 | 5000 | 820 | 5850 | 26 | 2317 | 0 |
| TURBO4 | 65536 | 5000 | 1076 | 6106 | 32 | 2320 | 0 |