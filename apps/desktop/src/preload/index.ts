import { contextBridge, ipcRenderer } from 'electron'
import { Channels, type MymiusApi } from '../shared/ipc'

const api: MymiusApi = {
  appInfo: () => ipcRenderer.invoke(Channels.appInfo)
}

contextBridge.exposeInMainWorld('mymius', api)
