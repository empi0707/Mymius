import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, nativeTheme, safeStorage, shell } from 'electron'
import { homedir } from 'node:os'
import { defaultSshAgent } from '@mymius/platform'
import { VaultStore } from '@mymius/vault'
import { Channels, type AppInfo, type OS } from '../shared/ipc'
import { ConnectionBroker } from './connections'
import { DriveSyncService } from './drive-service'
import { FileSyncService } from './file-sync-service'
import { FilesService } from './files'
import { OsSecretStore } from './secret-store'
import { TerminalService } from './terminals'
import { VaultService } from './vault-service'

const isMac = process.platform === 'darwin'

interface DriveEndpoints { authEndpoint?: string; tokenEndpoint?: string; revokeEndpoint?: string; baseUrl?: string }

let terminals: TerminalService
let fileService: FilesService
let driveService: DriveSyncService
let fileSyncService: FileSyncService
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
  win.on('closed', () => {
    terminals.closeOwnedBy(id)
    void fileService.closeOwnedBy(id)
  })

  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))
  return win
}

function registerIpc(): void {
  ipcMain.handle(Channels.setTheme, (_e, theme: unknown) => {
    if (theme === 'system' || theme === 'light' || theme === 'dark') nativeTheme.themeSource = theme
  })
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

  // The file manager.
  ipcMain.handle(Channels.filesPlaces, () => fileService.places())
  ipcMain.handle(Channels.filesConnect, (e, hostId: unknown) => fileService.connect(e.sender.id, hostId))
  ipcMain.handle(Channels.filesDisconnect, (e, id: unknown) => fileService.disconnect(e.sender.id, id))
  ipcMain.handle(Channels.filesList, (e, id: unknown, path: unknown) => fileService.list(e.sender.id, id, path))
  ipcMain.handle(Channels.filesMkdir, (e, id: unknown, dir: unknown, name: unknown) => fileService.mkdir(e.sender.id, id, dir, name))
  ipcMain.handle(Channels.filesRename, (e, id: unknown, path: unknown, name: unknown) => fileService.rename(e.sender.id, id, path, name))
  ipcMain.handle(Channels.filesDelete, (e, id: unknown, paths: unknown) => fileService.delete(e.sender.id, id, paths))
  ipcMain.handle(Channels.filesConflicts, (e, req: unknown) => fileService.conflicts(e.sender.id, req))
  ipcMain.handle(Channels.filesTransfer, (e, req: unknown) => fileService.transfer(e.sender.id, req))
  ipcMain.handle(Channels.filesCancel, (e, jobId: unknown) => fileService.cancel(e.sender.id, jobId))
  ipcMain.handle(Channels.filesOpen, (e, id: unknown, path: unknown) => fileService.open(e.sender.id, id, path))
  ipcMain.handle(Channels.filesJobs, (e) => fileService.listJobs(e.sender.id))
  ipcMain.handle(Channels.syncCompare, (e, req: unknown) => fileService.syncCompare(e.sender.id, req))
  ipcMain.handle(Channels.syncPreview, (e, req: unknown) => fileService.syncPreview(e.sender.id, req))
  ipcMain.handle(Channels.syncRun, (e, req: unknown) => fileService.syncRun(e.sender.id, req))
  ipcMain.handle(Channels.editList, (e) => fileService.listEdits(e.sender.id))
  ipcMain.handle(Channels.editClose, (e, id: unknown, discard: unknown) => fileService.closeEdit(e.sender.id, id, discard))

  // Google Drive sync.
  ipcMain.handle(Channels.driveStatus, () => driveService.status())
  ipcMain.handle(Channels.driveSetClient, (_e, settings: unknown) => driveService.setClient(settings))
  ipcMain.handle(Channels.driveConnect, () => driveService.connect())
  ipcMain.handle(Channels.driveCancel, () => driveService.cancelConnect())
  ipcMain.handle(Channels.driveDisconnect, (_e, deleteRemote: unknown) => driveService.disconnect(deleteRemote === true))
  ipcMain.handle(Channels.driveSyncNow, () => driveService.syncNow())

  // JSON file sync, backup and restore.
  ipcMain.handle(Channels.fileSyncStatus, () => fileSyncService.status())
  ipcMain.handle(Channels.fileSyncExport, () => fileSyncService.exportBackup())
  ipcMain.handle(Channels.fileSyncImport, () => fileSyncService.importBackup())
  ipcMain.handle(Channels.fileSyncLink, (_e, mode: unknown) => (mode === 'create' || mode === 'existing' ? fileSyncService.link(mode) : { ok: false, error: 'Invalid request' }))
  ipcMain.handle(Channels.fileSyncUnlink, () => fileSyncService.unlink())
  ipcMain.handle(Channels.fileSyncNow, () => fileSyncService.syncNow())

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
  // Hosts and keys can change without the user touching them (a sync merged another device's edits).
  store.on('changed', () => {
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send(Channels.vaultChanged)
  })
  await store.tryAutoUnlock().catch(() => false) // a damaged file is reported through vault.status() instead

  // Only the e2e build may talk to a stand-in for Google; a real build ignores this variable entirely.
  const fake: DriveEndpoints | undefined = import.meta.env.MODE === 'e2e' && process.env.MYMIUS_E2E_GOOGLE ? (JSON.parse(process.env.MYMIUS_E2E_GOOGLE) as DriveEndpoints) : undefined
  driveService = new DriveSyncService(
    {
      settingsFile: join(userData, 'drive-settings.json'),
      ...(import.meta.env.MAIN_VITE_GOOGLE_CLIENT_ID ? { defaultClient: { clientId: import.meta.env.MAIN_VITE_GOOGLE_CLIENT_ID, ...(import.meta.env.MAIN_VITE_GOOGLE_CLIENT_SECRET ? { clientSecret: import.meta.env.MAIN_VITE_GOOGLE_CLIENT_SECRET } : {}) } } : {}),
      openExternal: (url) => shell.openExternal(url),
      emitStatus: (status) => { for (const w of BrowserWindow.getAllWindows()) w.webContents.send(Channels.driveStatusEvent, status) },
      ...(fake ? { allowInsecureHttp: true, endpoints: fake, intervalMs: 500, debounceMs: 100 } : {})
    },
    store
  )
  await driveService.init()

  // The e2e build cannot click a native dialog, so it may name the path in advance; a real build ignores this.
  const e2ePath: string | undefined = import.meta.env.MODE === 'e2e' ? process.env.MYMIUS_E2E_FILE_PICK : undefined
  fileSyncService = new FileSyncService(
    {
      pick: async (kind, suggestedName) => {
        if (e2ePath) return e2ePath
        const win = BrowserWindow.getFocusedWindow() ?? undefined
        const filters = [{ name: 'Mymius sync file (JSON)', extensions: ['json'] }]
        if (kind === 'save') {
          const r = await (win ? dialog.showSaveDialog(win, { defaultPath: suggestedName, filters }) : dialog.showSaveDialog({ defaultPath: suggestedName, filters }))
          return r.canceled ? undefined : r.filePath
        }
        const r = await (win ? dialog.showOpenDialog(win, { properties: ['openFile'], filters }) : dialog.showOpenDialog({ properties: ['openFile'], filters }))
        return r.canceled ? undefined : r.filePaths[0]
      },
      emitStatus: (status) => { for (const w of BrowserWindow.getAllWindows()) w.webContents.send(Channels.fileSyncStatusEvent, status) },
      ...(e2ePath ? { intervalMs: 300, debounceMs: 100 } : {})
    },
    store
  )
  await fileSyncService.init()

  const broker = new ConnectionBroker(
    {
      knownHostsFile: join(userData, 'known_hosts.json'),
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
      }
    },
    vault.lookup
  )
  terminals = new TerminalService(
    {
      sendData: (target, e) => webContentsById(target)?.send(Channels.terminalData, e),
      sendExit: (target, e) => webContentsById(target)?.send(Channels.terminalExit, e)
    },
    broker,
    vault.lookup
  )
  fileService = new FilesService(
    {
      home: homedir(),
      workRoot: join(app.getPath('userData'), 'remote-edit'),
      trashItem: (p) => shell.trashItem(p),
      openLocal: async (p) => {
        const err = await shell.openPath(p)
        if (err) throw new Error(err)
      },
      confirmEditConflict: async (ctx) => {
        const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
        const options = {
          type: 'warning' as const,
          buttons: ['Cancel', 'Overwrite the server file', 'Reload from the server'],
          defaultId: 0, // Enter must not silently overwrite someone else's change
          cancelId: 0,
          title: ctx.kind === 'deleted' ? 'File deleted on the server' : 'File changed on the server',
          message:
            ctx.kind === 'deleted'
              ? `${ctx.remotePath} no longer exists on the server.`
              : `${ctx.remotePath} was changed on the server after you opened it.`,
          detail:
            ctx.kind === 'deleted'
              ? 'Overwrite recreates it from your copy. Cancel keeps your copy here without uploading.'
              : 'Overwrite replaces the server file with your version. Reload takes the server version and keeps your edits in a separate file next to your copy. Cancel uploads nothing.'
        }
        // A deleted file has nothing to reload, so that button is not offered.
        if (ctx.kind === 'deleted') options.buttons = ['Cancel', 'Recreate the server file']
        const r = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options)
        return r.response === 1 ? 'overwrite' : r.response === 2 ? 'reload' : 'cancel'
      },
      emitJob: (target, job) => webContentsById(target)?.send(Channels.filesJob, job),
      emitEdit: (target, e) => webContentsById(target)?.send(Channels.editEvent, e)
    },
    broker,
    vault.lookup
  )
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
