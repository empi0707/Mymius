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
        Syncing uses your own Google Cloud project, so your data never passes through anyone else&apos;s server.
        Create a <strong>Desktop app</strong> OAuth client with the Google Drive API enabled (step-by-step in <code>docs/GOOGLE_DRIVE_SETUP.md</code>),
        then paste its credentials here.
      </p>
      <label>Client ID<input name="clientId" value={clientId} onChange={(e) => setClientId(e.target.value)} spellCheck={false} placeholder="123456-abc.apps.googleusercontent.com" /></label>
      <label>Client secret <span className="sub">(Google issues one for desktop apps)</span><input name="clientSecret" type="password" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} autoComplete="off" /></label>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="row">
        <button type="button" className="link" onClick={() => window.open('https://console.cloud.google.com/apis/credentials')}>Open Google Cloud Console</button>
        <span className="grow" />
        <button type="submit" className="primary" disabled={!clientId.trim()}>{submitLabel}</button>
      </div>
    </form>
  )
}
