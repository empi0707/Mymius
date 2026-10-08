import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { MenuEntry } from './menu'

interface Props<A extends string> {
  x: number
  y: number
  entries: MenuEntry<A>[]
  onPick(action: A): void
  onClose(): void
}

/** A right-click menu: closes on Escape, a click elsewhere, scrolling or losing the window; arrows + Enter work too. */
export function ContextMenu<A extends string>({ x, y, entries, onPick, onClose }: Props<A>): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: x, top: y })
  const actionable = entries.flatMap((e, i) => (!e.separator && !e.disabled ? [i] : []))
  const [focus, setFocus] = useState<number>(actionable[0] ?? -1)

  // Keep it inside the window.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    setPos({ left: Math.max(4, Math.min(x, window.innerWidth - r.width - 4)), top: Math.max(4, Math.min(y, window.innerHeight - r.height - 4)) })
  }, [x, y])

  useEffect(() => {
    const away = (e: Event): void => { if (!ref.current?.contains(e.target as Node)) onClose() }
    const key = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); return }
      const at = actionable.indexOf(focus)
      if (['ArrowDown', 'ArrowUp', 'Enter'].includes(e.key)) e.stopPropagation() // the pane behind must not also act on it
      if (e.key === 'ArrowDown') { e.preventDefault(); setFocus(actionable[(at + 1) % actionable.length] ?? -1) }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setFocus(actionable[(at - 1 + actionable.length) % actionable.length] ?? -1) }
      else if (e.key === 'Enter') {
        e.preventDefault()
        const entry = entries[focus]
        if (entry && !entry.separator && !entry.disabled) onPick(entry.action)
      }
    }
    document.addEventListener('mousedown', away, true)
    document.addEventListener('keydown', key, true)
    window.addEventListener('blur', onClose)
    window.addEventListener('resize', onClose)
    document.addEventListener('wheel', onClose, { capture: true, passive: true })
    return () => {
      document.removeEventListener('mousedown', away, true)
      document.removeEventListener('keydown', key, true)
      window.removeEventListener('blur', onClose)
      window.removeEventListener('resize', onClose)
      document.removeEventListener('wheel', onClose, { capture: true })
    }
  })

  return (
    <div ref={ref} className="ctx-menu" role="menu" aria-label="File actions" data-testid="context-menu" style={pos} onContextMenu={(e) => e.preventDefault()}>
      {entries.map((e, i) =>
        e.separator ? (
          <div key={i} className="ctx-sep" role="separator" />
        ) : (
          <button
            key={e.action}
            role="menuitem"
            className={`ctx-item ${e.danger ? 'danger' : ''} ${focus === i ? 'focus' : ''}`}
            disabled={e.disabled}
            onMouseEnter={() => !e.disabled && setFocus(i)}
            onClick={() => onPick(e.action)}
          >
            <span>{e.label}</span>
            {e.hint && <kbd>{e.hint}</kbd>}
          </button>
        )
      )}
    </div>
  )
}
