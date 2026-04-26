import { useState } from 'react'

export interface ThinkingBlockProps {
  text: string
  defaultCollapsed?: boolean
}

export function ThinkingBlock({
  text,
  defaultCollapsed = true,
}: ThinkingBlockProps) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed)
  const preview = text.replace(/\s+/g, ' ').slice(0, 80)
  return (
    <div className="my-2 border-l-2 border-text-muted/40 pl-3">
      <button
        onClick={() => setCollapsed(c => !c)}
        className="text-text-muted text-xs hover:text-text-secondary"
      >
        {collapsed ? '▸' : '▾'} thinking ({text.length}{' '}
        {collapsed && preview ? `· ${preview}…` : 'chars'})
      </button>
      {!collapsed && (
        <pre className="text-xs text-text-muted whitespace-pre-wrap mt-1">
          {text}
        </pre>
      )}
    </div>
  )
}
