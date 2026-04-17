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
        // Notify the conversation that a skill creation was approved
        setMessages(prev => [
          ...prev,
          createSystemMessage(
            `用戶批准建立 skill "${current.name}"。請使用 SkillManage(action='create') 建立。`,
            'suggestion',
          ),
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
