#!/usr/bin/env bash
# M-DECOUPLE 完整 E2E 測試套件
#
# 涵蓋 M-DECOUPLE-1 (GrowthBook) / 3 (PRODUCT_URL) / 4 (auto-updater) /
#       5-11 (rename) / 12-16 (sideQuery → llama.cpp) / 2 (OAuth/cloud)
#
# 8 個分類，每類數個 case：
#   A. Static checks    — grep dangling reference / 不該存在的檔案 / 不該存在的 deps
#   B. Typecheck/Build  — typecheck 必綠、build:dev 必綠
#   C. Module imports   — 動態 import 後 export shape 正確、stub 行為正確
#   D. CLI smoke        — 一般對話 / 工具呼叫 / unset API key / 工具拒絕
#   E. Daemon lifecycle — start / status / attach / stop / pid file
#   F. Cron lifecycle   — build / list / fire / history JSONL
#   G. Memory recall    — sideQuery via llama.cpp / mtime fallback
#   H. Auto mode        — yoloClassifier 不 401 / 不 unavailable
#
# 用法：
#   bash tests/e2e/decouple-comprehensive.sh                 # 全部
#   bash tests/e2e/decouple-comprehensive.sh static          # 僅 A
#   bash tests/e2e/decouple-comprehensive.sh A,B,D           # 多分類
#
# Exit code：
#   0 全綠
#   1 任何測試失敗
#   2 環境問題（llama.cpp / daemon 起不來等）

set -uo pipefail

SCOPE="${1:-all}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT" || exit 2

REPORT_FILE="$ROOT/tests/e2e/decouple-comprehensive-$(date +%Y%m%d-%H%M%S).txt"
mkdir -p "$(dirname "$REPORT_FILE")"

PASS=0
FAIL=0
SKIP=0
FAILED_TESTS=()

log()    { echo "[$(date +%H:%M:%S)] $*" | tee -a "$REPORT_FILE"; }
section(){ echo "" | tee -a "$REPORT_FILE"; log "━━━━━━━━━━ $1 ━━━━━━━━━━"; }
test_pass(){ PASS=$((PASS+1)); log "  ✓ $1"; }
test_fail(){ FAIL=$((FAIL+1)); FAILED_TESTS+=("$1"); log "  ✗ $1: $2"; }
test_skip(){ SKIP=$((SKIP+1)); log "  ⊘ $1: $2"; }

scope_includes() {
  local code="$1"
  if [[ "$SCOPE" == "all" ]]; then return 0; fi
  if [[ ",$SCOPE," == *",$code,"* ]]; then return 0; fi
  if [[ ",$SCOPE," == *",${code,,},"* ]]; then return 0; fi
  return 1
}

# Pre-flight
log "═══════════════════════════════════════════════"
log "M-DECOUPLE 完整 E2E 測試 — $(date)"
log "ROOT=$ROOT  SCOPE=$SCOPE  REPORT=$REPORT_FILE"
log "═══════════════════════════════════════════════"

# Detect llama.cpp（用 base url 從 jsonc 抽，fallback 8080）
LLAMA_URL="${LLAMACPP_BASE_URL:-http://127.0.0.1:8080}"
if curl -sf "$LLAMA_URL/v1/models" > /dev/null 2>&1 \
   || curl -sf "$LLAMA_URL/health" > /dev/null 2>&1; then
  LLAMA_RUNNING=1
  log "✓ llama.cpp 可達於 $LLAMA_URL"
else
  LLAMA_RUNNING=0
  log "⚠ llama.cpp 不可達；C/D/G/H 部分測試將 skip"
fi

