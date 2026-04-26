import { useState } from 'react'
import { ChevronDown, ChevronRight, Brain } from 'lucide-react'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'

export interface ThinkingBlockProps {
  text: string
  defaultCollapsed?: boolean
}

export function ThinkingBlock({ text, defaultCollapsed = true }: ThinkingBlockProps) {
  const [open, setOpen] = useState(!defaultCollapsed)
  const preview = text.replace(/\s+/g, ' ').slice(0, 80)
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="my-2">
      <CollapsibleTrigger className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors">
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        <Brain className="h-3 w-3" />
        <span>thinking ({text.length} {!open && preview ? `· ${preview}…` : 'chars'})</span>
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-1 border-l-2 border-muted pl-3">
        <pre className="text-xs text-muted-foreground whitespace-pre-wrap font-mono">
          {text}
        </pre>
      </CollapsibleContent>
    </Collapsible>
  )
}
