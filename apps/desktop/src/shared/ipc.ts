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
  /** Open a terminal on this computer when the Terminals tab is first shown. */
  autoLocalTerminal: boolean
}

export type OpenAuth =
  | { type: 'password'; password: string }
  | { type: 'key'; keyPath: string; passphrase?: string }
  | { type: 'agent' }

/** Connect to something typed into the form, or to a saved host by id (credentials never reach the UI). */
export type TerminalTarget =
  /** A shell on this computer. */
  | { local: true }
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
  /** Folder the file panes open in after connecting. */
  path?: string
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
  /** Folder the file panes open in after connecting. */
  path?: string
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

export type CloudProvider = 'google' | 'dropbox'

export type DrivePhase = 'not-connected' | 'connecting' | 'idle' | 'syncing' | 'locked' | 'error' | 'needs-auth'

export interface DriveStatus {
  /** A Google OAuth client ID has been provided (without one, nothing can connect). */
  configured: boolean
  phase: DrivePhase
  email?: string
  /** Display name of the signed-in Google account. */
  name?: string
  /** The sign-in credentials come with the app rather than from the user's own Google Cloud project. */
  builtInClient: boolean
  /** A Dropbox app key is available (entered, or shipped with the build). */
  dropboxConfigured: boolean
  builtInDropbox: boolean
  /** Which service the current or pending sign-in is with. */
  provider: CloudProvider
  /** Dropbox sign-in is waiting for the code shown on the Dropbox page. */
  awaitingCode: boolean
  lastSyncAt?: number
  error?: string
  /** When the next automatic retry happens. */
  retryAt?: number
  /** Other devices seen in Google Drive. */
  devices: number
  /** Files skipped because they failed validation. */
  ignored: string[]
}

export interface FileSyncStatus {
  phase: 'off' | 'idle' | 'syncing' | 'locked' | 'error'
  /** The JSON file being kept in step with. */
  path?: string
  lastSyncAt?: number
  error?: string
  /** Other devices' copies found in the file. */
  devices: number
}

export type ImportSourceId = 'ssh-config' | 'forklift'

export interface ImportPreviewItem {
  id: string
  name: string
  host: string
  port: number
  username: string
  group?: string
  /** How it will sign in. */
  auth: 'keyFile' | 'agent'
  /** Name of the host it connects through. */
  jump?: string
  /** A host with the same address, port and user is already in the vault. */
  duplicate: boolean
  /** Fields the file did not give and that were filled in, e.g. "username". */
  assumed: string[]
}

export interface ImportPreview {
  token: string
  source: ImportSourceId
  fileName: string
  items: ImportPreviewItem[]
  skipped: { label: string; reason: string }[]
  warnings: string[]
}

export interface ImportOutcome {
  created: number
  failed: { name: string; error: string }[]
}

export interface AutoBackupStatus {
  enabled: boolean
  /** Where backups are written. */
  dir: string
  /** The person chose this folder (otherwise it is the app's own). */
  customDir: boolean
  lastBackupAt?: number
  lastFile?: string
  error?: string
}

export interface DriveClientSettings {
  clientId: string
  clientSecret?: string
}

export const Channels = {
  appInfo: 'app:info',
  setTheme: 'app:set-theme',
  pickPrivateKey: 'dialog:pick-private-key',
  filesPickFolder: 'files:pick-folder',
  filesAlive: 'files:alive',
  filesPickApp: 'files:pick-app',
  openWithList: 'files:open-with-list',
  openWithRemove: 'files:open-with-remove',
  closeTab: 'menu:close-tab',
  terminalOpen: 'terminal:open',
  terminalWrite: 'terminal:write',
  terminalResize: 'terminal:resize',
  terminalAck: 'terminal:ack',
  terminalClose: 'terminal:close',
  terminalHistory: 'terminal:history',
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
  driveSetDropboxKey: 'drive:set-dropbox-key',
  driveDropboxCode: 'drive:dropbox-code',
  importPreview: 'import:preview',
  importCommit: 'import:commit',
  importCancel: 'import:cancel',
  autoBackupStatus: 'autobackup:status',
  autoBackupEnable: 'autobackup:enable',
  autoBackupFolder: 'autobackup:folder',
  autoBackupReset: 'autobackup:reset',
  autoBackupNow: 'autobackup:now',
  autoBackupStatusEvent: 'autobackup:status-event',
  fileSyncStatus: 'filesync:status',
  fileSyncExport: 'filesync:export',
  fileSyncImport: 'filesync:import',
  fileSyncLink: 'filesync:link',
  fileSyncUnlink: 'filesync:unlink',
  fileSyncNow: 'filesync:now',
  fileSyncStatusEvent: 'filesync:status-event',
  driveStatusEvent: 'drive:status-event'
} as const

export interface HistoryEntry {
  command: string
  /** Unix seconds, when the server's shell recorded it. */
  at?: number
}
export type HistoryResult = { ok: true; entries: HistoryEntry[] } | { ok: false; error: string }

