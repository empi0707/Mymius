import { useCallback, useEffect, useMemo, useState } from 'react'
import type { HostInput, HostSummary, KeySummary } from '../../../shared/ipc'
import { HostEditor } from './HostEditor'
import { KeysPanel } from './KeysPanel'

type View = { kind: 'list' } | { kind: 'edit'; host?: HostSummary } | { kind: 'keys' }

export function HostsPage({ onConnect }: { onConnect(host: HostSummary): void }): React.JSX.Element {
  const [hosts, setHosts] = useState<HostSummary[]>([])
  const [keys, setKeys] = useState<KeySummary[]>([])
  const [view, setView] = useState<View>({ kind: 'list' })
  const [query, setQuery] = useState('')
  const [error, setError] = useState('')

  const reload = useCallback(async () => {
    const [h, k] = await Promise.all([window.mymius.hosts.list(), window.mymius.keys.list()])
    if (h.ok) setHosts(h.hosts)
    else setError(h.error)
    if (k.ok) setKeys(k.keys)
  }, [])
  useEffect(() => { void reload() }, [reload])

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase()
    const shown = hosts.filter((h) => !q || `${h.name} ${h.host} ${h.username} ${h.group ?? ''}`.toLowerCase().includes(q))
    const by = new Map<string, HostSummary[]>()
    for (const h of shown) by.set(h.group ?? '', [...(by.get(h.group ?? '') ?? []), h])
    return [...by.entries()].sort(([a], [b]) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b)))
  }, [hosts, query])

  if (view.kind === 'keys') {
    return <KeysPanel keys={keys} onChanged={reload} onBack={() => setView({ kind: 'list' })} />
  }
  if (view.kind === 'edit') {
    return (
      <HostEditor
        host={view.host}
        hosts={hosts}
        keys={keys}
        onKeysChanged={reload}
        onCancel={() => setView({ kind: 'list' })}
        onSave={async (input: HostInput) => {
          const r = await window.mymius.hosts.save(view.host?.id, input)
          if (r.ok) { await reload(); setView({ kind: 'list' }) }
          return r.ok ? null : r.error
        }}
        onDelete={async () => {
          if (!view.host) return null
          const r = await window.mymius.hosts.delete(view.host.id)
          if (r.ok) { await reload(); setView({ kind: 'list' }) }
          return r.ok ? null : r.error
        }}
      />
    )
  }

  return (
    <div className="hosts">
      <div className="toolbar">
        <input type="search" aria-label="Search hosts" placeholder="Search hosts" value={query} onChange={(e) => setQuery(e.target.value)} />
        <button className="secondary" onClick={() => setView({ kind: 'keys' })}>Keys ({keys.length})</button>
        <button className="primary" onClick={() => setView({ kind: 'edit' })}>New host</button>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      {hosts.length === 0 && !error && <p className="empty">No saved hosts yet. Add one to connect with a click.</p>}
      <div className="hostlist">
        {groups.map(([group, list]) => (
          <section key={group}>
            {group && <h3>{group}</h3>}
            {list.map((h) => (
              <div key={h.id} className="hostrow" data-testid={`host-${h.name}`}>
                <div className="info">
                  <strong>{h.name}</strong>
                  <span className="sub">{h.username}@{h.host}{h.port !== 22 ? `:${h.port}` : ''}</span>
                </div>
                <span className="badge">{authLabel(h)}</span>
                {h.jumpHostId && <span className="badge">via {hosts.find((x) => x.id === h.jumpHostId)?.name ?? '?'}</span>}
                <button className="secondary" aria-label={`Edit ${h.name}`} onClick={() => setView({ kind: 'edit', host: h })}>Edit</button>
                <button className="primary" aria-label={`Connect to ${h.name}`} onClick={() => onConnect(h)}>Connect</button>
              </div>
            ))}
          </section>
        ))}
      </div>
    </div>
  )
}

function authLabel(h: HostSummary): string {
  switch (h.authType) {
    case 'password': return 'password'
    case 'key': return `key: ${h.keyName ?? ''}`
    case 'keyFile': return 'key file'
    case 'agent': return 'agent'
  }
}
