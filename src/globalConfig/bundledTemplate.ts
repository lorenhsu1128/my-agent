/**
 * 全域設定檔 JSONC 模板（~/.my-agent/.my-agent.json）。
 *
 * 100+ 欄位完整含繁中 // 註解。首次 seed 時直接寫入；migration 時作為
 * baseline（使用者既有值會覆蓋 template 的預設值、同時保留模板所有註解）。
 *
 * 與 src/utils/config.ts GlobalConfig type 與 createDefaultGlobalConfig()
 * 保持同步。新增欄位時請一併更新此模板。
 *
 * 分節：
 *   §1  身份 / 認證
 *   §2  更新 / 安裝
 *   §3  Onboarding 狀態
 *   §4  核心功能開關（my-agent 會真的讀）
 *   §5  自動維護計數（不要手改）
 *   §6  動態容器（projects / githubRepoPaths）
 *   §7  Claude Code 遺留 🗑️（my-agent 不使用，可忽略或刪除）
 *   §8  Statsig / GrowthBook cache（my-agent ADR-003：不用 feature flag）
 */

export const GLOBAL_CONFIG_JSONC_TEMPLATE = `{
  // ═══════════════════════════════════════════════════════════════════
  // my-agent 全域設定（~/.my-agent/.my-agent.json）
  //
  // 此檔為 JSONC（JSON with Comments）— 允許 // 與 /* */ 註解、尾部逗號。
  // my-agent 寫回此檔時會**保留註解**（deep diff + jsonc.modify），使用者
  // 加的 // 筆記不會被下次 session 結束寫回洗掉。
  //
  // 大部分欄位 my-agent 會自動維護（如 numStartups / projects[cwd].lastCost /
  // skillUsage），勿手改；以下節列出的「功能開關」才適合人類編輯。
  //
  // 若檔案壞掉（JSON 語法 / schema 不符）→ my-agent stderr 警告並走內建
  // 預設，不 crash。~/.my-agent/backups/ 保留最近 5 份備份。
  // ═══════════════════════════════════════════════════════════════════

  // ═══ §1 身份 / 認證 ═══

  // 使用者 ID（32 字元 hash，首次啟動自動產生）。勿手改 — 改了會讓 skill
  // 使用統計、memory 歸屬等分裂到不同身份。
  // "userID": "<自動產生>",

  // ═══ §2 更新 / 安裝 ═══

  // 是否允許自動更新。my-agent 目前建構不走官方更新通道，實質 no-op。
  // 留著為了跟 Claude Code GlobalConfig 相容。
  "autoUpdates": false,

  // native 安裝時的更新保護旗標（與 autoUpdates 互補）。my-agent 不使用。
  // "autoUpdatesProtectedForNative": true,

  // 🗑️ [legacy] Claude Code 安裝方式（native / local / unknown）。
  // my-agent 從 ./cli 跑，此欄位無意義。可刪。
  // "installMethod": "unknown",

  // 設定 migration 版本號。my-agent 啟動時若 != CURRENT_MIGRATION_VERSION
  // 會跑一次 runMigrations 補。勿手改。
  // "migrationVersion": 11,

  // ═══ §3 Onboarding 狀態 ═══

  // 是否已完成首次 onboarding 流程。完成後永不再跳出 onboarding 對話框。
  "hasCompletedOnboarding": false,

  // 最後一次觸發 onboarding reset 的 my-agent 版本。用於 MIN_VERSION_REQUIRING_
  // ONBOARDING_RESET 比對 — 升級到該版本後會再跑一次 onboarding。
  // "lastOnboardingVersion": "0.0.0",

  // 使用者看過的最後一版 release notes 版號。新版本 release 後會自動提示。
  // "lastReleaseNotesSeen": "0.0.0",

  // 首次啟動 my-agent 的 ISO timestamp（僅記錄用）。
  // "firstStartTime": "<自動產生>",

  // ═══ §4 核心功能開關（最常手動編輯） ═══

  // 詳細 log 模式。true 時印更多 diagnostic；預設 false 避免 terminal 刷屏。
  "verbose": false,

  // 是否自動 compact 上下文。true（推薦）=context 接近上限時自動觸發
  // compaction；false = 只能手動 /compact。
  "autoCompactEnabled": true,

  // 覆蓋 context 長度估算值（tokens）。主要用在 llama.cpp 場景（/slots 查
  // 不到 n_ctx 時走此值）。Anthropic 模型通常不需改。
  // 優先序：/slots → env LLAMACPP_CTX_SIZE → 本欄位 → llamacpp.json.contextSize
  //         → MODEL_CONTEXT_WINDOW_DEFAULT (128K)
  "contextSize": 131072,

  // 是否在 turn 結束時顯示耗時提示（例如 "Cooked for 1m 6s"）。
  "showTurnDuration": true,

  // Turn 完成後多久算「idle」並發桌面通知（ms）。預設 60000（1 分鐘）。
  "messageIdleNotifThresholdMs": 60000,

  // Todo 功能開關（在 REPL 的 TodoWrite 工具）。
  "todoFeatureEnabled": true,

  // Todos 空白時是否還展開顯示（true = 總是展開）。
  "showExpandedTodos": false,

  // 檔案 checkpointing 開關 — Edit/Write 前先備份原檔到 snapshot。
  "fileCheckpointingEnabled": true,

  // 是否顯示 terminal progress bar（OSC 9;4 序列，支援的 terminal 才有效）。
  "terminalProgressBarEnabled": true,

  // 是否遵守 .gitignore（File picker / Glob 等工具預設忽略 ignored 檔）。
  // 注意：.ignore 檔案無論此設定為何都會被遵守。
  "respectGitignore": true,

  // /copy 行為：true = 總是複製完整回應；false = 顯示多選 picker。
  "copyFullResponse": false,

  // TUI 全螢幕選字時自動複製到 clipboard（滑鼠鬆開即複製）。undefined = true。
  // "copyOnSelect": true,

  // Theme（UI 配色）。可選：dark / light / dark-daltonized / light-daltonized
  "theme": "dark",

  // 偏好的桌面通知 channel。"auto" = 依 OS 偵測（iTerm2 / terminal-notifier /
  // WindowsToast 等）；或顯式指定。
  "preferredNotifChannel": "auto",

  // 編輯器模式：normal（預設）/ vim（REPL 輸入列支援 vim 快捷鍵）
  "editorMode": "normal",

  // Diff 顯示工具：auto（偵測 vscode）/ terminal / vscode
  "diffTool": "auto",

  // ── 通知 push ──

  // Turn 完成時發桌面通知（auto-approved 的 long-running task 尤其有用）。
  // 預設 off — 明確 opt-in 才會打擾。
  // "taskCompleteNotifEnabled": false,

  // 需要輸入（如 permission approval）時發桌面通知。預設 off。
  // "inputNeededNotifEnabled": false,

  // Agent push 通知（subagent 完成 / 失敗）。預設 off。
  // "agentPushNotifEnabled": false,

  // ── Daemon 模式（M-DAEMON / ADR-012）──

  // REPL 啟動時自動起一個 detached daemon（若尚未有活 daemon）。
  // 預設 undefined = true（啟用）；false = 停用。
  // 由 \`my-agent daemon autostart on|off\` 或 REPL /daemon on|off 切換。
  "daemonAutoStart": true,

  // Remote control 在啟動時自動開啟。預設 undefined；需要 BRIDGE_MODE。
  // my-agent 多數使用者不需要。
  "remoteControlAtStartup": false,

  // Remote 相關對話框（bridge 啟用前）是否已看過。看過就不再跳出。
  "remoteDialogSeen": false,

  // ── Teammate（多 agent 協作，M-TEAMMATE）──

  // Teammate spawn 模式：
  //   "auto"（預設）= 依可用資源自動決定
  //   "tmux"        = 新 tmux pane
  //   "in-process"  = 同 process 平行跑（節省資源）
  // "teammateMode": "auto",

  // Teammate 預設模型（當 spawn 沒指定時用）：
  //   undefined = 硬 default（Opus）
  //   null      = 用 leader 當下的模型
  //   "<id>"    = 指定 model alias / ID（例如 "qwen3.5-9b-neo"）
  // "teammateDefaultModel": null,

  // ── IDE 整合（可選）──

  // my-agent 從 IDE 啟動時自動連線（若唯一偵測到一個 IDE）。
  "autoConnectIde": false,

  // 從 IDE 啟動時自動安裝 IDE extension。
  "autoInstallIdeExtension": true,

  // ── Tool 權限（auto-approved 清單）──

  // 依 tool 類型快取使用者對自訂 API key 的同意/拒絕（approved / rejected
  // 陣列裝 key hash）。my-agent 通常用 env var，此欄位多數為空。
  "customApiKeyResponses": {
    "approved": [],
    "rejected": []
  },

  // Environment variable 覆蓋（@deprecated，請改用 settings.env）。
  "env": {},

  // ═══ §5 自動維護計數 — 勿手改 ═══

  // 累積啟動次數（每次 my-agent 啟動 +1）。
  "numStartups": 0,

  // 累積 /btw 使用次數。
  "btwUseCount": 0,

  // 累積 prompt queue 使用次數。
  "promptQueueUseCount": 0,

  // 累積 memory（MemoryTool）使用次數。
  "memoryUsageCount": 0,

  // 使用者是否已看過 tasks hint。
  "hasSeenTasksHint": false,

  // Tips 使用歷史（tipId → numStartups 當時值）。
  "tipsHistory": {},

  // 是否已使用過 backslash return（\\ 輸入多行）。
  "hasUsedBackslashReturn": false,

  // 是否用過 stash（Ctrl+S）。
  "hasUsedStash": false,

  // 是否把任務背景化過（Ctrl+B）。
  "hasUsedBackgroundTask": false,

  // Queue hint 顯示次數（顯示一定次數後自動藏）。
  "queuedCommandUpHintCount": 0,

  // Skill 使用統計（slash command autocomplete 排序依據）。
  // 結構：{ "<skill-name>": { "usageCount": N, "lastUsedAt": epochMs } }
  "skillUsage": {},

  // Teammate spinner tree 顯示開關（false = 顯示膠囊 pill）。
  "showSpinnerTree": false,

  // ═══ §6 動態容器（my-agent 自動維護） ═══

  // Per-project 設定與最近一次 session 的統計指標。
  // Key: 專案絕對路徑；Value: ProjectConfig（含 allowedTools / lastCost /
  // lastSessionMetrics 等）。進入新目錄開 session 會自動新增 entry。
  // 一般不需手改；若要清理舊專案可參考 session 清理工具。
  "projects": {},

  // GitHub repo → 本機路徑映射（teleport / directory switching）。
  // Key: "owner/repo"（小寫）；Value: 絕對路徑陣列。自動偵測 .git/config。
  "githubRepoPaths": {},

  // ═══ §7 Claude Code 遺留欄位 🗑️（my-agent 不使用） ═══
  //
  // 以下欄位是 fork 自 Claude Code 時沿用下來的 schema，my-agent 實際不讀。
  // 它們對應的功能在 my-agent 已被移除或重新實作：
  //   - OAuth / 訂閱相關 → my-agent 不走 OAuth（CLAUDE.md 遷移說明）
  //   - claude.ai MCP connectors → 沒接
  //   - Chrome extension → M15 已移除
  //   - IDE onboarding → my-agent 不做這塊
  //
  // 這一段可整段刪掉不影響功能。my-agent 不會寫回這裡。
  // 留著純粹為了 TypeScript schema 相容，以免未來引入相關功能時衝突。

  // 🗑️ Anthropic OAuth 帳號資訊。my-agent 不走 OAuth（用 API key / 本地模型）。
  // "oauthAccount": {},

  // 🗑️ Claude Code first token 日期。my-agent 不用此欄位做統計。
  // "claudeCodeFirstTokenDate": "",

  // 🗑️ Chrome extension 安裝偵測快取。M15 已移除 Chrome 整合。
  // "cachedChromeExtensionInstalled": false,

  // 🗑️ claude.ai MCP connectors 曾連線清單（Gmail / Calendar 等）。沒接。
  // "claudeAiMcpEverConnected": [],

  // 🗑️ Sonnet-1M subscription 存取快取（多 org）。my-agent 無此訂閱概念。
  // "s1mAccessCache": {},
  // "s1mNonSubscriberAccessCache": {},

  // 🗑️ Grove config 快取（claude.ai 伺服器側設定）。
  // "groveConfigCache": {},

  // 🗑️ Guest passes 資格 / upsell 計數（Anthropic 推薦制度）。
  // "passesEligibilityCache": {},
  // "passesUpsellSeenCount": 0,
  // "hasVisitedPasses": false,
  // "passesLastSeenRemaining": 0,

  // 🗑️ Overage credit grant 快取（Anthropic billing）。
  // "overageCreditGrantCache": {},
  // "overageCreditUpsellSeenCount": 0,
  // "hasVisitedExtraUsage": false,

  // 🗑️ Opus 4.5 Pro migration marker（Anthropic 內部遷移）。
  // "opusProMigrationComplete": false,
  // "opusProMigrationTimestamp": 0,
  // "opus1mMergeNoticeSeenCount": 0,
  // "sonnet1m45MigrationComplete": false,
  // "legacyOpusMigrationTimestamp": 0,
  // "sonnet45To46MigrationTimestamp": 0,
  // "hasShownOpus46Notice": {},
  // "opus46FeedSeenCount": 0,

  // 🗑️ Effort callout 提示計數（Opus 4.6 使用者看過一次就關）。
  // "effortCalloutDismissed": false,
  // "effortCalloutV2Dismissed": false,

  // 🗑️ IDE onboarding / hint 相關計數（my-agent 不做 IDE 整合 dialog）。
  // "hasIdeOnboardingBeenShown": {},
  // "ideHintShownCount": 0,
  // "hasIdeAutoConnectDialogBeenShown": false,

  // 🗑️ LSP 推薦計數（my-agent 不送 LSP 建議）。
  // "lspRecommendationIgnoredCount": 0,
  // "lspRecommendationDisabled": false,
  // "lspRecommendationNeverPlugins": [],

  // 🗑️ Feedback survey（claude.ai 用）。
  // "feedbackSurveyState": {},

  // 🗑️ Subscription / extra usage notice。
  // "subscriptionNoticeCount": 0,
  // "hasAvailableSubscription": false,
  // "cachedExtraUsageDisabledReason": null,

  // 🗑️ Additional model options / costs cache（server-side）。
  // "additionalModelOptionsCache": [],
  // "additionalModelCostsCache": {},

  // 🗑️ Desktop upsell（升級到 desktop app）。
  // "desktopUpsellSeenCount": 0,
  // "desktopUpsellDismissed": false,

  // 🗑️ Terminal setup backup paths。
  // "iterm2BackupPath": "",
  // "appleTerminalBackupPath": "",

  // 🗑️ Chrome clientDataCache（server-side experiment data）。
  // "clientDataCache": {},

  // 🗑️ Plan mode 最後使用時間。
  // "lastPlanModeUse": 0,

  // 🗑️ Marketplace 自動安裝標記。my-agent 用自己的 .my-agent/skills 機制。
  "officialMarketplaceAutoInstallAttempted": false,
  "officialMarketplaceAutoInstalled": false,

  // ═══ §8 Statsig / GrowthBook cache ═══
  //
  // my-agent 採 ADR-003（無 feature flag 全啟用），以下兩個 cache 物件理論
  // 上用不到。但 createDefaultGlobalConfig 仍會初始化它們（為了跟 upstream
  // Claude Code 殘留程式碼相容），留著為好。
  //
  // cachedStatsigGates / cachedDynamicConfigs 可保持空物件。
  // cachedGrowthBookFeatures 在 createDefaultGlobalConfig 有一大串預設覆
  // 寫（把 upstream 的 gating 全部設 true），以便 my-agent 走「全功能」
  // 路徑。勿手改其中的值，否則某些 code path 可能 guard 失敗。

  "cachedStatsigGates": {},
  "cachedDynamicConfigs": {},

  // Penguin mode（org 層級 fast mode）快取。my-agent 無此概念，保留 false。
  "penguinModeOrgEnabled": false
}
`
