import type { MymiusApi } from '../shared/ipc'

declare global {
  interface Window {
    mymius: MymiusApi
  }
}
export {}
