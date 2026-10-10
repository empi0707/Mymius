import { useEffect, useMemo, useRef, useState } from 'react'
import type { FsEntry, FsListing, FsPlace, FsSessionInfo, HostSummary } from '../../../shared/ipc'
import { setActivities } from '../activity/activity'
import { ContextMenu } from './ContextMenu'
import { dragImage } from './DragGhost'
import { formatDate, formatSize } from './format'
import { buildMenu, type MenuAction } from './menu'
import { searchEntries } from './search'
import { useVirtualList } from './useVirtualList'

export const DRAG_TYPE = 'application/x-mymius-files'
export interface DragPayload {
  sessionId: string
  paths: string[]
  /** What the files were dragged from (this computer or a host), so a drop can tell a move from a copy. */
  from: { kind: 'local' | 'sftp'; hostId?: string }
}

export type SortKey = 'name' | 'size' | 'mtime'
const ROW_HEIGHT = 26

export interface PaneProps {
  side: 0 | 1
  active: boolean
  session: FsSessionInfo | null
  path: string | null
  reload: number
  selected: readonly string[]
  places: FsPlace[]
  /** null while the vault is locked. */
  hosts: HostSummary[] | null
  sourceLabel: string
  status: 'ready' | 'connecting' | 'error'
  error?: string
  /** Only entries whose name contains this (any letter case) are shown. */
  query: string
  onClearQuery(): void
  onActivate(): void
  onNavigate(path: string): void
  onSelect(paths: string[]): void
  onChoose(choice: { kind: 'place'; path: string } | { kind: 'host'; hostId: string }): void
  onOpen(entry: FsEntry): void
  onListing(listing: FsListing): void
  onDropItems(payload: DragPayload, targetDir: string, altKey: boolean): void
  /** Files from outside the app (Finder, Explorer) were dropped on the folder `targetDir` of this pane. */
  onDropExternal(paths: string[], targetDir: string): void
  /** A drag started from this pane. */
  onDragStartInfo(info: { from: DragPayload['from']; folder: boolean; count: number }): void
  /** The drag is over this pane (true) or left it (false). Returns what a drop here would do, shown by the cursor. */
  onDragHover(over: boolean, altKey: boolean): 'move' | 'copy'
  onRetry(): void
  /** The other pane is connected and can receive copies. */
  hasTarget: boolean
  /** The file clipboard (Copy / Cut in the menu, ⌘C / ⌘X) holds something to paste here. */
  canPaste: boolean
  /** An item of the right-click menu was chosen. `entry` is the row that was clicked, when there was one. */
  onMenuAction(action: MenuAction, entry?: FsEntry): void
}

function compare(a: FsEntry, b: FsEntry, key: SortKey, dir: 1 | -1): number {
  const aDir = isFolder(a), bDir = isFolder(b)
  if (aDir !== bDir) return aDir ? -1 : 1 // folders always first
  let r = 0
  // A folder's "size" is whatever the file system reports for the directory itself: meaningless, and
  // reversing it would shuffle folders for no reason. Folders stay in name order when sorting by size.
  if (key === 'size' && aDir) return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
  if (key === 'size') r = a.size - b.size
  else if (key === 'mtime') r = (a.mtimeMs ?? 0) - (b.mtimeMs ?? 0)
  if (r === 0) r = a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
  return r * dir
}

export const isFolder = (e: FsEntry): boolean => e.kind === 'directory' || (e.kind === 'symlink' && e.targetKind === 'directory')

