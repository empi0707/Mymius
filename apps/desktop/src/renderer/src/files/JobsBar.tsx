import { useState } from 'react'
import type { EditInfo, JobState } from '../../../shared/ipc'
import { formatSize } from './format'

const EDIT_LABEL: Record<EditInfo['state'], string> = {
  opening: 'opening', synced: 'saved to server', uploading: 'uploading…', unsynced: 'NOT uploaded', conflict: 'waiting for you', error: 'error', closed: 'closed'
}

export function JobsBar({ jobs, edits, onCancel, onDismiss, onCloseEdit }: {
  jobs: JobState[]
  edits: EditInfo[]
  onCancel(id: string): void
  onDismiss(id: string): void
  onCloseEdit(id: string, discard: boolean): void
}): React.JSX.Element | null {
  const [open, setOpen] = useState(true)
  if (jobs.length === 0 && edits.length === 0) return null
  const running = jobs.filter((j) => j.state === 'running').length

  return (
    <div className="jobsbar" data-testid="jobsbar">
      <button className="link jobs-toggle" onClick={() => setOpen(!open)}>
        {open ? '▾' : '▸'} Activity {running ? `(${running} running)` : ''}
      </button>
      {open && (
        <div className="jobs-list">
          {edits.map((e) => (
            <div key={e.id} className="job edit" data-testid={`edit-${e.name}`}>
              <div className="job-main">
                <strong>Editing {e.name}</strong> <span className="sub">on {e.hostLabel}</span>
                <span className={`badge ${e.state}`}>{EDIT_LABEL[e.state]}</span>
                {e.message && <span className="sub error"> {e.message}</span>}
              </div>
              <div className="job-actions">
                <button className="secondary" onClick={() => onCloseEdit(e.id, false)} title="Stop watching this file. Unsaved changes stay on this computer.">Done</button>
                {e.state === 'unsynced' && <button className="danger" onClick={() => onCloseEdit(e.id, true)}>Discard my changes</button>}
              </div>
            </div>
          ))}
          {jobs.map((j) => {
            const pct = j.bytesTotal > 0 ? j.bytesDone / j.bytesTotal : j.filesTotal > 0 ? j.filesDone / j.filesTotal : j.state === 'running' ? 0 : 1
            return (
              <div key={j.id} className={`job ${j.state}`} data-testid={`job-${j.kind}`}>
                <div className="job-main">
                  <strong>{j.label}</strong>
                  {j.state === 'running' && <span className="sub"> {j.filesDone}/{j.filesTotal || '?'} · {formatSize(j.bytesDone)}{j.bytesTotal ? ` of ${formatSize(j.bytesTotal)}` : ''}</span>}
                  {j.state !== 'running' && <span className="sub"> {j.state === 'cancelled' ? 'Cancelled. ' : j.state === 'failed' ? 'Failed. ' : ''}{j.summary}</span>}
                  {j.state === 'running' && <div className="bar"><div style={{ width: `${Math.round(pct * 100)}%` }} /></div>}
                  {j.errors.length > 0 && (
                    <details className="issues"><summary>{j.errors.length} problem{j.errors.length === 1 ? '' : 's'}</summary>
                      <ul>{j.errors.slice(0, 50).map((x, i) => <li key={i}><code>{x.path}</code>: {x.message}</li>)}</ul>
                    </details>
                  )}
                </div>
                <div className="job-actions">
                  {j.state === 'running' ? <button className="secondary" onClick={() => onCancel(j.id)}>Cancel</button> : <button className="secondary" onClick={() => onDismiss(j.id)}>Dismiss</button>}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
