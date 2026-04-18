// Skill Creation Survey — reads appState.pendingSkillCandidate and
// presents a confirmation to the user. On confirmation, clears the state
// so the main conversation can act on it (e.g., invoke /skillify or
// directly create via SkillManage tool).
//
// Modeled after useSkillImprovementSurvey.ts

import { useCallback, useRef, useState } from 'react'
import type { FeedbackSurveyResponse } from '../components/FeedbackSurvey/utils.js'
import { useAppState, useSetAppState } from '../state/AppState.js'
import type { Message } from '../types/message.js'
import { createSystemMessage } from '../utils/messages.js'

export type SkillCreationCandidate = {
  isCandidate: boolean
  name?: string
  description?: string
  steps?: string[]
}

type SetMessages = (fn: (prev: Message[]) => Message[]) => void

export function useSkillCreationSurvey(setMessages: SetMessages): {
  isOpen: boolean
  candidate: SkillCreationCandidate | null
  handleSelect: (selected: FeedbackSurveyResponse) => void
} {
  const candidate = useAppState(s => s.pendingSkillCandidate)
  const setAppState = useSetAppState()
  const [isOpen, setIsOpen] = useState(false)
  const lastCandidateRef = useRef(candidate)

  // Track the candidate for display even after clearing AppState
  if (candidate) {
    lastCandidateRef.current = candidate
  }

  // Open when a new candidate arrives
  if (candidate && !isOpen) {
    setIsOpen(true)
  }

  const handleSelect = useCallback(
    (selected: FeedbackSurveyResponse) => {
      const current = lastCandidateRef.current
      if (!current) return

      const approved = selected !== 'dismissed'

      if (approved && current.name) {
        const stepsBlock =
          current.steps && current.steps.length > 0
            ? current.steps.map((s, i) => `  ${i + 1}. ${s}`).join('\n')
            : '  （偵測階段未提供步驟，請依工具序列自行歸納）'
        const descLine = current.description
          ? `- description: ${current.description}`
          : '- description: （偵測階段未提供，請依上下文擬定一行描述）'

        const body = `用戶批准建立 skill。立即呼叫 SkillManage(action='create') 建立下列 skill，**不要反問使用者**——以下資訊已足夠組出 SKILL.md：

- name: ${current.name}
${descLine}
- 建議 steps：
${stepsBlock}

content 參數請組成完整 SKILL.md：YAML frontmatter 至少含 name / description / when_to_use；Body 含 \`# <title>\` 與 \`## Steps\` 編號清單。若步驟需要特定工具，於 frontmatter 補 \`allowed-tools\`。建立後簡短回報路徑即可，不要再詢問使用者細節。`

        setMessages(prev => [
          ...prev,
          createSystemMessage(body, 'suggestion'),
        ])
      }

      // Close and clear
      setIsOpen(false)
      setAppState(prev => {
        if (!prev.pendingSkillCandidate) return prev
        return {
          ...prev,
          pendingSkillCandidate: null,
        }
      })
    },
    [setAppState, setMessages],
  )

  return {
    isOpen,
    candidate: lastCandidateRef.current,
    handleSelect,
  }
}
