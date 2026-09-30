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

/** Connect to something typed into the form, or to a saved host by id (credentials never reach the UI). */
export type TerminalTarget =
  | { hostId: string }
  | { host: string; port: number; username: string; auth: OpenAuth }

export type OpenTerminalRequest = TerminalTarget & { cols: number; rows: number }

export type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string }

export interface VaultStatus {
  state: 'uninitialized' | 'locked' | 'unlocked' | 'damaged'
  error?: string
  /** This machine has an OS keychain that can hold the key ("remember on this device"). */
  canRemember: boolean
  remembered: boolean
}

export type HostAuthType = 'password' | 'key' | 'keyFile' | 'agent'

/** A saved host as the UI sees it: everything except the secrets. */
export interface HostSummary {
  id: string
  name: string
  host: string
  port: number
  username: string
  authType: HostAuthType
  keyName?: string
  group?: string
  jumpHostId?: string
  notes?: string
}

/** What the UI submits. A missing secret means "keep what is stored". */
export interface HostInput {
  name: string
  host: string
  port: number
  username: string
  auth:
    | { type: 'password'; password?: string }
    | { type: 'key'; keyId: string }
    | { type: 'keyFile'; path: string; passphrase?: string }
    | { type: 'agent' }
  group?: string
  jumpHostId?: string
  notes?: string
}

export interface KeySummary {
  id: string
  name: string
  fingerprint?: string
  hasPassphrase: boolean
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
  terminalExit: 'terminal:exit',
  vaultStatus: 'vault:status',
  vaultCreate: 'vault:create',
  vaultUnlock: 'vault:unlock',
  vaultUnlockRecovery: 'vault:unlock-recovery',
  vaultLock: 'vault:lock',
  vaultChangePassphrase: 'vault:change-passphrase',
  vaultState: 'vault:state',
  hostsList: 'hosts:list',
  hostsSave: 'hosts:save',
  hostsDelete: 'hosts:delete',
  keysList: 'keys:list',
  keysImport: 'keys:import',
  keysDelete: 'keys:delete'
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

export interface VaultApi {
  status(): Promise<VaultStatus>
  create(passphrase: string, remember: boolean): Promise<Result<{ recoveryKey: string }>>
  unlock(passphrase: string, remember: boolean): Promise<Result>
  unlockWithRecovery(recoveryKey: string, remember: boolean): Promise<Result>
  lock(): Promise<void>
  changePassphrase(newPassphrase: string): Promise<Result>
  /** Fires when the vault locks or unlocks (including auto-lock). */
  onState(listener: (state: VaultStatus['state']) => void): () => void
}

export interface HostsApi {
  list(): Promise<Result<{ hosts: HostSummary[] }>>
  save(id: string | undefined, input: HostInput): Promise<Result<{ id: string }>>
  delete(id: string): Promise<Result>
}

export interface KeysApi {
  list(): Promise<Result<{ keys: KeySummary[] }>>
  /** The main process reads the file itself; key text never passes through the UI. */
  import(path: string, name: string, passphrase: string): Promise<Result<{ key: KeySummary }>>
  delete(id: string): Promise<Result>
}

export interface MymiusApi {
  appInfo(): Promise<AppInfo>
  /** Native file picker for a private key; null when cancelled. */
  pickPrivateKey(): Promise<string | null>
  terminal: TerminalApi
  vault: VaultApi
  hosts: HostsApi
  keys: KeysApi
}
