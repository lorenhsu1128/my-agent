#!/usr/bin/env bash
# 一次性部署：buun-llama-cpp（TCQ KV cache 壓縮 fork）+ unsloth Qwen3.5-9B Q4_K_M + mmproj-F16
# 目標：所有產物放在專案根目錄，idempotent — 重跑會跳過已完成步驟。
# 使用：bash scripts/llama/setup.sh [--force]
#
# 前置：
#   - Windows: Visual Studio 2022 Build Tools（cmake / cl.exe）
#   - CUDA Toolkit 12.x（nvcc 在 PATH）
#   - Git LFS（HuggingFace 大檔下載）

set -euo pipefail

# --- 路徑與常數 ---------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
BUUN_DIR="$ROOT_DIR/buun-llama-cpp"
BUILD_DIR="$BUUN_DIR/build"
SERVER_BIN="$BUILD_DIR/bin/Release/llama-server.exe"
MODELS_DIR="$ROOT_DIR/models"
INSTALLED_MARK="$BUUN_DIR/.installed"

# 模型來源：unsloth 官方 Qwen3.5-9B GGUF + mmproj-F16
MODEL_FILE="Qwen3.5-9B-Q4_K_M.gguf"
MMPROJ_FILE="mmproj-Qwen3.5-9B-F16.gguf"
MODEL_URL="https://huggingface.co/unsloth/Qwen3.5-9B-GGUF/resolve/main/Qwen3.5-9B-Q4_K_M.gguf"
MMPROJ_URL="https://huggingface.co/unsloth/Qwen3.5-9B-GGUF/resolve/main/mmproj-F16.gguf"

FORCE=0
[[ "${1:-}" == "--force" ]] && FORCE=1

# --- 工具函式 -----------------------------------------------------------
c_info()  { printf "\033[0;36m[*]\033[0m %s\n" "$*"; }
c_ok()    { printf "\033[0;32m[+]\033[0m %s\n" "$*"; }
c_warn()  { printf "\033[1;33m[!]\033[0m %s\n" "$*"; }
c_fail()  { printf "\033[0;31m[x]\033[0m %s\n" "$*" >&2; exit 1; }

need() { command -v "$1" &>/dev/null || c_fail "缺少指令：$1"; }

download() {
  local url="$1" dest="$2"
  if [[ -f "$dest" && -s "$dest" ]]; then
    c_info "已快取：$(basename "$dest") ($(du -h "$dest" | cut -f1))"
    return
  fi
  c_info "下載：$url"
  curl -L --fail --retry 3 --retry-delay 2 --continue-at - \
       --progress-bar -o "$dest" "$url" \
    || c_fail "下載失敗：$url"
}

# --- 前置檢查 -----------------------------------------------------------
need curl
need git
need cmake

if [[ -f "$INSTALLED_MARK" && $FORCE -eq 0 ]]; then
  c_ok "已安裝（$(cat "$INSTALLED_MARK")）— 用 --force 重裝"
  c_info "下一步：bash scripts/llama/serve.sh"
  exit 0
fi

c_info "部署目錄：$ROOT_DIR"
mkdir -p "$MODELS_DIR"

# --- 1. 確保 submodule 已 init ------------------------------------------
if [[ ! -f "$BUUN_DIR/CMakeLists.txt" ]]; then
  c_info "初始化 buun-llama-cpp submodule"
  (cd "$ROOT_DIR" && git submodule update --init --recursive buun-llama-cpp)
fi

# --- 2. 編譯（idempotent — 已存在 server bin 就跳過） -------------------
if [[ ! -x "$SERVER_BIN" || $FORCE -eq 1 ]]; then
  c_info "編譯 buun-llama-cpp（CUDA）— 約需 20–40 分鐘"
  (cd "$BUUN_DIR" && cmake -B build \
      -DGGML_CUDA=ON \
      -DGGML_NATIVE=ON \
      -DGGML_CUDA_FA=ON \
      -DGGML_CUDA_FA_ALL_QUANTS=ON \
      -DCMAKE_BUILD_TYPE=Release)
  (cd "$BUUN_DIR" && cmake --build build --config Release -j)
  [[ -x "$SERVER_BIN" ]] || c_fail "編譯完成但找不到 $SERVER_BIN"
else
  c_info "已編譯：$SERVER_BIN"
fi

# --- 3. 驗證版本 + CUDA --------------------------------------------------
VERSION_OUT="$("$SERVER_BIN" --version 2>&1 | head -3 || true)"
c_info "llama-server 版本/裝置："
echo "$VERSION_OUT" | sed 's/^/    /'

# --- 4. 下載模型 + mmproj ------------------------------------------------
download "$MODEL_URL"  "$MODELS_DIR/$MODEL_FILE"
download "$MMPROJ_URL" "$MODELS_DIR/$MMPROJ_FILE"

MODEL_SIZE="$(du -h "$MODELS_DIR/$MODEL_FILE" | cut -f1)"
MMPROJ_SIZE="$(du -h "$MODELS_DIR/$MMPROJ_FILE" | cut -f1)"
c_info "模型：$MODELS_DIR/$MODEL_FILE ($MODEL_SIZE)"
c_info "mmproj：$MODELS_DIR/$MMPROJ_FILE ($MMPROJ_SIZE)"

# --- 5. 完成標記 ---------------------------------------------------------
{
  echo "fork=buun-llama-cpp"
  echo "commit=$(cd "$BUUN_DIR" && git rev-parse --short HEAD 2>/dev/null || echo unknown)"
  echo "model=$MODEL_FILE"
  echo "mmproj=$MMPROJ_FILE"
  echo "installed_at=$(date '+%Y-%m-%d %H:%M:%S')"
} > "$INSTALLED_MARK"

c_ok "Installed buun-llama-cpp + Qwen3.5-9B Q4_K_M + mmproj-F16"
c_info "下一步：bash scripts/llama/serve.sh"
