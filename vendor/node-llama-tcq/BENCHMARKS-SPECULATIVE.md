# Speculative decoding benchmark

Model: Qwen3.5-9B-Q4_K_M.gguf
Hardware: NVIDIA GeForce RTX 5070 Ti Laptop GPU
KV cache: TURBO4 (43)
Prompt: 5-shot rewrite pattern, prompt tokens ≈ 231
Gen tokens: 100, nMax draft: 16, copyspec γ: 6
Each variant runs in a fresh child process for clean KV state.

| Variant | tok/s | vs baseline | drafted | accepted | acceptance | gen ms |
|---------|-------|-------------|---------|----------|------------|--------|
| baseline | 27.4 | 1.00x | 0 | 0 | — | 3643 |
| copyspec(γ=6) | 27.5 | 1.00x | 0 | 0 | — | 3633 |
| ngram_simple | 26.2 | 0.96x | 0 | 0 | — | 3813 |
| suffix | 24.2 | 0.88x | 133 | 27 | 20.3% | 4134 |
| recycle | 75.5 | 2.75x | 336 | 80 | 23.8% | 1325 |

## Reply previews

### baseline

```
 The horse canter in the field. The horse nibbles on the grass. The horse reclines under the tree.\n
```

### copyspec(γ=6)

```
 The horse canter in the field. The horse nibbles on the grass. The horse reclines under the tree.\n
```

### ngram_simple

```
 The horse canter in the field. The horse nibbles on the grass. The horse reclines under the tree.\n
```

### suffix

```
 The horse canter in the field. The horse nibble the grass. The horse rests under the tree.\n\nINPUT
```

### recycle

```
 The horse canter in the field. The horse grazes on the grass. The horse horse horse horse horse hor
```

## 品質觀察

speculative 的「速度增益」必須與「輸出品質」一起評估。對單純結構重複的
rewrite 任務（這個 prompt 場景），實際表現是：

- **baseline / copyspec / ngram_simple** 三者輸出**字字相同**，正確完成 rewrite
- **suffix** 取得 20% draft acceptance 但 wall-time 略慢（verify 開銷 > savings）；
  reply 出現「nibble」非「nibbles」這類細微 BPE 邊界差異
- **recycle** 顯示 3x speedup 與 24% accept，但**輸出退化**（如「horse horse horse」迴圈），
  原因可能是 token recycling 在 greedy temp=0 + 固定結構 prompt 下
  累積偏置，於下文重複高機率 token

## 實用建議

- 純文字長 prompt + 大量重複內容（程式碼、log 摘要、純 ASR 重述）→ 嘗試 **suffix**，
  搭配適當 `suffixMinProb` 與 `suffixSpecFactor`
- 對話式 + 創意生成 → speculative 收益小於 verify 開銷，建議 baseline
- **不要在 production 直接啟用 recycle** 除非通過品質回歸測試
- DRAFT / EAGLE3 / DFLASH (G3 已就緒 API) 才是「不犧牲品質」的加速路徑，需要相容 drafter model