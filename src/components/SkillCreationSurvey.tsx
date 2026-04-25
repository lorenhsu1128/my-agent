import React, { useEffect, useRef } from 'react'
import { BLACK_CIRCLE, BULLET_OPERATOR } from '../constants/figures.js'
import type { SkillCreationCandidate } from '../hooks/useSkillCreationSurvey.js'
import { Box, Text } from '../ink.js'
import { normalizeFullWidthDigits } from '../utils/stringUtils.js'
type FeedbackSurveyResponse = 'dismissed' | 'bad' | 'fine' | 'good'
const RESPONSE_INPUTS = ['0', '1', '2', '3'] as const
const isValidResponseInput = (input: string): boolean =>
  (RESPONSE_INPUTS as readonly string[]).includes(input)

type Props = {
  isOpen: boolean
  candidate: SkillCreationCandidate
  handleSelect: (selected: FeedbackSurveyResponse) => void
  inputValue: string
  setInputValue: (value: string) => void
}

export function SkillCreationSurvey({
  isOpen,
  candidate,
  handleSelect,
  inputValue,
  setInputValue,
}: Props): React.ReactNode {
  if (!isOpen) {
    return null
  }

  // Hide the survey if the user is typing anything other than a survey response
  if (inputValue && !isValidResponseInput(inputValue)) {
    return null
  }

  return (
    <SkillCreationSurveyView
      candidate={candidate}
      onSelect={handleSelect}
      inputValue={inputValue}
      setInputValue={setInputValue}
    />
  )
}

type ViewProps = {
  candidate: SkillCreationCandidate
  onSelect: (option: FeedbackSurveyResponse) => void
  inputValue: string
  setInputValue: (value: string) => void
}

// Only 1 (create) and 0 (dismiss) are valid for this survey
const VALID_INPUTS = ['0', '1'] as const

function isValidInput(input: string): boolean {
  return (VALID_INPUTS as readonly string[]).includes(input)
}

function SkillCreationSurveyView({
  candidate,
  onSelect,
  inputValue,
  setInputValue,
}: ViewProps): React.ReactNode {
  const initialInputValue = useRef(inputValue)

  useEffect(() => {
    if (inputValue !== initialInputValue.current) {
      const lastChar = normalizeFullWidthDigits(inputValue.slice(-1))
      if (isValidInput(lastChar)) {
        setInputValue(inputValue.slice(0, -1))
        // Map: 1 = "good" (create), 0 = "dismissed"
        onSelect(lastChar === '1' ? 'good' : 'dismissed')
      }
    }
  }, [inputValue, onSelect, setInputValue])

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box>
        <Text color="ansi:cyan">{BLACK_CIRCLE} </Text>
        <Text bold>
          Skill creation suggested: &quot;{candidate.name}&quot;
        </Text>
      </Box>

      {candidate.description && (
        <Box marginLeft={2}>
          <Text dimColor>{candidate.description}</Text>
        </Box>
      )}

      {candidate.steps && candidate.steps.length > 0 && (
        <Box flexDirection="column" marginLeft={2}>
          {candidate.steps.map((step, i) => (
            <Text key={i} dimColor>
              {BULLET_OPERATOR} {step}
            </Text>
          ))}
        </Box>
      )}

      <Box marginLeft={2} marginTop={1}>
        <Box width={12}>
          <Text>
            <Text color="ansi:cyan">1</Text>: 建立
          </Text>
        </Box>
        <Box width={14}>
          <Text>
            <Text color="ansi:cyan">0</Text>: 略過
          </Text>
        </Box>
      </Box>
    </Box>
  )
}
