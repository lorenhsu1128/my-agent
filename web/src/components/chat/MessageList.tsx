import { useEffect, useRef } from 'react'
import { useMessageStore } from '../../store/messageStore'
import { MessageItem } from './MessageItem'

export interface MessageListProps {
  sessionId: string
}

export function MessageList({ sessionId }: MessageListProps) {
  const messages = useMessageStore(s => s.bySession[sessionId] ?? [])
  const scrollRef = useRef<HTMLDivElement | null>(null)

  // 自動捲到底（user 接近底時才 auto-scroll；否則保持位置）
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const distFromBottom =
      el.scrollHeight - el.scrollTop - el.clientHeight
    if (distFromBottom < 200) {
      el.scrollTop = el.scrollHeight
    }
  }, [messages.length, messages[messages.length - 1]?.blocks.length])

  if (messages.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-text-muted text-sm">
        尚無訊息 — 在下方輸入框送一條訊息開始對話
      </div>
    )
  }
  return (
    <div ref={scrollRef} className="flex-1 overflow-y-auto">
      <div className="flex flex-col">
        {messages.map(m => (
          <MessageItem key={m.id} message={m} />
        ))}
      </div>
    </div>
  )
}
