import { useState } from 'react'
import { ClientForm } from './ClientForm'
import { timeAgo, useDrive } from './useDrive'

export function DriveCard(): React.JSX.Element {
  const { status, refresh } = useDrive()
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [deleteRemote, setDeleteRemote] = useState(false)
  const [editingClient, setEditingClient] = useState(false)

  if (!status) return <section className="card"><h3>Google Drive</h3><p className="hint">Loading…</p></section>

  const connected = !['not-connected', 'connecting'].includes(status.phase)
  const act = async (fn: () => Promise<{ ok: boolean; error?: string }>): Promise<void> => {
    setBusy(true); setMessage('')
    const r = await fn()
    setBusy(false)
    if (!r.ok && r.error) setMessage(r.error)
    await refresh()
  }

  return (
    <section className="card" data-testid="drive-card">
      <h3>Sync with Google Drive</h3>
      <p className="hint">Keeps your hosts and keys the same on all your devices. Everything is encrypted with your vault before it leaves this computer; Google only ever stores unreadable files in a hidden folder that only this app can open.</p>

      {(!status.configured || editingClient) && !connected && (
        <ClientForm submitLabel={status.configured ? 'Save' : 'Continue'} onSaved={() => { setEditingClient(false); void refresh() }} />
      )}

      {status.configured && !editingClient && status.phase === 'not-connected' && (
        <div className="row">
          <button className="primary" disabled={busy} onClick={() => void act(() => window.mymius.drive.connect())}>Connect Google Drive</button>
          <button className="link" onClick={() => setEditingClient(true)}>Change client ID</button>
        </div>
      )}

      {status.phase === 'connecting' && (
        <div className="row" role="status">
          <span>Waiting for you to finish signing in, in your browser…</span>
          <span className="grow" />
          <button className="secondary" onClick={() => void window.mymius.drive.cancelConnect()}>Cancel</button>
        </div>
      )}

      {connected && (
        <div data-testid="drive-connected">
          <div className="row"><strong>{status.email ?? 'Connected'}</strong><span className={`badge ${status.phase}`} data-testid="drive-phase">{PHASE[status.phase]}</span></div>
          <p className="sub" data-testid="drive-line">
            {status.phase === 'syncing' ? 'Syncing…'
              : status.lastSyncAt ? `Last synced ${timeAgo(status.lastSyncAt)}` : 'Not synced yet'}
            {' · '}{status.devices === 0 ? 'no other devices yet' : `${status.devices} other device${status.devices === 1 ? '' : 's'}`}
          </p>
          {status.phase === 'locked' && <p className="hint">Unlock the vault to continue syncing.</p>}
          {status.error && <p className="error" role="alert">{status.error}{status.retryAt ? ` Trying again ${new Date(status.retryAt).toLocaleTimeString()}.` : ''}</p>}
          {status.ignored.length > 0 && (
            <details className="issues"><summary>{status.ignored.length} file{status.ignored.length === 1 ? ' was' : 's were'} ignored because {status.ignored.length === 1 ? 'it' : 'they'} did not pass the security check</summary>
              <ul>{status.ignored.map((x) => <li key={x}><code>{x}</code></li>)}</ul></details>
          )}
          {message && <p className="error" role="alert">{message}</p>}
          <div className="row">
            {status.phase === 'needs-auth'
              ? <button className="primary" disabled={busy} onClick={() => void act(() => window.mymius.drive.connect())}>Sign in again</button>
              : <button className="secondary" disabled={busy || status.phase === 'syncing'} onClick={() => void act(() => window.mymius.drive.syncNow())}>Sync now</button>}
            <span className="grow" />
            {!confirming && <button className="danger" onClick={() => setConfirming(true)}>Disconnect…</button>}
          </div>
          {confirming && (
            <div className="confirm">
              <p>This stops syncing on this computer. Your hosts and keys stay here.</p>
              <label className="radio"><input type="checkbox" name="deleteRemote" checked={deleteRemote} onChange={(e) => setDeleteRemote(e.target.checked)} />Also delete the synced data from Google Drive <span className="sub">(your other devices will stop being able to sync)</span></label>
              <div className="row">
                <span className="grow" />
                <button className="secondary" onClick={() => { setConfirming(false); setDeleteRemote(false) }}>Keep syncing</button>
                <button className="danger" disabled={busy} onClick={() => void act(async () => { const r = await window.mymius.drive.disconnect(deleteRemote); setConfirming(false); setDeleteRemote(false); return r })}>Disconnect</button>
              </div>
            </div>
          )}
        </div>
      )}
      {!connected && message && <p className="error" role="alert">{message}</p>}
      {!connected && status.error && status.phase === 'not-connected' && !message && <p className="error" role="alert">{status.error}</p>}
    </section>
  )
}

const PHASE: Record<string, string> = { idle: 'up to date', syncing: 'syncing', locked: 'vault locked', error: 'problem', 'needs-auth': 'sign in needed', 'not-connected': 'off', connecting: 'connecting' }
