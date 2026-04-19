# llama.cpp b8457 + Qwen3.5-9B-Neo Q5_K_M 部署計畫

## Context

在 my-agent 專案根目錄部署本地推理環境，作為未來多 provider 支援（CLAUDE.md ADR-001 規劃以 LiteLLM 作 proxy）的後端 LLM。目標是「開啟專案→跑一次 setup→即可啟動本地 OpenAI 相容 API」，所有檔案都收納在專案目錄內，不污染系統。

**環境假設**：
- Windows 11 + Git Bash
- RTX 5070 12GB VRAM（**Blackwell sm_120，必須使用 CUDA 12.8+ 的 llama.cpp 構建**）
- 因此選用 `llama-b8457-bin-win-cuda-13.1-x64.zip` + `cudart-llama-bin-win-cuda-13.1-x64.zip`；CUDA 12.4 版在 5070 上不保證可用

## 目錄結構（新增）

```
my-agent/
├── llama/                              ← gitignore；b8457 CUDA 13.1 執行檔 + cudart DLL
│   ├── llama-server.exe
│   ├── llama-cli.exe
│   ├── ggml-cuda.dll, cudart64_13.dll, ...
│   └── .installed                      ← 完成標記（setup 據此判斷 idempotent）
├── models/                             ← gitignore；GGUF 權重
│   └── Jackrong_Qwen3.5-9B-Neo-Q5_K_M.gguf   (6.85 GB)
└── scripts/
    └── llama/
        ├── setup.sh                    ← 一次性：下載解壓 llama.cpp + cudart + GGUF
        ├── serve.sh                    ← 啟動 llama-server（OpenAI API @ :8080）
        ├── verify.sh                   ← 煙測：/v1/models + 一次 chat completion
        ├── README.md                   ← 部署說明（繁中）
        └── DEPLOYMENT_PLAN.md          ← 本文件
```

## 關鍵檔案變更清單

### 1. `.gitignore`（修改）
追加：
```
llama/
models/
.cache/llama-setup/
```

### 2. `scripts/llama/setup.sh`（新增）

職責（每步都 idempotent，重跑不會重下）：

1. 檢查 `llama/.installed` — 存在就跳過（除非 `--force`）
2. 建立 `llama/`、`models/`、`.cache/llama-setup/`
3. 下載（若快取不存在）：
   - `https://github.com/ggml-org/llama.cpp/releases/download/b8457/llama-b8457-bin-win-cuda-13.1-x64.zip`
   - `https://github.com/ggml-org/llama.cpp/releases/download/b8457/cudart-llama-bin-win-cuda-13.1-x64.zip`
   - `https://huggingface.co/bartowski/Jackrong_Qwen3.5-9B-Neo-GGUF/resolve/main/Jackrong_Qwen3.5-9B-Neo-Q5_K_M.gguf`（→ `models/`）
4. 解壓兩個 zip 到 `llama/`（cudart 解壓後與 llama-server.exe 同目錄即能載入）
5. 驗證：執行 `llama/llama-server.exe --version` 預期輸出含 `b8457`
6. 建立 `llama/.installed` 寫入 timestamp + build hash
7. 成功訊息顯示下一步：`bash scripts/llama/serve.sh`

下載工具優先順序：`curl -L --fail --retry 3 --continue-at -`（Git Bash 內建有 curl）。SHA 校驗可選（release 沒官方提供，跳過）。總下載量約 **7.3 GB**（含模型）。

### 3. `scripts/llama/serve.sh`（新增）

啟動 llama-server，參數針對 RTX 5070 12GB + Q5_K_M（6.85 GB）調整：

```bash
./llama/llama-server.exe \
  --model ./models/Jackrong_Qwen3.5-9B-Neo-Q5_K_M.gguf \
  --host 127.0.0.1 --port 8080 \
  --n-gpu-layers 99 \
  --ctx-size 16384 \
  --flash-attn auto \
  --jinja \
  --alias qwen3.5-9b-neo \
  --log-colors
```