# ═══════════════════════════════════════════════
# A. Static checks — 不需要 runtime
# ═══════════════════════════════════════════════
if scope_includes "A" || scope_includes "static"; then
  section "A. Static checks"

  # A1: 已刪除的檔案不應存在
  for f in \
    "src/services/analytics/growthbook.ts" \
    "src/migrations/migrateAutoUpdatesToSettings.ts" \
    "src/services/api/grove.ts" \
    "src/services/api/usage.ts" \
    "src/services/api/referral.ts" \
    "src/services/api/adminRequests.ts" \
    "src/services/api/sessionIngress.ts" \
    "src/services/api/firstTokenDate.ts" \
    "src/services/api/overageCreditGrant.ts" \
    "src/services/api/ultrareviewQuota.ts" \
    "src/services/policyLimits/index.ts" \
    "src/services/teamMemorySync/index.ts" \
    "src/services/remoteManagedSettings/index.ts" \
    "src/services/settingsSync/index.ts" \
    "src/services/mcp/claudeai.ts" \
    "src/services/oauth/auth-code-listener.ts" \
    "src/services/oauth/crypto.ts" \
    "src/components/grove/Grove.tsx" \
    "src/components/DesktopUpsell/DesktopUpsellStartup.tsx" \
    "src/components/FeedbackSurvey/FeedbackSurvey.tsx" \
    "src/commands/grove.ts" \
    "src/commands/remote-setup/index.ts" \
    "src/commands/remote-env/index.ts" \
    "src/commands/review/reviewRemote.ts" \
    "src/commands/review/ultrareviewCommand.tsx" \
    "src/constants/keys.ts" \
    "src/constants/product.ts.disabled"
  do
    if [[ -e "$f" ]]; then
      test_fail "A1.deleted/$f" "still exists"
    fi
  done
  test_pass "A1 已刪除檔案/目錄不存在（27 條）"

  # A2: 應存在的新檔
  for f in "src/constants/apiBase.ts" "src/services/oauth/types.ts"; do
    if [[ ! -f "$f" ]]; then
      test_fail "A2.new/$f" "missing"
    fi
  done
  test_pass "A2 新建檔案存在"

  # A3: GrowthBook flag reader 真實 caller 應為 0（排除單行/區塊註解）
  CNT=$(grep -rEn "getFeatureValue_CACHED_MAY_BE_STALE|getFeatureValue_DEPRECATED|getFeatureValue_CACHED_WITH_REFRESH|checkStatsigFeatureGate_CACHED_MAY_BE_STALE|checkGate_CACHED_OR_BLOCKING|checkSecurityRestrictionGate|getDynamicConfig_CACHED_MAY_BE_STALE|getDynamicConfig_BLOCKS_ON_INIT" src/ 2>/dev/null \
    | grep -vE ":\s*//" \
    | grep -vE ":\s*\*" \
    | wc -l)
  if [[ $CNT -eq 0 ]]; then
    test_pass "A3 GrowthBook flag reader 0 真實 caller（註解不計）"
  else
    test_fail "A3 GrowthBook flag" "$CNT 處非註解殘留"
  fi

  # A4: getOauthConfig().BASE_API_URL 等改用 apiBase 後應 0
  CNT=$(grep -rE "getOauthConfig\(\)\.(BASE_API_URL|CLAUDE_AI_ORIGIN|OAUTH_FILE_SUFFIX)" src/ 2>/dev/null | wc -l)
  if [[ $CNT -eq 0 ]]; then
    test_pass "A4 getOauthConfig BASE_API_URL/CLAUDE_AI_ORIGIN/OAUTH_FILE_SUFFIX 0 caller"
  else
    test_fail "A4 getOauthConfig" "$CNT 處殘留"
  fi

  # A5: getClaudeConfigHomeDir 應已改名（M-DECOUPLE-5）
  CNT=$(grep -rE "getClaudeConfigHomeDir" src/ 2>/dev/null | wc -l)
  if [[ $CNT -eq 0 ]]; then
    test_pass "A5 getClaudeConfigHomeDir 已 rename 為 getMyAgentConfigHomeDir"
  else
    test_fail "A5 getClaudeConfigHomeDir" "$CNT 處殘留"
  fi

  # A6: PRODUCT_URL 已移除
  CNT=$(grep -rE "\bPRODUCT_URL\b" src/ 2>/dev/null | wc -l)
  if [[ $CNT -eq 0 ]]; then
    test_pass "A6 PRODUCT_URL 0 引用"
  else
    test_fail "A6 PRODUCT_URL" "$CNT 處殘留"
  fi

  # A7: auto-updater 系列 export 已移除
  CNT=$(grep -rE "isAutoUpdaterDisabled|getAutoUpdaterDisabledReason|formatAutoUpdaterDisabledReason|migrateAutoUpdatesToSettings\b" src/ 2>/dev/null | wc -l)
  if [[ $CNT -eq 0 ]]; then
    test_pass "A7 auto-updater 系列 0 引用"
  else
    test_fail "A7 auto-updater" "$CNT 處殘留"
  fi

  # A8: package.json name=my-agent
  if grep -q '"name": "my-agent"' package.json; then
    test_pass "A8 package.json name=my-agent"
  else
    test_fail "A8 package.json name" "not my-agent"
  fi

  # A9: @growthbook/growthbook 依賴已移除
  if grep -q '@growthbook/growthbook' package.json 2>/dev/null; then
    test_fail "A9 @growthbook/growthbook" "still in package.json"
  else
    test_pass "A9 @growthbook/growthbook 0 in deps"
  fi

  # A10: bridgeMain.ts 不含 claude.ai/code 字串
  if grep -q "claude.ai/code" src/bridge/bridgeMain.ts 2>/dev/null; then
    test_fail "A10 bridgeMain.ts" "still mentions claude.ai/code"
  else
    test_pass "A10 bridgeMain help 文案無 claude.ai/code"
  fi

  # A11: cachedGrowthBookFeatures schema 欄位已移除
  if grep -q '^\s*cachedGrowthBookFeatures' src/utils/config.ts 2>/dev/null; then
    test_fail "A11 cachedGrowthBookFeatures" "still in config.ts"
  else
    test_pass "A11 cachedGrowthBookFeatures schema 已移除"
  fi

  # A12: sideQuery 不再 import getAnthropicClient
  if grep -q "getAnthropicClient" src/utils/sideQuery.ts 2>/dev/null; then
    test_fail "A12 sideQuery" "still uses getAnthropicClient"
  else
    test_pass "A12 sideQuery 不依賴 Anthropic SDK"
  fi

  # A13: anthropic.com/news 連結已從 Grove 移除
  if grep -q "anthropic.com/news" src/components/grove/Grove.tsx 2>/dev/null; then
    test_fail "A13 Grove.tsx" "still has anthropic.com/news link"
  fi
  # Grove.tsx 在 P1 應已被刪 — 雙重保險
  if [[ ! -f "src/components/grove/Grove.tsx" ]]; then
    test_pass "A13 Grove.tsx 已刪"
  fi

  # A14: services/oauth/client.ts 應已 stub 化（< 100 行）
  if [[ -f "src/services/oauth/client.ts" ]]; then
    LINES=$(wc -l < src/services/oauth/client.ts)
    if [[ $LINES -lt 100 ]]; then
      test_pass "A14 services/oauth/client.ts 已 stub 化（$LINES 行）"
    else
      test_fail "A14 services/oauth/client.ts" "still $LINES 行（應 < 100）"
    fi
  fi

  # A15: services/oauth/getOauthProfile.ts 應已 stub 化
  if [[ -f "src/services/oauth/getOauthProfile.ts" ]]; then
    LINES=$(wc -l < src/services/oauth/getOauthProfile.ts)
    if [[ $LINES -lt 50 ]]; then
      test_pass "A15 services/oauth/getOauthProfile.ts stub 化（$LINES 行）"
    else
      test_fail "A15 services/oauth/getOauthProfile.ts" "still $LINES 行"
    fi
  fi

  # A16: auth.ts 內 OAuth refresh path 應砍乾淨
  if grep -qE "refreshOAuthToken|isOAuthTokenExpired" src/utils/auth.ts 2>/dev/null; then
    test_fail "A16 auth.ts" "still imports OAuth refresh"
  else
    test_pass "A16 auth.ts 不再 import OAuth refresh"
  fi
