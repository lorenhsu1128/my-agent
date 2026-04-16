#!/usr/bin/env bash
# M2-19：執行所有 memory 整合測試
# 用法：bash tests/integration/memory/run-all.sh

set -e
cd "$(dirname "$0")/../../.."

echo "╔══════════════════════════════════════╗"
echo "║  M2-19 Memory Integration Tests     ║"
echo "╚══════════════════════════════════════╝"

TOTAL_PASS=0
TOTAL_FAIL=0
SCRIPTS=(
  "tests/integration/memory/memory-tool-injection.ts"
  "tests/integration/memory/recall-and-prefetch.ts"
  "tests/integration/memory/index-rebuild.ts"
  "tests/integration/memory/m2-22-smoke.ts"
)

for script in "${SCRIPTS[@]}"; do
  echo ""
  echo "━━━ Running: $script ━━━"
  if bun run "$script"; then
    echo "  → PASS"
  else
    echo "  → FAIL"
    TOTAL_FAIL=$((TOTAL_FAIL + 1))
  fi
  TOTAL_PASS=$((TOTAL_PASS + 1))
done

echo ""
echo "════════════════════════════════════════"
echo "Scripts run: $TOTAL_PASS, Failed: $TOTAL_FAIL"
if [ "$TOTAL_FAIL" -gt 0 ]; then
  exit 1
fi
echo "All memory integration tests passed!"
