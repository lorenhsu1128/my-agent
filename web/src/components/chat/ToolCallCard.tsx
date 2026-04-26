import { useState } from 'react'

export interface ToolCallCardProps {
  toolName: string
  input: unknown
  result?: unknown
  resultIsError?: boolean
}

export function ToolCallCard({
  toolName,
  input,
  result,
  resultIsError,
}: ToolCallCardProps) {
  const [open, setOpen] = useState(false)
  const inputJson = formatPretty(input)
  const resultText = formatResult(result)
  return (
    <div
      className={[
        'border-l-4 my-2 rounded bg-bg-tertiary',
        resultIsError ? 'border-status-dnd' : 'border-brand',
      ].join(' ')}
    >
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full text-left px-3 py-2 flex items-center gap-2 hover:bg-bg-accent/30 rounded-t"
      >
        <span className="text-text-muted text-xs">{open ? '▾' : '▸'}</span>
        <span className="text-brand font-mono text-sm">{toolName}</span>
        {result === undefined ? (
          <span className="text-text-muted text-xs">… running</span>
        ) : resultIsError ? (
          <span className="text-status-dnd text-xs">✗ error</span>
        ) : (
          <span className="text-status-online text-xs">✓ ok</span>
        )}
      </button>
      {open && (
        <div className="px-3 pb-3">
          <div className="text-text-muted text-[10px] uppercase mt-2">input</div>
          <pre className="text-xs text-text-secondary whitespace-pre-wrap break-all bg-bg-floating rounded px-2 py-1 mt-1 overflow-x-auto max-h-64">
            {inputJson}
          </pre>
          {result !== undefined && (
            <>
              <div className="text-text-muted text-[10px] uppercase mt-2">
                result
              </div>
              <pre
                className={[
                  'text-xs whitespace-pre-wrap break-all rounded px-2 py-1 mt-1 overflow-x-auto max-h-96',
                  resultIsError
                    ? 'text-status-dnd bg-status-dnd/10'
                    : 'text-text-secondary bg-bg-floating',
                ].join(' ')}
              >
                {resultText}
              </pre>
            </>
          )}
        </div>
      )}
    </div>
  )
}

function formatPretty(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2)
  } catch {
    return String(v)
  }
}

function formatResult(v: unknown): string {
  if (v === undefined) return ''
  if (typeof v === 'string') return v
  if (Array.isArray(v)) {
    // tool_result content 通常是 [{type:'text', text}]
    const out: string[] = []
    for (const item of v) {
      if (item && typeof item === 'object' && 'text' in item && typeof (item as { text?: unknown }).text === 'string') {
        out.push((item as { text: string }).text)
      } else {
        out.push(formatPretty(item))
      }
    }
    return out.join('\n')
  }
  return formatPretty(v)
}
