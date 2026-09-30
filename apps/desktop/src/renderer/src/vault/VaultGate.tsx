import { useState } from 'react'
import { ClientForm } from '../drive/ClientForm'
import { Account } from '../drive/Account'
import { useDrive } from '../drive/useDrive'
import { useVault } from './useVault'

/** Shows the vault screens until it is set up and unlocked, then the app content. */
export function VaultGate({ children }: { children: React.ReactNode }): React.JSX.Element {
  const { status, refresh } = useVault()
  const [recoveryKey, setRecoveryKey] = useState<string | null>(null)

  if (!status) return <p className="empty">Loading…</p>
  if (recoveryKey) return <RecoveryKey value={recoveryKey} onDone={() => { setRecoveryKey(null); void refresh() }} />
  switch (status.state) {
    case 'damaged':
      return (
        <div className="form" role="alert">
          <h2>The vault file is damaged</h2>
          <p className="hint">{status.error}</p>
          <p className="hint">Nothing has been changed or deleted. Restore <code>vault.json</code> from a backup, or contact support before creating a new vault.</p>
        </div>
      )
    case 'uninitialized':
      return <Setup canRemember={status.canRemember} onCreated={(k) => setRecoveryKey(k)} onRestored={() => void refresh()} />
    case 'locked':
      return <Unlock canRemember={status.canRemember} onUnlocked={() => void refresh()} />
    case 'unlocked':
      return <>{children}</>
  }
}

function Setup({ canRemember, onCreated, onRestored }: { canRemember: boolean; onCreated(recoveryKey: string): void; onRestored(): void }): React.JSX.Element {
  const [pass, setPass] = useState('')
  const [again, setAgain] = useState('')
  const [remember, setRemember] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    if (pass !== again) return setError('The two passphrases do not match')
    setBusy(true)
    setError('')
    const r = await window.mymius.vault.create(pass, remember)
    setBusy(false)
    if (r.ok) onCreated(r.recoveryKey)
    else setError(r.error)
  }

  return (
    <div className="setup">
    <form className="form" onSubmit={(e) => void submit(e)}>
      <h2>Create your vault</h2>
      <p className="hint">Your hosts, passwords and keys are encrypted with a passphrase that only you know. It is never stored or sent anywhere, so it cannot be reset.</p>
      <label>Passphrase (at least 10 characters)<input name="passphrase" type="password" value={pass} onChange={(e) => setPass(e.target.value)} autoFocus autoComplete="new-password" /></label>
      <label>Repeat passphrase<input name="passphrase2" type="password" value={again} onChange={(e) => setAgain(e.target.value)} autoComplete="new-password" /></label>
      {canRemember && (
        <label className="radio"><input type="checkbox" name="remember" checked={remember} onChange={(e) => setRemember(e.target.checked)} />Remember on this device (protected by the system keychain)</label>
      )}
      {error && <p className="error" role="alert">{error}</p>}
      <button type="submit" className="primary" disabled={busy || pass.length === 0}>Create vault</button>
    </form>
    <SignInWithGoogle onRestored={onRestored} />
    <RestoreFromFile onRestored={onRestored} />
    </div>
  )
}

/** Sign in with Google before anything else: restores an existing vault from the account, or syncs the new one. */
function SignInWithGoogle({ onRestored }: { onRestored(): void }): React.JSX.Element {
  const { status, refresh } = useDrive()
  const [error, setError] = useState('')
  const [asking, setAsking] = useState(false)
  const connecting = status?.phase === 'connecting'
  const signedIn = status !== null && status !== undefined && status.phase !== 'not-connected' && status.phase !== 'connecting'

  const start = async (): Promise<void> => {
    setError('')
    const r = await window.mymius.drive.connect()
    if (r.ok) onRestored()
    else setError(r.error)
    await refresh()
  }

  return (
    <div className="form restore" data-testid="restore">
      <h3>Sign in with Google</h3>
      {signedIn ? (
        <>
          <Account name={status.name} email={status.email} />
          <p className="hint" data-testid="signed-in-hint">Create your vault below and it will be synced to this Google account automatically.</p>
          <div className="row"><span className="grow" /><button className="link" onClick={() => void window.mymius.drive.disconnect(false).then(refresh)}>Sign out</button></div>
        </>
      ) : (
        <>
          <p className="hint">Use your Google account to keep your hosts and keys in sync. If you already use Mymius on another device, they come back here and you unlock them with the passphrase you chose there.</p>
          {status && !status.configured && !asking && <button className="secondary" onClick={() => setAsking(true)}>Set up Google sign-in…</button>}
          {asking && !status?.configured && <ClientForm submitLabel="Continue" onSaved={() => { setAsking(false); void refresh() }} />}
          {status?.configured && !connecting && <button className="secondary google" onClick={() => void start()}>Sign in with Google</button>}
          {connecting && (
            <div className="row" role="status"><span>Waiting for you to finish signing in, in your browser…</span><span className="grow" /><button className="secondary" onClick={() => void window.mymius.drive.cancelConnect()}>Cancel</button></div>
          )}
        </>
      )}
      {error && <p className="error" role="alert">{error}</p>}
    </div>
  )
}

