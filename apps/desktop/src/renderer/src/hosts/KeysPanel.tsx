import { useState } from 'react'
import type { KeySummary } from '../../../shared/ipc'

export function KeysPanel({ keys, onChanged, onBack }: { keys: KeySummary[]; onChanged(): Promise<void>; onBack(): void }): React.JSX.Element {
  const [path, setPath] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [passphrase, setPassphrase] = useState('')
  const [error, setError] = useState('')

  const pick = async (): Promise<void> => {
    const p = await window.mymius.pickPrivateKey()
    if (!p) return
    setPath(p)
    setName(p.split(/[\\/]/).pop() ?? '')
    setPassphrase('')
    setError('')
    await tryImport(p, p.split(/[\\/]/).pop() ?? '', '')
  }

  const tryImport = async (p: string, n: string, pass: string): Promise<void> => {
    const r = await window.mymius.keys.import(p, n, pass)
    if (r.ok) {
      setPath(null)
      setError('')
      await onChanged()
    } else {
      setError(r.error) // an encrypted key asks for its passphrase and is retried below
    }
  }

  const needsPassphrase = path !== null && /passphrase/i.test(error)

  return (
    <div className="form wide">
      <div className="row"><h2 className="grow">Keys in the vault</h2><button className="secondary" onClick={onBack}>Back</button></div>
      <p className="hint">Các khóa lưu ở đây được mã hóa và đi theo vault sang mọi thiết bị. Khóa riêng tư sẽ không bao giờ được hiển thị lại.</p>
      {keys.length === 0 && <p className="empty">Chưa có khóa nào.</p>}
      {keys.map((k) => (
        <div key={k.id} className="hostrow">
          <div className="info"><strong>{k.name}</strong><span className="sub">{k.fingerprint ?? ''}</span></div>
          {k.hasPassphrase && <span className="badge">passphrase</span>}
          <button className="danger" aria-label={`Delete ${k.name}`} onClick={() => void window.mymius.keys.delete(k.id).then(async (r) => { setError(r.ok ? '' : r.error); await onChanged() })}>Delete</button>
        </div>
      ))}
      {path === null && <button className="primary" onClick={() => void pick()}>Import key file…</button>}
      {path !== null && (
        <div className="form">
          <label>Name<input name="keyName" value={name} onChange={(e) => setName(e.target.value)} /></label>
          {needsPassphrase && <label>Key passphrase<input name="keyPassphrase" type="password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} autoFocus autoComplete="off" /></label>}
          <div className="row">
            <button className="secondary" onClick={() => { setPath(null); setError('') }}>Cancel</button>
            <button className="primary" onClick={() => void tryImport(path, name, passphrase)}>Import</button>
          </div>
        </div>
      )}
      {error && <p className="error" role="alert">{error}</p>}
    </div>
  )
}
