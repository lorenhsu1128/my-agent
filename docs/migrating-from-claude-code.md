# 從官方 Claude Code 遷移設定

> 從 CLAUDE.md 拆出。日常開發不需參考，僅在從官方 Claude Code 切換到 my-agent 時參考。

## 若從官方 Claude Code 遷移設定

my-agent 使用獨立的 `~/.my-agent/` 設定目錄，與官方 Claude Code 的 `~/.claude/` 完全隔離。

### 推薦作法（選擇性複製）

```bash
# Session 歷史
cp -r ~/.claude/projects ~/.my-agent/

# Memory（如有）
cp -r ~/.claude/projects/<slug>/memory ~/.my-agent/projects/<slug>/

# 自訂 skills / commands / agents
cp -r ~/.claude/skills ~/.my-agent/       # 按需
cp -r ~/.claude/commands ~/.my-agent/     # 按需
cp -r ~/.claude/agents ~/.my-agent/       # 按需
```

### 直接指向舊目錄（不推薦）

```bash
export CLAUDE_CONFIG_DIR=~/.claude
```

### 注意事項

- **OAuth tokens 無法使用** — my-agent 用本地 llama.cpp 或第三方 API key（`ANTHROPIC_API_KEY` / `CLAUDE_CODE_USE_BEDROCK` 等）
- **Chrome / Voice 設定無效** — 這兩個功能在 M15 已移除
- **Session JSONL 可讀** — 但 SQLite FTS 索引會在首次 reconcile 時重建
- **Settings schema 可能 drift** — 不建議直接沿用整個 `config.json`；只複製需要的部分比較安全