參數說明：
- `--n-gpu-layers 99`：全部 offload 到 GPU（9B 模型約 40 層，Q5_K_M 6.85GB + KV cache 可完整塞入 12GB）
- `--ctx-size 16384`：16K context；KV cache 留約 3–4 GB 空間，可視實測往上調到 32768
- `--flash-attn auto`：自動啟用 Flash Attention，降低 KV cache 記憶體
- `--jinja`：使用 GGUF 內建 ChatML template（Qwen3.5 的 `<think>` 標記會被正確處理）
- `--alias`：供 `/v1/models` 顯示的模型名稱

端點：`http://127.0.0.1:8080/v1/{models,chat/completions,completions,embeddings}`（OpenAI 相容）

### 4. `scripts/llama/verify.sh`（新增）

煙測腳本：
1. `curl -sf http://127.0.0.1:8080/v1/models` 檢查 server 活著、列出 `qwen3.5-9b-neo`
2. 發送一次 `/v1/chat/completions`：`"2+2=?"`，驗證回應包含數字
3. 列印 tokens/sec（從 server log 或回傳的 usage 欄位估算）

### 5. `scripts/llama/README.md`（新增，繁中）

內容大綱：
- **先決條件**：Windows 11 + NVIDIA Driver ≥ 560（CUDA 13 相容）、Git Bash、至少 10GB 磁碟空間
- **首次部署**：`bash scripts/llama/setup.sh` （約 5–15 分鐘，視網速）
- **啟動服務**：`bash scripts/llama/serve.sh`（前景執行；或 `scripts/llama/serve.sh &` 後景）
- **煙測**：另開終端 `bash scripts/llama/verify.sh`
- **與 my-agent 整合**：待 M1 完成後，設定 `LITELLM_URL` 或未來的 `src/services/providers/` 指向 `http://127.0.0.1:8080/v1`
- **調參提示**：12GB VRAM 的 context 上限約 32K（實測為準）；若 OOM 先降 `--ctx-size`，再考慮降到 Q4_K_M
- **疑難排解**：
  - RTX 5070 跑 cuda-12.4 版會失敗 → 本專案固定用 13.1
  - cudart DLL 找不到 → 確認 `llama/cudart64_13.dll` 存在
  - 下載中斷 → 重跑 setup.sh（curl `--continue-at -` 會續傳）
- **解除安裝**：`rm -rf llama/ models/ .cache/llama-setup/`

## 驗證計畫（端到端）

執行順序：
1. `bash scripts/llama/setup.sh` → 預期：印出下載進度、最後顯示 `✓ Installed llama.cpp b8457 with CUDA 13.1`
2. `ls -lh llama/llama-server.exe models/*.gguf` → 確認兩檔存在、GGUF 約 6.85GB
3. `bash scripts/llama/serve.sh` → 預期：printout 含 `llm_load_tensors: offloading ... layers to GPU`、`main: server is listening on 127.0.0.1:8080`
4. 另開 terminal：`bash scripts/llama/verify.sh` → 預期：`/v1/models` 回傳 qwen3.5-9b-neo；chat 回應正確
5. 刪除 `llama/.installed` 後重跑 setup → 應跳過已下載的 zip（cache 命中）並快速完成

## 下載 URL 清單

- llama.cpp b8457 CUDA 13.1：
  `https://github.com/ggml-org/llama.cpp/releases/download/b8457/llama-b8457-bin-win-cuda-13.1-x64.zip`
- CUDA 13.1 runtime：
  `https://github.com/ggml-org/llama.cpp/releases/download/b8457/cudart-llama-bin-win-cuda-13.1-x64.zip`
- Qwen3.5-9B-Neo Q5_K_M（6.85 GB）：
  `https://huggingface.co/bartowski/Jackrong_Qwen3.5-9B-Neo-GGUF/resolve/main/Jackrong_Qwen3.5-9B-Neo-Q5_K_M.gguf`

## 不在範圍內（之後的工作）
- 整合到 `src/services/providers/`（屬於 CLAUDE.md M1 任務）
- 設成 Windows 開機自動啟動 service（使用者沒要求）
- systemd/supervisord 類服務管理（桌面用途不需要）
- 多模型切換（目前只跑 Q5_K_M 一個）
