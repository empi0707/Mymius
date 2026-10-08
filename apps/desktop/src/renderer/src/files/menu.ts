export type MenuAction = 'open' | 'edit' | 'openWith' | 'clipCopy' | 'clipCut' | 'clipPaste' | 'download' | 'copy' | 'move' | 'rename' | 'delete' | 'copyPath' | 'newFolder' | 'refresh' | 'selectAll'

export type MenuEntry<A extends string = MenuAction> =
  | { separator: true }
  | { separator?: false; action: A; label: string; hint?: string; danger?: boolean; disabled?: boolean }

export interface MenuContext {
  /** Right-clicked on a file/folder (true) or on the empty space of the list (false). */
  onItems: boolean
  /** How many entries the menu acts on. */
  count: number
  /** The menu is for a single file (not a folder, not several items): only then can it be edited or opened with a chosen program. */
  singleFile: boolean
  /** The pane shows a server (SFTP), so there is something to download. */
  remote: boolean
  /** Something was copied or cut in the file manager and can be pasted here. */
  canPaste: boolean
  /** The other pane is ready to receive copies. */
  hasTarget: boolean
}

const SEP: MenuEntry = { separator: true }
const mod = (): string => (typeof navigator !== 'undefined' && navigator.platform.startsWith('Mac') ? '⌘' : 'Ctrl+')

/** What the right-click menu offers. Pure, so it can be tested without a window. */
export function buildMenu(c: MenuContext): MenuEntry[] {
  if (!c.onItems) {
    return [
      { action: 'clipPaste', label: 'Paste', hint: `${mod()}V`, disabled: !c.canPaste },
      SEP,
      { action: 'newFolder', label: 'New folder', hint: 'F7' },
      { action: 'refresh', label: 'Refresh', hint: `${mod()}R` },
      SEP,
      { action: 'selectAll', label: 'Select all', hint: `${mod()}A` }
    ]
  }
  const many = c.count > 1
  const things = many ? `${c.count} items` : ''
  return [
    { action: 'open', label: 'Open', hint: 'Enter', disabled: many },
    { action: 'edit', label: 'Edit', hint: 'F4', disabled: !c.singleFile },
    { action: 'openWith', label: 'Open with…', disabled: !c.singleFile },
    ...(c.remote ? [SEP, { action: 'download', label: many ? `Download ${things}…` : 'Download…' } as MenuEntry] : []),
    SEP,
    { action: 'clipCopy', label: many ? `Copy ${things}` : 'Copy', hint: `${mod()}C` },
    { action: 'clipCut', label: many ? `Cut ${things}` : 'Cut', hint: `${mod()}X` },
    { action: 'clipPaste', label: 'Paste', hint: `${mod()}V`, disabled: !c.canPaste },
    SEP,
    { action: 'copy', label: many ? `Copy ${things} to other pane` : 'Copy to other pane', hint: 'F5', disabled: !c.hasTarget },
    { action: 'move', label: many ? `Move ${things} to other pane` : 'Move to other pane', hint: 'F6', disabled: !c.hasTarget },
    SEP,
    { action: 'rename', label: 'Rename', hint: 'F2', disabled: many },
    { action: 'copyPath', label: many ? 'Copy paths' : 'Copy path' },
    SEP,
    { action: 'delete', label: many ? `Delete ${things}` : 'Delete', hint: 'F8', danger: true },
    SEP,
    { action: 'newFolder', label: 'New folder', hint: 'F7' },
    { action: 'refresh', label: 'Refresh', hint: `${mod()}R` }
  ]
}
