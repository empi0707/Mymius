import { useState } from 'react'
import { timeAgo } from './useDrive'
import { useFileSync } from './useFileSync'

/** Backup, restore and account-free sync through a plain .json file the person chooses. */
export function FileSyncCard(): React.JSX.Element {
  const { status, refresh } = useFileSync()
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null)

  const act = async (fn: () => Promise<{ ok: boolean; error?: string }>, done?: string): Promise<void> => {
    setBusy(true); setMessage(null)
    const r = await fn()
    setBusy(false)
    if (!r.ok && r.error) setMessage({ text: r.error, error: true })
    else if (r.ok && done) setMessage({ text: done, error: false })
    await refresh()
  }
  const api = window.mymius.fileSync
  const linked = !!status?.path

  return (
    <section className="card" data-testid="filesync-card">
      <h3>Backup and sync file</h3>
      <p className="hint">
        Your vault as a single <code>.json</code> file, encrypted with your passphrase, so it is safe to keep anywhere. Save a backup, or point Mymius at a file inside a folder
        that iCloud Drive, Dropbox, OneDrive, Syncthing or a NAS already syncs, and your devices stay in step without any account.
      </p>

      {linked && status && (
        <div data-testid="filesync-linked">
          <div className="row"><code className="path" data-testid="filesync-path">{status.path}</code><span className="grow" /><span className={`badge ${status.phase}`} data-testid="filesync-phase">{status.phase === 'idle' ? 'up to date' : status.phase === 'locked' ? 'vault locked' : status.phase === 'error' ? 'problem' : status.phase}</span></div>
          <p className="sub" data-testid="filesync-line">
            {status.lastSyncAt ? `Last synced ${timeAgo(status.lastSyncAt)}` : 'Not synced yet'}{' · '}{status.devices === 0 ? 'no other devices yet' : `${status.devices} other device${status.devices === 1 ? '' : 's'}`}
          </p>
          {status.error && <p className="error" role="alert">{status.error}</p>}
          <div className="row">
            <button className="secondary" disabled={busy} onClick={() => void act(() => api.syncNow())}>Sync now</button>
            <span className="grow" />
            <button className="danger" disabled={busy} onClick={() => void act(() => api.unlink())}>Stop using this file</button>
          </div>
        </div>
      )}

      {!linked && (
        <div className="row wrap">
          <button className="secondary" disabled={busy} onClick={() => void act(() => api.link('create'), 'Now syncing with that file.')}>Create sync file…</button>
          <button className="secondary" disabled={busy} onClick={() => void act(() => api.link('existing'), 'Now syncing with that file.')}>Use existing file…</button>
        </div>
      )}
      <div className="row wrap">
        <button className="secondary" disabled={busy} onClick={() => void act(() => api.exportBackup(), 'Backup saved.')}>Save backup…</button>
        <button className="secondary" disabled={busy} onClick={() => void act(() => api.importBackup(), 'Backup merged into this vault.')}>Restore from backup…</button>
      </div>
      {message && <p className={message.error ? 'error' : 'hint'} role={message.error ? 'alert' : 'status'} data-testid="filesync-message">{message.text}</p>}
    </section>
  )
}
