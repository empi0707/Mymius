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

// ---- file manager ---------------------------------------------------------------------------------

export type FsEntryKind = 'file' | 'directory' | 'symlink' | 'other'

export interface FsEntry {
  name: string
  path: string
  kind: FsEntryKind
  size: number
  mtimeMs: number | null
  /** For links: what they point at, so the UI knows whether it can open them as a folder. */
  targetKind?: FsEntryKind | 'broken'
}

export interface FsCrumb {
  name: string
  path: string
}

export interface FsListing {
  sessionId: string
  /** The canonical path that was actually listed. */
  path: string
  parent: string | null
  crumbs: FsCrumb[]
  entries: FsEntry[]
  /** More entries exist than were returned. */
  truncated: boolean
}

export interface FsSessionInfo {
  id: string
  label: string
  kind: 'local' | 'sftp'
  home: string
  /** The path separator of this file system, for building paths in the UI. */
  sep: '/' | '\\'
  hostId?: string
}

export interface FsPlace {
  name: string
  path: string
}

export type ConflictPolicy = 'overwrite' | 'skip' | 'keep-both'

export interface TransferRequest {
  fromSession: string
  paths: string[]
  toSession: string
  toDir: string
  mode: 'copy' | 'move'
  policy: ConflictPolicy
}

export interface JobIssue {
  path: string
  message: string
}

export interface JobState {
  id: string
  kind: 'copy' | 'move' | 'delete' | 'sync'
  label: string
  state: 'running' | 'done' | 'cancelled' | 'failed'
  filesDone: number
  filesTotal: number
  bytesDone: number
  bytesTotal: number
  current?: string
  errors: JobIssue[]
  /** One-line outcome, e.g. "12 files copied, 2 skipped". */
  summary?: string
}

export type SyncMode = 'mirror-ltr' | 'mirror-rtl' | 'two-way'
export type SyncDirection = 'ltr' | 'rtl' | 'skip'
export type SyncStatus = 'same' | 'left-only' | 'right-only' | 'left-newer' | 'right-newer' | 'different' | 'type-mismatch'

export interface SyncEndpoint {
  sessionId: string
  path: string
}

export interface SyncCompareRequest {
  left: SyncEndpoint
  right: SyncEndpoint
  compare: 'quick' | 'hash'
  ignore: string[]
}

export interface SyncItem {
  rel: string
  status: SyncStatus
  kind: FsEntryKind
  leftSize?: number
  rightSize?: number
  leftMtimeMs?: number | null
  rightMtimeMs?: number | null
}

export interface SyncCompareResult {
  compareId: string
  items: SyncItem[]
  scanErrors: string[]
  /** More items exist than were sent. */
  truncated: boolean
}

export interface SyncPlanRequest {
  compareId: string
  mode: SyncMode
  deleteExtras: boolean
  /** The arrows the user changed by hand, by relative path. */
  overrides: Record<string, SyncDirection>
}

export interface SyncSummary {
  copies: number
  mkdirs: number
  deletes: number
  bytes: number
  conflicts: number
}

export interface SyncPreview {
  directions: Record<string, SyncDirection>
  summary: SyncSummary
}

export type EditState = 'opening' | 'synced' | 'uploading' | 'unsynced' | 'conflict' | 'error' | 'closed'

export interface EditInfo {
  id: string
  name: string
  remotePath: string
  hostLabel: string
  state: EditState
  message?: string
}

// ---- Google Drive sync -----------------------------------------------------------------------------

export type DrivePhase = 'not-connected' | 'connecting' | 'idle' | 'syncing' | 'locked' | 'error' | 'needs-auth'

export interface DriveStatus {
  /** A Google OAuth client ID has been provided (without one, nothing can connect). */
  configured: boolean
  phase: DrivePhase
  email?: string
  lastSyncAt?: number
  error?: string
  /** When the next automatic retry happens. */
  retryAt?: number
  /** Other devices seen in Google Drive. */
  devices: number
  /** Files skipped because they failed validation. */
  ignored: string[]
}

