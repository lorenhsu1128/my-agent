#!/bin/bash
# macOS build script for my-agent CLI
# 產出：./cli（Mach-O arm64 單一 binary）+ 自動更新 /usr/local/bin/my-agent symlink
# 用法：
#   ./scripts/build-macos.sh          # 正式 build
#   ./scripts/build-macos.sh --dev    # 開發 build（含 dev version + 實驗功能）
#   ./scripts/build-macos.sh --dev-full  # 開發 build + 全部實驗功能
#   ./scripts/build-macos.sh --skip-typecheck  # 跳過 typecheck（加速重建）
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_DIR"

# ── 參數解析 ──
DEV=false
SKIP_TYPECHECK=false
FEATURE_SET=""
for arg in "$@"; do
  case "$arg" in
    --dev)             DEV=true ;;
    --dev-full)        DEV=true; FEATURE_SET="dev-full" ;;
    --skip-typecheck)  SKIP_TYPECHECK=true ;;
    *)                 echo "未知參數: $arg"; exit 1 ;;
  esac
done

LINK_PATH="/usr/local/bin/my-agent"

# ── 前置檢查 ──
echo "=== my-agent macOS build ==="

if ! command -v bun &>/dev/null; then
  echo "❌ bun 未安裝。請先安裝：curl -fsSL https://bun.sh/install | bash"
  exit 1
fi
echo "✓ bun $(bun --version)"

ARCH=$(uname -m)
if [[ "$ARCH" != "arm64" ]]; then
  echo "⚠ 偵測到 $ARCH — 本腳本針對 Apple Silicon (arm64) 最佳化"
fi

# ── 安裝依賴 ──
if [[ ! -d node_modules ]]; then
  echo "→ 安裝依賴..."
  bun install
fi

# ── Typecheck ──
if ! $SKIP_TYPECHECK; then
  echo "→ 型別檢查..."
  if ! bun run typecheck 2>&1 | grep -v 'TS5101'; then
    echo "❌ typecheck 失敗"
    exit 1
  fi
  echo "✓ typecheck 通過"
fi

# ── Build ──
echo "→ 編譯 binary..."
BUILD_ARGS=()
if $DEV; then
  BUILD_ARGS+=(--dev)
fi
if [[ -n "$FEATURE_SET" ]]; then
  BUILD_ARGS+=("--feature-set=$FEATURE_SET")
fi

bun run ./scripts/build.ts ${BUILD_ARGS[@]+"${BUILD_ARGS[@]}"}

# 確認產出
if $DEV; then
  OUTFILE="./cli-dev"
else
  OUTFILE="./cli"
fi

if [[ ! -f "$OUTFILE" ]]; then
  echo "❌ 編譯失敗：$OUTFILE 不存在"
  exit 1
fi

FILE_SIZE=$(du -h "$OUTFILE" | cut -f1 | xargs)
echo "✓ 產出 $OUTFILE ($FILE_SIZE)"

# ── 冒煙測試 ──
echo "→ 冒煙測試..."
if VERSION=$("$OUTFILE" --version 2>/dev/null); then
  echo "✓ $OUTFILE --version → $VERSION"
else
  echo "⚠ --version 執行失敗（binary 可能仍可用）"
fi

# ── 安裝 symlink（自動） ──
FULL_PATH="$(cd "$(dirname "$OUTFILE")" && pwd)/$(basename "$OUTFILE")"

if [[ -L "$LINK_PATH" ]]; then
  CURRENT_TARGET=$(readlink "$LINK_PATH")
  if [[ "$CURRENT_TARGET" == "$FULL_PATH" ]]; then
    echo "✓ symlink 已是最新：$LINK_PATH → $FULL_PATH"
  else
    ln -sf "$FULL_PATH" "$LINK_PATH"
    echo "✓ symlink 已更新：$LINK_PATH → $FULL_PATH（舊: $CURRENT_TARGET）"
  fi
elif [[ -e "$LINK_PATH" ]]; then
  echo "⚠ $LINK_PATH 已存在但不是 symlink，跳過自動連結"
else
  ln -s "$FULL_PATH" "$LINK_PATH"
  echo "✓ 建立 symlink：$LINK_PATH → $FULL_PATH"
fi

echo ""
echo "=== build 完成 ==="
echo "  binary: $OUTFILE"
echo "  全域:   my-agent"
