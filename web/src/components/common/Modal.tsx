import type { ReactNode } from 'react'

export interface ModalProps {
  open: boolean
  onClose: () => void
  title?: string
  children: ReactNode
}

export function Modal({ open, onClose, title, children }: ModalProps) {
  if (!open) return null
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={e => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="w-[480px] max-w-[90vw] rounded-lg bg-bg-secondary shadow-2xl border border-divider">
        {title && (
          <div className="px-6 py-4 border-b border-divider">
            <h2 className="text-lg font-semibold text-text-primary">{title}</h2>
          </div>
        )}
        <div className="p-6">{children}</div>
      </div>
    </div>
  )
}
