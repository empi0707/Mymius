import { useCallback, useEffect, useState } from 'react'
import type { AutoBackupStatus } from '../../../shared/ipc'

export function useAutoBackup(): { status: AutoBackupStatus | null; refresh(): Promise<void> } {
  const [status, setStatus] = useState<AutoBackupStatus | null>(null)
  const refresh = useCallback(async () => setStatus(await window.mymius.autoBackup.status()), [])
  useEffect(() => {
    void refresh()
    return window.mymius.autoBackup.onStatus(setStatus)
  }, [refresh])
  return { status, refresh }
}
