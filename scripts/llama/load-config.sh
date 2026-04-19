#!/usr/bin/env bash
# M-LLAMA-CFG: 從 ~/.my-agent/llamacpp.json 抽出 env vars 供 serve.sh 使用。
# 供其他 scripts source，本身不 exec。
#
# 優先序（先定義者勝）：
#   1. Shell 已 export 的 env（例：臨時覆蓋 `LLAMA_CTX=65536 bash serve.sh`）
#   2. ~/.my-agent/llamacpp.json 裡的 server.* 欄位
#   3. 腳本內硬編碼 fallback（與 src/llamacppConfig/schema.ts 預設對齊）
#
# 失敗情境：
#   - 缺 jq：印提示，沿用硬編碼 fallback（不 exit）
#   - 缺檔：沿用硬編碼 fallback（使用者首次啟動 my-agent 後會自動 seed）
#   - JSON 壞：jq 會報錯，本腳本吞掉錯誤走 fallback

CONFIG_PATH="${LLAMACPP_CONFIG_PATH:-$HOME/.my-agent/llamacpp.json}"

# 讀單一 jq 路徑，失敗回空字串
_read_cfg() {
  local path="$1"
  [[ -f "$CONFIG_PATH" ]] || { echo ""; return; }
  command -v jq >/dev/null 2>&1 || { echo ""; return; }
  jq -r "$path // empty" "$CONFIG_PATH" 2>/dev/null || echo ""
}

# server.host
_cfg_host=$(_read_cfg '.server.host')
export LLAMA_HOST="${LLAMA_HOST:-${_cfg_host:-127.0.0.1}}"

# server.port
_cfg_port=$(_read_cfg '.server.port')
export LLAMA_PORT="${LLAMA_PORT:-${_cfg_port:-8080}}"

# server.ctxSize
_cfg_ctx=$(_read_cfg '.server.ctxSize')
export LLAMA_CTX="${LLAMA_CTX:-${_cfg_ctx:-131072}}"

# server.gpuLayers
_cfg_ngl=$(_read_cfg '.server.gpuLayers')
export LLAMA_NGL="${LLAMA_NGL:-${_cfg_ngl:-99}}"

# server.alias
_cfg_alias=$(_read_cfg '.server.alias')
export LLAMA_ALIAS="${LLAMA_ALIAS:-${_cfg_alias:-qwen3.5-9b-neo}}"

# server.modelPath（相對 repo root 就補全、絕對路徑則照用）
_cfg_model_path=$(_read_cfg '.server.modelPath')
export LLAMA_MODEL_PATH="${LLAMA_MODEL_PATH:-${_cfg_model_path:-models/Jackrong_Qwen3.5-9B-Neo-Q5_K_M.gguf}}"

# server.binaryPath
_cfg_binary=$(_read_cfg '.server.binaryPath')
export LLAMA_BINARY="${LLAMA_BINARY:-${_cfg_binary:-llama/llama-server.exe}}"

# server.extraArgs（JSON array → space-separated；呼叫端可用 eval 或直接展開）
if [[ -f "$CONFIG_PATH" ]] && command -v jq >/dev/null 2>&1; then
  # 用 @sh 輸出安全 shell 引用；空陣列或缺欄位回空
  LLAMA_EXTRA_ARGS_SHELL="$(jq -r '(.server.extraArgs // []) | map(@sh) | join(" ")' "$CONFIG_PATH" 2>/dev/null || echo "")"
else
  LLAMA_EXTRA_ARGS_SHELL="'--flash-attn' 'auto' '--jinja'"
fi

# M-VISION: 若設定了 server.vision.mmprojPath，追加 `--mmproj <path>`。
#   - 相對路徑相對 repo root 補全（serve.sh 的 resolve_path 只處理 model/binary）
#   - jq / 檔案 / 路徑欄位任何一缺都視為未啟用 vision
if [[ -f "$CONFIG_PATH" ]] && command -v jq >/dev/null 2>&1; then
  _cfg_mmproj=$(jq -r '.server.vision.mmprojPath // empty' "$CONFIG_PATH" 2>/dev/null || echo "")
  if [[ -n "$_cfg_mmproj" ]]; then
    # 補全相對路徑：若不是絕對路徑（/... 或 X:/... / X:\...）則接到 repo root
    _script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    _root_dir="$(cd "$_script_dir/../.." && pwd)"
    if [[ "$_cfg_mmproj" = /* || "$_cfg_mmproj" =~ ^[A-Za-z]:[\\/] ]]; then
      _mmproj_abs="$_cfg_mmproj"
    else
      _mmproj_abs="$_root_dir/$_cfg_mmproj"
    fi
    # 附加到 extraArgs 尾端；若兩者都空就用單一 --mmproj 段
    if [[ -n "$LLAMA_EXTRA_ARGS_SHELL" ]]; then
      LLAMA_EXTRA_ARGS_SHELL="$LLAMA_EXTRA_ARGS_SHELL '--mmproj' $(printf %q "$_mmproj_abs")"
    else
      LLAMA_EXTRA_ARGS_SHELL="'--mmproj' $(printf %q "$_mmproj_abs")"
    fi
  fi
fi

# 允許呼叫端用 LLAMA_EXTRA_ARGS_SHELL 展開；舊腳本可繼續 hard-code 若沒改
export LLAMA_EXTRA_ARGS_SHELL

# 友善訊息（只在首次 source 有用）
if [[ ! -f "$CONFIG_PATH" && -z "${_LLAMACPP_CFG_WARNED:-}" ]]; then
  echo "[llamacpp config] $CONFIG_PATH 不存在；使用內建預設。跑一次 my-agent 即會自動 seed。" >&2
  export _LLAMACPP_CFG_WARNED=1
elif ! command -v jq >/dev/null 2>&1 && [[ -z "${_LLAMACPP_CFG_WARNED:-}" ]]; then
  echo "[llamacpp config] 系統缺 jq；使用內建預設。要讀 ${CONFIG_PATH} 請安裝 jq。" >&2
  export _LLAMACPP_CFG_WARNED=1
fi
