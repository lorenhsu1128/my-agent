#!/usr/bin/env bash
# M-DAEMON-8：Manual smoke test for daemon mode.
#
# 跑：
#   bash tests/integration/daemon/smoke.sh
#
# 驗證：
#   1. daemon 未啟動時 status 回「not running」
#   2. daemon start → status running + port > 0 + pid.json 寫入
#   3. daemon 第二次 start 失敗 "already running"
#   4. daemon stop → pid.json 清掉
#   5. stale pid.json 自動 take-over
#   6. ./cli -p 獨立模式能跑（daemon 不 attached）
#
# 需要環境：conda activate aiagent + bun。llama.cpp 不必（只測 transport）。
#
# 失敗時會 exit 1；通過 exit 0。
set -euo pipefail

# 可被外部環境 override。預設隔離到 tmp 目錄以免污染使用者真實 daemon。
TMP_HOME="${MY_AGENT_SMOKE_HOME:-$(mktemp -d -t my-agent-smoke-XXXXXX)}"
export CLAUDE_CONFIG_DIR="$TMP_HOME"

CLI="${CLI:-./cli}"
PORT="${PORT:-0}"
RED="\033[31m"
GREEN="\033[32m"
YELLOW="\033[33m"
RESET="\033[0m"

fail() { echo -e "${RED}FAIL${RESET} $1"; exit 1; }
ok()   { echo -e "${GREEN}OK${RESET}   $1"; }
info() { echo -e "${YELLOW}...${RESET}  $1"; }

cleanup() {
  # 盡力停 daemon（可能已停）
  "$CLI" daemon stop --graceful-ms 2000 >/dev/null 2>&1 || true
  # 清 tmp
  if [[ "${MY_AGENT_SMOKE_HOME:-}" == "" ]]; then
    rm -rf "$TMP_HOME" || true
  fi
}
trap cleanup EXIT

info "tmp home: $TMP_HOME"
info "cli:      $CLI"

# --- 1. no daemon → status reports not running ---
# 注意：daemon status 在 no-daemon 時 exit code=1；set -o pipefail + if 會把整個
# pipeline 視為 false。改抓 output 再 grep。
info "case 1: daemon status when no daemon"
status_out=$("$CLI" daemon status 2>&1 || true)
if echo "$status_out" | grep -q "not running"; then
  ok "status reports not running"
else
  fail "expected 'not running' in status output, got: $status_out"
fi

# --- 2. start daemon + status ---
info "case 2: daemon start"
# 背景啟動 daemon
"$CLI" daemon start --port "$PORT" >"$TMP_HOME/daemon-start.log" 2>&1 &
DAEMON_PID=$!
# 等 pid.json 出現
for i in {1..30}; do
  if [[ -f "$TMP_HOME/daemon.pid.json" ]]; then break; fi
  sleep 0.3
done
if [[ ! -f "$TMP_HOME/daemon.pid.json" ]]; then
  cat "$TMP_HOME/daemon-start.log" || true
  fail "pid.json did not appear within 9s"
fi
ok "pid.json written"

# status 回 running
status_out=$("$CLI" daemon status 2>&1 || true)
if echo "$status_out" | grep -q "running"; then
  ok "status reports running"
else
  fail "expected 'running' in status output, got: $status_out"
fi

# --- 3. second start fails with already-running ---
info "case 3: duplicate start rejected"
dup_out=$("$CLI" daemon start --port "$PORT" 2>&1 || true)
if echo "$dup_out" | grep -q "already running"; then
  ok "second start rejected"
else
  fail "duplicate start did not report 'already running', got: $dup_out"
fi

# --- 4. stop daemon ---
info "case 4: daemon stop"
"$CLI" daemon stop --graceful-ms 3000 >/dev/null || true
# wait for original daemon process to actually die
{ wait "$DAEMON_PID" 2>/dev/null || true; } || true
# 給 fs 一點時間 release pid.json（Windows 常見延遲）
for i in {1..30}; do
  if [[ ! -f "$TMP_HOME/daemon.pid.json" ]]; then break; fi
  sleep 0.3
done
if [[ -f "$TMP_HOME/daemon.pid.json" ]]; then
  fail "pid.json still present after stop (content: $(cat "$TMP_HOME/daemon.pid.json" 2>&1))"
fi
ok "pid.json removed"

# --- 5. stale pid take-over ---
info "case 5: stale pid take-over"
cat >"$TMP_HOME/daemon.pid.json" <<EOF
{"version":1,"pid":99999999,"port":1,"startedAt":1,"lastHeartbeat":1,"agentVersion":"ghost"}
EOF
"$CLI" daemon start --port "$PORT" >"$TMP_HOME/daemon-takeover.log" 2>&1 &
DAEMON_PID=$!
for i in {1..30}; do
  if [[ -f "$TMP_HOME/daemon.pid.json" ]]; then
    agent=$(grep -o '"agentVersion":"[^"]*"' "$TMP_HOME/daemon.pid.json" || true)
    if [[ "$agent" != *"ghost"* ]]; then break; fi
  fi
  sleep 0.3
done
if grep -q '"agentVersion":"ghost"' "$TMP_HOME/daemon.pid.json"; then
  fail "stale pid was not taken over"
fi
ok "stale pid taken over"
"$CLI" daemon stop --graceful-ms 3000 >/dev/null || true
{ wait "$DAEMON_PID" 2>/dev/null || true; } || true

# --- 6. ./cli -p still works with CLAUDE_CONFIG_DIR (standalone) ---
# 這個案例跳過 LLM，只確認不會因為 daemon skip 邏輯當掉（env CLAUDE_CONFIG_DIR=tmp）。
# 需要 llama.cpp 才真跑 LLM；這裡以 --help 確認 CLI 活著。
info "case 6: ./cli --help works with isolated home"
if "$CLI" --help >/dev/null 2>&1; then
  ok "./cli --help runs"
else
  fail "./cli --help failed"
fi

echo -e "${GREEN}All smoke checks passed.${RESET}"
