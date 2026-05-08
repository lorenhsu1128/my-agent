# Sampling Preset 對照（live-test-realistic-v3-myagent）

Model: qwen3.5-9b (Q4_K_M)  Shim: TCQ :8081 (256k turbo4 reasoning=on)

執行: 2026-05-07T04:22:53.951Z

## Preset 參數

| Preset | temp | top_p | top_k | min_p | presence_penalty | repetition_penalty |
|--------|------|-------|-------|-------|------------------|--------------------|
| thinking-general | 1 | 0.95 | 20 | 0 | 1.5 | 1 |
| thinking-coding | 0.6 | 0.95 | 20 | 0 | 0 | 1 |
| instruct-general | 0.7 | 0.8 | 20 | 0 | 1.5 | 1 |
| instruct-reasoning | 1 | 0.95 | 20 | 0 | 1.5 | 1 |

## 總覽

| Preset | Pass | Total Time | Total in | Total out | Total think (ch) | Avg ttft |
|--------|------|-----------|----------|-----------|------------------|----------|
| thinking-general | 12/12 | 425.2s | 543164 | 4526 | 3175 | 11110ms |
| thinking-coding | 11/12 | 295.9s | 515983 | 3416 | 2342 | 11213ms |
| instruct-general | 11/12 | 330.2s | 501880 | 6765 | 2392 | 10886ms |
| instruct-reasoning | 8/12 | 261.9s | 431927 | 2966 | 2705 | 11232ms |

## 逐 Case PASS/FAIL

| Case | thinking-general | thinking-coding | instruct-general | instruct-reasoning |
|------|------------------|-----------------|------------------|--------------------|
| D1.1 | ✅ 17.3s | ✅ 15.4s | ✅ 15.8s | ✅ 14.8s |
| D2.1 | ✅ 32.4s | ✅ 30.4s | ✅ 31.0s | ❌ 20.0s |
| D3.1 | ✅ 20.9s | ✅ 19.7s | ✅ 19.7s | ✅ 22.3s |
| D4.1 | ✅ 17.2s | ✅ 46.3s | ✅ 82.8s | ✅ 17.6s |
| D5.1 | ✅ 31.6s | ✅ 28.8s | ✅ 27.4s | ❌ 23.2s |
| D6.1 | ✅ 27.5s | ✅ 23.1s | ❌ 25.8s | ❌ 23.7s |
| D7.1 | ✅ 27.1s | ✅ 25.7s | ✅ 25.6s | ✅ 25.3s |
| D8.1 | ✅ 154.8s | ❌ 13.1s | ✅ 19.3s | ❌ 16.6s |
| D9.1 | ✅ 15.5s | ✅ 13.9s | ✅ 15.5s | ✅ 17.7s |
| D10.1 | ✅ 25.5s | ✅ 24.9s | ✅ 27.5s | ✅ 25.8s |
| D11.1 | ✅ 18.9s | ✅ 19.4s | ✅ 19.6s | ✅ 19.1s |
| D12.1 | ✅ 36.4s | ✅ 35.3s | ✅ 20.2s | ✅ 36.0s |

## Thinking Chars / case

| Case | thinking-general | thinking-coding | instruct-general | instruct-reasoning |
|------|------------------|-----------------|------------------|--------------------|
| D1.1 | 213ch | 189ch | 194ch | 153ch |
| D2.1 | 536ch | 596ch | 200ch | 101ch |
| D3.1 | 86ch | 250ch | 237ch | 553ch |
| D4.1 | 95ch | 351ch | 316ch | 241ch |
| D5.1 | 309ch | 206ch | 174ch | 181ch |
| D6.1 | 458ch | 156ch | 517ch | 202ch |
| D7.1 | 218ch | 81ch | 78ch | 61ch |
| D8.1 | 445ch | 56ch | 86ch | 251ch |
| D9.1 | 383ch | 86ch | 180ch | 625ch |
| D10.1 | 131ch | 142ch | 185ch | 135ch |
| D11.1 | 113ch | 133ch | 112ch | 87ch |
| D12.1 | 188ch | 96ch | 113ch | 115ch |

## Tool Calls / case

| Case | thinking-general | thinking-coding | instruct-general | instruct-reasoning |
|------|------------------|-----------------|------------------|--------------------|
| D1.1 | (none) | (none) | (none) | (none) |
| D2.1 | (none) | (none) | (none) | (none) |
| D3.1 | Read | Read | Read | Read |
| D4.1 | Grep | Grep,Grep,Bash,Grep | Grep,Grep,Read | Grep |
| D5.1 | Glob,Read | Glob,Read | Glob,Read | Glob,Glob |
| D6.1 | Read | Read | Read | Read |
| D7.1 | Bash | Bash | Bash | Bash |
| D8.1 | Skill,Skill,Skill,Agent,Skill | (none) | WebCrawl | (none) |
| D9.1 | (none) | (none) | (none) | (none) |
| D10.1 | Bash | Bash | Bash | Bash |
| D11.1 | Read | Read | Read | Read |
| D12.1 | Read,Bash | Read,Bash | Read | Read,Bash |

## Fail Notes


### thinking-coding
- **D8.1** D8.1 訂機票  note=``

### instruct-general
- **D6.1** D6.1 分析 QwenChatWrapper thoughts 處理  note=``

### instruct-reasoning
- **D2.1** D2.1 100 以內 4 質因數的數  note=``
- **D5.1** D5.1 找 src/llamacppConfig 並讀 schema.ts 摘要  note=``
- **D6.1** D6.1 分析 QwenChatWrapper thoughts 處理  note=``
- **D8.1** D8.1 訂機票  note=``