export function Pane(p: PaneProps): React.JSX.Element {
  const [listing, setListing] = useState<FsListing | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'name', dir: 1 })
  const [showHidden, setShowHidden] = useState(false)
  const [editingPath, setEditingPath] = useState<string | null>(null)
  const [cursor, setCursor] = useState(0)
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; entry?: FsEntry } | null>(null)
  const anchor = useRef(0)
  const leaveTimer = useRef<number | undefined>(undefined)
  const wrapper = useRef<HTMLDivElement>(null)

  // Load the folder whenever the place, the path or the reload counter changes.
  useEffect(() => {
    if (!p.session || p.path === null || p.status !== 'ready') return
    let stale = false
    setLoading(true)
    void window.mymius.files.list(p.session.id, p.path).then((r) => {
      if (stale) return
      setLoading(false)
      if (r.ok) {
        setListing(r.listing)
        setError('')
        setCursor(0)
        anchor.current = 0
        if (r.listing.path !== p.path) p.onListing(r.listing)
      } else {
        setError(r.error)
      }
    })
    return () => { stale = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.session?.id, p.path, p.reload, p.status])

  // Reading a folder on a server can take a while; let the corner bar say so.
  const remote = p.session?.kind === 'sftp'
  useEffect(() => {
    setActivities(`list:${p.side}`, loading && remote ? [{ id: 'list', label: 'Đang tải thư mục từ máy chủ…' }] : [])
    return () => setActivities(`list:${p.side}`, [])
  }, [loading, remote, p.side])

  const needle = p.query.trim().toLowerCase()
  const found = useMemo(() => searchEntries(listing?.entries ?? [], p.query, showHidden), [listing, p.query, showHidden])
  const total = found.total
  const rows = useMemo(() => [...found.shown].sort((a, b) => compare(a, b, sort.key, sort.dir)), [found, sort])

  // What is filtered out cannot stay selected: Delete or Copy must never act on rows the person cannot see.
  useEffect(() => {
    if (p.selected.length === 0) return
    const visible = new Set(rows.map((r) => r.path))
    const keep = p.selected.filter((x) => visible.has(x))
    if (keep.length !== p.selected.length) p.onSelect(keep)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows])
  useEffect(() => { setCursor(0); anchor.current = 0 }, [needle])

  const v = useVirtualList(rows.length, ROW_HEIGHT)
  const selectedSet = useMemo(() => new Set(p.selected), [p.selected])

  const select = (index: number, mode: 'replace' | 'toggle' | 'range'): void => {
    const entry = rows[index]
    if (!entry) return
    setCursor(index)
    if (mode === 'range') {
      const [a, b] = [Math.min(anchor.current, index), Math.max(anchor.current, index)]
      p.onSelect(rows.slice(a, b + 1).map((r) => r.path))
    } else if (mode === 'toggle') {
      anchor.current = index
      p.onSelect(selectedSet.has(entry.path) ? p.selected.filter((x) => x !== entry.path) : [...p.selected, entry.path])
    } else {
      anchor.current = index
      p.onSelect([entry.path])
    }
    v.reveal(index)
  }

  const activate = (entry: FsEntry): void => {
    if (isFolder(entry)) p.onNavigate(entry.path)
    else p.onOpen(entry)
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if ((e.target as HTMLElement).closest('input, select, textarea')) return
    const meta = e.metaKey || e.ctrlKey
    const move = (to: number): void => {
      e.preventDefault()
      select(Math.max(0, Math.min(rows.length - 1, to)), e.shiftKey ? 'range' : 'replace')
    }
    if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
      e.preventDefault()
      const entry = rows[cursor]
      const el = wrapper.current?.querySelector<HTMLElement>(entry ? `[data-name="${CSS.escape(entry.name)}"]` : '.rows')
      const r = el?.getBoundingClientRect()
      if (entry && !selectedSet.has(entry.path)) select(cursor, 'replace')
      setMenu({ x: (r?.left ?? 0) + 40, y: (r?.top ?? 0) + (entry ? ROW_HEIGHT : 8), ...(entry ? { entry } : {}) })
      return
    }
    switch (e.key) {
      case 'ArrowDown': return move(cursor + 1)
      case 'ArrowUp': return move(cursor - 1)
      case 'Home': return move(0)
      case 'End': return move(rows.length - 1)
      case 'PageDown': return move(cursor + v.pageSize)
      case 'PageUp': return move(cursor - v.pageSize)
      case 'Enter': {
        e.preventDefault()
        const entry = rows[cursor]
        if (entry) activate(entry)
        return
      }
      case 'F4': {
        e.preventDefault()
        const entry = rows[cursor]
        if (entry && !isFolder(entry)) p.onMenuAction('edit', entry)
        return
      }
      case 'Backspace':
        if (!meta && listing?.parent) { e.preventDefault(); p.onNavigate(listing.parent) }
        return
      case 'a':
        if (meta) { e.preventDefault(); p.onSelect(rows.map((r) => r.path)) }
        return
    }
  }

  const sortBy = (key: SortKey): void => setSort((s) => (s.key === key ? { key, dir: (s.dir * -1) as 1 | -1 } : { key, dir: 1 }))
  const arrow = (key: SortKey): string => (sort.key === key ? (sort.dir === 1 ? ' ▲' : ' ▼') : '')

  const onDragStart = (e: React.DragEvent, entry: FsEntry, index: number): void => {
    if (!p.session) return
    const paths = selectedSet.has(entry.path) ? [...p.selected] : [entry.path]
    if (!selectedSet.has(entry.path)) select(index, 'replace')
    const from: DragPayload['from'] = p.session.kind === 'local' ? { kind: 'local' } : { kind: 'sftp', ...(p.session.hostId ? { hostId: p.session.hostId } : {}) }
    const payload: DragPayload = { sessionId: p.session.id, paths, from }
    e.dataTransfer.setData(DRAG_TYPE, JSON.stringify(payload))
    e.dataTransfer.effectAllowed = 'copyMove'
    // The picture that follows the pointer is drawn by the page (see DragGhost), so it can switch to "copy" (a + on the
    // file icon) while it is over a different server. The browser's own drag picture is hidden.
    e.dataTransfer.setDragImage(dragImage(), 0, 0)
    p.onDragStartInfo({ from, folder: isFolder(entry), count: paths.length })
  }
  const acceptsDrop = (e: React.DragEvent): boolean => e.dataTransfer.types.includes(DRAG_TYPE) || e.dataTransfer.types.includes('Files')
  const over = (e: React.DragEvent): void => {
    e.preventDefault()
    window.clearTimeout(leaveTimer.current) // still inside this pane
    e.dataTransfer.dropEffect = e.dataTransfer.types.includes(DRAG_TYPE) ? p.onDragHover(true, e.altKey) : 'copy'
  }
  const onDrop = (e: React.DragEvent, targetDir: string): void => {
    e.preventDefault()
    window.clearTimeout(leaveTimer.current)
    setDropTarget(null)
    p.onDragHover(false, false)
    if (e.dataTransfer.types.includes(DRAG_TYPE)) {
      try {
        const payload = JSON.parse(e.dataTransfer.getData(DRAG_TYPE)) as DragPayload
        p.onDropItems(payload, targetDir, e.altKey)
      } catch { /* not ours */ }
    } else if (e.dataTransfer.files.length > 0) {
      // Files dragged in from Finder / Explorer: they are on this computer, so they are copied here.
      const paths = Array.from(e.dataTransfer.files).map((f) => window.mymius.pathForFile(f)).filter(Boolean)
      if (paths.length > 0) p.onDropExternal(paths, targetDir)
    }
  }

  const openMenu = (e: React.MouseEvent, entry: FsEntry | undefined, index = -1): void => {
    e.preventDefault()
    e.stopPropagation()
    p.onActivate()
    if (entry && !selectedSet.has(entry.path)) select(index, 'replace')
    setMenu({ x: e.clientX, y: e.clientY, ...(entry ? { entry } : {}) })
  }
  const pick = (action: MenuAction): void => {
    const entry = menu?.entry
    setMenu(null)
    if (action === 'selectAll') p.onSelect(rows.map((r) => r.path))
    else p.onMenuAction(action, entry)
  }
  const menuCount = menu?.entry ? (selectedSet.has(menu.entry.path) ? p.selected.length : 1) : 0

  const hostOptions = p.hosts

  return (
    <div
      ref={wrapper}
      className={`pane-box ${p.active ? 'active' : ''}`}
      data-testid={`pane-${p.side}`}
      tabIndex={0}
      onFocus={p.onActivate}
      onMouseDown={p.onActivate}
      onKeyDown={onKeyDown}
    >
      <div className="pane-top">
        <select
          aria-label={`Source of pane ${p.side + 1}`}
          value={p.session ? (p.session.kind === 'local' ? 'local' : `host:${p.session.hostId}`) : ''}
          onChange={(e) => {
            const v2 = e.target.value
            if (v2.startsWith('host:')) p.onChoose({ kind: 'host', hostId: v2.slice(5) })
            else if (v2.startsWith('place:')) p.onChoose({ kind: 'place', path: v2.slice(6) })
          }}
        >
          <optgroup label="This computer">
            <option value="local" hidden>{p.sourceLabel}</option>
            {p.places.map((pl) => <option key={pl.path} value={`place:${pl.path}`}>{pl.name}</option>)}
          </optgroup>
          <optgroup label="Saved hosts">
            {hostOptions === null && <option disabled>Mở khóa vault để xem các host</option>}
            {hostOptions?.length === 0 && <option disabled>Chưa có host nào được lưu</option>}
            {hostOptions?.map((h) => <option key={h.id} value={`host:${h.id}`}>{h.name}</option>)}
          </optgroup>
        </select>
        <button className="icon" aria-label="Parent folder" title="Parent folder (Backspace)" disabled={!listing?.parent} onClick={() => listing?.parent && p.onNavigate(listing.parent)}>↑</button>
        <button className="icon" aria-label="Refresh" title="Refresh" onClick={p.onRetry}>⟳</button>
        <label className="toggle" title="Show hidden files"><input type="checkbox" checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} />hidden</label>
      </div>

      {editingPath !== null ? (
        <input
          className="pathbar"
          aria-label="Path"
          value={editingPath}
          autoFocus
          spellCheck={false}
          onChange={(e) => setEditingPath(e.target.value)}
          onBlur={() => setEditingPath(null)}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter') { const t = editingPath; setEditingPath(null); p.onNavigate(t) }
            if (e.key === 'Escape') setEditingPath(null)
          }}
        />
      ) : (
        <div className="crumbs" onDoubleClick={() => setEditingPath(listing?.path ?? p.path ?? '')} title="Double-click to type a path">
          {listing?.crumbs.map((c, i) => (
            <button key={c.path} className="crumb" onClick={() => p.onNavigate(c.path)}>{i === 0 ? c.name : `${c.name}`}</button>
          ))}
        </div>
      )}

      {needle && (
        <div className="pane-filter" role="status" data-testid={`pane-filter-${p.side}`}>
          <span>Đang lọc “{p.query.trim()}”: {rows.length}/{total} mục</span>
          <button className="link" onClick={p.onClearQuery}>Clear</button>
        </div>
      )}

      <div className="colhead" role="row">
        <button role="columnheader" className="c-name" onClick={() => sortBy('name')}>Name{arrow('name')}</button>
        <button role="columnheader" className="c-size" onClick={() => sortBy('size')}>Size{arrow('size')}</button>
        <button role="columnheader" className="c-date" onClick={() => sortBy('mtime')}>Modified{arrow('mtime')}</button>
      </div>

      <div
        ref={v.ref}
        className={`rows ${dropTarget === '.' ? 'drop' : ''}`}
        role="listbox"
        aria-multiselectable="true"
        aria-label={`Files in ${listing?.path ?? ''}`}
        onScroll={v.onScroll}
        onDragOver={(e) => { if (acceptsDrop(e)) { over(e); setDropTarget('.') } }}
        // Browsers report dragleave when the pointer only moves from one child to another (and give no usable
        // relatedTarget), so "left the pane" is decided by no dragover arriving for a moment.
        onDragLeave={() => { window.clearTimeout(leaveTimer.current); leaveTimer.current = window.setTimeout(() => { setDropTarget(null); p.onDragHover(false, false) }, 120) }}
        onDrop={(e) => listing && onDrop(e, listing.path)}
        onClick={(e) => { if (e.target === e.currentTarget) p.onSelect([]) }}
        onContextMenu={(e) => openMenu(e, undefined)}
      >
        {p.status === 'connecting' && <div className="pane-msg">Đang kết nối…</div>}
        {p.status === 'error' && <div className="pane-msg error" role="alert">{p.error} <button className="link" onClick={p.onRetry}>Retry</button></div>}
        {p.status === 'ready' && error && <div className="pane-msg error" role="alert">{error} <button className="link" onClick={p.onRetry}>Retry</button></div>}
        {p.status === 'ready' && !error && !loading && rows.length === 0 && <div className="pane-msg">{needle ? `Không có mục nào khớp “${p.query.trim()}”` : 'Thư mục này trống'}</div>}
        <div style={{ height: v.totalHeight, position: 'relative' }}>
          {rows.slice(v.start, v.end).map((entry, k) => {
            const index = v.start + k
            const folder = isFolder(entry)
            return (
              <div
                key={entry.path}
                role="option"
                aria-selected={selectedSet.has(entry.path)}
                data-name={entry.name}
                className={`frow ${selectedSet.has(entry.path) ? 'sel' : ''} ${index === cursor && p.active ? 'cur' : ''} ${dropTarget === entry.path ? 'drop' : ''}`}
                style={{ top: index * ROW_HEIGHT, height: ROW_HEIGHT }}
                draggable
                onDragStart={(e) => onDragStart(e, entry, index)}
                onDragOver={(e) => { if (folder && acceptsDrop(e)) { over(e); e.stopPropagation(); setDropTarget(entry.path) } }}
                onDrop={(e) => { if (folder) { e.stopPropagation(); onDrop(e, entry.path) } }}
                onClick={(e) => select(index, e.shiftKey ? 'range' : e.metaKey || e.ctrlKey ? 'toggle' : 'replace')}
                onDoubleClick={() => activate(entry)}
                onContextMenu={(e) => openMenu(e, entry, index)}
              >
                <span className="c-name"><span className="ico" aria-hidden>{folder ? '📁' : entry.kind === 'symlink' ? '🔗' : '📄'}</span>{entry.name}</span>
                <span className="c-size">{folder ? '' : formatSize(entry.size)}</span>
                <span className="c-date">{formatDate(entry.mtimeMs)}</span>
              </div>
            )
          })}
        </div>
      </div>

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          entries={buildMenu({ onItems: Boolean(menu.entry), count: menuCount, singleFile: menuCount === 1 && menu.entry !== undefined && !isFolder(menu.entry), remote: p.session?.kind === 'sftp', hasTarget: p.hasTarget, canPaste: p.canPaste })}
          onPick={pick}
          onClose={() => setMenu(null)}
        />
      )}

      <div className="pane-foot">
        {listing ? `${rows.length} item${rows.length === 1 ? '' : 's'}${p.selected.length ? ` · ${p.selected.length} selected` : ''}${listing.truncated ? ' · list truncated' : ''}` : ''}
      </div>
    </div>
  )
}
