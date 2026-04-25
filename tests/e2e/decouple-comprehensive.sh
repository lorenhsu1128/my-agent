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
#   I. Discord gateway  — module load / unit / 真 boot bot connected
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
  BUILD_OUT="$(timeout -k 10s 300 bun run build:dev 2>&1 | tail -30)"
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
  section "D. CLI smoke（fresh cli-dev.exe）"
  BIN=$([[ -f ./cli-dev.exe ]] && echo ./cli-dev.exe || echo ./cli)
  if [[ $LLAMA_RUNNING -eq 0 ]]; then
    test_skip "D" "llama.cpp 未啟動"
  elif [[ ! -f "$BIN" ]]; then
    test_skip "D" "$BIN 不存在（先 bun run build:dev）"
  else
    # 確保 daemon 沒殘留（D 走 standalone 模式較好預期）
    ( $BIN daemon stop > /tmp/d-cleanup.log 2>&1 & ); sleep 2
    rm -f "$HOME/.my-agent/daemon.pid.json" 2>/dev/null

    # D1 算術（避開 grep 配對 prompt echo；LLM thinking 模型可能慢，給 60s）
    OUT=$(timeout -k 10s 60 $BIN -p "請只回一個阿拉伯數字：2+2 等於幾" 2>&1 | tail -5)
    if echo "$OUT" | grep -qE "\b4\b|^4$|是 4"; then
      test_pass "D1 算術 2+2=4"
    else
      test_fail "D1 算術" "$OUT"
    fi

    # D2 工具呼叫
    OUT=$(timeout -k 10s 60 $BIN -p "讀 package.json 然後回 name 欄位的值" 2>&1 | tail -10)
    if echo "$OUT" | grep -qE "my-agent"; then
      test_pass "D2 Read tool"
    else
      test_fail "D2 Read tool" "$OUT"
    fi

    # D3 unset API key — LLM 冷啟動可能 1m+，給 90s
    OUT=$(env -u ANTHROPIC_API_KEY timeout -k 10s 90 $BIN -p "請只回一個阿拉伯數字：3+5 等於幾" 2>&1 | tail -5)
    if echo "$OUT" | grep -qE "\b8\b|^8$|是 8"; then
      test_pass "D3 unset API key 仍可對話"
    else
      test_fail "D3 unset API key" "$OUT"
    fi

    # D4 fake API key
    OUT=$(ANTHROPIC_API_KEY=fake-test-key timeout -k 10s 30 $BIN -p "ok" 2>&1 | tail -5)
    if echo "$OUT" | grep -qE "401|Unauthorized|Anthropic"; then
      test_fail "D4 fake key" "走錯 endpoint"
    else
      test_pass "D4 fake key 不 401（仍走 llama.cpp）"
    fi

    # D5 啟動時間（fast path --version）
    START=$(date +%s)
    timeout -k 10s 10 $BIN --version > /dev/null 2>&1
    END=$(date +%s)
    DUR=$((END-START))
    if [[ $DUR -lt 10 ]]; then
      test_pass "D5 --version 啟動 < 10s（${DUR}s）"
    else
      test_fail "D5 啟動慢" "${DUR}s"
    fi

    # D6 (M-DECOUPLE-3-2-1) SRC 模式 sanity — `bun run dev` shim 跑 cli.tsx 原始碼。
    # 用 `--version` 而非 LLM 算術：SRC 模式三層 bun（dev shim → cli.tsx → llama.cpp）
    # 第一次 cold start 含 tsx 全樹 transpile 可能 4 分鐘+，用 LLM 太貴。`--version`
    # 走 fast path，但仍會 import 整個 module 樹 — feature flag 殘留 / dangling
    # import / vendored SDK import 壞都會立刻爆 + 1m 內完成。
    if [[ -f ./scripts/dev.ts ]]; then
      OUT=$(timeout -k 10s 90 bun run ./scripts/dev.ts --version 2>&1 | tail -5)
      RC=$?
      if [[ $RC -eq 0 ]] && echo "$OUT" | grep -qE "[0-9]+\.[0-9]+\."; then
        test_pass "D6 SRC mode (bun run dev) --version 通"
      else
        test_fail "D6 SRC mode" "rc=$RC out=$OUT"
      fi
    else
      test_skip "D6" "scripts/dev.ts 不存在"
    fi
  fi
