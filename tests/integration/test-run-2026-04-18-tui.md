# free-code TUI 品牌清理測試報告 — 2026-04-18

執行人：Claude Opus 4.7（auto mode）
被測 commit：`10fed0a`（M16 完成後） → 補修後

## 清理範圍

針對 **TUI（React Ink 互動介面）** 使用者可見字串中的 "Claude Code" / "Anthropic" 殘留。

## 修補清單（~30 處跨 25 檔案）

### UI 元件
- `src/screens/REPL.tsx` — Ctrl+Z suspend 訊息
- `src/screens/Doctor.tsx` — 診斷結束訊息
- `src/components/HelpV2/HelpV2.tsx` — Help 對話框標題
- `src/components/permissions/PermissionRequest.tsx` — 權限請求標題（3 處）
- `src/components/BypassPermissionsModeDialog.tsx` — Bypass 模式對話框（2 處）
- `src/components/TrustDialog/TrustDialog.tsx` — Trust 對話框
- `src/components/Onboarding.tsx` — Onboarding terminal setup
- `src/components/ClaudeMdExternalIncludesDialog.tsx` — 安全警告
- `src/components/CostThresholdDialog.tsx` — 費用對話框（Anthropic API → API）
- `src/components/ResumeTask.tsx` — Resume 任務 UI（5 處）
- `src/components/Stats.tsx` — Stats 載入訊息（2 處）
- `src/components/ModelPicker.tsx` — Model picker 說明
- `src/components/OutputStylePicker.tsx` — Output style 說明
- `src/components/IdeOnboardingDialog.tsx` — IDE 歡迎（2 處）
- `src/components/permissions/rules/PermissionRuleList.tsx` — 規則說明（4 處）
- `src/components/permissions/rules/AddWorkspaceDirectory.tsx`
- `src/components/permissions/rules/RemoveWorkspaceDirectory.tsx`
- `src/components/permissions/ComputerUseApproval/ComputerUseApproval.tsx`
- `src/components/ManagedSettingsSecurityDialog/ManagedSettingsSecurityDialog.tsx`
- `src/components/mcp/ElicitationDialog.tsx` — Notify 標題（2 處）
- `src/components/mcp/MCPRemoteServerMenu.tsx` — Auth 警告（4 處）
- `src/components/mcp/MCPSettings.tsx` — MCP 設定 tab 名稱

### CLI / Commands
- `src/main.tsx` — 主命令描述（version/description/mcp/plugin/marketplace/doctor/install/ssh/open）、cost tip、"code" tip 警告
- `src/commands/install.tsx` — Install 流程（4 處）
- `src/commands/ide/ide.tsx` — IDE 偵測提示（3 處）
- `src/commands/statusline.tsx` — Statusline 描述
- `src/commands/plugin/index.tsx` — Plugin 描述
- `src/commands/plugin/DiscoverPlugins.tsx` — Git 必要訊息
- `src/commands/plugin/ManageMarketplaces.tsx` — Auto-update 說明

### Hooks / Utilities
- `src/hooks/useOfficialMarketplaceNotification.tsx` — 通知訊息（Anthropic → Official，2 處）
- `src/hooks/notifs/useNpmDeprecationNotification.tsx` — npm 棄用訊息
- `src/utils/status.tsx` — `Anthropic base URL` → `API base URL`

## 測試結果

| Tier | 結果 |
|------|------|
| **T1** typecheck | ✅ PASS（僅既有 baseUrl warning） |
| **T3** self-improve unit tests | ✅ **93/93** |
| **T4.1** session-index-smoke | ✅ **66/66** |
| **T4.2** memory-tool-smoke | ✅ **47/47** |
| **T4.3** memory-prefetch-smoke | ✅ **24/24** |
| **T4.4** session-search-tool-smoke | ✅ **29/29** |
| **T7.1** `--version` | ✅ `2.1.87-dev (my-agent)` |
| **T7.2** `--help` 第二行 | ✅ `my-agent - starts an interactive session by default...` |
| **T7.3** `auth login` | ✅ `OAuth sign-in is not supported in this build.` + exit 1 |

## 未修補殘留（已分類評估）

### 註解 / JSDoc（不影響 UI 顯示）
- `src/ink/components/App.tsx:412,433`
- `src/main.tsx:3368`
- `src/interactiveHelpers.tsx:205`
- `src/screens/REPL.tsx:2676`
- `src/tools/PowerShellTool/PowerShellTool.tsx:564`
- `src/tools/BashTool/BashTool.tsx:774`
- `src/components/Onboarding.tsx:101`
- `src/components/Settings/Config.tsx:1086`
- `src/components/design-system/LoadingState.tsx:45`
- `src/commands/terminalSetup/terminalSetup.tsx:75`

### 死功能 UI（OAuth 停用後路徑不可達）
- `src/tasks/RemoteAgentTask/RemoteAgentTask.tsx` — Remote Agent
- `src/commands/ultraplan.tsx` — Ultraplan（需 OAuth）
- `src/commands/thinkback/thinkback.tsx` — Think Back（需 Claude Code Web）
- `src/utils/teleport.tsx` — Teleport
- `src/components/TeleportRepoMismatchDialog.tsx`
- `src/components/UltraplanLaunchDialog.tsx`
- `src/components/DesktopUpsell/DesktopUpsellStartup.tsx`
- `src/components/Passes/Passes.tsx` — 推薦計畫
- `src/components/tasks/RemoteSessionDetailDialog.tsx`
- `src/components/FeedbackSurvey/TranscriptSharePrompt.tsx` — M8 已 no-op
- `src/components/Feedback.tsx` — M8 已 no-op
- `src/hooks/notifs/useCanSwitchToExistingSubscription.tsx`
- `src/components/permissions/ExitPlanModePermissionRequest/*` — Ultraplan 選項
- `src/components/PromptInput/PromptInput.tsx:764` — Ultraplan 相關
- `src/components/WorkflowMultiselectDialog.tsx` — GitHub Actions 工作流模板

### 可選清理（後續 M 里程碑）
- `src/constants/github-app.ts` — PR/Workflow 模板全文（已停用功能）
- `src/constants/prompts.ts:704,707` — System prompt 對產品能力的描述（教育性）
- `src/bridge/*.ts` — Remote Control 錯誤訊息（已停用）
- `src/skills/bundled/stuck.ts` / `skillCreatorContent.ts` — Skill 教育內容

## 結論

✅ **TUI 使用者主要互動路徑已中性化**

- 使用者在日常 TUI 使用過程中（help、permission prompt、trust dialog、onboarding、suspend、resume、settings、mcp、model/output picker、version 顯示）**不會看到 "Claude Code" 字樣**
- 剩餘殘留全部屬於**註解**（不顯示）或**死功能路徑**（OAuth 停用無法觸發）
- 既有功能測試 **全綠（189+ 測試）**

紅燈 0，可繼續部署。
