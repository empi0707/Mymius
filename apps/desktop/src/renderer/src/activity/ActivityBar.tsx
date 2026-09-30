import { useEffect, useState } from 'react'
import { summarize, useActivities } from './activity'

/** How long something must last before it is worth showing, and how long the bar stays once shown (so it never flashes). */
const SHOW_AFTER_MS = 200
const MIN_VISIBLE_MS = 600

/** A short, thin bar in the top-right corner: what the app is busy with, and how far along it is when that is known. */
export function ActivityBar(): React.JSX.Element | null {
  const list = useActivities()
  const busy = list.length > 0
  const [shown, setShown] = useState(false)

  useEffect(() => {
    if (busy && !shown) {
      const t = window.setTimeout(() => setShown(true), SHOW_AFTER_MS)
      return () => window.clearTimeout(t)
    }
    if (!busy && shown) {
      const t = window.setTimeout(() => setShown(false), MIN_VISIBLE_MS)
      return () => window.clearTimeout(t)
    }
    return undefined
  }, [busy, shown])

  const now = summarize(list)
  const [last, setLast] = useState(now)
  useEffect(() => { if (now) setLast(now) }, [now?.label, now?.progress])
  const show = shown ? (now ?? last) : null
  if (!show) return null

  return (
    <div className="activity" role="status" aria-live="polite" data-testid="activity">
      <span className="activity-label" data-testid="activity-label" title={show.label}>{show.label}</span>
      <span className="activity-track" aria-hidden>
        <span
          className={`activity-fill ${show.progress === undefined ? 'indeterminate' : ''}`}
          data-testid="activity-fill"
          {...(show.progress !== undefined ? { style: { width: `${Math.round(show.progress * 100)}%` } } : {})}
        />
      </span>
    </div>
  )
}
