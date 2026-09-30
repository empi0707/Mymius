import { useCallback, useEffect, useState } from 'react'
import type { FileSyncStatus } from '../../../shared/ipc'

export function useFileSync(): { status: FileSyncStatus | null; refresh(): Promise<void> } {
  const [status, setStatus] = useState<FileSyncStatus | null>(null)
  const refresh = useCallback(async () => setStatus(await window.mymius.fileSync.status()), [])
  useEffect(() => {
    void refresh()
    return window.mymius.fileSync.onStatus(setStatus)
  }, [refresh])
  return { status, refresh }
}
