import { useCallback, useEffect, useState } from 'react'
import type { DriveStatus } from '../../../shared/ipc'

/** The Google Drive sync state, kept current as the main process reports changes. */
export function useDrive(): { status: DriveStatus | null; refresh(): Promise<void> } {
  const [status, setStatus] = useState<DriveStatus | null>(null)
  const refresh = useCallback(async () => setStatus(await window.mymius.drive.status()), [])
  useEffect(() => {
    void refresh()
    return window.mymius.drive.onStatus(setStatus)
  }, [refresh])
  return { status, refresh }
}

export function timeAgo(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000))
  if (s < 10) return 'just now'
  if (s < 60) return `${s} seconds ago`
  const m = Math.round(s / 60)
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'} ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`
  return new Date(ms).toLocaleString()
}
