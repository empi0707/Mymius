/** A transparent 1x1 picture for `setDragImage`: the browser's own drag picture is hidden, DragGhost draws ours. */
let blank: HTMLImageElement | undefined
export function dragImage(): HTMLImageElement {
  if (!blank) {
    blank = new Image()
    blank.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'
  }
  return blank
}

export interface Ghost {
  x: number
  y: number
  folder: boolean
  count: number
  /** Dropping here would copy (a different server) rather than move: the icon gets a "+" at its bottom right. */
  copy: boolean
}

/** The file icon that follows the pointer while files are dragged. */
export function DragGhost({ ghost }: { ghost: Ghost }): React.JSX.Element {
  return (
    <div className="drag-ghost" style={{ left: ghost.x + 10, top: ghost.y + 10 }} data-testid="drag-ghost" data-mode={ghost.copy ? 'copy' : 'move'} aria-hidden>
      <span className="drag-icon">{ghost.folder ? '📁' : '📄'}</span>
      {ghost.count > 1 && <span className="drag-count" data-testid="drag-count">{ghost.count}</span>}
      {ghost.copy && <span className="drag-plus" data-testid="drag-plus">+</span>}
    </div>
  )
}