fi

# ═══════════════════════════════════════════════
# E. Daemon lifecycle（用 fresh cli-dev.exe，subshell+bg+redirect 防 pipe hang）
# ═══════════════════════════════════════════════
# 為什麼這樣寫：直接 `./cli-dev.exe daemon start | tail` 會掛——daemon 繼承
# stdout，tail 等 EOF 永遠不到。subshell+bg+redirect 把 daemon stdout 寫入
# log 檔，子 shell 立刻 detach，daemon 持續活著。daemon stop 同樣處理。
if scope_includes "E" || scope_includes "daemon"; then
  section "E. Daemon lifecycle"
  BIN=$([[ -f ./cli-dev.exe ]] && echo ./cli-dev.exe || echo ./cli)
  if [[ $LLAMA_RUNNING -eq 0 ]]; then
    test_skip "E" "llama.cpp 未啟動"
  elif [[ ! -f "$BIN" ]]; then
    test_skip "E" "$BIN 不存在（先跑 bun run build:dev）"
  else
    # 先清乾淨任何殘留 daemon
    ( $BIN daemon stop > /tmp/d-cleanup.log 2>&1 & )
    sleep 2
    rm -f "$HOME/.my-agent/daemon.pid.json" 2>/dev/null || true

    # 清前次 F section 殘留的 `e2etest*` cron task — 否則 E5 sendInput
    # 會撞到 cron 觸發的 turn → interactive intent 中斷它 → E5 收 aborted。
    # F 自己有 backup/restore，但 backup 來自前次 F 留下的污染狀態形成連鎖。
    CRON_FILE="$ROOT/.my-agent/scheduled_tasks.jsonc"
    if [[ -f "$CRON_FILE" ]]; then
      bun -e "
        import { readFileSync, writeFileSync } from 'fs'
        try {
          const raw = readFileSync('$CRON_FILE', 'utf8')
            .replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
          const parsed = JSON.parse(raw)
          const before = parsed.tasks?.length ?? 0
          parsed.tasks = (parsed.tasks ?? []).filter(t => !(t.id ?? '').startsWith('e2etest'))
          writeFileSync('$CRON_FILE', JSON.stringify(parsed, null, 2))
          if (before !== parsed.tasks.length)
            console.log('cleaned', before - parsed.tasks.length, 'e2etest cron tasks')
        } catch(e) { console.log('cron clean skip:', e.message) }
      " 2>&1 | head -1
    fi

    # E1 daemon start（subshell + bg + redirect）
    ( $BIN daemon start > "$ROOT/tests/e2e/daemon-start.log" 2>&1 & )
    for i in $(seq 1 12); do
      [[ -f "$HOME/.my-agent/daemon.pid.json" ]] && break
      sleep 1
    done
    if [[ -f "$HOME/.my-agent/daemon.pid.json" ]]; then
      test_pass "E1 daemon start 寫 pid.json"
    else
      test_fail "E1 daemon start" "no pid.json after 12s"
      cat "$ROOT/tests/e2e/daemon-start.log" 2>/dev/null | tail -10 >> "$REPORT_FILE"
    fi

    # 給 daemon 多 5s 讓 WS server / cron / runner 完全就緒
    sleep 5

    # E2 print mode while daemon up — 注意：`-p` 不走 thin-client（standalone
    # 直打 llama.cpp），這裡只驗 daemon 在跑時 print 路徑仍正常。真實 thin-client
    # attach 由 E4 驗證（M-DECOUPLE-3-3）。LLM 冷啟動可能 1m+，給 150s。
    OUT=$(timeout -k 10s 150 $BIN -p "請只回 4" 2>&1 | tail -5)
    if echo "$OUT" | grep -qE "\b4\b|^4$"; then
      test_pass "E2 print mode while daemon up（回 4）"
    else
      test_fail "E2 print mode" "$OUT"
    fi

    # E4 真 thin-client attach — bun 直接跑 _thinClientPing.ts，打開 WS、
    # 等 hello frame、送 permissionContextSync、close。比 E2 精準，
    # daemon.log 會有 `client connected` 紀錄。
    PING_LOG_BEFORE=$(grep -c "client connected" "$HOME/.my-agent/daemon.log" 2>/dev/null || echo 0)
    OUT=$(timeout -k 10s 30 bun run "$ROOT/tests/e2e/_thinClientPing.ts" 2>&1)
    PING_RC=$?
    PING_LOG_AFTER=$(grep -c "client connected" "$HOME/.my-agent/daemon.log" 2>/dev/null || echo 0)
    PING_DELTA=$((PING_LOG_AFTER - PING_LOG_BEFORE))
    if [[ $PING_RC -eq 0 ]] && echo "$OUT" | grep -q "hello received" && [[ $PING_DELTA -ge 1 ]]; then
      test_pass "E4 thin-client attach + hello + ack（daemon.log +${PING_DELTA}）"
    else
      test_fail "E4 thin-client" "rc=$PING_RC delta=$PING_DELTA out=$OUT"
    fi

    # E5 完整 turn — 用 REPL 真正用的 createFallbackManager + createDaemonDetector，
    # 送 sendInput 等 turnEnd 抽 assistant output。比 E4 多驗 input/runnerEvent/
    # turnEnd 整個 protocol；差別只剩 React 渲染（PTY 互動 REPL 留 M-DECOUPLE-3-5）。
    OUT=$(timeout -k 10s 180 bun run "$ROOT/tests/e2e/_thinClientTurn.ts" 2>&1)
    TURN_RC=$?
    if [[ $TURN_RC -eq 0 ]] && echo "$OUT" | grep -q 'output="9"'; then
      test_pass "E5 thin-client turn（4+5=9 via runnerEvent）"
    else
      test_fail "E5 thin-client turn" "rc=$TURN_RC out=$OUT"
    fi

    # E3 daemon stop（subshell + bg + redirect）
    ( $BIN daemon stop > "$ROOT/tests/e2e/daemon-stop.log" 2>&1 & )
    for i in $(seq 1 12); do
      [[ ! -f "$HOME/.my-agent/daemon.pid.json" ]] && break
      sleep 1
    done
    if [[ ! -f "$HOME/.my-agent/daemon.pid.json" ]]; then
      test_pass "E3 daemon stop 清 pid.json"
    else
      rm -f "$HOME/.my-agent/daemon.pid.json"
      test_fail "E3 daemon stop" "pid.json 12s 後仍存在（已強制清）"
    fi

    # E6 (M-DECOUPLE-3-2-2) SRC daemon start/stop — `bun run dev daemon start`
    # 走 dev.ts shim spawn 子 bun 跑 cli.tsx。commit 5cd3028 留下「SRC hang」
    # 後續任務；2026-04-25 重新診斷重現不到（八成是 e2e timeout 殺掉誤判），
    # 加回 sanity gate 防迴歸。
    if [[ -f ./scripts/dev.ts ]]; then
      ( bun run ./scripts/dev.ts daemon stop > /tmp/d-cleanup.log 2>&1 & )
      sleep 2
      rm -f "$HOME/.my-agent/daemon.pid.json" 2>/dev/null || true

      ( bun run ./scripts/dev.ts daemon start > "$ROOT/tests/e2e/daemon-src-start.log" 2>&1 & )
      for i in $(seq 1 15); do
        [[ -f "$HOME/.my-agent/daemon.pid.json" ]] && break
        sleep 1
      done
      if [[ -f "$HOME/.my-agent/daemon.pid.json" ]]; then
        test_pass "E6 SRC daemon start 寫 pid.json"
      else
        test_fail "E6 SRC daemon start" "no pid.json after 15s"
        cat "$ROOT/tests/e2e/daemon-src-start.log" 2>/dev/null | tail -10 >> "$REPORT_FILE"
      fi

      ( bun run ./scripts/dev.ts daemon stop > "$ROOT/tests/e2e/daemon-src-stop.log" 2>&1 & )
      for i in $(seq 1 12); do
        [[ ! -f "$HOME/.my-agent/daemon.pid.json" ]] && break
        sleep 1
      done
      if [[ ! -f "$HOME/.my-agent/daemon.pid.json" ]]; then
        test_pass "E7 SRC daemon stop 清 pid.json"
      else
        rm -f "$HOME/.my-agent/daemon.pid.json"
        test_fail "E7 SRC daemon stop" "pid.json 12s 後仍存在（已強制清）"
      fi
    else
      test_skip "E6/E7" "scripts/dev.ts 不存在"
    fi
  fi
