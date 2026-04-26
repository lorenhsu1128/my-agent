import type { UiMessage } from '../../store/messageStore'
import { ToolCallCard } from './ToolCallCard'
import { ThinkingBlock } from './ThinkingBlock'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

export interface MessageItemProps {
  message: UiMessage
}

export function MessageItem({ message }: MessageItemProps) {
  const isUser = message.role === 'user'
  return (
    <article
      className={cn(
        'flex flex-col gap-1 px-4 py-3 border-l-2',
        isUser ? 'bg-muted/40 border-l-primary' : 'border-l-transparent',
      )}
    >
      <header className="flex items-baseline gap-2">
        <span className={cn('text-sm font-semibold', isUser ? 'text-primary' : 'text-foreground')}>
          {isUser ? '你' : 'Assistant'}
        </span>
        {message.source && message.source !== 'web' && (
          <Badge variant="outline" className="text-[10px] uppercase">
            via {message.source}
          </Badge>
        )}
        {message.inFlight && (
          <span className="text-xs text-muted-foreground">… streaming</span>
        )}
      </header>
      <div className="flex flex-col text-sm">
        {message.blocks.length === 0 && message.inFlight && (
          <span className="text-muted-foreground">… 等待回應</span>
        )}
        {message.blocks.map((b, i) => {
          if (b.kind === 'text') {
            return (
              <div key={i} className="whitespace-pre-wrap break-words">
                {b.text}
              </div>
            )
          }
          if (b.kind === 'thinking') {
            return <ThinkingBlock key={i} text={b.text} />
          }
          if (b.kind === 'tool_use') {
            return (
              <ToolCallCard
                key={i}
                toolName={b.toolName}
                input={b.input}
                result={b.result}
                resultIsError={b.resultIsError}
              />
            )
          }
          return null
        })}
      </div>
    </article>
  )
}
