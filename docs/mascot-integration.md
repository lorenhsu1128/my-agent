# 桌寵整合（mascot）

my-agent 目前唯一支援連線的桌寵客戶端是 [virtual-assistant-desktop](https://github.com/lorenhsu1128/virtual-assistant-desktop)（本機路徑：`C:\Users\LOREN\Documents\_projects\virtual-assistant-desktop`）。本文件說明 my-agent 端要知道的整合面向，**詳細實作藍圖在 desktop repo 的 `AGENT_INTEGRATION_PLAN.md`**。

> 整合里程碑見 TODO.md § M-MASCOT（已完成主線，2026-05-09）。

## 桌寵長什麼樣

Electron + TypeScript + Three.js + @pixiv/three-vrm 的桌面虛擬陪伴軟體，VRM 3D 角色常駐桌面、自主移動、視窗碰撞 / 吸附 / 遮擋（Windows）、表情系統、`.vrma` 動畫、系統托盤。my-agent 只是「可選 AI 大腦」，桌寵不依賴 my-agent 也能跑。

## 整合三條通道

```
┌────────────────────────────────────────────────────────┐
│  Electron main process（virtual-assistant-desktop）    │
│  ┌──────────────────────┐  ┌────────────────────────┐ │
│  │ AgentDaemonManager   │  │ MascotMcpServer (HTTP) │ │
│  │ - spawn bun daemon   │  │ - set_expression       │ │
│  │ - pid/token/health   │  │ - play_animation       │ │
│  └─────────┬────────────┘  │ - say                  │ │
│            │ ws://         │ - look_at_screen       │ │
│  ┌─────────▼──────────────────────────────┐  └─────────┘ │
│  │ my-agent daemon  (source='mascot')    │            │
│  └────────────────────────────────────────┘            │
└────────────────────────────────────────────────────────┘
```

1. **WS 直連 session** — desktop 端 `electron/agent/AgentSessionClient` 連 daemon `/sessions`，握手用 `source='mascot'`；turn / runnerEvent / stream_event 餵 React 對話氣泡。
2. **MCP 反向控制** — desktop 自架 MCP HTTP server（`MascotMcpServer`，per-request stateless），透過 `cli mcp add --scope user --transport http` 註冊到 `~/.virtual-assistant-desktop/mcp.json`。LLM tool call → MCP HTTP → Electron main → IPC → renderer dispatcher → ExpressionManager / AnimationManager。
3. **設定視窗** — 桌寵托盤「設定」→ React BrowserWindow（desktop `src-settings/`）→ enable / daemon 模式 / bun / cli / workspace 路徑；套用即觸發 daemon `stop → updateConfig → start`。

## my-agent 端做了什麼 / 沒做什麼

**改動只有一處**：`ClientSource` 加 `'mascot'`（commit `1ceda16`，影響 `src/server/clientRegistry.ts` / `directConnectServer.ts` / `inputQueue.ts`）。

**沒改**：

- 不在 `src/` 內加桌寵專屬模組 — 桌寵是 daemon WS 客戶端 + 註冊 MCP server，本質上和 discord / web mode 同等地位。
- 不發明新的 daemon WS event types — 反向控制改走標準 MCP，daemon 不知道也不在乎客戶端是桌寵。
- 不直接綁定 desktop repo 路徑、bun binary、Electron — 整合工作全部在 desktop 端。

## 桌寵專屬人格（可選）

桌寵連 daemon 時會帶自己的 cwd（`AgentSessionClient` 握手時送），M-SP-FULL Phase 1 的 `bootstrapDaemonContext(opts.cwd)` 會載對應 snapshot。**換 cwd → 換 persona，零 my-agent 程式碼修改**：

- desktop 設 daemon cwd（建議：`~/.virtual-assistant-desktop/agent-workspace/` 或 desktop 設定視窗指定）
- 在 `~/.virtual-assistant-desktop/projects/<mascot-slug>/system-prompt-override.md` 寫桌寵伴侶人格

完整流程見 `docs/m-sp-full-guide.md` § 5「桌寵 / 多人格實戰」。

## 已知問題

- **M-MASCOT-FU-1**：本機 qwen3.5-9b-neo 會把 mascot MCP tool 包進 Skill meta-tool，導致 Skill router 不認 — 需研究 router 端把 MCP tool 從 Skill 包裝拆出來，或在 system prompt / tool 描述上標註不要包。詳見 TODO.md。

## 連結

| 資源 | 路徑 |
|------|------|
| 整合藍圖（最新；含 P0–P3 進度） | `<desktop>/AGENT_INTEGRATION_PLAN.md` |
| 桌寵架構 | `<desktop>/ARCHITECTURE.md` |
| 桌寵使用手冊 | `<desktop>/USAGE.md` |
| 桌寵教訓記錄 | `<desktop>/LESSONS.md` § my-agent 整合 |
| my-agent 端里程碑 | `TODO.md` § M-MASCOT |
| 多人格 / per-cwd persona | `docs/m-sp-full-guide.md` § 5、`docs/customizing-system-prompt.md` |
| ClientSource 改動 | commit `1ceda16` |
