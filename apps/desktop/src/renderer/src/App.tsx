import { useEffect, useRef, useState } from 'react'
import type { AppInfo } from '../../shared/ipc'
import { FilesPage } from './files/FilesPage'
import { useDrive, timeAgo } from './drive/useDrive'
import { SettingsPage } from './settings/SettingsPage'
import { HostsPage } from './hosts/HostsPage'
import { TerminalsPage, type OpenRequest } from './terminal/TerminalsPage'
import { VaultGate } from './vault/VaultGate'
import { useVault } from './vault/useVault'

type Section = 'hosts' | 'terminals' | 'files' | 'settings'

const SECTIONS: { id: Section; label: string }[] = [
  { id: 'hosts', label: 'Hosts' },
  { id: 'terminals', label: 'Terminals' },
  { id: 'files', label: 'Files' },
  { id: 'settings', label: 'Settings' }
]

export function App(): React.JSX.Element {
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [section, setSection] = useState<Section>('hosts')
  const [openReq, setOpenReq] = useState<OpenRequest | undefined>()
  const counter = useRef(0)
  const { status } = useVault()
  const { status: drive } = useDrive()

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
          {drive && drive.phase !== 'not-connected' && (
            <button className="link sync-line" data-testid="sync-line" onClick={() => setSection('settings')} title={drive.error ?? ''}>
              {drive.phase === 'error' || drive.phase === 'needs-auth' ? '⚠ Drive sync problem'
                : drive.phase === 'syncing' || drive.phase === 'connecting' ? '⟳ Syncing…'
                : drive.phase === 'locked' ? 'Drive sync paused'
                : drive.lastSyncAt ? `✓ Synced ${timeAgo(drive.lastSyncAt)}` : 'Drive sync on'}
            </button>
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
        {/* Kept mounted too: the panes' folders, selections and running jobs survive a change of section. */}
        <div className="section" hidden={section !== 'files'}><FilesPage visible={section === 'files'} /></div>
        {section === 'settings' && <div className="section scroll"><SettingsPage /></div>}
        {info && !info.secureStorage && (
          <p className="warn">No system keychain available: the vault can't be remembered on this device and will ask for its passphrase each time.</p>
        )}
      </main>
    </div>
  )
}
