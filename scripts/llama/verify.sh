#!/usr/bin/env bash
# 煙測：驗證 llama-server 是否正常提供 OpenAI 相容 API。
# 先在另一個終端執行 bash scripts/llama/serve.sh

set -euo pipefail

HOST="${LLAMA_HOST:-127.0.0.1}"
PORT="${LLAMA_PORT:-8080}"
BASE="http://$HOST:$PORT"

echo "[*] 檢查 $BASE/v1/models"
MODELS_JSON="$(curl -sf --max-time 5 "$BASE/v1/models")" \
  || { echo "[x] server 未回應 — 先啟動 bash scripts/llama/serve.sh" >&2; exit 1; }
echo "$MODELS_JSON" | head -c 400; echo

echo ""
echo "[*] 發送 chat completion：2+2=?"
# 以檔案傳遞 JSON body，避免 Git Bash 命令列對 UTF-8 的 mangling
REQ_FILE="$(mktemp -t llama-req.XXXXXX.json)"
trap 'rm -f "$REQ_FILE"' EXIT
cat > "$REQ_FILE" <<'JSON'
{
  "model": "qwen3.5-9b-neo",
  "messages": [{"role":"user","content":"What is 2+2? Reply with just the number."}],
  "max_tokens": 512,
  "temperature": 0.1
}
JSON

RESPONSE="$(curl -sf --max-time 180 "$BASE/v1/chat/completions" \
  -H 'Content-Type: application/json' \
  --data-binary "@$REQ_FILE")"

echo "$RESPONSE" | head -c 800; echo
echo ""

CONTENT="$(echo "$RESPONSE" | grep -oE '"content"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1)"
REASONING="$(echo "$RESPONSE" | grep -oE '"reasoning_content"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1)"
USAGE="$(echo   "$RESPONSE" | grep -oE '"usage"[[:space:]]*:[[:space:]]*\{[^}]*\}'    | head -1)"
FINISH="$(echo  "$RESPONSE" | grep -oE '"finish_reason"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1)"

echo "[+] content:   $CONTENT"
echo "[+] reasoning: $(echo "$REASONING" | head -c 160)..."
echo "[+] finish:    $FINISH"
echo "[+] usage:     $USAGE"

# Qwen3.5-Neo 會把思維鏈放到 reasoning_content，答案放到 content；任一處出現數字都算通過
if echo "$CONTENT$REASONING" | grep -qE '[0-9]'; then
  echo "[+] 煙測通過 — server 正常運作"
  exit 0
else
  echo "[!] 回應中未偵測到數字，請手動檢查" >&2
  exit 2
fi
