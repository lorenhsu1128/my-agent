import { feature } from 'bun:bundle'
import type { Message } from '../types/message.js'
import type { Attachment } from '../utils/attachments.js'
import { getGlobalConfig } from '../utils/config.js'
import {
  getSectionInterpolated,
  interpolate,
} from '../systemPromptFiles/snapshot.js'
import { getCompanion } from './companion.js'

// M-SP-FULL Phase 3：buddy 介紹文外部化（{name}, {species} 插值）。
const COMPANION_INTRO_FALLBACK = `# Companion

A small {species} named {name} sits beside the user's input box and occasionally comments in a speech bubble. You're not {name} — it's a separate watcher.

When the user addresses {name} directly (by name), its bubble will answer. Your job in that moment is to stay out of the way: respond in ONE line or less, or just answer any part of the message meant for you. Don't explain that you're not {name} — they know. Don't narrate what {name} might say — the bubble handles that.`

export function companionIntroText(name: string, species: string): string {
  const vars = { name, species }
  return (
    getSectionInterpolated('subllm/buddy-companion', vars) ??
    interpolate(COMPANION_INTRO_FALLBACK, vars)
  )
}

export function getCompanionIntroAttachment(
  messages: Message[] | undefined,
): Attachment[] {
  if (!feature('BUDDY')) return []
  const companion = getCompanion()
  if (!companion || getGlobalConfig().companionMuted) return []

  // Skip if already announced for this companion.
  for (const msg of messages ?? []) {
    if (msg.type !== 'attachment') continue
    if (msg.attachment.type !== 'companion_intro') continue
    if (msg.attachment.name === companion.name) return []
  }

  return [
    {
      type: 'companion_intro',
      name: companion.name,
      species: companion.species,
    },
  ]
}
