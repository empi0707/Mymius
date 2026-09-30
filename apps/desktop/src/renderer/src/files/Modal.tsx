import { useEffect, useRef } from 'react'

/** A dialog that closes on Escape and never leaves the keyboard focus behind it. */
export function Modal({ title, children, actions, onCancel, wide }: {
  title: string
  children: React.ReactNode
  actions: React.ReactNode
  onCancel(): void
  wide?: boolean
}): React.JSX.Element {
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    box.current?.querySelector<HTMLElement>('input, button.primary, button')?.focus()
    return () => previous?.focus?.()
  }, [])
  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel() }}>
      <div
        ref={box}
        className={`modal ${wide ? 'wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onKeyDown={(e) => {
          if (e.key === 'Escape') { e.stopPropagation(); onCancel() }
          e.stopPropagation() // shortcuts of the page behind must not fire while typing here
        }}
      >
        <h3>{title}</h3>
        <div className="modal-body">{children}</div>
        <div className="modal-actions">{actions}</div>
      </div>
    </div>
  )
}
