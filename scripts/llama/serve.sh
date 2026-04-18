#!/usr/bin/env bash
# 啟動 llama-server，提供 OpenAI 相容 API 於 http://127.0.0.1:8080/v1
# 針對 RTX 5070 12GB VRAM + Qwen3.5-9B-Neo Q5_K_M 調校。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
SERVER="$ROOT_DIR/llama/llama-server.exe"
MODEL="$ROOT_DIR/models/Jackrong_Qwen3.5-9B-Neo-Q5_K_M.gguf"

# --- 可調參數（環境變數覆蓋）-------------------------------------------
HOST="${LLAMA_HOST:-127.0.0.1}"
PORT="${LLAMA_PORT:-8080}"
CTX_SIZE="${LLAMA_CTX:-131072}"
NGL="${LLAMA_NGL:-99}"
ALIAS="${LLAMA_ALIAS:-qwopus3.5-9b-v3}"

# --- 前置檢查 -----------------------------------------------------------
[[ -x "$SERVER" ]] || { echo "[x] 找不到 $SERVER，請先執行 bash scripts/llama/setup.sh" >&2; exit 1; }
[[ -f "$MODEL"  ]] || { echo "[x] 找不到模型 $MODEL，請先執行 bash scripts/llama/setup.sh" >&2; exit 1; }

echo "[*] 啟動 llama-server"
echo "    model   = $(basename "$MODEL")"
echo "    endpoint= http://$HOST:$PORT/v1"
echo "    ctx     = $CTX_SIZE    ngl = $NGL    alias = $ALIAS"
echo ""

exec "$SERVER" \
  --model "$MODEL" \
  --host "$HOST" --port "$PORT" \
  --n-gpu-layers "$NGL" \
  --ctx-size "$CTX_SIZE" \
  --flash-attn auto \
  --jinja \
  --alias "$ALIAS"
