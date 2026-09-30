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
  if (s < 10) return 'vừa xong'
  if (s < 60) return `${s} giây trước`
  const m = Math.round(s / 60)
  if (m < 60) return `${m} phút trước`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} giờ trước`
  return new Date(ms).toLocaleString()
}