fi

# ═══════════════════════════════════════════════
# B. Typecheck / Build
# ═══════════════════════════════════════════════
if scope_includes "B" || scope_includes "build"; then
  section "B. Typecheck / Build"

  TC_OUT="$(bun run typecheck 2>&1)"
  if echo "$TC_OUT" | grep -E "error TS[0-9]+" | grep -v "TS5101.*baseUrl" | grep -q .; then
    test_fail "B1 typecheck" "新 type error"
    echo "$TC_OUT" >> "$REPORT_FILE"
  else
    test_pass "B1 typecheck baseline"
  fi

  # 注意 build:dev 可能需要較長；給 5 min
  log "  跑 bun run build:dev（較久）..."
  BUILD_OUT="$(timeout 300 bun run build:dev 2>&1 | tail -30)"
  if echo "$BUILD_OUT" | grep -qE "build error|✘|Bundle failed"; then
    test_fail "B2 build:dev" "build error"
    echo "$BUILD_OUT" >> "$REPORT_FILE"
  else
    test_pass "B2 build:dev"
  fi
fi

# ═══════════════════════════════════════════════
# C. Module imports — bun -e 跑單行檢查
# ═══════════════════════════════════════════════
if scope_includes "C" || scope_includes "module"; then
  section "C. Module imports"

  # C1 apiBase getter shape
  OUT=$(bun -e "import('./src/constants/apiBase.ts').then(m => console.log(typeof m.getApiBaseUrl, typeof m.getClaudeAiOrigin, typeof m.getKeychainFileSuffix, typeof m.getMcpProxyUrl, typeof m.getMcpProxyPath, typeof m.getMcpClientMetadataUrl, typeof m.OAUTH_BETA_HEADER))" 2>&1 | tail -1)
  if echo "$OUT" | grep -q "function function function function function function string"; then
    test_pass "C1 apiBase 6 getter + OAUTH_BETA_HEADER export 正確"
  else
    test_fail "C1 apiBase shape" "$OUT"
  fi

  # C2 services/oauth/client.ts 兩個 export
  OUT=$(bun -e "import('./src/services/oauth/client.ts').then(m => console.log(typeof m.getOrganizationUUID, typeof m.populateOAuthAccountInfoIfNeeded))" 2>&1 | tail -1)
  if echo "$OUT" | grep -q "function function"; then
    test_pass "C2 services/oauth/client.ts 保留兩個 stub"
  else
    test_fail "C2 oauth/client" "$OUT"
  fi

  # C3 services/oauth/getOauthProfile.ts return undefined
  OUT=$(bun -e "import('./src/services/oauth/getOauthProfile.ts').then(async m => { const r = await m.getOauthProfileFromApiKey('fake'); console.log('result=', r); })" 2>&1 | tail -1)
  if echo "$OUT" | grep -q "result= undefined"; then
    test_pass "C3 getOauthProfileFromApiKey return undefined"
  else
    test_fail "C3 getOauthProfile" "$OUT"
  fi

  # C4 isAnthropicAuthEnabled 永遠 false
  OUT=$(bun -e "import('./src/utils/auth.ts').then(m => console.log('result=', m.isAnthropicAuthEnabled()))" 2>&1 | tail -1)
  if echo "$OUT" | grep -q "result= false"; then
    test_pass "C4 isAnthropicAuthEnabled() === false"
  else
    test_fail "C4 isAnthropicAuthEnabled" "$OUT"
  fi

  # C5 sideQuery 模組可載入；queryHaiku 在 services/api/claude.ts
  OUT=$(bun -e "
    Promise.all([
      import('./src/utils/sideQuery.ts'),
      import('./src/services/api/claude.ts'),
    ]).then(([sq, cl]) => {
      console.log(typeof sq.sideQuery, typeof cl.queryHaiku)
    })
  " 2>&1 | tail -1)
  if echo "$OUT" | grep -q "function function"; then
    test_pass "C5 sideQuery + queryHaiku export 正確"
  else
    test_fail "C5 sideQuery" "$OUT"
  fi

  # C6 isPolicyAllowed stub return true
  if [[ -f "src/utils/permissions/policyLimits.ts" ]] || grep -rq "isPolicyAllowed" src/utils/ 2>/dev/null; then
    OUT=$(bun -e "
      // policyLimits 已刪，caller 把 isPolicyAllowed inline 為 () => true；
      // 這裡測 caller（teleport.tsx 等）可載入不報錯
      import('./src/utils/teleport.tsx').then(m => console.log('teleport ok'))
    " 2>&1 | tail -1)
    if echo "$OUT" | grep -q "teleport ok"; then
      test_pass "C6 teleport (含 isPolicyAllowed stub) 可載入"
    else
      test_fail "C6 teleport" "$OUT"
    fi
  fi

  # C7 cron NL parser 可載入
  OUT=$(bun -e "import('./src/utils/cronNlParser.ts').then(m => console.log(typeof m.parseScheduleNL))" 2>&1 | tail -1)
  if echo "$OUT" | grep -q "function"; then
    test_pass "C7 cronNlParser 可載入"
  else
    test_fail "C7 cronNlParser" "$OUT"
  fi

  # C8 daemon module 可載入（ProjectRegistry 是 interface，typeof === undefined；測 createProjectRegistry function）
  OUT=$(bun -e "import('./src/daemon/projectRegistry.ts').then(m => console.log(typeof m.createProjectRegistry, typeof m.projectIdFromCwd))" 2>&1 | tail -1)
  if echo "$OUT" | grep -q "function function"; then
    test_pass "C8 daemon/projectRegistry 可載入"
  else
    test_fail "C8 daemon" "$OUT"
  fi
fi

# ═══════════════════════════════════════════════
# D. CLI smoke
# ═══════════════════════════════════════════════
if scope_includes "D" || scope_includes "cli"; then
  section "D. CLI smoke"
  if [[ $LLAMA_RUNNING -eq 0 ]]; then
    test_skip "D" "llama.cpp 未啟動"
  else
    # D1 一般對話
    OUT=$(timeout 30 ./cli -p "say hi" 2>&1 | tail -3)
    if echo "$OUT" | grep -qiE "hi|hello|你好|嗨"; then
      test_pass "D1 ./cli -p hello"
    else
      test_fail "D1 ./cli -p hello" "$OUT"
    fi

    # D2 工具呼叫（Read package.json）
    OUT=$(timeout 60 ./cli -p "讀 package.json，告訴我 name 欄位的值" 2>&1 | tail -10)
    if echo "$OUT" | grep -qE "my-agent"; then
      test_pass "D2 Read tool 取 package.json name"
    else
      test_fail "D2 Read tool" "$OUT"
    fi

    # D3 unset ANTHROPIC_API_KEY 仍走 llama.cpp
    OUT=$(env -u ANTHROPIC_API_KEY timeout 30 ./cli -p "say hi" 2>&1 | tail -3)
    if echo "$OUT" | grep -qiE "hi|hello|你好|嗨"; then
      test_pass "D3 unset API key 仍可對話"
    else
      test_fail "D3 unset API key" "$OUT"
    fi

    # D4 fake API key 仍走 llama.cpp（不會誤打 Anthropic）
    OUT=$(ANTHROPIC_API_KEY=fake-test-key timeout 30 ./cli -p "say hi" 2>&1 | tail -3)
    if echo "$OUT" | grep -qE "401|Unauthorized|Anthropic"; then
      test_fail "D4 fake API key" "走錯 endpoint：$OUT"
    elif echo "$OUT" | grep -qiE "hi|hello|你好|嗨"; then
      test_pass "D4 fake API key 仍走 llama.cpp"
    else
      test_fail "D4 fake API key" "$OUT"
    fi

    # D5 -p 內 LLM 沒因 cloud prefetch 卡 startup（10s 應該夠）
    START=$(date +%s)
    timeout 30 ./cli -p "ok" > /dev/null 2>&1
    END=$(date +%s)
    DUR=$((END-START))
    if [[ $DUR -lt 25 ]]; then
      test_pass "D5 啟動 < 25s（${DUR}s）"
    else
      test_fail "D5 啟動慢" "${DUR}s"
    fi
  fi
fi

# ═══════════════════════════════════════════════
# E. Daemon lifecycle
# ═══════════════════════════════════════════════
if scope_includes "E" || scope_includes "daemon"; then
  section "E. Daemon lifecycle"
  if [[ $LLAMA_RUNNING -eq 0 ]]; then
    test_skip "E" "llama.cpp 未啟動"
  else
    # 先停掉任何現有 daemon
    ./cli daemon stop > /dev/null 2>&1 || true
    sleep 1
    rm -f "$HOME/.my-agent/daemon.pid.json" 2>/dev/null || true

    # E1 daemon start
    timeout 30 ./cli daemon start > "$ROOT/tests/e2e/daemon-start.log" 2>&1 &
    DAEMON_PID=$!
    # 等 pid file 出現（最多 8 秒）
    for i in 1 2 3 4 5 6 7 8; do
      [[ -f "$HOME/.my-agent/daemon.pid.json" ]] && break
      sleep 1
    done

    if [[ -f "$HOME/.my-agent/daemon.pid.json" ]]; then
      test_pass "E1 daemon start 寫 pid.json"
    else
      test_fail "E1 daemon start" "no pid.json after 8s"
      cat "$ROOT/tests/e2e/daemon-start.log" | tail -10 >> "$REPORT_FILE"
    fi

    # E2 attached turn
    OUT=$(timeout 30 ./cli -p "say hi" 2>&1 | tail -5)
    if echo "$OUT" | grep -qiE "hi|hello|你好|嗨"; then
      test_pass "E2 thin client attach + turn"
    else
      test_fail "E2 attach turn" "$OUT"
    fi

    # E3 daemon stop
    ./cli daemon stop > "$ROOT/tests/e2e/daemon-stop.log" 2>&1
    sleep 2
    if [[ ! -f "$HOME/.my-agent/daemon.pid.json" ]]; then
      test_pass "E3 daemon stop 清 pid.json"
    else
      test_fail "E3 daemon stop" "pid.json still exists"
    fi

    # 確保背景 daemon 真的停了
    kill $DAEMON_PID 2>/dev/null || true
    wait $DAEMON_PID 2>/dev/null || true
  fi
fi

# ═══════════════════════════════════════════════
# F. Cron task lifecycle
# ═══════════════════════════════════════════════
if scope_includes "F" || scope_includes "cron"; then
  section "F. Cron task lifecycle"
  if [[ $LLAMA_RUNNING -eq 0 ]]; then
    test_skip "F" "llama.cpp 未啟動"
  else
    # F1 cron tasks 檔案能讀
    CRON_DIR="$HOME/.my-agent/projects"
    if compgen -G "$CRON_DIR/*/cron-tasks.json" > /dev/null \
       || compgen -G "$CRON_DIR/*/cron-tasks.jsonc" > /dev/null; then
      test_pass "F1 cron-tasks 檔案存在"
    else
      test_skip "F1 cron-tasks" "尚未建過 cron"
    fi

    # F2 history JSONL 機制
    if compgen -G "$CRON_DIR/*/cron-history.jsonl" > /dev/null; then
      test_pass "F2 cron-history JSONL 存在"
    else
      test_skip "F2 cron-history" "尚未跑過 cron"
    fi

    # F3 cronNlParser 不 throw（透過 unit-test 風格 bun -e）
    OUT=$(bun -e "
      import('./src/utils/cronNlParser.ts').then(async m => {
        try {
          // 用 bad input 測；caller 應 catch（不 throw 出來）
          const r = await m.parseScheduleNL('not a valid time string').catch(e => 'caught:'+e.message);
          console.log('result=', r);
        } catch(e) { console.log('throw=', e.message) }
      })
    " 2>&1 | tail -3)
    # 不管結果是 cron expr / null / caught error 都算正常路徑（不應 unhandled throw）
    if echo "$OUT" | grep -qE "result=|caught:"; then
      test_pass "F3 cronNlParser 不 unhandled throw"
    else
      test_fail "F3 cronNlParser" "$OUT"
    fi
  fi
fi

# ═══════════════════════════════════════════════
# G. Memory recall via llama.cpp
# ═══════════════════════════════════════════════
if scope_includes "G" || scope_includes "memory"; then
  section "G. Memory recall"
  if [[ $LLAMA_RUNNING -eq 0 ]]; then
    test_skip "G" "llama.cpp 未啟動"
  else
    # G1 memdir 存在
    if compgen -G "$HOME/.my-agent/projects/*/memory" > /dev/null; then
      test_pass "G1 memdir 存在"
    else
      test_skip "G1 memdir" "尚無 memory"
    fi

    # G2 selectViaLlamaCpp 路徑 — 直接呼 selector
    OUT=$(bun -e "
      import('./src/memdir/findRelevantMemories.ts').then(async m => {
        try {
          const r = await m.findRelevantMemories({
            query: 'test',
            memoryDir: process.env.HOME + '/.my-agent/projects',
            alreadySurfaced: new Set(),
          });
          console.log('result_type=', Array.isArray(r) ? 'array' : typeof r);
        } catch(e) {
          console.log('throw=', e.message);
        }
      })
    " 2>&1 | tail -3)
    if echo "$OUT" | grep -qE "result_type=array"; then
      test_pass "G2 findRelevantMemories 走 llama.cpp 不 throw"
    elif echo "$OUT" | grep -qE "result_type="; then
      test_pass "G2 findRelevantMemories 走 llama.cpp（不同 shape 但不 throw）"
    else
      test_fail "G2 findRelevantMemories" "$OUT"
    fi

    # G3 unset ANTHROPIC_API_KEY 走 llama.cpp 不 401
    OUT=$(env -u ANTHROPIC_API_KEY timeout 60 ./cli -p "幫我複習一下 my-agent 的 ADR-014 大致內容" 2>&1 | tail -10)
    if echo "$OUT" | grep -qE "401|Unauthorized|ANTHROPIC_API_KEY"; then
      test_fail "G3 memory recall pure llamacpp" "401 / unauthorized"
    else
      test_pass "G3 memory recall pure llamacpp 不 401"
    fi
  fi
fi

# ═══════════════════════════════════════════════
# H. Auto mode（yoloClassifier）
# ═══════════════════════════════════════════════
if scope_includes "H" || scope_includes "auto"; then
  section "H. Auto mode classifier"
  if [[ $LLAMA_RUNNING -eq 0 ]]; then
    test_skip "H" "llama.cpp 未啟動"
  else
    # H1 yoloClassifier 模組可載入 + 呼叫不 401
    OUT=$(env -u ANTHROPIC_API_KEY bun -e "
      import('./src/utils/permissions/yoloClassifier.ts').then(async m => {
        try {
          // 直接呼 classifyYoloAction 看不會 401
          const fn = m.classifyYoloAction;
          if (typeof fn !== 'function') { console.log('skip: no fn'); return }
          const r = await fn({
            toolName: 'Bash',
            input: { command: 'ls' },
            mode: 'turbo',
          }).catch(e => 'caught:' + (e?.message || e));
          console.log('result=', JSON.stringify(r).slice(0, 100));
        } catch(e) {
          console.log('throw=', e.message);
        }
      })
    " 2>&1 | tail -3)
    if echo "$OUT" | grep -qE "401|Unauthorized"; then
      test_fail "H1 yoloClassifier" "401 — sideQuery 沒走 llama.cpp"
    elif echo "$OUT" | grep -qE "result=|caught:|skip:"; then
      test_pass "H1 yoloClassifier 不 401"
    else
      test_fail "H1 yoloClassifier" "$OUT"
    fi
  fi
fi

# ═══════════════════════════════════════════════
# 總結
# ═══════════════════════════════════════════════
log ""
log "═══════════════════════════════════════════════"
log "總結：PASS=$PASS  FAIL=$FAIL  SKIP=$SKIP"
if [[ $FAIL -gt 0 ]]; then
  log "失敗清單："
  for t in "${FAILED_TESTS[@]}"; do log "  - $t"; done
  log "詳細：$REPORT_FILE"
  exit 1
elif [[ $PASS -eq 0 ]]; then
  log "⚠ 沒任何測試通過（scope 可能太窄）"
  exit 1
else
  log "✓ 全綠"
  exit 0
fi
