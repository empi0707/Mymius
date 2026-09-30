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

export type OpenAuth =
  | { type: 'password'; password: string }
  | { type: 'key'; keyPath: string; passphrase?: string }
  | { type: 'agent' }

export interface OpenTerminalRequest {
  host: string
  port: number
  username: string
  auth: OpenAuth
  cols: number
  rows: number
}

export type OpenTerminalResult = { ok: true; id: string } | { ok: false; error: string }

export interface TerminalDataEvent {
  id: string
  data: Uint8Array
}

export interface TerminalExitEvent {
  id: string
  code?: number
  signal?: string
  /** Human-readable reason when the connection failed rather than the shell exiting. */
  error?: string
}

export const Channels = {
  appInfo: 'app:info',
  pickPrivateKey: 'dialog:pick-private-key',
  terminalOpen: 'terminal:open',
  terminalWrite: 'terminal:write',
  terminalResize: 'terminal:resize',
  terminalAck: 'terminal:ack',
  terminalClose: 'terminal:close',
  terminalData: 'terminal:data',
  terminalExit: 'terminal:exit'
} as const

export interface TerminalApi {
  open(req: OpenTerminalRequest): Promise<OpenTerminalResult>
  write(id: string, data: string): void
  resize(id: string, cols: number, rows: number): void
  /** Tell the main process how many output bytes were actually rendered (flow control). */
  ack(id: string, bytes: number): void
  close(id: string): void
  onData(listener: (e: TerminalDataEvent) => void): () => void
  onExit(listener: (e: TerminalExitEvent) => void): () => void
}

export interface MymiusApi {
  appInfo(): Promise<AppInfo>
  /** Native file picker for a private key; null when cancelled. */
  pickPrivateKey(): Promise<string | null>
  terminal: TerminalApi
}