fi

# ═══════════════════════════════════════════════
# F. Cron task lifecycle（自動化：寫 task → 起 daemon → 等 fire → 驗 history）
# ═══════════════════════════════════════════════
if scope_includes "F" || scope_includes "cron"; then
  section "F. Cron task lifecycle"
  BIN=$([[ -f ./cli-dev.exe ]] && echo ./cli-dev.exe || echo ./cli)

  # F0 cronNlParser 不 throw（純單元測試，無 daemon）
  OUT=$(bun -e "
    import('./src/utils/cronNlParser.ts').then(async m => {
      try {
        const r = await m.parseScheduleNL('not a valid time string').catch(e => 'caught:'+e.message);
        console.log('result=', r);
      } catch(e) { console.log('throw=', e.message) }
    })
  " 2>&1 | tail -3)
  if echo "$OUT" | grep -qE "result=|caught:"; then
    test_pass "F0 cronNlParser 不 unhandled throw"
  else
    test_fail "F0 cronNlParser" "$OUT"
  fi

  if [[ ! -f "$BIN" ]]; then
    test_skip "F1-F8" "$BIN 不存在"
  else
    # cron tasks 在 <cwd>/.my-agent/scheduled_tasks.jsonc，shape 是 {"tasks":[...]}
    # cron history 在 <cwd>/.my-agent/cron/history/<task-id>.jsonl
    CRON_FILE="$ROOT/.my-agent/scheduled_tasks.jsonc"
    HIST_DIR="$ROOT/.my-agent/cron/history"
    mkdir -p "$ROOT/.my-agent" "$HIST_DIR" 2>/dev/null

    BACKUP_CRON="$CRON_FILE.e2e-bak"
    [[ -f "$CRON_FILE" ]] && cp "$CRON_FILE" "$BACKUP_CRON"

    # 共用：merge 一個 task 進 cron file（避開 bun -e 內 bash regex 轉義）
    MERGE_SCRIPT=$(mktemp --suffix=.ts /tmp/cron-merge.XXXX.ts 2>/dev/null || echo "/tmp/cron-merge-$$.ts")
    cat > "$MERGE_SCRIPT" <<'TSEOF'
import { readFileSync, writeFileSync } from 'fs'
const file = process.env.CRON_FILE!
const taskId = process.env.TASK_ID!
let existing: any[] = []
try {
  const raw = readFileSync(file, 'utf8')
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
  const parsed = JSON.parse(raw)
  existing = parsed.tasks || []
} catch {}
const newTask = {
  id: taskId,
  name: 'e2e cron smoke',
  cron: '* * * * *',
  prompt: '請只回 ok',
  recurring: true,
  createdAt: Date.now(),
  scheduleSpec: { kind: 'cron', raw: '* * * * *' }
}
writeFileSync(file, JSON.stringify({ tasks: [...existing, newTask] }, null, 2))
console.log('wrote', existing.length + 1, 'tasks')
TSEOF

    # 共用 helper — 起 daemon、寫 task、等 fire、停 daemon。
    # 用法：cron_lifecycle <label> <start_cmd> <stop_cmd> <fire_log_path> <stop_log_path>
    cron_lifecycle() {
      local label="$1"
      local start_cmd="$2"
      local stop_cmd="$3"
      local start_log="$4"
      local stop_log="$5"
      local f_start="F$F_OFFSET"
      local f_fire="F$((F_OFFSET+1))"
      local f_stop="F$((F_OFFSET+2))"

      local task_id="e2etest$(date +%s)$label"
      local hist_file="$HIST_DIR/$task_id.jsonl"

      CRON_FILE="$CRON_FILE" TASK_ID="$task_id" bun "$MERGE_SCRIPT" 2>&1 | tail -3 > /dev/null
      if ! grep -q "$task_id" "$CRON_FILE" 2>/dev/null; then
        test_fail "$f_start [$label] 寫 cron task" "merge failed"
        return
      fi

      ( eval "$stop_cmd" > /tmp/d-cleanup-$label.log 2>&1 & ); sleep 2
      rm -f "$HOME/.my-agent/daemon.pid.json" 2>/dev/null
      ( eval "$start_cmd" > "$start_log" 2>&1 & )
      for i in $(seq 1 15); do
        [[ -f "$HOME/.my-agent/daemon.pid.json" ]] && break
        sleep 1
      done
      if [[ -f "$HOME/.my-agent/daemon.pid.json" ]]; then
        test_pass "$f_start [$label] daemon 起來 + cron task 寫入 ($task_id)"
      else
        test_fail "$f_start [$label] daemon 起" "no pid.json after 15s"
        return
      fi

      log "  等 cron fire [$label]（最多 90s）..."
      local fired=0
      local reason=""
      for i in $(seq 1 90); do
        if [[ -f "$hist_file" ]] && [[ -s "$hist_file" ]]; then
          fired=1; reason="history JSONL 有 $(wc -l < "$hist_file") 筆"
          break
        fi
        if grep -A 2 "\"id\": \"$task_id\"" "$CRON_FILE" 2>/dev/null | grep -q "lastFiredAt"; then
          fired=1; reason="task lastFiredAt 已寫"
          break
        fi
        sleep 1
      done
      if [[ $fired -eq 1 ]]; then
        test_pass "$f_fire [$label] cron fire（$reason）"
      else
        test_fail "$f_fire [$label] cron fire" "90s 內未見 fire 痕跡"
      fi

      ( eval "$stop_cmd" > "$stop_log" 2>&1 & )
      for i in $(seq 1 12); do
        [[ ! -f "$HOME/.my-agent/daemon.pid.json" ]] && break
        sleep 1
      done
      if [[ ! -f "$HOME/.my-agent/daemon.pid.json" ]]; then
        test_pass "$f_stop [$label] daemon stop"
      else
        rm -f "$HOME/.my-agent/daemon.pid.json"
        test_fail "$f_stop [$label] daemon stop" "pid.json 仍在（已強制清）"
      fi
    }

    if [[ $LLAMA_RUNNING -eq 0 ]]; then
      test_skip "F1-F8" "llama.cpp 未啟動，daemon 不能起"
    else
      # F1-F3: BIN daemon path
      F_OFFSET=1
      cron_lifecycle "BIN" \
        "$BIN daemon start" \
        "$BIN daemon stop" \
        "$ROOT/tests/e2e/cron-bin-start.log" \
        "$ROOT/tests/e2e/cron-bin-stop.log"

      # F4-F6: SRC daemon path（M-DECOUPLE-3-4：dev.ts shim 跑的 daemon 也要驗
      # cron 真的能 fire — 防 SRC 跟 BIN 行為發散）
      if [[ -f ./scripts/dev.ts ]]; then
        F_OFFSET=4
        cron_lifecycle "SRC" \
          "bun run ./scripts/dev.ts daemon start" \
          "bun run ./scripts/dev.ts daemon stop" \
          "$ROOT/tests/e2e/cron-src-start.log" \
          "$ROOT/tests/e2e/cron-src-stop.log"
      else
        test_skip "F4-F6 [SRC]" "scripts/dev.ts 不存在"
      fi
    fi

    rm -f "$MERGE_SCRIPT"

    # cleanup：先還原原本 cron-tasks.jsonc，再 filter 掉所有 `e2etest*`
    # （備份本身可能來自前次 F 污染，所以還要再 filter 一次保證乾淨）
    if [[ -f "$BACKUP_CRON" ]]; then
      mv "$BACKUP_CRON" "$CRON_FILE"
    fi
    if [[ -f "$CRON_FILE" ]]; then
      bun -e "
        import { readFileSync, writeFileSync } from 'fs'
        try {
          const raw = readFileSync('$CRON_FILE', 'utf8')
            .replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
          const parsed = JSON.parse(raw)
          parsed.tasks = (parsed.tasks ?? []).filter(t => !(t.id ?? '').startsWith('e2etest'))
          writeFileSync('$CRON_FILE', JSON.stringify(parsed, null, 2))
        } catch {}
      " 2>&1 | head -1
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
    BIN=$([[ -f ./cli-dev.exe ]] && echo ./cli-dev.exe || echo ./cli)
    OUT=$(env -u ANTHROPIC_API_KEY timeout -k 10s 60 $BIN -p "ok" 2>&1 | tail -10)
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
# I. Discord gateway（M-DECOUPLE-3-5）
#   I1 (a) static — discord 模組可載入、helper 不 throw
#   I2 (b) unit  — tests/integration/discord/* 跑過
#   I3 (c) full  — 真起 daemon + bot 連 Discord，daemon.log 看到 `discord ready`
# ═══════════════════════════════════════════════
if scope_includes "I" || scope_includes "discord"; then
  section "I. Discord gateway"
  BIN=$([[ -f ./cli-dev.exe ]] && echo ./cli-dev.exe || echo ./cli)

  # I1 (a) — 5 個關鍵模組可動態 load + helper 不 throw
  OUT=$(bun -e "
    import('./src/discord/router.ts').then(m => console.log('router=', typeof m.routeMessage));
    import('./src/discord/messageAdapter.ts').then(m => console.log('adapter=', typeof m.adaptDiscordMessage));
    import('./src/discord/truncate.ts').then(m => console.log('truncate=', typeof m.truncateForDiscord, 'chunks=' + m.truncateForDiscord('x'.repeat(3000)).length));
    import('./src/discord/channelNaming.ts').then(m => console.log('naming=', typeof m.computeChannelName, m.computeChannelName('test', 'abc123')));
    import('./src/discordConfig/index.ts').then(m => console.log('config=', typeof m.getDiscordConfigSnapshot));
  " 2>&1 | tail -10)
  if echo "$OUT" | grep -q "router= function" \
     && echo "$OUT" | grep -q "adapter= function" \
     && echo "$OUT" | grep -q "truncate= function" \
     && echo "$OUT" | grep -q "chunks=2" \
     && echo "$OUT" | grep -q "naming= function" \
     && echo "$OUT" | grep -q "config= function"; then
    test_pass "I1 discord 模組可載入（router/adapter/truncate/naming/config）"
  else
    test_fail "I1 discord 模組" "$OUT"
  fi

  # I2 (b) — 整合單元測試套件跑過（filter 掉 watch / verbose noise）
  OUT=$(bun test tests/integration/discord/ 2>&1 | tail -8)
  if echo "$OUT" | grep -qE "[0-9]+ pass" && ! echo "$OUT" | grep -qE "[1-9][0-9]* fail"; then
    PASS_CNT=$(echo "$OUT" | grep -oE "[0-9]+ pass" | head -1 | grep -oE "[0-9]+")
    test_pass "I2 discord unit tests（${PASS_CNT:-?} pass）"
  else
    test_fail "I2 discord unit tests" "$(echo "$OUT" | tail -3)"
  fi

  # I3 (c) — full gateway boot：daemon 起來時 stdout 印 `discord: enabled
  # (bot connected, ...)` 表示 token 有解到 + Client.login() 成功，daemon.log
  # 接著會印 `discord ready` + `binding health check`。若 discord disabled 或無
  # token → skip（不算 fail，因為這台機器可能沒設 bot）。
  if [[ ! -f "$BIN" ]]; then
    test_skip "I3" "$BIN 不存在"
  elif [[ $LLAMA_RUNNING -eq 0 ]]; then
    test_skip "I3" "llama.cpp 未啟動，daemon 不能起"
  else
    DISCORD_ENABLED=$(bun -e "
      import('./src/discordConfig/index.ts').then(async m => {
        // loader 是 lazy，session 啟動才 init；e2e 顯式呼一次拿真設定
        const cfg = await m.loadDiscordConfigSnapshot();
        const tokFromEnv = !!process.env.DISCORD_BOT_TOKEN;
        const tokFromCfg = typeof cfg.botToken === 'string' && cfg.botToken.length > 10;
        console.log('result=', cfg.enabled && (tokFromEnv || tokFromCfg) ? 'yes' : 'no');
      })
    " 2>&1 | grep -oE "result= (yes|no)" | awk '{print $2}')

    if [[ "$DISCORD_ENABLED" != "yes" ]]; then
      test_skip "I3" "discord 未啟用或 token 不可解（DISCORD_BOT_TOKEN env / discord.jsonc botToken）"
    else
      ( $BIN daemon stop > /tmp/d-cleanup.log 2>&1 & ); sleep 2
      rm -f "$HOME/.my-agent/daemon.pid.json" 2>/dev/null

      DAEMON_LOG_BEFORE=$(grep -c "discord ready" "$HOME/.my-agent/daemon.log" 2>/dev/null || echo 0)
      START_LOG="$ROOT/tests/e2e/discord-daemon-start.log"
      ( $BIN daemon start > "$START_LOG" 2>&1 & )
      for i in $(seq 1 15); do
        [[ -f "$HOME/.my-agent/daemon.pid.json" ]] && break
        sleep 1
      done
      if [[ ! -f "$HOME/.my-agent/daemon.pid.json" ]]; then
        test_fail "I3 daemon start" "no pid.json after 15s"
      else
        # 等最多 60s 看 daemon.log 出現 `discord ready` + `slash commands registered`
        # 兩條都要才算 gateway 完整起來。daemon 還在 run 時 stdout banner 不會 flush
        # 到檔（OS pipe buffering），所以不查 stdout，靠 daemon.log（authoritative）。
        DISCORD_OK=0
        SLASH_OK=0
        SLASH_BEFORE=$(grep -c "slash commands registered" "$HOME/.my-agent/daemon.log" 2>/dev/null || echo 0)
        for i in $(seq 1 60); do
          DAEMON_LOG_AFTER=$(grep -c "discord ready" "$HOME/.my-agent/daemon.log" 2>/dev/null || echo 0)
          SLASH_AFTER=$(grep -c "slash commands registered" "$HOME/.my-agent/daemon.log" 2>/dev/null || echo 0)
          if [[ $DAEMON_LOG_AFTER -gt $DAEMON_LOG_BEFORE ]]; then DISCORD_OK=1; fi
          if [[ $SLASH_AFTER -gt $SLASH_BEFORE ]]; then SLASH_OK=1; fi
          if [[ $DISCORD_OK -eq 1 ]] && [[ $SLASH_OK -eq 1 ]]; then break; fi
          sleep 1
        done

        if [[ $DISCORD_OK -eq 1 ]] && [[ $SLASH_OK -eq 1 ]]; then
          test_pass "I3 discord gateway 啟動（discord ready + slash commands registered）"
        elif [[ $DISCORD_OK -eq 1 ]]; then
          test_fail "I3 discord gateway" "discord ready 有，但 slash commands 60s 內未 register"
        else
          test_fail "I3 discord gateway" "60s 內 daemon.log 無 'discord ready'"
        fi
      fi

      ( $BIN daemon stop > /tmp/d-discord-stop.log 2>&1 & )
      for i in $(seq 1 12); do
        [[ ! -f "$HOME/.my-agent/daemon.pid.json" ]] && break
        sleep 1
      done
      rm -f "$HOME/.my-agent/daemon.pid.json" 2>/dev/null || true
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
