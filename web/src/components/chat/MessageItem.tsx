import type { UiMessage } from '../../store/messageStore'
import { ToolCallCard } from './ToolCallCard'
import { ThinkingBlock } from './ThinkingBlock'

export interface MessageItemProps {
  message: UiMessage
}

export function MessageItem({ message }: MessageItemProps) {
  const isUser = message.role === 'user'
  return (
    <article
      className={[
        'flex flex-col gap-1 px-4 py-3',
        isUser
          ? 'bg-bg-secondary/50 border-l-2 border-brand'
          : 'border-l-2 border-transparent',
      ].join(' ')}
    >
      <header className="flex items-baseline gap-2">
        <span
          className={[
            'text-sm font-semibold',
            isUser ? 'text-brand' : 'text-text-primary',
          ].join(' ')}
        >
          {isUser ? '你' : 'Assistant'}
        </span>
        {message.source && message.source !== 'web' && (
          <span className="text-text-muted text-[10px] uppercase">
            via {message.source}
          </span>
        )}
        {message.inFlight && (
          <span className="text-status-idle text-xs">… streaming</span>
        )}
      </header>
      <div className="flex flex-col text-sm text-text-primary">
        {message.blocks.length === 0 && message.inFlight && (
          <span className="text-text-muted">… 等待回應</span>
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
