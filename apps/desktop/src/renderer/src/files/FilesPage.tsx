import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ConflictPolicy, EditInfo, FsEntry, FsListing, FsPlace, FsSessionInfo, HostSummary, JobState } from '../../../shared/ipc'
import { filesActivities, setActivities } from '../activity/activity'
import { useVault } from '../vault/useVault'
import { JobsBar } from './JobsBar'
import { Modal } from './Modal'
import { Pane, type DragPayload } from './Pane'
import { SyncDialog } from './SyncDialog'

interface PaneState {
  session: FsSessionInfo | null
  path: string | null
  selected: string[]
  reload: number
  status: 'ready' | 'connecting' | 'error'
  error?: string
  /** Name of the server being connected to, while `status` is 'connecting' for one. */
  connectingTo?: string
}

type Dialog =
  | { kind: 'conflict'; names: string[]; resolve(p: ConflictPolicy | null): void }
  | { kind: 'delete'; count: number; local: boolean; resolve(ok: boolean): void }
  | { kind: 'name'; title: string; initial: string; action: string; resolve(name: string | null): void }
  | { kind: 'sync' }

const emptyPane = (): PaneState => ({ session: null, path: null, selected: [], reload: 0, status: 'connecting' })

/** `visible`: this tab is on screen. The page stays mounted while hidden, so it must refresh itself on return. */
export function FilesPage({ visible }: { visible: boolean }): React.JSX.Element {
  const { status: vault } = useVault()
  const [panes, setPanes] = useState<[PaneState, PaneState]>([emptyPane(), emptyPane()])
  const [active, setActive] = useState<0 | 1>(0)
  const [places, setPlaces] = useState<FsPlace[]>([])
  const [hosts, setHosts] = useState<HostSummary[] | null>(null)
  const [jobs, setJobs] = useState<JobState[]>([])
  const [edits, setEdits] = useState<EditInfo[]>([])
  const [dialog, setDialog] = useState<Dialog | null>(null)
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null)
  const panesRef = useRef(panes)
  panesRef.current = panes
  const settled = useRef(new Set<string>())

  const patch = useCallback((i: 0 | 1, p: Partial<PaneState>) => setPanes((cur) => {
    const next: [PaneState, PaneState] = [cur[0], cur[1]]
    next[i] = { ...cur[i], ...p }
    return next
  }), [])
  const say = useCallback((text: string, error = false) => {
    setNotice({ text, error })
    window.setTimeout(() => setNotice((n) => (n?.text === text ? null : n)), 7000)
  }, [])
  const refreshBoth = useCallback(() => setPanes((cur) => [{ ...cur[0], reload: cur[0].reload + 1 }, { ...cur[1], reload: cur[1].reload + 1 }]), [])

  // ---- start: local disk in both panes ----
  useEffect(() => {
    void window.mymius.files.places().then((r) => {
      if (!r.ok) return say(r.error, true)
      setPlaces(r.places)
      const home = r.session.home
      setPanes([{ ...emptyPane(), session: r.session, path: home, status: 'ready' }, { ...emptyPane(), session: r.session, path: home, status: 'ready' }])
    })
    void window.mymius.files.jobs().then(setJobs)
    void window.mymius.files.edits.list().then(setEdits)
  }, [say])

  // Saved hosts are only visible while the vault is unlocked.
  // Hosts can be added or renamed on the Hosts tab meanwhile, so fetch again each time this tab is shown.
  useEffect(() => {
    if (vault?.state !== 'unlocked') return setHosts(null)
    if (!visible) return
    const load = (): void => void window.mymius.hosts.list().then((r) => setHosts(r.ok ? r.hosts : null))
    load()
    return window.mymius.vault.onChanged(load) // and when sync brings in changes while this tab is open
  }, [vault?.state, visible])

  // ---- jobs & edits arrive as events ----
  useEffect(() => window.mymius.files.onJob((job) => {
    setJobs((cur) => [job, ...cur.filter((j) => j.id !== job.id)])
    if (job.state !== 'running' && !settled.current.has(job.id)) {
      settled.current.add(job.id)
      refreshBoth()
      if (job.state === 'failed') say(job.summary ?? 'Thao tác thất bại', true)
    }
  }), [refreshBoth, say])
  useEffect(() => window.mymius.files.edits.onEvent((e) => {
    setEdits((cur) => (e.state === 'closed' ? cur.filter((x) => x.id !== e.id) : [e, ...cur.filter((x) => x.id !== e.id)]))
    if (e.state === 'unsynced') say(`${e.name} CHƯA được tải lên: bản trên server đã thay đổi. Chỉnh sửa của bạn vẫn được giữ trên máy này.`, true)
    if (e.state === 'error') say(`${e.name}: ${e.message ?? 'tải lên thất bại'}`, true)
  }), [say])

  // What the person may be waiting for, for the bar in the corner.
  useEffect(() => {
    const connecting = panes.flatMap((p, side) => (p.status === 'connecting' && p.connectingTo !== undefined ? [{ side, host: p.connectingTo }] : []))
    setActivities('files', filesActivities({ connecting, jobs, edits }))
  }, [panes, jobs, edits])
  useEffect(() => () => setActivities('files', []), [])

  // ---- dialogs as promises ----
  const ask = useCallback(<T,>(make: (resolve: (v: T) => void) => Dialog): Promise<T> => new Promise<T>((resolve) => {
    setDialog(make((v) => { setDialog(null); resolve(v) }))
  }), [])

  // ---- navigation ----
  const navigate = (i: 0 | 1, path: string): void => patch(i, { path, selected: [] })

  const choose = async (i: 0 | 1, c: { kind: 'place'; path: string } | { kind: 'host'; hostId: string }): Promise<void> => {
    const old = panesRef.current[i].session
    if (c.kind === 'place') {
      const local = panesRef.current[0].session?.kind === 'local' ? panesRef.current[0].session : panesRef.current[1].session?.kind === 'local' ? panesRef.current[1].session : null
      const session = local ?? (await window.mymius.files.places().then((r) => (r.ok ? r.session : null)))
      if (!session) return
      patch(i, { session, path: c.path, selected: [], status: 'ready' })
    } else {
      patch(i, { status: 'connecting', selected: [], connectingTo: hosts?.find((h) => h.id === c.hostId)?.name ?? 'máy chủ' })
      const r = await window.mymius.files.connect(c.hostId)
      if (!r.ok) return patch(i, { status: 'error', error: r.error })
      patch(i, { session: r.session, path: r.session.home, status: 'ready' })
    }
    if (old && old.kind === 'sftp') void window.mymius.files.disconnect(old.id)
  }

  const reconnect = async (i: 0 | 1): Promise<void> => {
    const s = panesRef.current[i].session
    if (s?.kind === 'sftp' && s.hostId && (panesRef.current[i].status === 'error' || panesRef.current[i].error)) return choose(i, { kind: 'host', hostId: s.hostId })
    patch(i, { reload: panesRef.current[i].reload + 1, status: panesRef.current[i].status === 'error' ? 'ready' : panesRef.current[i].status })
  }

  // ---- operations ----
  const other = (i: 0 | 1): 0 | 1 => (i === 0 ? 1 : 0)

  const transfer = useCallback(async (mode: 'copy' | 'move', fromSession: string, paths: string[], toSession: string, toDir: string): Promise<void> => {
    if (paths.length === 0) return say('Hãy chọn một mục trước')
    const req = { fromSession, paths, toSession, toDir }
    const c = await window.mymius.files.conflicts(req)
    if (!c.ok) return say(c.error, true)
    let policy: ConflictPolicy = 'skip'
    if (c.names.length > 0) {
      const choice = await ask<ConflictPolicy | null>((resolve) => ({ kind: 'conflict', names: c.names, resolve }))
      if (!choice) return
      policy = choice
    }
    const r = await window.mymius.files.transfer({ ...req, mode, policy })
    if (!r.ok) say(r.error, true)
  }, [ask, say])

  const copyMove = (mode: 'copy' | 'move'): void => {
    const s = panes[active], d = panes[other(active)]
    if (!s.session || !d.session || d.path === null) return
    void transfer(mode, s.session.id, s.selected, d.session.id, d.path)
  }

  const newFolder = async (): Promise<void> => {
    const s = panes[active]
    if (!s.session || s.path === null) return
    const name = await ask<string | null>((resolve) => ({ kind: 'name', title: 'New folder', initial: 'New folder', action: 'Create', resolve }))
    if (!name) return
    const r = await window.mymius.files.mkdir(s.session.id, s.path, name)
    if (!r.ok) say(r.error, true)
    else patch(active, { reload: s.reload + 1, selected: [] })
  }

  const rename = async (): Promise<void> => {
    const s = panes[active]
    if (!s.session || s.selected.length !== 1) return say('Hãy chọn đúng một mục để đổi tên')
    const path = s.selected[0]!
    const current = path.split(/[\\/]/).pop() ?? ''
    const name = await ask<string | null>((resolve) => ({ kind: 'name', title: 'Rename', initial: current, action: 'Rename', resolve }))
    if (!name || name === current) return
    const r = await window.mymius.files.rename(s.session.id, path, name)
    if (!r.ok) say(r.error, true)
    else patch(active, { reload: s.reload + 1, selected: [] })
  }

  const remove = async (): Promise<void> => {
    const s = panes[active]
    if (!s.session || s.selected.length === 0) return say('Hãy chọn một mục trước')
    const ok = await ask<boolean>((resolve) => ({ kind: 'delete', count: s.selected.length, local: s.session!.kind === 'local', resolve }))
    if (!ok) return
    const r = await window.mymius.files.delete(s.session.id, s.selected)
    if (!r.ok) say(r.error, true)
    else patch(active, { selected: [] })
  }

  const openFile = async (i: 0 | 1, entry: FsEntry): Promise<void> => {
    const s = panes[i].session
    if (!s) return
    const r = await window.mymius.files.open(s.id, entry.path)
    if (!r.ok) say(r.error, true)
    else if (r.how === 'editing') say(`Đang sửa ${entry.name}. Bấm lưu trong trình soạn thảo là file tự động được tải lên.`)
  }

  const onDropItems = (target: 0 | 1, payload: DragPayload, dir: string, move: boolean): void => {
    const to = panes[target].session
    if (!to) return
    void transfer(move ? 'move' : 'copy', payload.sessionId, payload.paths, to.id, dir)
  }

  const shortcuts = (e: React.KeyboardEvent): void => {
    if ((e.target as HTMLElement).closest('input, select, textarea') || dialog) return
    const mod = e.metaKey || e.ctrlKey
    if (e.key === 'F5') { e.preventDefault(); copyMove('copy') }
    else if (e.key === 'F6') { e.preventDefault(); copyMove('move') }
    else if (e.key === 'F7') { e.preventDefault(); void newFolder() }
    else if (e.key === 'F2') { e.preventDefault(); void rename() }
    else if (e.key === 'F8' || e.key === 'Delete' || (mod && e.key === 'Backspace')) { e.preventDefault(); void remove() }
    else if (e.key === 'Tab' && !mod) { e.preventDefault(); setActive(other(active)); document.querySelector<HTMLElement>(`[data-testid="pane-${other(active)}"]`)?.focus() }
    else if (mod && e.key.toLowerCase() === 'r') { e.preventDefault(); refreshBoth() }
  }

  const label = (s: FsSessionInfo | null): string => s?.label ?? '…'
  const both = panes[0].session && panes[1].session && panes[0].path !== null && panes[1].path !== null
  const visibleJobs = useMemo(() => jobs.filter((j) => !settled.current.has('dismissed:' + j.id)), [jobs])

  return (
    <div className="files" onKeyDown={shortcuts}>
      <div className="fm-toolbar" role="toolbar" aria-label="File actions">
        <button onClick={() => copyMove('copy')} title="Copy to the other pane (F5)">Copy →</button>
        <button onClick={() => copyMove('move')} title="Move to the other pane (F6)">Move →</button>
        <button onClick={() => void newFolder()} title="New folder (F7)">New folder</button>
        <button onClick={() => void rename()} title="Rename (F2)">Rename</button>
        <button className="danger-text" onClick={() => void remove()} title="Delete (F8)">Delete</button>
        <span className="grow" />
        <button className="primary" disabled={!both} onClick={() => setDialog({ kind: 'sync' })} title="Compare and synchronise the two folders">Sync folders…</button>
      </div>

      <div className="panes2">
        {([0, 1] as const).map((i) => (
          <Pane
            key={i}
            side={i}
            active={active === i}
            session={panes[i].session}
            path={panes[i].path}
            reload={panes[i].reload}
            selected={panes[i].selected}
            places={places}
            hosts={hosts}
            sourceLabel={label(panes[i].session)}
            status={panes[i].status}
            {...(panes[i].error ? { error: panes[i].error } : {})}
            onActivate={() => setActive(i)}
            onNavigate={(p) => navigate(i, p)}
            onSelect={(paths) => patch(i, { selected: paths })}
            onChoose={(c) => void choose(i, c)}
            onOpen={(e) => void openFile(i, e)}
            onListing={(l: FsListing) => patch(i, { path: l.path })}
            onDropItems={(payload, dir, move) => onDropItems(i, payload, dir, move)}
            onRetry={() => void reconnect(i)}
          />
        ))}
      </div>

      {notice && <div className={`notice ${notice.error ? 'error' : ''}`} role={notice.error ? 'alert' : 'status'}>{notice.text}</div>}

      <JobsBar
        jobs={visibleJobs}
        edits={edits}
        onCancel={(id) => void window.mymius.files.cancel(id)}
        onDismiss={(id) => setJobs((cur) => cur.filter((j) => j.id !== id))}
        onCloseEdit={(id, discard) => void window.mymius.files.edits.close(id, discard)}
      />

      {dialog?.kind === 'conflict' && (
        <Modal
          title="Some items already exist"
          onCancel={() => dialog.resolve(null)}
          actions={<>
            <button className="secondary" onClick={() => dialog.resolve(null)}>Cancel</button>
            <button className="secondary" onClick={() => dialog.resolve('skip')}>Skip existing</button>
            <button className="secondary" onClick={() => dialog.resolve('keep-both')}>Keep both</button>
            <button className="primary" onClick={() => dialog.resolve('overwrite')}>Replace</button>
          </>}
        >
          <p>{dialog.names.length === 1 ? `"${dialog.names[0]}" đã tồn tại` : `${dialog.names.length} mục đã tồn tại`} ở thư mục đích:</p>
          <ul className="names">{dialog.names.slice(0, 6).map((n) => <li key={n}>{n}</li>)}{dialog.names.length > 6 && <li>…và {dialog.names.length - 6} mục nữa</li>}</ul>
        </Modal>
      )}

      {dialog?.kind === 'delete' && (
        <Modal
          title={`Delete ${dialog.count} item${dialog.count === 1 ? '' : 's'}?`}
          onCancel={() => dialog.resolve(false)}
          actions={<>
            <button className="secondary" onClick={() => dialog.resolve(false)}>Keep</button>
            <button className="danger" onClick={() => dialog.resolve(true)}>{dialog.local ? 'Move to trash' : 'Delete permanently'}</button>
          </>}
        >
          <p>{dialog.local ? 'Các mục sẽ được chuyển vào thùng rác và có thể khôi phục.' : 'Các mục này nằm trên server, nơi không có thùng rác. Sau khi xóa sẽ không lấy lại được.'}</p>
        </Modal>
      )}

      {dialog?.kind === 'name' && <NameDialog spec={dialog} />}

      {dialog?.kind === 'sync' && panes[0].session && panes[1].session && panes[0].path !== null && panes[1].path !== null && (
        <SyncDialog
          left={{ sessionId: panes[0].session.id, path: panes[0].path }}
          right={{ sessionId: panes[1].session.id, path: panes[1].path }}
          leftLabel={panes[0].session.label}
          rightLabel={panes[1].session.label}
          jobs={jobs}
          onClose={() => setDialog(null)}
          onFinished={refreshBoth}
        />
      )}
    </div>
  )
}

function NameDialog({ spec }: { spec: Extract<Dialog, { kind: 'name' }> }): React.JSX.Element {
  const [name, setName] = useState(spec.initial)
  return (
    <Modal
      title={spec.title}
      onCancel={() => spec.resolve(null)}
      actions={<>
        <button className="secondary" onClick={() => spec.resolve(null)}>Cancel</button>
        <button className="primary" disabled={!name.trim()} onClick={() => spec.resolve(name)}>{spec.action}</button>
      </>}
    >
      <input
        className="name-input"
        aria-label="Name"
        value={name}
        autoFocus
        spellCheck={false}
        onFocus={(e) => e.target.select()}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && name.trim()) spec.resolve(name) }}
      />
    </Modal>
  )
}
