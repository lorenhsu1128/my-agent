import type { Message } from '../../types/message.js'

type TranscriptShareResult = {
  success: boolean
  transcriptId?: string
}

export type TranscriptShareTrigger =
  | 'bad_feedback_survey'
  | 'good_feedback_survey'
  | 'frustration'
  | 'memory_survey'

/**
 * free-code: 不對 api.anthropic.com 上傳對話 transcript；保留簽章供 caller 不破壞，永遠回 success:false。
 */
export async function submitTranscriptShare(
  messages: Message[],
  trigger: TranscriptShareTrigger,
  appearanceId: string,
): Promise<TranscriptShareResult> {
  void messages
  void trigger
  void appearanceId
  return { success: false }
}
