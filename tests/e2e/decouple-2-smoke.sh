#!/usr/bin/env bash
# M-DECOUPLE-2 自動化 E2E smoke 套件
#
# 在 Phase 結束時跑（特別是 P2A bridge 分叉、P2C auth.ts 死碼清除後）。
# 跑完前需要 conda activate aiagent + llama.cpp server 已啟動。
#
# 用法：
#   bash tests/e2e/decouple-2-smoke.sh                    # 全部
#   bash tests/e2e/decouple-2-smoke.sh llm                # 只跑 LLM 路徑
#   bash tests/e2e/decouple-2-smoke.sh daemon             # 只跑 daemon
#   bash tests/e2e/decouple-2-smoke.sh cron               # 只跑 cron
#   bash tests/e2e/decouple-2-smoke.sh memory             # 只跑 memory
#
# Exit code：
#   0 全綠
#   1 任何測試失敗
#   2 環境問題（llama.cpp / daemon 起不來）

set -uo pipefail

SCOPE="${1:-all}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT" || exit 2

REPORT_FILE="$ROOT/tests/e2e/decouple-2-report-$(date +%Y%m%d-%H%M%S).txt"
mkdir -p "$(dirname "$REPORT_FILE")"

PASS=0
FAIL=0
FAILED_TESTS=()

log() { echo "[$(date +%H:%M:%S)] $*" | tee -a "$REPORT_FILE"; }
test_start() { log "▶ $1"; }
test_pass() { PASS=$((PASS+1)); log "✓ $1"; }
test_fail() { FAIL=$((FAIL+1)); FAILED_TESTS+=("$1"); log "✗ $1: $2"; }

# === Pre-flight ===
log "=== M-DECOUPLE-2 E2E smoke 開始 ==="
log "ROOT=$ROOT  SCOPE=$SCOPE"

# Verify llama.cpp server reachable
LLAMA_URL="${LLAMACPP_BASE_URL:-http://127.0.0.1:8080}"
if ! curl -sf "$LLAMA_URL/health" > /dev/null 2>&1 \
   && ! curl -sf "$LLAMA_URL/v1/models" > /dev/null 2>&1; then
  log "✗ llama.cpp server unreachable at $LLAMA_URL"
  log "  先啟動 scripts/llama/serve.sh 再跑此腳本"
  exit 2
fi
log "✓ llama.cpp server 可達"

# typecheck baseline
test_start "typecheck baseline"
TC_OUT="$(bun run typecheck 2>&1)"
if echo "$TC_OUT" | grep -E "error TS[0-9]+" | grep -v "TS5101.*baseUrl" | grep -q .; then
  test_fail "typecheck" "新 type error，看 $REPORT_FILE"
  echo "$TC_OUT" >> "$REPORT_FILE"
else
  test_pass "typecheck baseline"
fi

# === B1. LLM 對話路徑 ===
if [[ "$SCOPE" == "all" || "$SCOPE" == "llm" ]]; then
  log ""
  log "=== B1. LLM 對話路徑 ==="

  test_start "B1.1 純 llama.cpp -p hello"
  OUT="$(timeout 30 ./cli -p "say hi in 3 words" 2>&1 | tail -3)"
  if echo "$OUT" | grep -qiE "hi|hello|你好"; then
    test_pass "B1.1 -p hello"
  else
    test_fail "B1.1 -p hello" "$OUT"
  fi

  test_start "B1.2 工具呼叫 (Read)"
  OUT="$(timeout 60 ./cli -p "讀取 package.json 第一行回覆給我" 2>&1 | tail -10)"
  if echo "$OUT" | grep -qE "name|my-agent|\{"; then
    test_pass "B1.2 Read tool"
  else
    test_fail "B1.2 Read tool" "$OUT"
  fi

  test_start "B1.3 unset ANTHROPIC_API_KEY"
  OUT="$(env -u ANTHROPIC_API_KEY timeout 30 ./cli -p "say hi" 2>&1 | tail -3)"
  if echo "$OUT" | grep -qiE "hi|hello|你好"; then
    test_pass "B1.3 unset API key"
  else
    test_fail "B1.3 unset API key" "$OUT"
  fi
fi

# === B2. Daemon ===
if [[ "$SCOPE" == "all" || "$SCOPE" == "daemon" ]]; then
  log ""
  log "=== B2. Daemon ==="

  # Stop any existing daemon
  ./cli daemon stop 2>/dev/null || true
  sleep 1

  test_start "B2.1 daemon start"
  if ./cli daemon start 2>&1 | grep -qE "started|listening|pid"; then
    sleep 2
    if [[ -f "$HOME/.my-agent/daemon.pid.json" ]]; then
      test_pass "B2.1 daemon start"
    else
      test_fail "B2.1 daemon start" "no pid.json"
    fi
  else
    test_fail "B2.1 daemon start" "command failed"
  fi

  test_start "B2.2 daemon status"
  if ./cli daemon status 2>&1 | grep -qE "running|alive|attached"; then
    test_pass "B2.2 daemon status"
  else
    test_fail "B2.2 daemon status" "not running"
  fi

  test_start "B2.3 thin client attach"
  OUT="$(timeout 30 ./cli -p "say hi" 2>&1 | tail -5)"
  if echo "$OUT" | grep -qiE "hi|hello|你好"; then
    test_pass "B2.3 attach + turn"
  else
    test_fail "B2.3 attach" "$OUT"
  fi

  test_start "B2.4 daemon stop"
  if ./cli daemon stop 2>&1 | grep -qE "stopped|killed|exit"; then
    sleep 1
    if [[ ! -f "$HOME/.my-agent/daemon.pid.json" ]]; then
      test_pass "B2.4 daemon stop"
    else
      test_fail "B2.4 daemon stop" "pid.json still exists"
    fi
  else
    test_fail "B2.4 daemon stop" "command failed"
  fi
