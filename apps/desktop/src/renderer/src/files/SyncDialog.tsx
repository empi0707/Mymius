import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { JobState, SyncCompareResult, SyncDirection, SyncEndpoint, SyncItem, SyncMode, SyncStatus, SyncSummary } from '../../../shared/ipc'
import { formatDate, formatSize } from './format'
import { Modal } from './Modal'
import { useVirtualList } from './useVirtualList'

const MODES: { id: SyncMode; label: string; hint: string }[] = [
  { id: 'mirror-ltr', label: 'Make right match left  →', hint: 'Thư mục bên phải trở thành bản sao của thư mục bên trái.' },
  { id: 'mirror-rtl', label: '←  Make left match right', hint: 'Thư mục bên trái trở thành bản sao của thư mục bên phải.' },
  { id: 'two-way', label: 'Two-way  ↔', hint: 'File mới được chép qua cả hai chiều và bản mới hơn thắng. Việc xóa không bao giờ được chép sang bên kia.' }
]

const STATUS_LABEL: Record<SyncStatus, string> = {
  same: 'giống nhau', 'left-only': 'chỉ có ở trái', 'right-only': 'chỉ có ở phải', 'left-newer': 'bên trái mới hơn',
  'right-newer': 'bên phải mới hơn', different: 'khác nhau', 'type-mismatch': 'file và thư mục'
}

/** The next arrow when the user clicks one: their own choice cycles through all three. */
const CYCLE: SyncDirection[] = ['ltr', 'rtl', 'skip']
const ROW = 28

export function SyncDialog({ left, right, leftLabel, rightLabel, jobs, onClose, onFinished }: {
  left: SyncEndpoint
  right: SyncEndpoint
  leftLabel: string
  rightLabel: string
  jobs: JobState[]
  onClose(): void
  onFinished(): void
}): React.JSX.Element {
  const [mode, setMode] = useState<SyncMode>('mirror-ltr')
  const [deleteExtras, setDeleteExtras] = useState(false)
  const [byContent, setByContent] = useState(false)
  const [ignore, setIgnore] = useState('.git, node_modules')
  const [showSame, setShowSame] = useState(false)
  const [busy, setBusy] = useState<'comparing' | 'running' | null>(null)
  const [error, setError] = useState('')
  const [result, setResult] = useState<SyncCompareResult | null>(null)
  const [overrides, setOverrides] = useState<Record<string, SyncDirection>>({})
  const [directions, setDirections] = useState<Record<string, SyncDirection>>({})
  const [summary, setSummary] = useState<SyncSummary | null>(null)
  const [jobId, setJobId] = useState<string | null>(null)
  const notified = useRef(false)

  const job = jobId ? jobs.find((j) => j.id === jobId) : undefined
  useEffect(() => {
    if (job && job.state !== 'running' && !notified.current) {
      notified.current = true
      setBusy(null)
      onFinished()
    }
  }, [job, onFinished])

  const compare = async (): Promise<void> => {
    setBusy('comparing'); setError(''); setResult(null); setOverrides({}); setJobId(null); notified.current = false
    const r = await window.mymius.files.sync.compare({ left, right, compare: byContent ? 'hash' : 'quick', ignore: ignore.split(',').map((s) => s.trim()).filter(Boolean) })
    setBusy(null)
    if (r.ok) setResult(r)
    else setError(r.error)
  }

  // Recompute what would happen whenever the mode or any arrow changes.
  useEffect(() => {
    if (!result) return
    let stale = false
    const t = setTimeout(() => {
      void window.mymius.files.sync.preview({ compareId: result.compareId, mode, deleteExtras, overrides }).then((r) => {
        if (stale) return
        if (r.ok) { setDirections(r.preview.directions); setSummary(r.preview.summary) }
        else setError(r.error)
      })
    }, 120)
    return () => { stale = true; clearTimeout(t) }
  }, [result, mode, deleteExtras, overrides])

  const run = async (): Promise<void> => {
    if (!result) return
    setBusy('running'); setError('')
    const r = await window.mymius.files.sync.run({ compareId: result.compareId, mode, deleteExtras, overrides })
    if (r.ok) setJobId(r.jobId)
    else { setBusy(null); setError(r.error) }
  }

  const toggle = useCallback((rel: string) => {
    setOverrides((o) => {
      const current = o[rel] ?? directions[rel] ?? 'skip'
      const next = CYCLE[(CYCLE.indexOf(current) + 1) % CYCLE.length]!
      return { ...o, [rel]: next }
    })
  }, [directions])

  const visible = useMemo(() => (result ? result.items.filter((i) => showSame || i.status !== 'same') : []), [result, showSame])
  const v = useVirtualList(visible.length, ROW)
  const nothing = summary !== null && summary.copies + summary.mkdirs + summary.deletes === 0

  return (
    <Modal
      wide
      title="Sync folders"
      onCancel={onClose}
      actions={
        <>
          {busy === 'running' && job?.state === 'running' && <button className="secondary" onClick={() => void window.mymius.files.cancel(job.id)}>Cancel sync</button>}
          <button className="secondary" onClick={onClose}>{job && job.state !== 'running' ? 'Close' : 'Cancel'}</button>
          <button className="secondary" onClick={() => void compare()} disabled={busy !== null}>{result ? 'Compare again' : 'Compare'}</button>
          <button className="primary" onClick={() => void run()} disabled={!result || busy !== null || nothing || (job !== undefined && job.state !== 'running')}>Sync now</button>
        </>
      }
    >
      <div className="sync-ends">
        <div><span className="sub">Left</span><strong title={left.path}>{leftLabel}: {left.path}</strong></div>
        <div><span className="sub">Right</span><strong title={right.path}>{rightLabel}: {right.path}</strong></div>
      </div>

      <div className="sync-options">
        <fieldset>
          <legend>Direction</legend>
          {MODES.map((m) => (
            <label key={m.id} className="radio" title={m.hint}><input type="radio" name="syncmode" value={m.id} checked={mode === m.id} onChange={() => setMode(m.id)} />{m.label}</label>
          ))}
        </fieldset>
        <div className="sync-checks">
          <label className="radio"><input type="checkbox" name="deleteExtras" checked={deleteExtras} disabled={mode === 'two-way'} onChange={(e) => setDeleteExtras(e.target.checked)} />Xóa các file chỉ có ở thư mục đích <span className="sub">(được giữ trong .mymius-trash)</span></label>
          <label className="radio"><input type="checkbox" name="byContent" checked={byContent} onChange={(e) => setByContent(e.target.checked)} />Compare by content <span className="sub">(chậm hơn, bỏ qua ngày giờ)</span></label>
          <label>Ignore <input name="ignore" value={ignore} onChange={(e) => setIgnore(e.target.value)} spellCheck={false} /></label>
        </div>
      </div>

      {error && <p className="error" role="alert">{error}</p>}
      {busy === 'comparing' && <p className="hint">Đang so sánh các thư mục…</p>}

      {result && (
        <>
          <div className="sync-summary" data-testid="sync-summary">
            {summary ? (
              nothing ? 'Không có gì cần làm: các thư mục đã khớp nhau theo chiều này.' :
              <>{summary.copies} cần chép ({formatSize(summary.bytes)}) · {summary.mkdirs} thư mục mới · {summary.deletes} cần xóa{summary.conflicts ? ` · ${summary.conflicts} xung đột để bạn tự xử lý` : ''}</>
            ) : 'Đang tính toán…'}
            <label className="toggle"><input type="checkbox" checked={showSame} onChange={(e) => setShowSame(e.target.checked)} />hiện mục giống nhau</label>
          </div>
          {result.truncated && <p className="hint">Chỉ hiển thị {result.items.length} khác biệt đầu tiên.</p>}
          {result.scanErrors.length > 0 && <details className="issues"><summary>{result.scanErrors.length} thư mục không đọc được</summary><ul>{result.scanErrors.slice(0, 20).map((e, i) => <li key={i}>{e}</li>)}</ul></details>}
          <div className="sync-table" role="table" aria-label="Differences">
            <div className="sync-head" role="row"><span>Left</span><span /><span>Right</span><span>Item</span></div>
            <div ref={v.ref} className="sync-rows" onScroll={v.onScroll}>
              {visible.length === 0 && <div className="pane-msg">Không có khác biệt</div>}
              <div style={{ height: v.totalHeight, position: 'relative' }}>
                {visible.slice(v.start, v.end).map((item, k) => (
                  <SyncRow key={item.rel} item={item} top={(v.start + k) * ROW} dir={overrides[item.rel] ?? directions[item.rel] ?? 'skip'} overridden={item.rel in overrides} onToggle={() => toggle(item.rel)} />
                ))}
              </div>
            </div>
          </div>
        </>
      )}

      {job && (
        <div className={`sync-result ${job.state}`} role="status" data-testid="sync-result">
          {job.state === 'running' ? `Đang đồng bộ… ${job.filesDone}/${job.filesTotal}` : `${job.state === 'done' ? 'Xong. ' : job.state === 'cancelled' ? 'Đã hủy. ' : 'Thất bại. '}${job.summary ?? ''}`}
          {job.errors.length > 0 && <ul>{job.errors.slice(0, 10).map((e, i) => <li key={i}><code>{e.path}</code>: {e.message}</li>)}</ul>}
        </div>
      )}
    </Modal>
  )
}

