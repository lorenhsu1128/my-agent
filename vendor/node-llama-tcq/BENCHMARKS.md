# Benchmark — Qwen3.5-9B-Q4_K_M.gguf

Model: Qwen3.5-9B-Q4_K_M.gguf, contextSize=4096
Hardware: NVIDIA GeForce RTX 5070 Ti Laptop GPU
Runtime: node-llama-tcq + buun-llama-cpp (CUDA)

Each variant runs in a fresh child process for clean VRAM measurement.

| Variant | KV Type | VRAM (MB) | createCtx (ms) | prompt (ms) | reply len |
|---------|---------|-----------|----------------|-------------|-----------|
| F16 (baseline) | F16 (1) | 5682 | 19 | 8642 | 10 |
| Q8_0 | Q8_0 (8) | 5614 | 22 | 8788 | 10 |
| TURBO4_0 | TURBO4_0 (43) | 5580 | 19 | 8453 | 10 |

## Reply previews

### F16 (baseline)

```
  2 plus 2
```

### Q8_0

```
  2 plus 2
```

### TURBO4_0

```
  2 plus 2
```
