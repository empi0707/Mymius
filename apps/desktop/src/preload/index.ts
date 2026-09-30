import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { Channels, type MymiusApi, type TerminalDataEvent, type TerminalExitEvent } from '../shared/ipc'

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
  }
}

contextBridge.exposeInMainWorld('mymius', api)
