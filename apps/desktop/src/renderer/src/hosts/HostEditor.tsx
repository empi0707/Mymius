import { useState } from 'react'
import type { HostInput, HostSummary, KeySummary } from '../../../shared/ipc'

type AuthType = HostInput['auth']['type']

interface Props {
  host?: HostSummary
  hosts: HostSummary[]
  keys: KeySummary[]
  onKeysChanged(): Promise<void>
  onCancel(): void
  /** Resolve to an error message, or null on success. */
  onSave(input: HostInput): Promise<string | null>
  onDelete(): Promise<string | null>
}

export function HostEditor({ host, hosts, keys, onCancel, onSave, onDelete }: Props): React.JSX.Element {
  const editing = host !== undefined
  const [name, setName] = useState(host?.name ?? '')
  const [hostname, setHostname] = useState(host?.host ?? '')
  const [port, setPort] = useState(String(host?.port ?? 22))
  const [username, setUsername] = useState(host?.username ?? '')
  const [group, setGroup] = useState(host?.group ?? '')
  const [jump, setJump] = useState(host?.jumpHostId ?? '')
  const [notes, setNotes] = useState(host?.notes ?? '')
  const [type, setType] = useState<AuthType>(host?.authType ?? 'password')
  const [password, setPassword] = useState('')
  const [keyId, setKeyId] = useState(keys[0]?.id ?? '')
  const [keyPath, setKeyPath] = useState('')
  const [passphrase, setPassphrase] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirmingDelete, setConfirmingDelete] = useState(false)

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    const auth: HostInput['auth'] =
      type === 'password' ? { type, ...(password ? { password } : {}) }
      : type === 'key' ? { type, keyId }
      : type === 'keyFile' ? { type, path: keyPath, ...(passphrase ? { passphrase } : {}) }
      : { type }
    setBusy(true)
    const err = await onSave({
      name: name.trim() || hostname.trim(),
      host: hostname,
      port: Number(port),
      username,
      auth,
      ...(group.trim() ? { group: group.trim() } : {}),
      ...(jump ? { jumpHostId: jump } : {}),
      ...(notes.trim() ? { notes } : {})
    })
    setBusy(false)
    if (err) setError(err)
  }

  const groups = [...new Set(hosts.map((h) => h.group).filter((g): g is string => Boolean(g)))]

  return (
    <form className="form wide" onSubmit={(e) => void submit(e)}>
      <h2>{editing ? `Edit ${host.name}` : 'New host'}</h2>
      <label>Name<input name="name" value={name} onChange={(e) => setName(e.target.value)} placeholder={hostname || 'My server'} autoFocus /></label>
      <div className="row">
        <label className="grow">Host<input name="host" value={hostname} onChange={(e) => setHostname(e.target.value)} spellCheck={false} placeholder="example.com" /></label>
        <label className="narrow">Port<input name="port" value={port} onChange={(e) => setPort(e.target.value)} inputMode="numeric" /></label>
      </div>
      <label>User<input name="username" value={username} onChange={(e) => setUsername(e.target.value)} spellCheck={false} autoCapitalize="off" /></label>

      <fieldset>
        <legend>Sign in with</legend>
        {([['password', 'Password'], ['key', 'Vault key'], ['keyFile', 'Key file'], ['agent', 'SSH agent']] as const).map(([v, label]) => (
          <label key={v} className="radio"><input type="radio" name="auth" value={v} checked={type === v} onChange={() => setType(v)} />{label}</label>
        ))}
      </fieldset>
      {type === 'password' && (
        <label>Password<input name="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="off" placeholder={editing && host.authType === 'password' ? 'Đã lưu - để trống nếu muốn giữ nguyên' : ''} /></label>
      )}
      {type === 'key' && (
        keys.length === 0
          ? <p className="hint">Vault chưa có khóa nào. Hãy nhập khóa ở trang Keys trước.</p>
          : <label>Key<select name="keyId" value={keyId} onChange={(e) => setKeyId(e.target.value)}>{keys.map((k) => <option key={k.id} value={k.id}>{k.name}</option>)}</select></label>
      )}
      {type === 'keyFile' && (
        <>
          <div className="row">
            <label className="grow">Key file (this device only)<input name="keyPath" value={keyPath} onChange={(e) => setKeyPath(e.target.value)} placeholder="~/.ssh/id_ed25519" spellCheck={false} /></label>
            <button type="button" className="secondary" onClick={() => void window.mymius.pickPrivateKey().then((p) => p && setKeyPath(p))}>Browse…</button>
          </div>
          <label>Passphrase (if any)<input name="passphrase" type="password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} autoComplete="off" placeholder={editing && host.authType === 'keyFile' ? 'Đã lưu - để trống nếu muốn giữ nguyên' : ''} /></label>
        </>
      )}

      <div className="row">
        <label className="grow">Group<input name="group" list="groups" value={group} onChange={(e) => setGroup(e.target.value)} placeholder="e.g. Production" /><datalist id="groups">{groups.map((g) => <option key={g} value={g} />)}</datalist></label>
        <label className="grow">Jump through
          <select name="jump" value={jump} onChange={(e) => setJump(e.target.value)}>
            <option value="">(direct)</option>
            {hosts.filter((h) => h.id !== host?.id).map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}
          </select>
        </label>
      </div>
      <label>Notes<textarea name="notes" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} /></label>

      {error && <p className="error" role="alert">{error}</p>}
      <div className="row actions">
        {editing && !confirmingDelete && <button type="button" className="danger" onClick={() => setConfirmingDelete(true)}>Delete</button>}
        {editing && confirmingDelete && (
          <>
            <span>Delete {host.name}?</span>
            <button type="button" className="danger" onClick={() => void onDelete().then((e) => { setConfirmingDelete(false); if (e) setError(e) })}>Yes, delete</button>
            <button type="button" className="secondary" onClick={() => setConfirmingDelete(false)}>Keep</button>
          </>
        )}
        <span className="grow" />
        <button type="button" className="secondary" onClick={onCancel}>Cancel</button>
        <button type="submit" className="primary" disabled={busy || !hostname || !username}>Save</button>
      </div>
    </form>
  )
}
