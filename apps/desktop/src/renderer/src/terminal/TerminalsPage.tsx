import { useEffect, useRef, useState } from 'react'
import type { OpenTerminalRequest, OS } from '../../../shared/ipc'
import { ConnectForm } from './ConnectForm'
import { TerminalView, type TabStatus } from './TerminalView'

type Target = Omit<OpenTerminalRequest, 'cols' | 'rows'>

interface Tab {
  key: string
  title: string
  target: Target
  attempt: number
  status: TabStatus
  message?: string
}

export function TerminalsPage({ os }: { os: OS }): React.JSX.Element {
  const [tabs, setTabs] = useState<Tab[]>([])
  const [active, setActive] = useState<string | 'new'>('new')
  const counter = useRef(0)

  const add = (target: Target): void => {
    const key = `t${++counter.current}`
    setTabs((t) => [...t, { key, title: `${target.username}@${target.host}`, target, attempt: 0, status: 'connecting' }])
    setActive(key)
  }
  const patch = (key: string, p: Partial<Tab>): void => setTabs((t) => t.map((x) => (x.key === key ? { ...x, ...p } : x)))
  const close = (key: string): void => {
    setTabs((t) => t.filter((x) => x.key !== key))
    setActive((a) => (a === key ? 'new' : a))
  }

  // Cmd/Ctrl+T opens a new connection tab, like a browser.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((os === 'darwin' ? e.metaKey : e.ctrlKey && e.shiftKey) && e.key.toLowerCase() === 't') {
        e.preventDefault()
        setActive('new')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [os])

  return (
    <div className="terminals">
      <div className="tabbar" role="tablist">
        {tabs.map((t) => (
          <div key={t.key} role="tab" aria-selected={active === t.key} className={`tab ${active === t.key ? 'active' : ''}`} onClick={() => setActive(t.key)}>
            <span className={`dot ${t.status}`} title={t.message ?? t.status} />
            <span className="title">{t.title}</span>
            <button className="x" aria-label={`Close ${t.title}`} onClick={(e) => { e.stopPropagation(); close(t.key) }}>×</button>
          </div>
        ))}
        <button className="tab plus" aria-label="New connection" onClick={() => setActive('new')}>+</button>
      </div>
      <div className="stage">
        {tabs.map((t) => (
          <div key={t.key} className="pane" hidden={active !== t.key}>
            <TerminalView
              request={t.target}
              os={os}
              attempt={t.attempt}
              active={active === t.key}
              testId={t.key}
              onStatus={(status, message) => patch(t.key, { status, ...(message ? { message } : {}) })}
            />
            {(t.status === 'closed' || t.status === 'error') && (
              <div className="overlay" role="status">
                <p>{t.message}</p>
                <button className="primary" onClick={() => patch(t.key, { attempt: t.attempt + 1, status: 'connecting' })}>Reconnect</button>
                <button className="secondary" onClick={() => close(t.key)}>Close tab</button>
              </div>
            )}
          </div>
        ))}
        {(active === 'new' || tabs.length === 0) && <ConnectForm onConnect={add} />}
      </div>
    </div>
  )
}
