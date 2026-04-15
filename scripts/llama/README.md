# 本地 llama.cpp 部署

在專案根目錄跑 **llama.cpp b8457（CUDA 13.1）+ Jackrong Qwen3.5-9B-Neo Q5_K_M**。
所有產物（二進位、cudart DLL、GGUF 權重）都放在專案目錄內，不污染系統。

## 先決條件

| 項目 | 需求 |
|------|------|
| 作業系統 | Windows 11 |
| GPU | NVIDIA（建議 ≥ 8GB VRAM；本設定針對 RTX 5070 12GB 調校） |
| NVIDIA Driver | ≥ 560（CUDA 13 runtime 需要） |
| Shell | Git Bash（Git for Windows 內建） |
| 磁碟 | ≥ 10GB 空閒（二進位 + 6.85GB GGUF） |
| 指令 | `curl`、`unzip`（Git Bash 內建） |

> **RTX 5070 注意**：Blackwell 架構必須用 CUDA 12.8+ 構建。setup.sh 固定使用
> CUDA 13.1 的 llama.cpp — 不要換成 CUDA 12.4 版。

## 首次部署

```bash
conda activate aiagent        # 專案慣例：每個 session 先啟動
bash scripts/llama/setup.sh   # 約 5–15 分鐘，視網速；下載約 7.3GB
```

setup 腳本做了什麼：

1. 下載 `llama-b8457-bin-win-cuda-13.1-x64.zip` 到 `.cache/llama-setup/`
2. 下載 `cudart-llama-bin-win-cuda-13.1-x64.zip` 到 `.cache/llama-setup/`
3. 下載 `Jackrong_Qwen3.5-9B-Neo-Q5_K_M.gguf`（6.85GB）到 `models/`
4. 解壓兩個 zip 到 `llama/`（cudart DLL 與 llama-server.exe 同目錄）
5. 呼叫 `llama-server.exe --version` 驗證
6. 寫入 `llama/.installed` 完成標記

重跑 setup.sh 會跳過已完成的步驟（curl `--continue-at -` 會續傳中斷的下載）。
要強制重裝：`bash scripts/llama/setup.sh --force`。

## 啟動服務

```bash
bash scripts/llama/serve.sh
```

端點：`http://127.0.0.1:8080/v1/{models,chat/completions,completions,embeddings}`（OpenAI 相容）。
服務在前景執行 — 關閉終端或 Ctrl+C 即停止。

### 可調整參數（環境變數）

| 變數 | 預設 | 說明 |
|------|------|------|
| `LLAMA_HOST`  | `127.0.0.1` | 綁定位址 |
| `LLAMA_PORT`  | `8080` | 連接埠 |
| `LLAMA_CTX`   | `16384` | Context 長度；12GB VRAM 上限約 32768 |
| `LLAMA_NGL`   | `99` | 送到 GPU 的層數（99 = 全部） |
| `LLAMA_ALIAS` | `qwen3.5-9b-neo` | `/v1/models` 顯示的名稱 |

範例：`LLAMA_CTX=32768 bash scripts/llama/serve.sh`

## 煙測

另開終端：
```bash
bash scripts/llama/verify.sh
```

會呼叫 `/v1/models` 並送一個 `"2+2=?"` 的 chat completion，驗證整條鏈路正常。

## 與 free-code 整合（之後）

這個 server 是純本地的 OpenAI 相容端點。M1 完成後，在 free-code 的 provider 設定
指向 `http://127.0.0.1:8080/v1`，模型名用 `qwen3.5-9b-neo`（或 `LLAMA_ALIAS`）。

## 疑難排解

| 症狀 | 對策 |
|------|------|
| CUDA 初始化失敗 / 找不到裝置 | 更新 NVIDIA Driver 到 ≥ 560；確認 `nvidia-smi` 可用 |
| 找不到 `cudart64_13.dll` | 確認 `llama/cudart64_13.dll` 存在；不存在就 `bash scripts/llama/setup.sh --force` |
| 執行時 OOM | 先降 `LLAMA_CTX`（例如 8192）；仍不夠就換 Q4_K_M 量化 |
| 下載中斷 | 直接重跑 `bash scripts/llama/setup.sh`（會續傳） |
| server 啟動但 verify 失敗 | 用 `curl http://127.0.0.1:8080/v1/models` 手動檢查；看 serve.sh 終端的錯誤訊息 |
| HuggingFace 下載 403 | 某些 gated 模型需要登入；本模型公開不需 token |

## 解除安裝

```bash
rm -rf llama/ models/ .cache/llama-setup/
```

（三個目錄都在 `.gitignore` 中，不會影響 git 狀態。）