export interface DriveClientSettings {
  clientId: string
  clientSecret?: string
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
  vaultChanged: 'vault:changed',
  hostsList: 'hosts:list',
  hostsSave: 'hosts:save',
  hostsDelete: 'hosts:delete',
  keysList: 'keys:list',
  keysImport: 'keys:import',
  keysDelete: 'keys:delete',
  filesPlaces: 'files:places',
  filesConnect: 'files:connect',
  filesDisconnect: 'files:disconnect',
  filesList: 'files:list',
  filesMkdir: 'files:mkdir',
  filesRename: 'files:rename',
  filesDelete: 'files:delete',
  filesConflicts: 'files:conflicts',
  filesTransfer: 'files:transfer',
  filesCancel: 'files:cancel',
  filesOpen: 'files:open',
  filesJobs: 'files:jobs',
  filesJob: 'files:job',
  syncCompare: 'sync:compare',
  syncPreview: 'sync:preview',
  syncRun: 'sync:run',
  editList: 'edit:list',
  editClose: 'edit:close',
  editEvent: 'edit:event',
  driveStatus: 'drive:status',
  driveSetClient: 'drive:set-client',
  driveConnect: 'drive:connect',
  driveCancel: 'drive:cancel',
  driveDisconnect: 'drive:disconnect',
  driveSyncNow: 'drive:sync-now',
  driveStatusEvent: 'drive:status-event'
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
  /** Fires when hosts or keys changed, including changes that arrived from another device through sync. */
  onChanged(listener: () => void): () => void
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

export interface FilesApi {
  places(): Promise<Result<{ session: FsSessionInfo; places: FsPlace[] }>>
  connect(hostId: string): Promise<Result<{ session: FsSessionInfo }>>
  disconnect(sessionId: string): Promise<void>
  list(sessionId: string, path?: string): Promise<Result<{ listing: FsListing }>>
  mkdir(sessionId: string, dir: string, name: string): Promise<Result>
  rename(sessionId: string, path: string, newName: string): Promise<Result>
  delete(sessionId: string, paths: string[]): Promise<Result<{ jobId: string }>>
  /** Names in the destination that already exist, so the UI can ask what to do first. */
  conflicts(req: Omit<TransferRequest, 'policy' | 'mode'>): Promise<Result<{ names: string[] }>>
  transfer(req: TransferRequest): Promise<Result<{ jobId: string }>>
  cancel(jobId: string): Promise<void>
  /** Local file: open with the system app. Remote file: edit it here and upload on every save. */
  open(sessionId: string, path: string): Promise<Result<{ how: 'opened' | 'editing' }>>
  jobs(): Promise<JobState[]>
  onJob(listener: (job: JobState) => void): () => void
  sync: {
    compare(req: SyncCompareRequest): Promise<Result<SyncCompareResult>>
    preview(req: SyncPlanRequest): Promise<Result<{ preview: SyncPreview }>>
    run(req: SyncPlanRequest): Promise<Result<{ jobId: string }>>
  }
  edits: {
    list(): Promise<EditInfo[]>
    close(id: string, discard: boolean): Promise<void>
    onEvent(listener: (e: EditInfo) => void): () => void
  }
}

export interface DriveApi {
  status(): Promise<DriveStatus>
  /** Save the OAuth client ID (and secret, which Google issues for desktop clients) used to sign in. */
  setClient(settings: DriveClientSettings): Promise<Result>
  /**
   * Sign in with Google in the system browser. With no vault on this device this restores the vault
   * from Google Drive (it then needs unlocking); otherwise it turns on syncing.
   */
  connect(): Promise<Result>
  cancelConnect(): Promise<void>
  /** Sign out. `deleteRemote` also erases the synced data from Google Drive, for every device. */
  disconnect(deleteRemote: boolean): Promise<Result>
  syncNow(): Promise<Result>
  onStatus(listener: (s: DriveStatus) => void): () => void
}

export interface MymiusApi {
  appInfo(): Promise<AppInfo>
  /** Native file picker for a private key; null when cancelled. */
  pickPrivateKey(): Promise<string | null>
  terminal: TerminalApi
  vault: VaultApi
  hosts: HostsApi
  keys: KeysApi
  files: FilesApi
  drive: DriveApi
}
