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
        Vault của bạn được lưu thành một file <code>.json</code> duy nhất, đã mã hóa bằng passphrase nên có thể cất ở bất cứ đâu. Bạn có thể lưu một bản backup, hoặc chỉ cho Mymius một file nằm trong thư mục
        mà iCloud Drive, Dropbox, OneDrive, Syncthing hay NAS đã đồng bộ sẵn, các thiết bị sẽ tự khớp nhau mà không cần tài khoản nào.
      </p>

      {linked && status && (
        <div data-testid="filesync-linked">
          <div className="row"><code className="path" data-testid="filesync-path">{status.path}</code><span className="grow" /><span className={`badge ${status.phase}`} data-testid="filesync-phase">{status.phase === 'idle' ? 'đã cập nhật' : status.phase === 'locked' ? 'vault đang khóa' : status.phase === 'error' ? 'có sự cố' : 'đang đồng bộ'}</span></div>
          <p className="sub" data-testid="filesync-line">
            {status.lastSyncAt ? `Đồng bộ lần cuối ${timeAgo(status.lastSyncAt)}` : 'Chưa đồng bộ'}{' · '}{status.devices === 0 ? 'chưa có thiết bị khác' : `${status.devices} thiết bị khác`}
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
          <button className="secondary" disabled={busy} onClick={() => void act(() => api.link('create'), 'Đã bắt đầu đồng bộ với file đó.')}>Create sync file…</button>
          <button className="secondary" disabled={busy} onClick={() => void act(() => api.link('existing'), 'Đã bắt đầu đồng bộ với file đó.')}>Use existing file…</button>
        </div>
      )}
      <div className="row wrap">
        <button className="secondary" disabled={busy} onClick={() => void act(() => api.exportBackup(), 'Đã lưu backup.')}>Save backup…</button>
        <button className="secondary" disabled={busy} onClick={() => void act(() => api.importBackup(), 'Đã gộp backup vào vault này.')}>Restore from backup…</button>
      </div>
      {message && <p className={message.error ? 'error' : 'hint'} role={message.error ? 'alert' : 'status'} data-testid="filesync-message">{message.text}</p>}
    </section>
  )
}
