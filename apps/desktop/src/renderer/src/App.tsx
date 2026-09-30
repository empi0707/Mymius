import { useEffect, useState } from 'react'
import type { AppInfo } from '../../shared/ipc'

type Section = 'hosts' | 'files' | 'sync'

const SECTIONS: { id: Section; label: string }[] = [
  { id: 'hosts', label: 'Hosts' },
  { id: 'files', label: 'Files' },
  { id: 'sync', label: 'Folder Sync' }
]

export function App(): React.JSX.Element {
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [section, setSection] = useState<Section>('files')

  useEffect(() => {
    void window.mymius.appInfo().then(setInfo)
  }, [])

  return (
    <div className={`shell os-${info?.os ?? 'unknown'}`}>
      <aside className="sidebar">
        <div className="titlebar-drag" />
        <nav>
          {SECTIONS.map((s) => (
            <button key={s.id} className={s.id === section ? 'active' : ''} onClick={() => setSection(s.id)}>
              {s.label}
            </button>
          ))}
        </nav>
        <footer>{info ? `${info.name} ${info.version} · ${info.os}/${info.arch}` : ''}</footer>
      </aside>
      <main>
        <div className="titlebar-drag" />
        {section === 'files' ? <DualPanePlaceholder /> : <p className="empty">{SECTIONS.find((s) => s.id === section)?.label} - coming soon</p>}
        {info && !info.secureStorage && (
          <p className="warn">OS keychain unavailable: secrets will need your sync passphrase on every launch.</p>
        )}
      </main>
    </div>
  )
}

function DualPanePlaceholder(): React.JSX.Element {
  return (
    <div className="panes">
      <section><h2>Left</h2><p className="empty">Local / SFTP / S3 ...</p></section>
      <section><h2>Right</h2><p className="empty">Local / SFTP / S3 ...</p></section>
    </div>
  )
}
