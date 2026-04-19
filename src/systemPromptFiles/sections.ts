/**
 * System Prompt Externalization — Section 註冊表
 *
 * 每個 section 對應一個 .md 檔。SectionId 作為程式碼內的 key，
 * filename 是使用者會看到的檔案名。所有條件分支（USER_TYPE、feature flag）
 * 仍由程式碼在讀取檔案後處理，.md 只承載「預設的完整文字」。
 *
 * Status：
 *   - externalized = true：已接上檔案載入，TS 端改為讀 snapshot
 *   - externalized = false：計畫中尚未搬家，僅列出以 seed README
 */
export type SectionId =
  | 'intro'
  | 'system'
  | 'doing-tasks'
  | 'actions'
  | 'using-tools'
  | 'tone-style'
  | 'output-efficiency'
  | 'proactive'
  | 'skills-guidance'
  | 'numeric-length-anchors'
  | 'token-budget'
  | 'scratchpad'
  | 'frc'
  | 'summarize-tool-results'
  | 'default-agent'
  | 'cyber-risk'
  | 'user-profile-frame'
  | 'errors/max-turns'
  | 'errors/max-budget'
  | 'errors/max-structured-output-retries'
  | 'errors/ede-diagnostic'
  | 'memory/types-combined'
  | 'memory/types-individual'
  | 'memory/what-not-to-save'
  | 'memory/drift-caveat'
  | 'memory/when-to-access'
  | 'memory/trusting-recall'
  | 'memory/frontmatter-example'
  | 'memory/combined-template'

export interface SectionMeta {
  id: SectionId
  filename: string
  /** 一句話說明此檔案影響的 prompt 區塊 */
  purpose: string
  /** 注入時機：static(啟動凍結) / dynamic(每 turn) / conditional(feature flag) */
  timing: 'static' | 'dynamic' | 'conditional'
  /** 是否已接上檔案載入（false = 尚未搬、走程式碼寫死） */
  externalized: boolean
  /** 是否可安全刪除（true = 刪除會 fallback 回 bundled；false = 空字串是刻意設計） */
  safeToDelete: boolean
}

