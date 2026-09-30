import { useState } from 'react'
import { Account } from './Account'
import { ClientForm } from './ClientForm'
import { DropboxCodeForm, DropboxKeyForm } from './DropboxForms'
import { timeAgo, useDrive } from './useDrive'

export function DriveCard(): React.JSX.Element {
  const { status, refresh } = useDrive()
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [deleteRemote, setDeleteRemote] = useState(false)
  const [editingClient, setEditingClient] = useState(false)

  if (!status) return <section className="card"><h3>Google Drive</h3><p className="hint">Đang tải…</p></section>

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
      <h3>Cloud account</h3>
      <p className="hint">Đăng nhập Dropbox hoặc Google để host và khóa của bạn giống nhau trên mọi thiết bị. Mọi thứ được mã hóa bằng vault trước khi rời khỏi máy này; dịch vụ chỉ lưu các file không đọc được trong một thư mục riêng của ứng dụng.</p>

      {status.phase === 'not-connected' && !status.awaitingCode && (
        status.dropboxConfigured
          ? <div className="row"><button className="primary" disabled={busy} onClick={() => void act(() => window.mymius.drive.connect('dropbox'))}>Sign in with Dropbox</button></div>
          : <DropboxKeyForm onSaved={() => void refresh()} />
      )}

      {!status.configured && status.phase === 'not-connected' && !status.awaitingCode && (
        <details className="issues"><summary>Dùng Google Drive thay thế</summary>
          <ClientForm submitLabel="Continue" onSaved={() => void refresh()} />
        </details>
      )}
      {status.configured && editingClient && !connected && !status.awaitingCode && (
        <ClientForm submitLabel="Save" onSaved={() => { setEditingClient(false); void refresh() }} />
      )}

      {status.configured && !editingClient && status.phase === 'not-connected' && (
        <div className="row">
          <button className="primary" disabled={busy} onClick={() => void act(() => window.mymius.drive.connect())}>Sign in with Google</button>
          {!status.builtInClient && <button className="link" onClick={() => setEditingClient(true)}>Change client ID</button>}
        </div>
      )}

      {status.awaitingCode && <DropboxCodeForm onDone={() => void refresh()} />}

      {status.phase === 'connecting' && !status.awaitingCode && (
        <div className="row" role="status">
          <span>Đang chờ bạn đăng nhập xong trong trình duyệt…</span>
          <span className="grow" />
          <button className="secondary" onClick={() => void window.mymius.drive.cancelConnect()}>Cancel</button>
        </div>
      )}

      {connected && (
        <div data-testid="drive-connected">
          <div className="row"><Account name={status.name} email={status.email} /><span className="grow" /><span className="badge" data-testid="drive-provider">{status.provider === 'dropbox' ? 'Dropbox' : 'Google Drive'}</span><span className={`badge ${status.phase}`} data-testid="drive-phase">{PHASE[status.phase]}</span></div>
          <p className="sub" data-testid="drive-line">
            {status.phase === 'syncing' ? 'Đang đồng bộ…'
              : status.lastSyncAt ? `Đồng bộ lần cuối ${timeAgo(status.lastSyncAt)}` : 'Chưa đồng bộ'}
            {' · '}{status.devices === 0 ? 'chưa có thiết bị khác' : `${status.devices} thiết bị khác`}
          </p>
          {status.phase === 'locked' && <p className="hint">Hãy mở khóa vault để tiếp tục đồng bộ.</p>}
          {status.error && <p className="error" role="alert">{status.error}{status.retryAt ? ` Sẽ thử lại lúc ${new Date(status.retryAt).toLocaleTimeString()}.` : ''}</p>}
          {status.ignored.length > 0 && (
            <details className="issues"><summary>{status.ignored.length} file bị bỏ qua vì không qua được bước kiểm tra an toàn</summary>
              <ul>{status.ignored.map((x) => <li key={x}><code>{x}</code></li>)}</ul></details>
          )}
          {message && <p className="error" role="alert">{message}</p>}
          <div className="row">
            {status.phase === 'needs-auth'
              ? <button className="primary" disabled={busy} onClick={() => void act(() => window.mymius.drive.connect(status.provider))}>Sign in again</button>
              : <button className="secondary" disabled={busy || status.phase === 'syncing'} onClick={() => void act(() => window.mymius.drive.syncNow())}>Sync now</button>}
            <span className="grow" />
            {!confirming && <button className="danger" onClick={() => setConfirming(true)}>Sign out…</button>}
          </div>
          {confirming && (
            <div className="confirm">
              <p>Đăng xuất sẽ dừng đồng bộ trên máy này. Host và khóa của bạn vẫn được giữ lại ở đây.</p>
              <label className="radio"><input type="checkbox" name="deleteRemote" checked={deleteRemote} onChange={(e) => setDeleteRemote(e.target.checked)} />Xóa luôn dữ liệu đã đồng bộ khỏi Google Drive <span className="sub">(các thiết bị khác sẽ không đồng bộ được nữa)</span></label>
              <div className="row">
                <span className="grow" />
                <button className="secondary" onClick={() => { setConfirming(false); setDeleteRemote(false) }}>Stay signed in</button>
                <button className="danger" disabled={busy} onClick={() => void act(async () => { const r = await window.mymius.drive.disconnect(deleteRemote); setConfirming(false); setDeleteRemote(false); return r })}>Sign out</button>
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

const PHASE: Record<string, string> = { idle: 'đã cập nhật', syncing: 'đang đồng bộ', locked: 'vault đang khóa', error: 'có sự cố', 'needs-auth': 'cần đăng nhập lại', 'not-connected': 'tắt', connecting: 'đang kết nối' }
