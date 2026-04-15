#!/usr/bin/env bash
# Part B：前 5 核心工具端到端測試（走 ./cli）
#
# 每個工具：
#   1. 準備環境（若需要）
#   2. 以 CLAUDE_CODE_USE_LLAMACPP=true ./cli --dangerously-skip-permissions
#      -p "..." 誘導模型呼叫對應工具
#   3. 檢驗 (c) 工具是否成功執行 / (d) 結果是否正確顯示
#   4. 清理測試產物
#
# 需 llama-server 在跑（bash scripts/llama/serve.sh） + ./cli 已 build。
#
# 用法：bash scripts/poc/llamacpp-core-tools-e2e.sh

set -u
# Git Bash 的 /tmp 是合法 bash 路徑但傳給 Windows 下的 Node/Bun fs API
# 會 ENOENT（Bun 只認 Windows 絕對路徑）。用 cygpath 轉成 Windows 路徑
# 再交給 ./cli 的 prompt。
TESTDIR_BASH="${TMPDIR:-/tmp}/llamacpp-e2e-$$"
mkdir -p "$TESTDIR_BASH"
trap 'rm -rf "$TESTDIR_BASH"' EXIT

# 取 Windows 形式路徑（例如 C:\Users\...\Temp\llamacpp-e2e-1234）
if command -v cygpath &>/dev/null; then
  TESTDIR_WIN="$(cygpath -w "$TESTDIR_BASH" | sed 's/\\/\\\\/g')"
else
  TESTDIR_WIN="$TESTDIR_BASH"
fi
# 傳給 CLI 的 prompt 用 forward-slash Windows 路徑（C:/Users/.../Temp/xxx），
# 大部分 fs API 都接受。
TESTDIR_FWD="$(cygpath -m "$TESTDIR_BASH" 2>/dev/null || echo "$TESTDIR_BASH")"
echo "TESTDIR_BASH=$TESTDIR_BASH"
echo "TESTDIR_FWD =$TESTDIR_FWD"

CLI="./cli"
[[ -x "$CLI" ]] || { echo "[x] 找不到 $CLI，請先 bun run build"; exit 1; }

curl -sf --max-time 3 http://127.0.0.1:8080/v1/models >/dev/null \
  || { echo "[x] llama-server 未響應；bash scripts/llama/serve.sh"; exit 2; }

export CLAUDE_CODE_USE_LLAMACPP=true
export LLAMA_BASE_URL=http://127.0.0.1:8080/v1
unset ANTHROPIC_API_KEY  # 避免 bootstrap 阻塞（LESSONS.md 記錄）

PASS=0
FAIL=0
RESULTS=()

check() {
  local name="$1" want_c="$2" want_d="$3" extra="${4:-}"
  if [[ "$want_c" == "OK" && "$want_d" == "OK" ]]; then
    PASS=$((PASS+1))
    RESULTS+=("$name  c=✓ d=✓  $extra")
  else
    FAIL=$((FAIL+1))
    RESULTS+=("$name  c=$want_c d=$want_d  $extra")
  fi
}

# ── 1. BashTool ──────────────────────────────────────────────────────────
echo "=== [1/5] BashTool ==="
OUT="$TESTDIR_FWD/bash.out"
timeout 120 "$CLI" --dangerously-skip-permissions -p \
  'Run the bash command `echo BASHOK_MARKER_1234` using the Bash tool and show me the output.' \
  </dev/null >"$OUT" 2>&1
# (c) 工具執行：llama-server log 會有 POST，實際執行由 Bash tool 做；我們
# 在 CLI stdout 裡找 marker 就同時證明 c+d
if grep -q "BASHOK_MARKER_1234" "$OUT"; then
  check "1. BashTool     " OK OK "marker 回傳"
else
  check "1. BashTool     " FAIL FAIL "stdout 無 marker"
  head -20 "$OUT"
fi