export interface TerminalApi {
  open(req: OpenTerminalRequest): Promise<OpenTerminalResult>
  write(id: string, data: string): void
  resize(id: string, cols: number, rows: number): void
  /** Tell the main process how many output bytes were actually rendered (flow control). */
  ack(id: string, bytes: number): void
  close(id: string): void
  /** Recent commands from the shell history files on the server this terminal is connected to. */
  history(id: string): Promise<HistoryResult>
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

/** The application a file is opened with: the system's default for its type, or a program the person picked. */
export type AppChoice = { kind: 'system' } | { kind: 'app'; path: string; name: string }
/** open: the saved choice for this type of file (or ask). edit: needs a real application. with: always ask. */
export type OpenMode = 'open' | 'edit' | 'with'
export interface OpenOptions {
  mode: OpenMode
  /** The application to use now; without it the saved choice is used, or `how: 'ask'` comes back. */
  app?: AppChoice
  /** Keep `app` for this extension, for every file, or only this time. */
  remember?: 'none' | 'ext' | 'all'
}
export type OpenOutcome = { how: 'opened' | 'editing' } | { how: 'ask'; name: string; ext: string }
/** A saved "open this kind of file with that program" choice. */
export interface OpenAssociation {
  key: string
  label: string
  app: AppChoice
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
  open(sessionId: string, path: string, options?: OpenOptions): Promise<Result<OpenOutcome>>
  /** Native dialog to pick a program. `app` is null when the person cancelled. */
  pickApp(): Promise<{ app: AppChoice | null }>
  openWith: {
    list(): Promise<OpenAssociation[]>
    remove(key: string): Promise<void>
  }
  /** Is this connection still open? (A server can drop it while the pane is not looking.) */
  alive(sessionId: string): Promise<boolean>
  /** Native "choose a folder" dialog (starts in Downloads). `path` is null when the person cancelled. */
  pickFolder(): Promise<{ path: string | null }>
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
   * Sign in with Google in the system browser. With no vault on this device this restores the vault from the
   * account's Google Drive if it has one (it then needs unlocking); if not, the sign-in is kept and syncing starts
   * as soon as a vault is created here. With a vault it turns on syncing.
   */
  connect(provider?: CloudProvider): Promise<Result>
  /** Save the Dropbox app key used to sign in. */
  setDropboxKey(appKey: string): Promise<Result>
  /** Dropbox shows a short code after approval; paste it here to finish signing in. */
  submitDropboxCode(code: string): Promise<Result>
  cancelConnect(): Promise<void>
  /** Sign out. `deleteRemote` also erases the synced data from Google Drive, for every device. */
  disconnect(deleteRemote: boolean): Promise<Result>
  syncNow(): Promise<Result>
  onStatus(listener: (s: DriveStatus) => void): () => void
}

export interface FileSyncApi {
  status(): Promise<FileSyncStatus>
  /** Save an encrypted copy of the vault as a .json file. `error` is empty when the person cancelled. */
  exportBackup(): Promise<Result>
  /** Bring in a .json backup or sync file: sets up a device that has no vault, or merges into an unlocked one. */
  importBackup(): Promise<Result>
  /** Keep syncing with a .json file in any folder (iCloud Drive, Dropbox, a NAS...). No account needed. */
  link(mode: 'create' | 'existing'): Promise<Result>
  unlink(): Promise<Result>
  syncNow(): Promise<Result>
  onStatus(listener: (s: FileSyncStatus) => void): () => void
}

export interface ImportApi {
  /** Asks for a file with a native dialog and reads it in the main process. `error` is empty when cancelled. */
  preview(source: ImportSourceId): Promise<Result<{ preview: ImportPreview }>>
  /** Adds the chosen items (by id) to the vault. */
  commit(token: string, ids: string[]): Promise<Result<{ outcome: ImportOutcome }>>
  cancel(token: string): Promise<void>
}

export interface AutoBackupApi {
  status(): Promise<AutoBackupStatus>
  /** A backup is written each time a new host appears. */
  setEnabled(enabled: boolean): Promise<Result>
  /** Pick the folder backups go to. `error` is empty when the person cancelled. */
  chooseFolder(): Promise<Result>
  /** Go back to the app's own folder. */
  resetFolder(): Promise<Result>
  backupNow(): Promise<Result>
  onStatus(listener: (s: AutoBackupStatus) => void): () => void
}

export interface MymiusApi {
  appInfo(): Promise<AppInfo>
  /** Makes native dialogs and menus follow the chosen appearance. */
  setTheme(theme: 'system' | 'light' | 'dark'): Promise<void>
  /** Native file picker for a private key; null when cancelled. */
  pickPrivateKey(): Promise<string | null>
  /** The path of a file the person dragged into the window from Finder / Explorer ('' when it has none). */
  pathForFile(file: File): string
  /** The Close Tab menu item (Cmd+W, or Ctrl+Shift+W on Windows/Linux) was used. */
  onCloseTab(listener: () => void): () => void
  terminal: TerminalApi
  vault: VaultApi
  hosts: HostsApi
  keys: KeysApi
  files: FilesApi
  drive: DriveApi
  fileSync: FileSyncApi
  autoBackup: AutoBackupApi
  importer: ImportApi
}
