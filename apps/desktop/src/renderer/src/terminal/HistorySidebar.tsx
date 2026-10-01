import { useCallback, useEffect, useMemo, useState } from 'react'
import type { HistoryEntry } from '../../../shared/ipc'

interface Props {
  /** Server the active tab is connected to; empty when there is no terminal tab to show. */
  title: string
  sessionId: string | null
  /** Commands typed in this tab since it opened, newest first. */
  typed: string[]
  /** Put the command on the prompt (`run` false) or run it right away. */
  onUse(command: string, run: boolean): void
}

const oneLine = (c: string): string => (c.includes('\n') ? c.split('\n')[0] + ' …' : c)

export function HistorySidebar({ title, sessionId, typed, onUse }: Props): React.JSX.Element {
  const [server, setServer] = useState<HistoryEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [filter, setFilter] = useState('')

  const load = useCallback(async (): Promise<void> => {
    if (!sessionId) { setServer([]); setError(''); return }
    setLoading(true)
    const r = await window.mymius.terminal.history(sessionId)
    setLoading(false)
    if (r.ok) { setServer(r.entries); setError('') } else { setServer([]); setError(r.error) }
  }, [sessionId])
  useEffect(() => { void load() }, [load])

  const items = useMemo(() => {
    const seen = new Set<string>()
    const all: { command: string; mine: boolean }[] = []
    for (const c of typed) if (!seen.has(c)) { seen.add(c); all.push({ command: c, mine: true }) }
    for (const e of server) if (!seen.has(e.command)) { seen.add(e.command); all.push({ command: e.command, mine: false }) }
    const needle = filter.trim().toLowerCase()
    return needle ? all.filter((i) => i.command.toLowerCase().includes(needle)) : all
  }, [typed, server, filter])

  return (
    <aside className="history" aria-label="Command history" data-testid="history">
      <div className="history-head">
        <strong>Lịch sử lệnh</strong>
        <button className="link" onClick={() => void load()} disabled={!sessionId || loading} aria-label="Refresh history">{loading ? 'Đang đọc…' : 'Refresh'}</button>
      </div>
      {title && <div className="history-host" title={title}>{title}</div>}
      <input
        type="search"
        className="history-filter"
        aria-label="Filter history"
        placeholder="Lọc lệnh…"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        disabled={!sessionId}
      />
      {!sessionId && <p className="hint">Chọn một tab terminal đã kết nối để xem lịch sử lệnh của server đó.</p>}
      {error && <p className="error" role="alert">{error}</p>}
      <ul className="history-list">
        {items.map((i) => (
          <li key={i.command} className="history-item">
            <button className="history-cmd" title={`${i.command}\n\nBấm để đưa lên dòng lệnh (chưa chạy)`} onClick={() => onUse(i.command, false)} data-testid="history-item">
              <span className="badge" title={i.mine ? 'Gõ trong tab này' : undefined}>{i.mine ? '●' : ''}</span>
              <code>{oneLine(i.command)}</code>
            </button>
            {!i.command.includes('\n') && (
              <button className="history-run" aria-label={`Run ${i.command}`} title="Chạy ngay" onClick={() => onUse(i.command, true)}>▶</button>
            )}
          </li>
        ))}
      </ul>
      {sessionId && !loading && !error && items.length === 0 && <p className="hint">{filter ? 'Không có lệnh nào khớp.' : 'Chưa có lệnh nào.'}</p>}
      {sessionId && (
        <p className="hint foot">
          Lấy từ file lịch sử của tài khoản đang đăng nhập (bash, zsh, fish) cùng các lệnh bạn gõ ở tab này. Bash chỉ ghi lịch sử khi một phiên kết thúc.
        </p>
      )}
    </aside>
  )
}