function SyncRow({ item, top, dir, overridden, onToggle }: { item: SyncItem; top: number; dir: SyncDirection; overridden: boolean; onToggle(): void }): React.JSX.Element {
  const isDir = item.kind === 'directory'
  // ltr on an item that exists only on the right means "remove it": show that plainly.
  const removing = (dir === 'ltr' && item.status === 'right-only') || (dir === 'rtl' && item.status === 'left-only')
  const glyph = dir === 'skip' ? (item.status === 'same' ? '=' : '≠') : dir === 'ltr' ? '→' : '←'
  return (
    <div className={`sync-row st-${item.status} ${dir}`} style={{ top, height: ROW }} data-rel={item.rel} data-testid="sync-row">
      <span className="side">{item.leftSize !== undefined ? (isDir ? 'folder' : `${formatSize(item.leftSize)} · ${formatDate(item.leftMtimeMs)}`) : ''}</span>
      <button
        className={`arrow ${overridden ? 'manual' : ''} ${removing ? 'remove' : ''}`}
        title={`${STATUS_LABEL[item.status]}. Click to change what happens.${removing ? ' This removes the file.' : ''}`}
        aria-label={`${item.rel}: ${dir === 'skip' ? 'leave alone' : dir === 'ltr' ? 'left to right' : 'right to left'}${removing ? ' (removes)' : ''}`}
        onClick={onToggle}
      >{removing ? '✕' : glyph}</button>
      <span className="side right">{item.rightSize !== undefined ? (isDir ? 'folder' : `${formatSize(item.rightSize)} · ${formatDate(item.rightMtimeMs)}`) : ''}</span>
      <span className="name" title={item.rel}>{isDir ? '📁 ' : ''}{item.rel}</span>
    </div>
  )
}
