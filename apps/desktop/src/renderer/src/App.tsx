import { useEffect, useRef, useState } from 'react'
import type { AppInfo } from '../../shared/ipc'
import { HostsPage } from './hosts/HostsPage'
import { TerminalsPage, type OpenRequest } from './terminal/TerminalsPage'
import { VaultGate } from './vault/VaultGate'
import { useVault } from './vault/useVault'

type Section = 'hosts' | 'terminals' | 'files' | 'sync'

const SECTIONS: { id: Section; label: string }[] = [
  { id: 'hosts', label: 'Hosts' },
  { id: 'terminals', label: 'Terminals' },
  { id: 'files', label: 'Files' },
  { id: 'sync', label: 'Folder Sync' }
]

export function App(): React.JSX.Element {
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [section, setSection] = useState<Section>('hosts')
  const [openReq, setOpenReq] = useState<OpenRequest | undefined>()
  const counter = useRef(0)
  const { status } = useVault()

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
        <footer>
          {status?.state === 'unlocked' && (
            <button className="link" onClick={() => void window.mymius.vault.lock()}>Lock vault</button>
          )}
          <div>{info ? `${info.name} ${info.version} · ${info.os}/${info.arch}` : ''}</div>
        </footer>
      </aside>
      <main>
        <div className="titlebar-drag" />
        {/* Kept mounted (just hidden) so switching sections never kills a running terminal. */}
        {info && (
          <div className="section" hidden={section !== 'terminals'}>
            <TerminalsPage os={info.os} {...(openReq ? { open: openReq } : {})} />
          </div>
        )}
        {section === 'hosts' && (
          <div className="section scroll">
            <VaultGate>
              <HostsPage
                onConnect={(h) => {
                  setOpenReq({ token: ++counter.current, title: h.name, target: { hostId: h.id } })
                  setSection('terminals')
                }}
              />
            </VaultGate>
          </div>
        )}
        {section === 'files' && <DualPanePlaceholder />}
        {section === 'sync' && <p className="empty">Folder Sync - coming soon</p>}
        {info && !info.secureStorage && (
          <p className="warn">No system keychain available: the vault can't be remembered on this device and will ask for its passphrase each time.</p>
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
