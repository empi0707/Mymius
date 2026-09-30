/**
 * The only surface the renderer can reach the main process through.
 * Every new capability is added here first (channel name + typed request/response),
 * so the renderer stays sandboxed and the contract is reviewable in one place.
 */
export type OS = 'darwin' | 'win32' | 'linux'

export interface AppInfo {
  name: string
  version: string
  os: OS
  arch: string
  /** True when secrets can be stored in the OS keychain (false on Linux without libsecret/kwallet). */
  secureStorage: boolean
}

export const Channels = {
  appInfo: 'app:info'
} as const

export interface MymiusApi {
  appInfo(): Promise<AppInfo>
}
