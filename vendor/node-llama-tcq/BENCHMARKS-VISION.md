# Vision benchmark — Qwen3.5-9B-Q4_K_M + mmproj F16

Model: Qwen3.5-9B-Q4_K_M.gguf
mmproj: mmproj-Qwen3.5-9B-F16.gguf
Hardware: NVIDIA GeForce RTX 5070 Ti Laptop GPU
ctx=16384, image: test-1.jpeg (newspaper, 20×15=300 image tokens each)

## VRAM total (MB)

| Variant | 1 img | 2 imgs | 4 imgs |
|---------|-------|--------|--------|
| F16 | 7026 | 7028 | 7028 |
| TURBO4 | 6656 | 6656 | 6656 |

## Detail

| Variant | imgs | totalTokens | eval ms | gen ms | tok/s | VRAM MB | reply preview |
|---------|------|-------------|---------|--------|-------|---------|---------------|
| F16 | 1 | 316 | 566 | 1064 | 30.1 | 7026 | ` The main subject is the historic moment of the first moon landing, depicted through the newspaper h` |
| F16 | 2 | 619 | 754 | 964 | 32.2 | 7028 | ` The main subject is the historic moment of the first moon landing, as depicted in both the newspape` |
| F16 | 4 | 1225 | 1579 | 1363 | 27.1 | 7028 | ` The main subject is the front page of The New York Times from July 21, 1969, featuring the historic` |
| TURBO4 | 1 | 316 | 617 | 1125 | 28.4 | 6656 | ` The main subject is the historic moment of the first moon landing, depicted through the newspaper h` |
| TURBO4 | 2 | 619 | 775 | 1161 | 26.7 | 6656 | ` The main subject is the historic moment of the first moon landing, as depicted in both the newspape` |
| TURBO4 | 4 | 1225 | 1777 | 1336 | 29.9 | 6656 | ` The main subject is a vintage newspaper from July 21, 1969, featuring the historic Apollo 11 moon l` |