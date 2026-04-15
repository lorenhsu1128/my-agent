#!/bin/bash
# Hook: Notification
# 目的：在 session 結束時記錄摘要到 TODO.md 並通知使用者。
# Windows 注意：透過 Git Bash 執行；桌面通知使用 PowerShell。

TIMESTAMP=$(date '+%Y-%m-%d %H:%M')
TODO_FILE="./TODO.md"
DONE=0
TOTAL=0

if [ -f "$TODO_FILE" ]; then
  DONE=$(grep -c '\[x\]' "$TODO_FILE" 2>/dev/null || echo 0)
  TODO=$(grep -c '\[ \]' "$TODO_FILE" 2>/dev/null || echo 0)
  TOTAL=$((DONE + TODO))

  {
    echo ""
    echo "- $TIMESTAMP: Session 結束 | 進度：$DONE/$TOTAL 任務 | $(git log --oneline -1 2>/dev/null || echo '無 commit')"
  } >> "$TODO_FILE"
fi

MESSAGE="Session 結束。進度：$DONE/$TOTAL 任務"

# 桌面通知（按平台選擇）
case "$(uname -s 2>/dev/null)" in
  MINGW*|MSYS*|CYGWIN*|Windows_NT)
    # Windows 透過 PowerShell 顯示氣球通知
    powershell.exe -NoProfile -Command "
      Add-Type -AssemblyName System.Windows.Forms;
      \$n = New-Object System.Windows.Forms.NotifyIcon;
      \$n.Icon = [System.Drawing.SystemIcons]::Information;
      \$n.Visible = \$true;
      \$n.ShowBalloonTip(3000, 'Claude Code', '$MESSAGE', 'Info');
      Start-Sleep -Seconds 4;
      \$n.Dispose()
    " 2>/dev/null &
    ;;
  Darwin)
    osascript -e "display notification \"$MESSAGE\" with title \"Claude Code\"" 2>/dev/null
    ;;
  Linux)
    if command -v notify-send &>/dev/null; then
      notify-send "Claude Code" "$MESSAGE" 2>/dev/null
    fi
    ;;
esac

exit 0
