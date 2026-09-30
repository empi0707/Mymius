import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } from 'electron'
import { defaultSshAgent } from '@mymius/platform'
import { VaultStore } from '@mymius/vault'
import { Channels, type AppInfo, type OS } from '../shared/ipc'
import { OsSecretStore } from './secret-store'
import { TerminalService } from './terminals'
import { VaultService } from './vault-service'

const isMac = process.platform === 'darwin'

let terminals: TerminalService
let vault: VaultService
let osKeychain = false

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 560,
    show: false,
    // macOS: traffic lights inset into our own title bar. Windows/Linux keep the native frame for now.
    ...(isMac ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 14, y: 14 } } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  win.once('ready-to-show', () => win.show())

  // The renderer only ever shows our own UI. Links clicked in a terminal open in the user's browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== win.webContents.getURL()) e.preventDefault()
  })

  const id = win.webContents.id
  win.on('closed', () => terminals.closeOwnedBy(id))

  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))
  return win
}

function registerIpc(): void {
  ipcMain.handle(Channels.appInfo, (): AppInfo => ({
    name: app.getName(),
    version: app.getVersion(),
    os: process.platform as OS,
    arch: process.arch,
    secureStorage: osKeychain
  }))

  ipcMain.handle(Channels.pickPrivateKey, async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const options = { title: 'Choose a private key', properties: ['openFile', 'showHiddenFiles'] as ('openFile' | 'showHiddenFiles')[] }
    const r = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    return r.canceled ? null : (r.filePaths[0] ?? null)
  })

  // The vault: secrets go in, redacted summaries come out.
  ipcMain.handle(Channels.vaultStatus, () => vault.status())
  ipcMain.handle(Channels.vaultCreate, (_e, pass: unknown, remember: unknown) => vault.create(pass, remember))
  ipcMain.handle(Channels.vaultUnlock, (_e, pass: unknown, remember: unknown) => vault.unlock(pass, remember))
  ipcMain.handle(Channels.vaultUnlockRecovery, (_e, key: unknown, remember: unknown) => vault.unlockWithRecovery(key, remember))
  ipcMain.handle(Channels.vaultLock, () => vault.lock())
  ipcMain.handle(Channels.vaultChangePassphrase, (_e, pass: unknown) => vault.changePassphrase(pass))
  ipcMain.handle(Channels.hostsList, () => vault.listHosts())
  ipcMain.handle(Channels.hostsSave, (_e, id: unknown, input: unknown) => vault.saveHost(id, input))
  ipcMain.handle(Channels.hostsDelete, (_e, id: unknown) => vault.deleteHost(id))
  ipcMain.handle(Channels.keysList, () => vault.listKeys())
  ipcMain.handle(Channels.keysImport, (_e, path: unknown, name: unknown, pass: unknown) => vault.importKey(path, name, pass))
  ipcMain.handle(Channels.keysDelete, (_e, id: unknown) => vault.deleteKey(id))

  ipcMain.handle(Channels.terminalOpen, (e, req: unknown) => terminals.open(e.sender.id, req))
  ipcMain.on(Channels.terminalWrite, (e, id: unknown, data: unknown) => terminals.write(e.sender.id, id, data))
  ipcMain.on(Channels.terminalResize, (e, id: unknown, c: unknown, r: unknown) => terminals.resize(e.sender.id, id, c, r))
  ipcMain.on(Channels.terminalAck, (e, id: unknown, n: unknown) => terminals.ack(e.sender.id, id, n))
  ipcMain.on(Channels.terminalClose, (e, id: unknown) => terminals.close(e.sender.id, id))
}

/**
 * Is there an OS keychain we would trust with the vault key? On Linux without a desktop keyring
 * Electron falls back to a fixed built-in key ("basic_text"), which protects nothing.
 */
function keychainIsStrong(): boolean {
  if (!safeStorage.isEncryptionAvailable()) return false
  return process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text'
}

void app.whenReady().then(async () => {
  const userData = app.getPath('userData')
  osKeychain = keychainIsStrong()
  const secrets = osKeychain
    ? new OsSecretStore(join(userData, 'secrets.json'), {
        encrypt: (s) => safeStorage.encryptString(s),
        decrypt: (b) => safeStorage.decryptString(b)
      })
    : undefined
  const store = new VaultStore(join(userData, 'vault.json'), { ...(secrets ? { secrets } : {}), autoLockMs: 15 * 60_000 })
  vault = new VaultService(store, { readTextFile: (p) => readFile(p, 'utf8'), agentSocket: () => defaultSshAgent() })
  store.on('state', (state: string) => {
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send(Channels.vaultState, state)
  })
  await store.tryAutoUnlock().catch(() => false) // a damaged file is reported through vault.status() instead

  terminals = new TerminalService({
    knownHostsFile: join(app.getPath('userData'), 'known_hosts.json'),
    confirmHostKey: async (info) => {
      const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
      const options = {
        type: 'question' as const,
        buttons: ['Cancel', 'Trust and connect'],
        defaultId: 0, // Enter must not accept an unverified host
        cancelId: 0,
        title: 'Unknown host',
        message: `The authenticity of ${info.host}${info.port === 22 ? '' : `:${info.port}`} can't be established.`,
        detail: `Key fingerprint:\n${info.fingerprint}\n\nOnly continue if you recognise this fingerprint.`
      }
      const r = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options)
      return r.response === 1
    },
    sendData: (target, e) => webContentsById(target)?.send(Channels.terminalData, e),
    sendExit: (target, e) => webContentsById(target)?.send(Channels.terminalExit, e)
  }, vault.lookup)
  registerIpc()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

function webContentsById(id: number): Electron.WebContents | undefined {
  return BrowserWindow.getAllWindows().find((w) => w.webContents.id === id)?.webContents
}

app.on('before-quit', () => terminals?.closeAll())

// macOS apps stay alive without windows; everywhere else closing the last window quits.
app.on('window-all-closed', () => {
  if (!isMac) app.quit()
})
