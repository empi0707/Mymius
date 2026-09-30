import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { Channels, type EditInfo, type JobState, type MymiusApi, type TerminalDataEvent, type TerminalExitEvent, type VaultStatus } from '../shared/ipc'

function subscribe<T>(channel: string, listener: (e: T) => void): () => void {
  const handler = (_e: IpcRendererEvent, payload: T): void => listener(payload)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

const api: MymiusApi = {
  appInfo: () => ipcRenderer.invoke(Channels.appInfo),
  pickPrivateKey: () => ipcRenderer.invoke(Channels.pickPrivateKey),
  terminal: {
    open: (req) => ipcRenderer.invoke(Channels.terminalOpen, req),
    write: (id, data) => ipcRenderer.send(Channels.terminalWrite, id, data),
    resize: (id, cols, rows) => ipcRenderer.send(Channels.terminalResize, id, cols, rows),
    ack: (id, bytes) => ipcRenderer.send(Channels.terminalAck, id, bytes),
    close: (id) => ipcRenderer.send(Channels.terminalClose, id),
    onData: (l) => subscribe<TerminalDataEvent>(Channels.terminalData, l),
    onExit: (l) => subscribe<TerminalExitEvent>(Channels.terminalExit, l)
  },
  vault: {
    status: () => ipcRenderer.invoke(Channels.vaultStatus),
    create: (passphrase, remember) => ipcRenderer.invoke(Channels.vaultCreate, passphrase, remember),
    unlock: (passphrase, remember) => ipcRenderer.invoke(Channels.vaultUnlock, passphrase, remember),
    unlockWithRecovery: (key, remember) => ipcRenderer.invoke(Channels.vaultUnlockRecovery, key, remember),
    lock: () => ipcRenderer.invoke(Channels.vaultLock),
    changePassphrase: (p) => ipcRenderer.invoke(Channels.vaultChangePassphrase, p),
    onState: (l) => subscribe<VaultStatus['state']>(Channels.vaultState, l)
  },
  hosts: {
    list: () => ipcRenderer.invoke(Channels.hostsList),
    save: (id, input) => ipcRenderer.invoke(Channels.hostsSave, id, input),
    delete: (id) => ipcRenderer.invoke(Channels.hostsDelete, id)
  },
  keys: {
    list: () => ipcRenderer.invoke(Channels.keysList),
    import: (path, name, passphrase) => ipcRenderer.invoke(Channels.keysImport, path, name, passphrase),
    delete: (id) => ipcRenderer.invoke(Channels.keysDelete, id)
  },
  files: {
    places: () => ipcRenderer.invoke(Channels.filesPlaces),
    connect: (hostId) => ipcRenderer.invoke(Channels.filesConnect, hostId),
    disconnect: (sessionId) => ipcRenderer.invoke(Channels.filesDisconnect, sessionId),
    list: (sessionId, path) => ipcRenderer.invoke(Channels.filesList, sessionId, path),
    mkdir: (sessionId, dir, name) => ipcRenderer.invoke(Channels.filesMkdir, sessionId, dir, name),
    rename: (sessionId, path, newName) => ipcRenderer.invoke(Channels.filesRename, sessionId, path, newName),
    delete: (sessionId, paths) => ipcRenderer.invoke(Channels.filesDelete, sessionId, paths),
    conflicts: (req) => ipcRenderer.invoke(Channels.filesConflicts, req),
    transfer: (req) => ipcRenderer.invoke(Channels.filesTransfer, req),
    cancel: (jobId) => ipcRenderer.invoke(Channels.filesCancel, jobId),
    open: (sessionId, path) => ipcRenderer.invoke(Channels.filesOpen, sessionId, path),
    jobs: () => ipcRenderer.invoke(Channels.filesJobs),
    onJob: (l) => subscribe<JobState>(Channels.filesJob, l),
    sync: {
      compare: (req) => ipcRenderer.invoke(Channels.syncCompare, req),
      preview: (req) => ipcRenderer.invoke(Channels.syncPreview, req),
      run: (req) => ipcRenderer.invoke(Channels.syncRun, req)
    },
    edits: {
      list: () => ipcRenderer.invoke(Channels.editList),
      close: (id, discard) => ipcRenderer.invoke(Channels.editClose, id, discard),
      onEvent: (l) => subscribe<EditInfo>(Channels.editEvent, l)
    }
  }
}

contextBridge.exposeInMainWorld('mymius', api)
