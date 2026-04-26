import { useEffect, useRef } from 'react'
import { useMessageStore } from '../../store/messageStore'
import { MessageItem } from './MessageItem'
import { ScrollArea } from '@/components/ui/scroll-area'

export interface MessageListProps {
  sessionId: string
}

export function MessageList({ sessionId }: MessageListProps) {
  const messages = useMessageStore(s => s.bySession[sessionId] ?? [])
  const scrollRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const viewport = el.querySelector('[data-radix-scroll-area-viewport]') as HTMLElement | null
    const target = viewport ?? el
    const distFromBottom = target.scrollHeight - target.scrollTop - target.clientHeight
    if (distFromBottom < 200) {
      target.scrollTop = target.scrollHeight
    }
  }, [messages.length, messages[messages.length - 1]?.blocks.length])

  if (messages.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
        尚無訊息 — 在下方輸入框送一條訊息開始對話
      </div>
    )
  }
  return (
    <ScrollArea ref={scrollRef} className="flex-1">
      <div className="flex flex-col">
        {messages.map(m => (
          <MessageItem key={m.id} message={m} />
        ))}
      </div>
    </ScrollArea>
  )
}