/** No account needed: bring a vault in from a .json backup or sync file. */
function RestoreFromFile({ onRestored }: { onRestored(): void }): React.JSX.Element {
  const [error, setError] = useState('')
  const pick = async (mode: 'import' | 'link'): Promise<void> => {
    setError('')
    const r = mode === 'import' ? await window.mymius.fileSync.importBackup() : await window.mymius.fileSync.link('existing')
    if (r.ok) onRestored()
    else if (r.error) setError(r.error)
  }
  return (
    <div className="form restore" data-testid="restore-file">
      <h3>Have a backup or sync file?</h3>
      <p className="hint">Restore from a <code>.json</code> file made by Mymius on another device. You unlock it with the passphrase you chose there.</p>
      <div className="row wrap">
        <button className="secondary" onClick={() => void pick('import')}>Restore from backup…</button>
        <button className="secondary" onClick={() => void pick('link')}>Restore and keep in sync with file…</button>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
    </div>
  )
}

function RecoveryKey({ value, onDone }: { value: string; onDone(): void }): React.JSX.Element {
  const [saved, setSaved] = useState(false)
  const [copied, setCopied] = useState(false)
  return (
    <div className="form">
      <h2>Save your recovery key</h2>
      <p className="hint">If you forget your passphrase, this key is the <strong>only</strong> way back into your vault. It is shown once. Store it somewhere safe, such as a password manager or a printout.</p>
      <code className="recovery" data-testid="recovery-key">{value}</code>
      <button type="button" className="secondary" onClick={() => void navigator.clipboard.writeText(value).then(() => setCopied(true))}>{copied ? 'Copied' : 'Copy'}</button>
      <label className="radio"><input type="checkbox" name="saved" checked={saved} onChange={(e) => setSaved(e.target.checked)} />I have saved my recovery key</label>
      <button type="button" className="primary" disabled={!saved} onClick={onDone}>Continue</button>
    </div>
  )
}

function Unlock({ canRemember, onUnlocked }: { canRemember: boolean; onUnlocked(): void }): React.JSX.Element {
  const { status: drive } = useDrive()
  const [useRecovery, setUseRecovery] = useState(false)
  const [secret, setSecret] = useState('')
  const [remember, setRemember] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    setBusy(true)
    setError('')
    const r = useRecovery
      ? await window.mymius.vault.unlockWithRecovery(secret, remember)
      : await window.mymius.vault.unlock(secret, remember)
    setBusy(false)
    if (r.ok) onUnlocked()
    else setError(r.error)
  }

  return (
    <form className="form" onSubmit={(e) => void submit(e)}>
      <h2>Unlock your vault</h2>
      {drive?.email && drive.phase === 'locked' && (
        <p className="hint" data-testid="restored-hint">Your vault was restored from Google Drive ({drive.email}). Enter the passphrase you chose on your other device.</p>
      )}
      <label>
        {useRecovery ? 'Recovery key' : 'Passphrase'}
        <input name={useRecovery ? 'recovery' : 'passphrase'} type={useRecovery ? 'text' : 'password'} value={secret} onChange={(e) => setSecret(e.target.value)} autoFocus spellCheck={false} autoComplete="off" />
      </label>
      {canRemember && (
        <label className="radio"><input type="checkbox" name="remember" checked={remember} onChange={(e) => setRemember(e.target.checked)} />Remember on this device</label>
      )}
      {error && <p className="error" role="alert">{error}</p>}
      <button type="submit" className="primary" disabled={busy || !secret}>Unlock</button>
      <button type="button" className="link" onClick={() => { setUseRecovery(!useRecovery); setSecret(''); setError('') }}>
        {useRecovery ? 'Use my passphrase instead' : 'I forgot my passphrase'}
      </button>
    </form>
  )
}
