import { useCallback, useEffect, useState } from 'react'
import type { VaultStatus } from '../../../shared/ipc'

/** The vault's state, kept fresh when it locks or unlocks (including auto-lock in the main process). */
export function useVault(): { status: VaultStatus | null; refresh(): Promise<void> } {
  const [status, setStatus] = useState<VaultStatus | null>(null)
  const refresh = useCallback(async () => setStatus(await window.mymius.vault.status()), [])
  useEffect(() => {
    void refresh()
    return window.mymius.vault.onState(() => void refresh())
  }, [refresh])
  return { status, refresh }
}
