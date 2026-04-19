// Generates a default global settings.json (JSONC format with Traditional Chinese comments)
// for first-time users. Called once at startup when ~/.my-agent/settings.json doesn't exist.

export function generateDefaultSettingsContent(): string {
  return `{
  // ═══════════════════════════════════════════════════════════════
  //  my-agent 全域設定檔
  //  此檔案在首次執行時自動產生，所有值皆為預設值。
  //  修改後重新啟動 my-agent 即可生效。
  //  檔案格式：JSONC（支援 // 註解）
  //
  //  設定優先級（低→高）：
  //    此檔案（全域）→ 專案 .my-agent/settings.json
  //    → .my-agent/settings.local.json → 命令列參數
  //
  //  全域目錄結構（~/.my-agent/）：
  //    settings.json      ← 你正在讀的這份檔案
  //    projects/           ← 各專案的 session 記錄與記憶
  //      <project>/          每個專案一個子目錄（以專案路徑命名）
  //        *.jsonl             session transcript（對話原始記錄）
  //        session-index.db    SQLite FTS5 全文搜尋索引
  //        memory/             自動記憶目錄
  //          MEMORY.md           記憶索引（≤200 行）
  //          *.md                主題記憶檔（user/feedback/project/reference 四型）
  //          skill-drafts/       Session Review 產出的 skill 草稿
  //          trajectories/       每日 session 軌跡摘要
  //    plans/              ← Plan mode 的計畫檔案
  //    cache/              ← 外部資源快取
  // ═══════════════════════════════════════════════════════════════

  // ── 模型設定 ──────────────────────────────────────────────────

  // 覆寫預設模型（取消註解並填入模型名稱即可切換）
  // 本地模型範例："qwen3.5-9b-neo"（需先啟動 llama.cpp server）
  // "model": "",

  // ── 記憶與學習 ────────────────────────────────────────────────

  // 啟用自動記憶（跨 session 記住用戶偏好和專案知識）
  "autoMemoryEnabled": true,

  // 啟用背景記憶整合（AutoDream — 定期整理跨 session 的記憶）
  "autoDreamEnabled": true,

  // 自我改進迴圈的觸發閾值
  // 所有欄位皆可選，未設定或刪除時使用括號內的預設值
  "selfImproveThresholds": {
    // 每 N 個用戶訊息檢查一次已有 skill 的改進需求（預設：5）
    "skillImprovementTurnBatch": 5,
    // 每 N 個用戶訊息偵測一次用戶偏好/修正（預設：8）
    "memoryNudgeTurnBatch": 8,
    // 累積 N 個工具呼叫後偵測可 skill 化的 workflow（預設：15）
    "skillCreationToolUseThreshold": 15,
    // Session 內至少 N 個工具呼叫才觸發 session review（預設：15）
    "sessionReviewMinToolUses": 15,
    // 兩次 session review 之間至少間隔 N 小時（預設：2，支援小數如 0.5）
    "sessionReviewMinIntervalHours": 2,
    // 距上次記憶整合至少 N 小時才觸發 AutoDream（預設：24）
    "autoDreamMinHours": 24,
    // 距上次記憶整合至少 N 個 session 才觸發 AutoDream（預設：5）
    "autoDreamMinSessions": 5
  },

  // ── 介面與顯示 ────────────────────────────────────────────────

  // 偏好語言（影響 AI 回應的語言偏好）
  // "language": "zh-TW",

  // 顯示思考過程摘要（在 Ctrl+O transcript 檢視中）
  "showThinkingSummaries": false,

  // 減少動畫效果（無障礙設定 — spinner 閃爍等）
  "prefersReducedMotion": false,

  // ── Git 與提交 ────────────────────────────────────────────────

  // 提交訊息是否包含 Co-Authored-By 標記
  "includeCoAuthoredBy": true,

  // ── 工作階段管理 ──────────────────────────────────────────────

  // session 記錄保留天數（超過此天數的舊 session 會被自動清理）
  "cleanupPeriodDays": 30
}
`
}
