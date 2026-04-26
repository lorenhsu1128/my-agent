import { useState } from 'react'
import { ChevronDown, ChevronRight, Check, X, Loader2 } from 'lucide-react'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { cn } from '@/lib/utils'

export interface ToolCallCardProps {
  toolName: string
  input: unknown
  result?: unknown
  resultIsError?: boolean
}

export function ToolCallCard({ toolName, input, result, resultIsError }: ToolCallCardProps) {
  const [open, setOpen] = useState(false)
  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className={cn(
        'my-2 rounded-md border-l-4 bg-muted/40',
        resultIsError ? 'border-l-destructive' : 'border-l-primary',
      )}
    >
      <CollapsibleTrigger className="w-full flex items-center gap-2 px-3 py-2 hover:bg-muted/60 rounded-t-md text-left">
        {open ? <ChevronDown className="h-3 w-3 text-muted-foreground" /> : <ChevronRight className="h-3 w-3 text-muted-foreground" />}
        <span className="text-primary font-mono text-sm">{toolName}</span>
        {result === undefined ? (
          <span className="text-muted-foreground text-xs flex items-center gap-1">
            <Loader2 className="h-3 w-3 animate-spin" /> running
          </span>
        ) : resultIsError ? (
          <span className="text-destructive text-xs flex items-center gap-1">
            <X className="h-3 w-3" /> error
          </span>
        ) : (
          <span className="text-xs flex items-center gap-1 text-[hsl(var(--chart-3))]">
            <Check className="h-3 w-3" /> ok
          </span>
        )}
      </CollapsibleTrigger>
      <CollapsibleContent className="px-3 pb-3">
        <div className="text-muted-foreground text-[10px] uppercase mt-2">input</div>
        <pre className="text-xs whitespace-pre-wrap break-all bg-background border rounded px-2 py-1 mt-1 overflow-x-auto max-h-64 font-mono">
          {formatPretty(input)}
        </pre>
        {result !== undefined && (
          <>
            <div className="text-muted-foreground text-[10px] uppercase mt-2">result</div>
            <pre
              className={cn(
                'text-xs whitespace-pre-wrap break-all rounded px-2 py-1 mt-1 overflow-x-auto max-h-96 border font-mono',
                resultIsError ? 'text-destructive bg-destructive/10' : 'bg-background',
              )}
            >
              {formatResult(result)}
            </pre>
          </>
        )}
      </CollapsibleContent>
    </Collapsible>
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
