import { useState } from 'react'
import { getThemeChoice, setThemeChoice, type ThemeChoice } from '../theme'
import { AutoBackupCard } from '../drive/AutoBackupCard'
import { DriveCard } from '../drive/DriveCard'
import { FileSyncCard } from '../drive/FileSyncCard'
import { VaultGate } from '../vault/VaultGate'

export function SettingsPage(): React.JSX.Element {
  return (
    <div className="settings">
      <h2>Settings</h2>
      <AppearanceCard />
      <VaultGate>
        <DriveCard />
        <FileSyncCard />
        <AutoBackupCard />
        <PassphraseCard />
      </VaultGate>
    </div>
  )
}

function PassphraseCard(): React.JSX.Element {
  const [pass, setPass] = useState('')
  const [again, setAgain] = useState('')
  const [msg, setMsg] = useState<{ text: string; error: boolean } | null>(null)
  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    if (pass !== again) return setMsg({ text: 'Hai passphrase không khớp nhau', error: true })
    const r = await window.mymius.vault.changePassphrase(pass)
    if (r.ok) { setPass(''); setAgain(''); setMsg({ text: 'Đã đổi passphrase. Các thiết bị khác sẽ hỏi passphrase mới sau lần đồng bộ tới.', error: false }) }
    else setMsg({ text: r.error, error: true })
  }
  return (
    <section className="card">
      <h3>Vault passphrase</h3>
      <form className="inline-form" onSubmit={(e) => void submit(e)}>
        <label>New passphrase (at least 10 characters)<input name="newPassphrase" type="password" value={pass} onChange={(e) => setPass(e.target.value)} autoComplete="new-password" /></label>
        <label>Repeat it<input name="newPassphrase2" type="password" value={again} onChange={(e) => setAgain(e.target.value)} autoComplete="new-password" /></label>
        {msg && <p className={msg.error ? 'error' : 'hint'} role={msg.error ? 'alert' : 'status'}>{msg.text}</p>}
        <div className="row"><span className="grow" /><button type="submit" className="primary" disabled={!pass}>Change passphrase</button></div>
      </form>
    </section>
  )
}

function AppearanceCard(): React.JSX.Element {
  const [choice, setChoice] = useState<ThemeChoice>(getThemeChoice())
  const pick = (c: ThemeChoice): void => { setChoice(c); setThemeChoice(c) }
  return (
    <section className="card" data-testid="appearance-card">
      <h3>Appearance</h3>
      <div className="row" role="radiogroup" aria-label="Theme">
        {(['system', 'light', 'dark'] as const).map((c) => (
          <label key={c} className="radio"><input type="radio" name="theme" value={c} checked={choice === c} onChange={() => pick(c)} />{c === 'system' ? 'Match system' : c === 'light' ? 'Light' : 'Dark'}</label>
        ))}
      </div>
    </section>
  )
}
