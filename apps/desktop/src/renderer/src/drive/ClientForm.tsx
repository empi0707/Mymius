import { useState } from 'react'

/** Google OAuth client credentials. Each person (or organisation) makes their own in Google Cloud; see the setup guide. */
export function ClientForm({ onSaved, submitLabel = 'Save' }: { onSaved(): void; submitLabel?: string }): React.JSX.Element {
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const [error, setError] = useState('')
  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    const r = await window.mymius.drive.setClient({ clientId, ...(clientSecret ? { clientSecret } : {}) })
    if (r.ok) onSaved()
    else setError(r.error)
  }
  return (
    <form className="inline-form" onSubmit={(e) => void submit(e)}>
      <p className="hint">
        Đồng bộ dùng project Google Cloud của chính bạn nên dữ liệu không đi qua máy chủ của ai khác.
        Hãy tạo một OAuth client loại <strong>Desktop app</strong> có bật Google Drive API (hướng dẫn từng bước trong <code>docs/GOOGLE_DRIVE_SETUP.md</code>),
        rồi dán thông tin của nó vào đây.
      </p>
      <label>Client ID<input name="clientId" value={clientId} onChange={(e) => setClientId(e.target.value)} spellCheck={false} placeholder="123456-abc.apps.googleusercontent.com" /></label>
      <label>Client secret <span className="sub">(Google cấp cho ứng dụng desktop)</span><input name="clientSecret" type="password" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} autoComplete="off" /></label>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="row">
        <button type="button" className="link" onClick={() => window.open('https://console.cloud.google.com/apis/credentials')}>Open Google Cloud Console</button>
        <span className="grow" />
        <button type="submit" className="primary" disabled={!clientId.trim()}>{submitLabel}</button>
      </div>
    </form>
  )
}
