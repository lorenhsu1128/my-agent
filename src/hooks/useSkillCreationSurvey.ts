// Skill Creation Survey — reads appState.pendingSkillCandidate and
// presents a confirmation to the user. On confirmation, clears the state
// so the main conversation can act on it (e.g., invoke /skillify or
// directly create via SkillManage tool).
//
// Modeled after useSkillImprovementSurvey.ts

import { useCallback, useRef, useState } from 'react'
type FeedbackSurveyResponse = 'dismissed' | 'bad' | 'fine' | 'good'
import { useAppState, useSetAppState } from '../state/AppState.js'
import type { Message } from '../types/message.js'
import { createSystemMessage, createUserMessage } from '../utils/messages.js'
import { createSkill } from '../tools/SkillManageTool/SkillManageTool.js'
import { logError } from '../utils/log.js'
import { toError } from '../utils/errors.js'

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
        const name = current.name
        const description =
          current.description ?? `${name}（自動由 skill nudge 建立，描述待補強）`
        const steps =
          current.steps && current.steps.length > 0
            ? current.steps
            : ['（偵測階段未提供步驟，請依實際工具序列補充）']

        const stepsBlock = steps.map((s, i) => `${i + 1}. ${s}`).join('\n')
        const skillMd = `---
name: ${name}
description: ${description}
when_to_use: ${description}
---

# ${name}

${description}

## Steps

${stepsBlock}
`

        createSkill(name, skillMd)
          .then(result => {
            if (result.success) {
              setMessages(prev => [
                ...prev,
                createSystemMessage(
                  `已建立 skill：${result.path}（內容為自動產生雛形，可請我用 SkillManage edit/patch 補強）`,
                  'info',
                ),
                createUserMessage({
                  content: `[系統] 使用者批准的 skill 已自動寫入磁碟：\n- name: ${name}\n- path: ${result.path}\n\n你不需要再次呼叫 SkillManage(create)。如果上下文中有更完整的步驟、注意事項或工具集，請改用 SkillManage(action='edit') 補強內容。`,
                  isMeta: true,
                }),
              ])
            } else {
              setMessages(prev => [
                ...prev,
                createSystemMessage(
                  `建立 skill '${name}' 失敗：${result.error}`,
                  'error',
                ),
              ])
            }
          })
          .catch(e => {
            logError(toError(e))
            setMessages(prev => [
              ...prev,
              createSystemMessage(
                `建立 skill '${name}' 發生例外：${toError(e).message}`,
                'error',
              ),
            ])
          })
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
