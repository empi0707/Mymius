import { useState } from 'react'

/** The Dropbox app key: an identifier for the app, not a secret (Dropbox sign-in uses PKCE and needs no secret). */
export function DropboxKeyForm({ onSaved }: { onSaved(): void }): React.JSX.Element {
  const [key, setKey] = useState('')
  const [error, setError] = useState('')
  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    const r = await window.mymius.drive.setDropboxKey(key)
    if (r.ok) onSaved()
    else setError(r.error)
  }
  return (
    <form className="inline-form" onSubmit={(e) => void submit(e)}>
      <p className="hint">
        Để đồng bộ qua Dropbox, hãy tạo một app trên Dropbox App Console với quyền truy cập <strong>App folder</strong> (bật <code>account_info.read</code>, <code>files.metadata.read</code>, <code>files.content.read</code> và <code>files.content.write</code>, rồi bấm Submit), rồi dán <strong>App key</strong> vào đây.
        Hướng dẫn từng bước trong <code>docs/DROPBOX_SETUP.md</code>.
      </p>
      <label>Dropbox app key<input name="dropboxKey" value={key} onChange={(e) => setKey(e.target.value)} spellCheck={false} placeholder="vd. a1b2c3d4e5f6g7h" /></label>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="row">
        <button type="button" className="link" onClick={() => window.open('https://www.dropbox.com/developers/apps')}>Open Dropbox App Console</button>
        <span className="grow" />
        <button type="submit" className="primary" disabled={!key.trim()}>Save key</button>
      </div>
    </form>
  )
}

/** Dropbox shows a short code after the person approves in the browser; it is pasted here. */
export function DropboxCodeForm({ onDone }: { onDone(message?: string): void }): React.JSX.Element {
  const [code, setCode] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    setBusy(true); setError('')
    const r = await window.mymius.drive.submitDropboxCode(code)
    setBusy(false)
    if (r.ok) onDone()
    else setError(r.error)
  }
  return (
    <form className="inline-form" onSubmit={(e) => void submit(e)} data-testid="dropbox-code-form">
      <p className="hint">Trình duyệt đã mở trang Dropbox. Bấm <strong>Allow</strong>, rồi sao chép mã Dropbox hiển thị và dán vào ô bên dưới.</p>
      <label>Mã từ Dropbox<input name="dropboxCode" value={code} onChange={(e) => setCode(e.target.value)} spellCheck={false} autoComplete="off" autoFocus /></label>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="row">
        <span className="grow" />
        <button type="button" className="secondary" onClick={() => void window.mymius.drive.cancelConnect()}>Cancel</button>
        <button type="submit" className="primary" disabled={busy || !code.trim()}>Finish sign-in</button>
      </div>
    </form>
  )
}
