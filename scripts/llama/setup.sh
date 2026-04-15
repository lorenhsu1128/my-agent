#!/usr/bin/env bash
# 一次性部署：llama.cpp b8457 (CUDA 13.1) + Qwen3.5-9B-Neo Q5_K_M
# 目標：所有產物放在專案根目錄，idempotent — 重跑會跳過已完成步驟。
# 使用：bash scripts/llama/setup.sh [--force]

set -euo pipefail

# --- 路徑與常數 ---------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
LLAMA_DIR="$ROOT_DIR/llama"
MODELS_DIR="$ROOT_DIR/models"
CACHE_DIR="$ROOT_DIR/.cache/llama-setup"
INSTALLED_MARK="$LLAMA_DIR/.installed"

LLAMA_BUILD="b8457"
LLAMA_ZIP="llama-${LLAMA_BUILD}-bin-win-cuda-13.1-x64.zip"
CUDART_ZIP="cudart-llama-bin-win-cuda-13.1-x64.zip"
MODEL_FILE="Jackrong_Qwen3.5-9B-Neo-Q5_K_M.gguf"

LLAMA_URL="https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_BUILD}/${LLAMA_ZIP}"
CUDART_URL="https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_BUILD}/${CUDART_ZIP}"
MODEL_URL="https://huggingface.co/bartowski/Jackrong_Qwen3.5-9B-Neo-GGUF/resolve/main/${MODEL_FILE}"

FORCE=0
[[ "${1:-}" == "--force" ]] && FORCE=1

# --- 工具函式 -----------------------------------------------------------
c_info()  { printf "\033[0;36m[*]\033[0m %s\n" "$*"; }
c_ok()    { printf "\033[0;32m[+]\033[0m %s\n" "$*"; }
c_warn()  { printf "\033[1;33m[!]\033[0m %s\n" "$*"; }
c_fail()  { printf "\033[0;31m[x]\033[0m %s\n" "$*" >&2; exit 1; }

need() { command -v "$1" &>/dev/null || c_fail "缺少指令：$1（Git Bash 應內建）"; }

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
need unzip

if [[ -f "$INSTALLED_MARK" && $FORCE -eq 0 ]]; then
  c_ok "已安裝（$(cat "$INSTALLED_MARK")）— 用 --force 重裝"
  c_info "下一步：bash scripts/llama/serve.sh"
  exit 0
fi

c_info "部署目錄：$ROOT_DIR"
mkdir -p "$LLAMA_DIR" "$MODELS_DIR" "$CACHE_DIR"

# --- 下載 ---------------------------------------------------------------
download "$LLAMA_URL"  "$CACHE_DIR/$LLAMA_ZIP"
download "$CUDART_URL" "$CACHE_DIR/$CUDART_ZIP"
download "$MODEL_URL"  "$MODELS_DIR/$MODEL_FILE"

# --- 解壓 ---------------------------------------------------------------
c_info "解壓 llama.cpp 至 $LLAMA_DIR"
unzip -oq "$CACHE_DIR/$LLAMA_ZIP"  -d "$LLAMA_DIR"
c_info "解壓 cudart 至 $LLAMA_DIR"
unzip -oq "$CACHE_DIR/$CUDART_ZIP" -d "$LLAMA_DIR"

# llama.cpp zip 有時會解壓到子目錄；若是則平展
if [[ -d "$LLAMA_DIR/build" ]]; then
  c_info "平展 build/ 子目錄"
  mv "$LLAMA_DIR/build/bin/"* "$LLAMA_DIR/" 2>/dev/null || true
  rm -rf "$LLAMA_DIR/build"
fi

# --- 驗證 ---------------------------------------------------------------
SERVER="$LLAMA_DIR/llama-server.exe"
[[ -x "$SERVER" ]] || c_fail "找不到 $SERVER — 解壓可能失敗"

VERSION_OUT="$("$SERVER" --version 2>&1 | head -3 || true)"
c_info "llama-server 版本：$VERSION_OUT"
echo "$VERSION_OUT" | grep -q "$LLAMA_BUILD" \
  || c_warn "版本字串未包含 $LLAMA_BUILD（可能仍可運作）"

MODEL_PATH="$MODELS_DIR/$MODEL_FILE"
MODEL_SIZE="$(du -h "$MODEL_PATH" | cut -f1)"
c_info "模型：$MODEL_PATH ($MODEL_SIZE)"

# --- 完成標記 -----------------------------------------------------------
{
  echo "build=$LLAMA_BUILD"
  echo "cuda=13.1"
  echo "model=$MODEL_FILE"
  echo "installed_at=$(date '+%Y-%m-%d %H:%M:%S')"
} > "$INSTALLED_MARK"

c_ok "Installed llama.cpp $LLAMA_BUILD with CUDA 13.1"
c_info "下一步：bash scripts/llama/serve.sh"