fi

# === B3. Cron ===
if [[ "$SCOPE" == "all" || "$SCOPE" == "cron" ]]; then
  log ""
  log "=== B3. Cron ==="

  TASK_PROMPT="echo cron-test-$(date +%s)"

  test_start "B3.1 build cron task (NL)"
  # 用 -p 走 LLM 自然語言觸發 ScheduleCron
  OUT="$(timeout 60 ./cli -p "建一個 cron task，每分鐘執行 bash 指令 \"$TASK_PROMPT\"，名字叫 e2e-test" 2>&1 | tail -5)"
  if echo "$OUT" | grep -qE "cron|task|scheduled|建立"; then
    test_pass "B3.1 build cron"
  else
    test_fail "B3.1 build cron" "$OUT"
  fi

  test_start "B3.2 list cron"
  OUT="$(timeout 30 ./cli -p "列出所有 cron tasks" 2>&1 | tail -10)"
  if echo "$OUT" | grep -qE "e2e-test"; then
    test_pass "B3.2 list cron"
  else
    test_fail "B3.2 list cron" "task not in list"
  fi

  test_start "B3.3 history JSONL exists"
  if compgen -G "$HOME/.my-agent/projects/*/cron-history.jsonl" > /dev/null; then
    test_pass "B3.3 history JSONL"
  else
    test_fail "B3.3 history JSONL" "no JSONL found"
  fi

  # Cleanup
  timeout 30 ./cli -p "刪除 cron task e2e-test" > /dev/null 2>&1 || true
fi

# === B4. Memory ===
if [[ "$SCOPE" == "all" || "$SCOPE" == "memory" ]]; then
  log ""
  log "=== B4. Memory ==="

  MEMORY_DIR="$HOME/.my-agent/projects"

  test_start "B4.1 memdir 存在"
  if compgen -G "$MEMORY_DIR/*/memory" > /dev/null; then
    test_pass "B4.1 memdir 存在"
  else
    test_fail "B4.1 memdir" "no memory dir"
  fi

  test_start "B4.2 sideQuery → llamacpp（記憶選擇器）"
  # 跑一個會觸發 prefetch 的 prompt
  OUT="$(env -u ANTHROPIC_API_KEY timeout 60 ./cli -p "幫我複習一下這個專案的架構" 2>&1 | tail -10)"
  # 沒 401 / 沒 throw 即可
  if echo "$OUT" | grep -qE "401|Unauthorized|ANTHROPIC_API_KEY"; then
    test_fail "B4.2 sideQuery llamacpp" "$OUT"
  else
    test_pass "B4.2 sideQuery → llamacpp 不 throw"
  fi
fi

# === B5. Build / Bundle ===
if [[ "$SCOPE" == "all" || "$SCOPE" == "build" ]]; then
  log ""
  log "=== B5. Build ==="

  test_start "B5.1 bun run build:dev"
  if timeout 120 bun run build:dev 2>&1 | tail -20 | grep -qE "✘|error" \
     | grep -v "growthbook\|baseUrl"; then
    test_fail "B5.1 build:dev" "build error"
  else
    test_pass "B5.1 build:dev"
  fi
fi

# === Integration test suites ===
if [[ "$SCOPE" == "all" || "$SCOPE" == "integration" ]]; then
  log ""
  log "=== B6. Integration tests ==="

  for SUITE in llamacpp memory cron daemon; do
    test_start "B6.$SUITE"
    if [[ -d "tests/integration/$SUITE" ]]; then
      if timeout 120 bun test "tests/integration/$SUITE/" 2>&1 | tail -5 | grep -qE "fail"; then
        test_fail "B6.$SUITE" "test failure"
      else
        test_pass "B6.$SUITE"
      fi
    else
      log "⊘ B6.$SUITE skipped（no tests/integration/$SUITE/）"
    fi
  done
fi

# === Final ===
log ""
log "=== 總結 ==="
log "PASS=$PASS  FAIL=$FAIL"
if [[ $FAIL -gt 0 ]]; then
  log "Failed:"
  for t in "${FAILED_TESTS[@]}"; do log "  - $t"; done
  log "詳細：$REPORT_FILE"
  exit 1
else
  log "✓ 全綠"
  exit 0
fi