# ── 2. FileReadTool ──────────────────────────────────────────────────────
echo "=== [2/5] FileReadTool ==="
echo "READOK_MARKER_5678" > "$TESTDIR_FWD/read-target.txt"
OUT="$TESTDIR_FWD/read.out"
timeout 120 "$CLI" --dangerously-skip-permissions -p \
  "Read the file at $TESTDIR_FWD/read-target.txt using the Read tool and tell me its contents." \
  </dev/null >"$OUT" 2>&1
if grep -q "READOK_MARKER_5678" "$OUT"; then
  check "2. FileReadTool " OK OK "marker 從檔案讀出"
else
  check "2. FileReadTool " FAIL FAIL "stdout 無 marker"
  head -20 "$OUT"
fi

# ── 3. FileWriteTool ─────────────────────────────────────────────────────
echo "=== [3/5] FileWriteTool ==="
WRITEPATH="$TESTDIR_FWD/write-target.txt"
OUT="$TESTDIR_FWD/write.out"
timeout 120 "$CLI" --dangerously-skip-permissions -p \
  "Use the Write tool to create a file at $WRITEPATH containing exactly: WRITEOK_MARKER_90AB" \
  </dev/null >"$OUT" 2>&1
if [[ -f "$WRITEPATH" ]] && grep -q "WRITEOK_MARKER_90AB" "$WRITEPATH"; then
  check "3. FileWriteTool" OK OK "檔案被寫入且內容正確"
else
  check "3. FileWriteTool" FAIL FAIL "檔案未建立或內容錯誤"
  echo "---file---"; cat "$WRITEPATH" 2>&1 | head -5
  echo "---cli out---"; head -15 "$OUT"
fi

# ── 4. FileEditTool ──────────────────────────────────────────────────────
echo "=== [4/5] FileEditTool ==="
EDITPATH="$TESTDIR_FWD/edit-target.txt"
echo "OLD_VALUE_XYZ" > "$EDITPATH"
OUT="$TESTDIR_FWD/edit.out"
timeout 120 "$CLI" --dangerously-skip-permissions -p \
  "Use the Edit tool to replace OLD_VALUE_XYZ with NEW_VALUE_ABC in the file $EDITPATH" \
  </dev/null >"$OUT" 2>&1
if grep -q "NEW_VALUE_ABC" "$EDITPATH" && ! grep -q "OLD_VALUE_XYZ" "$EDITPATH"; then
  check "4. FileEditTool " OK OK "替換正確"
else
  check "4. FileEditTool " FAIL FAIL "替換未發生"
  echo "---file after---"; cat "$EDITPATH"
  echo "---cli out---"; head -15 "$OUT"
fi

# ── 5. GlobTool ──────────────────────────────────────────────────────────
echo "=== [5/5] GlobTool ==="
touch "$TESTDIR_FWD/globtest_a.md" "$TESTDIR_FWD/globtest_b.md" "$TESTDIR_FWD/globtest_c.txt"
OUT="$TESTDIR_FWD/glob.out"
timeout 120 "$CLI" --dangerously-skip-permissions -p \
  "Use the Glob tool to find all .md files in $TESTDIR_FWD and list what you found." \
  </dev/null >"$OUT" 2>&1
if grep -q "globtest_a.md" "$OUT" && grep -q "globtest_b.md" "$OUT"; then
  check "5. GlobTool     " OK OK "找到兩個 .md"
else
  check "5. GlobTool     " FAIL FAIL "未列出 .md 檔"
  echo "---cli out---"; head -20 "$OUT"
fi

# ── 總結 ──────────────────────────────────────────────────────────────────
echo ""
echo "=== Part B 總結 ==="
for line in "${RESULTS[@]}"; do echo "  $line"; done
echo ""
echo "pass=$PASS fail=$FAIL"
if [[ $FAIL -eq 0 ]]; then
  echo "✓ Part B 全部通過"
  exit 0
else
  echo "✗ 有失敗項目"
  exit 1
fi
