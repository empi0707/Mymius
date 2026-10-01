import type { MenuItemConstructorOptions } from 'electron'

/**
 * The application menu. Electron's default menu binds Cmd/Ctrl+W to "Close Window", so pressing it to close a
 * terminal tab closed the whole app. Here Cmd+W closes the current tab (macOS), and closing the window moves to
 * Shift+Cmd+W. On Windows/Linux Ctrl+W is left alone (the shell's "delete word"), and Ctrl+Shift+W closes the tab,
 * matching the Ctrl+Shift+T that opens one.
 */
export function menuTemplate(mac: boolean, closeTab: () => void): MenuItemConstructorOptions[] {
  const closeTabItem: MenuItemConstructorOptions = {
    id: 'close-tab',
    label: 'Close Tab',
    accelerator: mac ? 'Cmd+W' : 'Ctrl+Shift+W',
    click: closeTab
  }
  const file: MenuItemConstructorOptions = {
    label: 'File',
    submenu: mac
      ? [closeTabItem, { id: 'close-window', role: 'close', accelerator: 'Shift+Cmd+W' }]
      : [closeTabItem, { id: 'close-window', role: 'close', accelerator: 'Alt+F4' }, { type: 'separator' }, { role: 'quit' }]
  }
  return [
    ...(mac ? [{ role: 'appMenu' } as MenuItemConstructorOptions] : []),
    file,
    { role: 'editMenu' },
    { role: 'viewMenu' },
    // The stock window menu would bring back a Close item bound to Cmd/Ctrl+W.
    { label: 'Window', submenu: [{ role: 'minimize' }, ...(mac ? [{ role: 'zoom' } as MenuItemConstructorOptions] : [])] }
  ]
}
