import { useState } from 'react'
import type { OpenAuth, TerminalTarget } from '../../../shared/ipc'

type Target = Extract<TerminalTarget, { host: string }>

export function ConnectForm({ onConnect, onLocal }: { onConnect(t: Target): void; onLocal(): void }): React.JSX.Element {
  const [host, setHost] = useState('')
  const [port, setPort] = useState('22')
  const [username, setUsername] = useState('')
  const [method, setMethod] = useState<OpenAuth['type']>('password')
  const [password, setPassword] = useState('')
  const [keyPath, setKeyPath] = useState('')
  const [passphrase, setPassphrase] = useState('')

  const submit = (e: React.FormEvent): void => {
    e.preventDefault()
    const auth: OpenAuth =
      method === 'password' ? { type: 'password', password }
      : method === 'key' ? { type: 'key', keyPath, ...(passphrase ? { passphrase } : {}) }
      : { type: 'agent' }
    onConnect({ host, port: Number(port), username, auth })
  }

  return (
    <form className="form" onSubmit={submit}>
      <h2>New connection</h2>
      <div className="row">
        <button type="button" className="secondary" onClick={onLocal}>Open local terminal</button>
        <span className="hint grow">Một shell trên máy này, không cần SSH.</span>
      </div>
      <div className="row">
        <label className="grow">Host<input name="host" value={host} onChange={(e) => setHost(e.target.value)} autoFocus spellCheck={false} placeholder="example.com" /></label>
        <label className="narrow">Port<input name="port" value={port} onChange={(e) => setPort(e.target.value)} inputMode="numeric" /></label>
      </div>
      <label>User<input name="username" value={username} onChange={(e) => setUsername(e.target.value)} spellCheck={false} autoCapitalize="off" /></label>
      <fieldset>
        <legend>Sign in with</legend>
        {(['password', 'key', 'agent'] as const).map((m) => (
          <label key={m} className="radio">
            <input type="radio" name="method" value={m} checked={method === m} onChange={() => setMethod(m)} />
            {m === 'password' ? 'Password' : m === 'key' ? 'Private key' : 'SSH agent'}
          </label>
        ))}
      </fieldset>
      {method === 'password' && (
        <label>Password<input name="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="off" /></label>
      )}
      {method === 'key' && (
        <>
          <div className="row">
            <label className="grow">Key file<input name="keyPath" value={keyPath} onChange={(e) => setKeyPath(e.target.value)} placeholder="~/.ssh/id_ed25519" spellCheck={false} /></label>
            <button type="button" className="secondary" onClick={() => void window.mymius.pickPrivateKey().then((p) => p && setKeyPath(p))}>Browse…</button>
          </div>
          <label>Passphrase (if any)<input name="passphrase" type="password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} autoComplete="off" /></label>
        </>
      )}
      <button type="submit" className="primary" disabled={!host || !username}>Connect</button>
    </form>
  )
}
