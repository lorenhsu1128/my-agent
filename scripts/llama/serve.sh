#!/usr/bin/env bash
# 啟動 llama-server，提供 OpenAI 相容 API。
# M-LLAMA-CFG：設定來源改為 ~/.my-agent/llamacpp.json（透過 load-config.sh）。
# 舊環境變數（LLAMA_HOST / LLAMA_PORT / LLAMA_CTX / LLAMA_NGL / LLAMA_ALIAS）仍可臨時覆蓋。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

# --- 載入共用設定（會 export LLAMA_* env） ----------------------------
# shellcheck disable=SC1091
source "$SCRIPT_DIR/load-config.sh"

# --- 解析 binary / model 路徑（相對 repo root 的話補全） ----------------
resolve_path() {
  local p="$1"
  if [[ "$p" = /* || "$p" =~ ^[A-Za-z]:[\\/] ]]; then
    echo "$p"
  else
    echo "$ROOT_DIR/$p"
  fi
}

SERVER="$(resolve_path "$LLAMA_BINARY")"
MODEL="$(resolve_path "$LLAMA_MODEL_PATH")"

# --- 前置檢查 -----------------------------------------------------------
[[ -x "$SERVER" ]] || { echo "[x] 找不到 $SERVER，請先執行 bash scripts/llama/setup.sh" >&2; exit 1; }
[[ -f "$MODEL"  ]] || { echo "[x] 找不到模型 $MODEL，請先執行 bash scripts/llama/setup.sh" >&2; exit 1; }

echo "[*] 啟動 llama-server"
echo "    model   = $(basename "$MODEL")"
echo "    endpoint= http://$LLAMA_HOST:$LLAMA_PORT/v1"
echo "    ctx     = $LLAMA_CTX    ngl = $LLAMA_NGL    alias = $LLAMA_ALIAS"
echo "    extra   = ${LLAMA_EXTRA_ARGS_SHELL}"
echo ""

# 使用 eval 讓 LLAMA_EXTRA_ARGS_SHELL 裡的 @sh 引用正確展開
eval "exec \"\$SERVER\" \
  --model \"\$MODEL\" \
  --host \"\$LLAMA_HOST\" --port \"\$LLAMA_PORT\" \
  --n-gpu-layers \"\$LLAMA_NGL\" \
  --ctx-size \"\$LLAMA_CTX\" \
  --alias \"\$LLAMA_ALIAS\" \
  $LLAMA_EXTRA_ARGS_SHELL"
