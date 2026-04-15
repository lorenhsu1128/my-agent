#!/bin/bash
# Hook: PostToolUse (Edit, Write, MultiEdit)
# 目的：在任何 .ts/.tsx 檔案被修改後自動執行 typecheck。
#
# Claude Code 透過 stdin 傳入 JSON payload（tool_name、tool_input 等）。
# Windows 注意：此腳本透過 Git Bash 執行。

PAYLOAD=$(cat 2>/dev/null || echo '{}')

if command -v jq &>/dev/null; then
  TOOL_NAME=$(echo "$PAYLOAD" | jq -r '.tool_name // empty')
  FILE_PATH=$(echo "$PAYLOAD" | jq -r '.tool_input.file_path // .tool_input.path // .tool_input.filePath // empty')
else
  TOOL_NAME=$(echo "$PAYLOAD" | grep -oE '"tool_name"[[:space:]]*:[[:space:]]*"[^"]+"' | head -1 | sed 's/.*"\([^"]*\)"$/\1/')
  FILE_PATH=$(echo "$PAYLOAD" | grep -oE '"(file_path|path|filePath)"[[:space:]]*:[[:space:]]*"[^"]+"' | head -1 | sed 's/.*"\([^"]*\)"$/\1/')
fi

# 僅對檔案修改工具觸發
case "$TOOL_NAME" in
  Edit|Write|MultiEdit)
    ;;
  *)
    exit 0
    ;;
esac

# 僅在 TypeScript 檔案被修改時執行 typecheck
if [[ "$FILE_PATH" == *.ts || "$FILE_PATH" == *.tsx ]]; then
  echo "🔍 編輯 $FILE_PATH 後自動觸發 typecheck" >&2
  
  # 確保 conda 已啟用
  eval "$(conda shell.bash hook 2>/dev/null)"
  conda activate aiagent 2>/dev/null
  
  # 執行 typecheck
  bun run typecheck 2>&1 | tail -20 >&2
  TYPECHECK_EXIT=$?
  
  if [ $TYPECHECK_EXIT -ne 0 ]; then
    echo "❌ 編輯 $FILE_PATH 後 typecheck 失敗 — 繼續之前請先修復" >&2
  else
    echo "✅ Typecheck 通過" >&2
  fi
fi

exit 0
