#!/bin/bash
# Hook: PreToolUse (Bash)
# 目的：確保在任何 shell 指令執行前 conda 環境 'aiagent' 已啟用。
#
# Claude Code 透過 stdin 傳入 hook payload（JSON），包含 tool_name、tool_input 等
# 結束碼 0 = 允許；2 = 阻擋並把 stderr 回饋給 Claude
#
# Windows 注意：此腳本透過 Git Bash 執行（settings.json 中以 `bash` 明確呼叫）

# 從 stdin 讀取 payload；若無 jq 則 fallback 到簡單 grep
PAYLOAD=$(cat 2>/dev/null || echo '{}')
if command -v jq &>/dev/null; then
  TOOL_NAME=$(echo "$PAYLOAD" | jq -r '.tool_name // empty')
else
  TOOL_NAME=$(echo "$PAYLOAD" | grep -oE '"tool_name"[[:space:]]*:[[:space:]]*"[^"]+"' | head -1 | sed 's/.*"\([^"]*\)"$/\1/')
fi

# 僅檢查會執行 shell 的工具
case "$TOOL_NAME" in
  Bash)
    ;;
  *)
    exit 0
    ;;
esac

# 檢查 conda aiagent 環境是否已啟用
if [[ "$CONDA_DEFAULT_ENV" != "aiagent" ]]; then
  # 嘗試啟用
  eval "$(conda shell.bash hook 2>/dev/null)"
  conda activate aiagent 2>/dev/null
  if [[ "$CONDA_DEFAULT_ENV" != "aiagent" ]]; then
    echo "conda 環境 'aiagent' 未啟用。請在 shell 中執行：conda activate aiagent" >&2
    exit 2
  fi
fi

exit 0
