import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Renders only the rows that are on screen, so a folder with 20,000 files scrolls as smoothly as one
 * with 20. Rows have a fixed height, which keeps the arithmetic trivial and robust.
 */
export function useVirtualList(count: number, rowHeight: number, overscan = 10) {
  const ref = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [height, setHeight] = useState(600)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    setHeight(el.clientHeight || 600)
    const ro = new ResizeObserver(() => setHeight(el.clientHeight || 600))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan)
  const end = Math.min(count, Math.ceil((scrollTop + height) / rowHeight) + overscan)

  const onScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => setScrollTop(e.currentTarget.scrollTop), [])

  /** Scroll the minimum amount needed to show a row (keyboard navigation). */
  const reveal = useCallback((index: number) => {
    const el = ref.current
    if (!el) return
    const top = index * rowHeight
    if (top < el.scrollTop) el.scrollTop = top
    else if (top + rowHeight > el.scrollTop + el.clientHeight) el.scrollTop = top + rowHeight - el.clientHeight
  }, [rowHeight])

  return { ref, start, end, totalHeight: count * rowHeight, onScroll, reveal, pageSize: Math.max(1, Math.floor(height / rowHeight) - 1) }
}