export const SECTIONS: SectionMeta[] = [
  {
    id: 'intro',
    filename: 'intro.md',
    purpose: 'system prompt 開頭的身份宣告 + 網安聲明',
    timing: 'static',
    externalized: true,
    safeToDelete: true,
  },
  {
    id: 'system',
    filename: 'system.md',
    purpose: '# System 規則段（工具、tags、injection、hooks）',
    timing: 'static',
    externalized: true,
    safeToDelete: true,
  },
  {
    id: 'doing-tasks',
    filename: 'doing-tasks.md',
    purpose: '# Doing tasks 任務執行準則與程式碼風格',
    timing: 'static',
    externalized: false,
    safeToDelete: true,
  },
  {
    id: 'actions',
    filename: 'actions.md',
    purpose: '# Executing actions with care 可逆/不可逆動作守則',
    timing: 'static',
    externalized: true,
    safeToDelete: true,
  },
  {
    id: 'using-tools',
    filename: 'using-tools.md',
    purpose: '# Using your tools 工具選擇守則',
    timing: 'static',
    externalized: false,
    safeToDelete: true,
  },
  {
    id: 'tone-style',
    filename: 'tone-style.md',
    purpose: '# Tone and style 回應風格（簡潔、emoji、file:line 格式）',
    timing: 'static',
    externalized: true,
    safeToDelete: true,
  },
  {
    id: 'output-efficiency',
    filename: 'output-efficiency.md',
    purpose: '# Output efficiency 輸出簡潔性原則',
    timing: 'static',
    externalized: true,
    safeToDelete: true,
  },
  {
    id: 'proactive',
    filename: 'proactive.md',
    purpose: 'Proactive/Kairos 自主模式指示（feature 啟用時才注入）',
    timing: 'conditional',
    externalized: false,
    safeToDelete: true,
  },
  {
    id: 'skills-guidance',
    filename: 'skills-guidance.md',
    purpose: 'SkillManage 工具啟用時的使用指引',
    timing: 'conditional',
    externalized: false,
    safeToDelete: true,
  },
  {
    id: 'numeric-length-anchors',
    filename: 'numeric-length-anchors.md',
    purpose: '回應字數上限（USER_TYPE=ant 才注入）',
    timing: 'conditional',
    externalized: false,
    safeToDelete: true,
  },
  {
    id: 'token-budget',
    filename: 'token-budget.md',
    purpose: 'Token budget 模式指示（feature TOKEN_BUDGET 啟用時）',
    timing: 'conditional',
    externalized: false,
    safeToDelete: true,
  },
  {
    id: 'scratchpad',
    filename: 'scratchpad.md',
    purpose: 'Scratchpad 工作目錄指引',
    timing: 'conditional',
    externalized: false,
    safeToDelete: true,
  },
  {
    id: 'frc',
    filename: 'frc.md',
    purpose: 'Function result clearing 微壓縮說明',
    timing: 'conditional',
    externalized: false,
    safeToDelete: true,
  },
  {
    id: 'summarize-tool-results',
    filename: 'summarize-tool-results.md',
    purpose: '工具結果摘要指引',
    timing: 'static',
    externalized: false,
    safeToDelete: true,
  },
  {
    id: 'default-agent',
    filename: 'default-agent.md',
    purpose: '預設 subagent 系統提示',
    timing: 'static',
    externalized: false,
    safeToDelete: true,
  },
  {
    id: 'cyber-risk',
    filename: 'cyber-risk.md',
    purpose: '網安風險聲明（預設空檔；使用者若補上會注入 intro 開頭）',
    timing: 'static',
    externalized: false,
    safeToDelete: true,
  },
  {
    id: 'user-profile-frame',
    filename: 'user-profile-frame.md',
    purpose: '<user-profile> 外框前後綴文字（M-UM）',
    timing: 'dynamic',
    externalized: false,
    safeToDelete: false,
  },
  {
    id: 'errors/max-turns',
    filename: 'errors/max-turns.md',
    purpose: '達到最大 turn 數時注入 LLM 的錯誤訊息（支援 {maxTurns} 變數）',
    timing: 'conditional',
    externalized: false,
    safeToDelete: true,
  },
  {
    id: 'errors/max-budget',
    filename: 'errors/max-budget.md',
    purpose: '達到最大預算時的錯誤訊息（支援 {maxBudgetUsd}）',
    timing: 'conditional',
    externalized: false,
    safeToDelete: true,
  },
  {
    id: 'errors/max-structured-output-retries',
    filename: 'errors/max-structured-output-retries.md',
    purpose: 'structured output 重試失敗訊息（支援 {maxRetries}）',
    timing: 'conditional',
    externalized: false,
    safeToDelete: true,
  },
  {
    id: 'errors/ede-diagnostic',
    filename: 'errors/ede-diagnostic.md',
    purpose: '查詢執行失敗時的診斷訊息',
    timing: 'conditional',
    externalized: false,
    safeToDelete: true,
  },
  {
    id: 'memory/types-combined',
    filename: 'memory/types-combined.md',
    purpose: 'memory 系統 combined mode 的類型分類說明',
    timing: 'static',
    externalized: false,
    safeToDelete: true,
  },
  {
    id: 'memory/types-individual',
    filename: 'memory/types-individual.md',
    purpose: 'memory 系統 individual mode 的類型分類說明',
    timing: 'static',
    externalized: false,
    safeToDelete: true,
  },
  {
    id: 'memory/what-not-to-save',
    filename: 'memory/what-not-to-save.md',
    purpose: 'memory 禁止保存的項目說明',
    timing: 'static',
    externalized: false,
    safeToDelete: true,
  },
  {
    id: 'memory/drift-caveat',
    filename: 'memory/drift-caveat.md',
    purpose: 'memory 可能過期的警告',
    timing: 'static',
    externalized: false,
    safeToDelete: true,
  },
  {
    id: 'memory/when-to-access',
    filename: 'memory/when-to-access.md',
    purpose: '何時讀取 memory 的指引',
    timing: 'static',
    externalized: false,
    safeToDelete: true,
  },
  {
    id: 'memory/trusting-recall',
    filename: 'memory/trusting-recall.md',
    purpose: '驗證 recalled memory 的指引',
    timing: 'static',
    externalized: false,
    safeToDelete: true,
  },
  {
    id: 'memory/frontmatter-example',
    filename: 'memory/frontmatter-example.md',
    purpose: 'memory 檔案 frontmatter 範例',
    timing: 'static',
    externalized: false,
    safeToDelete: true,
  },
  {
    id: 'memory/combined-template',
    filename: 'memory/combined-template.md',
    purpose: 'memory combined prompt 完整模板',
    timing: 'static',
    externalized: false,
    safeToDelete: true,
  },
]

export function getSectionMeta(id: SectionId): SectionMeta {
  const meta = SECTIONS.find(s => s.id === id)
  if (!meta) throw new Error(`Unknown section id: ${id}`)
  return meta
}
