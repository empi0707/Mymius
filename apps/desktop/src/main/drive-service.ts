import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  AuthSession, DriveClient, DriveSync, NoRemoteVaultError, authorize, restoreVault, revoke,
  type OAuthConfig, type StateStorage, type SyncState, type Tokens
} from '@mymius/drive-sync'
import type { VaultStore } from '@mymius/vault'
import type { DriveClientSettings, DriveStatus, Result } from '../shared/ipc'

export interface DriveHost {
  /** Where the OAuth client ID is kept. It is configuration, not a secret. */
  settingsFile: string
  /** Credentials shipped with the build; used when the user has not entered their own. */
  defaultClient?: DriveClientSettings
  /** Show a URL in the user's own browser. */
  openExternal(url: string): Promise<void>
  emitStatus(status: DriveStatus): void
  /** Only tests and the e2e build talk to a fake Google over http; a real build refuses to. */
  allowInsecureHttp?: boolean
  /** Point at a fake Google. Never set in a real build. */
  endpoints?: { authEndpoint?: string; tokenEndpoint?: string; revokeEndpoint?: string; baseUrl?: string }
  intervalMs?: number
  debounceMs?: number
}

const TOKENS = 'drive-tokens'
const SYNC_STATE = 'drive-sync-state'

const NOT_CONFIGURED = 'Hãy nhập Google client ID trước (xem hướng dẫn cài đặt)'

function friendly(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Turns Google Drive syncing on and off for the app: the browser sign-in, keeping the credentials, starting
 * the background sync when the vault is unlocked, and restoring a vault onto a new device. Credentials live
 * in the vault's device-local sealed area, so they are protected by the vault key and never synced.
 */
export class DriveSyncService {
  private settings: DriveClientSettings | undefined
  private engine: DriveSync | undefined
  private auth: AuthSession | undefined
  private email: string | undefined
  private name: string | undefined
  private connecting = false
  private cancel: (() => void) | undefined
  /** Credentials obtained while the vault is locked or missing: kept in memory until it can hold them. */
  private pending: Tokens | undefined
  private lastError: string | undefined
  private started = false

  constructor(private readonly host: DriveHost, private readonly store: VaultStore) {}

  /** Call once at startup, after any automatic unlock. */
  async init(): Promise<void> {
    this.settings = await this.readSettings()
    this.store.on('state', (s: string) => {
      if (s === 'unlocked') void this.onUnlocked()
      else this.forgetSession() // the vault key is gone: nothing can be read or written, and no secret should linger
      this.publish()
    })
    if ((await this.store.state().catch(() => 'damaged')) === 'unlocked') await this.onUnlocked()
    this.publish()
  }

  /** Locking the vault means forgetting the Google credentials held in memory too; unlocking reloads them. */
  private forgetSession(): void {
    this.engine?.stop()
    this.engine = undefined
    this.auth = undefined
    this.started = false
  }

  // ---- settings ------------------------------------------------------------------------------------

  private async readSettings(): Promise<DriveClientSettings | undefined> {
    try {
      const v: unknown = JSON.parse(await readFile(this.host.settingsFile, 'utf8'))
      const o = v as Partial<DriveClientSettings>
      return typeof o?.clientId === 'string' && o.clientId ? { clientId: o.clientId, ...(typeof o.clientSecret === 'string' && o.clientSecret ? { clientSecret: o.clientSecret } : {}) } : undefined
    } catch {
      return undefined
    }
  }

  async setClient(input: unknown): Promise<Result> {
    const o = (input ?? {}) as Partial<DriveClientSettings>
    const clientId = typeof o.clientId === 'string' ? o.clientId.trim() : ''
    const clientSecret = typeof o.clientSecret === 'string' ? o.clientSecret.trim() : ''
    if (!clientId || clientId.length > 300 || /\s/.test(clientId)) return { ok: false, error: 'Đây không giống một Google client ID' }
    if (clientSecret.length > 300 || /\s/.test(clientSecret)) return { ok: false, error: 'Đây không giống một client secret' }
    if (this.engine || this.connecting) return { ok: false, error: 'Hãy đăng xuất khỏi Google Drive trước khi đổi client ID' }
    this.settings = { clientId, ...(clientSecret ? { clientSecret } : {}) }
    await mkdir(path.dirname(this.host.settingsFile), { recursive: true })
    const tmp = `${this.host.settingsFile}.tmp`
    await writeFile(tmp, JSON.stringify(this.settings), { mode: 0o600 })
    await rename(tmp, this.host.settingsFile)
    this.publish()
    return { ok: true }
  }

  /** The user's own credentials win over the ones shipped with the build. */
  private get client(): DriveClientSettings | undefined {
    return this.settings ?? this.host.defaultClient
  }

  private oauth(): OAuthConfig {
    const client = this.client
    if (!client) throw new Error(NOT_CONFIGURED)
    return { clientId: client.clientId, ...(client.clientSecret ? { clientSecret: client.clientSecret } : {}), ...this.host.endpoints && {
      ...(this.host.endpoints.authEndpoint ? { authEndpoint: this.host.endpoints.authEndpoint } : {}),
      ...(this.host.endpoints.tokenEndpoint ? { tokenEndpoint: this.host.endpoints.tokenEndpoint } : {}),
      ...(this.host.endpoints.revokeEndpoint ? { revokeEndpoint: this.host.endpoints.revokeEndpoint } : {})
    } }
  }

  // ---- status --------------------------------------------------------------------------------------

  async status(): Promise<DriveStatus> {
    return this.snapshot()
  }

  private snapshot(): DriveStatus {
    const e = this.engine?.status
    const phase: DriveStatus['phase'] = this.connecting ? 'connecting' : e ? (e.phase === 'off' ? 'not-connected' : e.phase) : this.pending ? 'locked' : 'not-connected'
    const error = this.lastError ?? e?.error
    return {
      configured: this.client !== undefined,
      builtInClient: this.settings === undefined && this.host.defaultClient !== undefined,
      phase,
      ...(this.email ? { email: this.email } : {}),
      ...(this.name ? { name: this.name } : {}),
      ...(e?.lastSyncAt ? { lastSyncAt: e.lastSyncAt } : {}),
      ...(error ? { error } : {}),
      ...(e?.retryAt ? { retryAt: e.retryAt } : {}),
      devices: e?.devices ?? 0,
      ignored: e?.ignored ?? []
    }
  }

  private publish(): void {
    this.host.emitStatus(this.snapshot())
  }

  // ---- connecting ----------------------------------------------------------------------------------

  async connect(): Promise<Result> {
    if (this.connecting) return { ok: false, error: 'Một phiên đăng nhập đang diễn ra' }
    if (this.engine) {
      if (this.engine.status.phase !== 'needs-auth') return { ok: false, error: 'Đã kết nối với Google Drive' }
      // Access was withdrawn: signing in again replaces the dead credentials, keeping everything else.
      this.engine.stop()
      this.engine = undefined
      this.auth = undefined
    }
    let oauth: OAuthConfig
    try { oauth = this.oauth() } catch (err) { return { ok: false, error: friendly(err) } }

    this.connecting = true
    this.lastError = undefined
    this.publish()
    try {
      const tokens = await authorize(oauth, {
        openBrowser: (url) => this.open(url),
        onCancelable: (c) => { this.cancel = c }
      })
      this.email = tokens.email
      this.name = tokens.name
      const state = await this.store.state()
      if (state === 'uninitialized') return await this.restore(tokens, oauth)
      this.pending = tokens
      if (state === 'unlocked') await this.onUnlocked()
      const started = this.engine as DriveSync | undefined // set by onUnlocked() above
      return started?.status.phase === 'error' ? { ok: false, error: started.status.error ?? 'Sync failed' } : { ok: true }
    } catch (err) {
      this.lastError = friendly(err)
      return { ok: false, error: this.lastError }
    } finally {
      this.connecting = false
      this.cancel = undefined
      this.publish()
    }
  }

  private async open(url: string): Promise<void> {
    const u = new URL(url)
    if (u.protocol !== 'https:' && !(this.host.allowInsecureHttp && u.protocol === 'http:')) {
      throw new Error('Từ chối mở trang đăng nhập không dùng HTTPS')
    }
    await this.host.openExternal(url)
  }

  cancelConnect(): void {
    this.cancel?.()
  }

  /** A device with no vault: fetch the metadata from Drive so the passphrase can unlock it. */
  private async restore(tokens: Tokens, oauth: OAuthConfig): Promise<Result> {
    const drive = new DriveClient({ auth: new AuthSession(oauth, tokens), ...(this.host.endpoints?.baseUrl ? { baseUrl: this.host.endpoints.baseUrl } : {}) })
    try {
      await restoreVault(drive, this.store)
    } catch (err) {
      if (!(err instanceof NoRemoteVaultError)) {
        this.lastError = friendly(err)
        return { ok: false, error: this.lastError }
      }
      // A brand-new account: stay signed in, and start syncing the moment a vault has been created here.
    }
    this.pending = tokens // held in memory until the vault is unlocked and can store them
    return { ok: true }
  }

  /** The vault is open: adopt any credentials waiting for it, or load the saved ones, and start syncing. */
  private async onUnlocked(): Promise<void> {
    if (this.engine || !this.client) return
    let tokens = this.pending
    if (tokens) {
      await this.store.setLocal(TOKENS, JSON.stringify(tokens))
    } else {
      const saved = this.store.getLocal(TOKENS)
      if (saved) tokens = JSON.parse(saved) as Tokens
    }
    this.pending = undefined
    if (!tokens) return

    this.email = tokens.email
    this.name = tokens.name
    const oauth = this.oauth()
    const auth = new AuthSession(oauth, tokens, {
      onChange: (t) => { void this.store.setLocal(TOKENS, JSON.stringify({ ...t, ...(this.email ? { email: this.email } : {}), ...(this.name ? { name: this.name } : {}) })).catch(() => undefined) }
    })
    this.auth = auth
    const drive = new DriveClient({ auth, ...(this.host.endpoints?.baseUrl ? { baseUrl: this.host.endpoints.baseUrl } : {}) })
    let cache: SyncState | undefined
    try { cache = JSON.parse(this.store.getLocal(SYNC_STATE) ?? 'null') as SyncState | undefined ?? undefined } catch { cache = undefined }
    const state: StateStorage = {
      load: () => cache,
      save: async (s) => { cache = s; await this.store.setLocal(SYNC_STATE, JSON.stringify(s)) }
    }
    const engine = new DriveSync({ store: this.store, drive, state, ...(this.host.intervalMs ? { intervalMs: this.host.intervalMs } : {}), ...(this.host.debounceMs ? { debounceMs: this.host.debounceMs } : {}) })
    engine.on('status', () => this.publish())
    this.engine = engine
    engine.start()
    this.started = true
    this.publish()
  }

  async syncNow(): Promise<Result> {
    if (!this.engine) return { ok: false, error: 'Chưa kết nối với Google Drive' }
    try {
      await this.engine.syncNow()
      return { ok: true }
    } catch (err) {
      return { ok: false, error: friendly(err) }
    }
  }

  // ---- leaving -------------------------------------------------------------------------------------

  /**
   * Sign out. Signing out on this computer always completes; the part that touches Google Drive (leaving,
   * or erasing everything) is best effort, and if it fails the caller is told exactly what was not done.
   */
  async disconnect(deleteRemote: boolean): Promise<Result> {
    const engine = this.engine
    const tokens = this.auth?.current ?? this.pending
    let remoteProblem: string | undefined
    if (engine) {
      try {
        if (deleteRemote) await engine.deleteAllRemote()
        else await engine.removeThisDevice()
      } catch (err) {
        remoteProblem = friendly(err) // e.g. access already withdrawn, or offline
      }
    }
    engine?.stop()
    this.forgetSession()
    this.pending = undefined
    this.lastError = undefined
    this.email = undefined
    this.name = undefined
    try {
      if (tokens) await revoke(this.oauth(), tokens.refreshToken)
      if ((await this.store.state()) === 'unlocked') {
        await this.store.deleteLocal(TOKENS)
        await this.store.deleteLocal(SYNC_STATE)
      }
    } catch (err) {
      remoteProblem ??= friendly(err)
    }
    this.publish()
    if (deleteRemote && remoteProblem) {
      return { ok: false, error: `Đã đăng xuất trên máy này, nhưng chưa xóa được dữ liệu đã đồng bộ khỏi Google Drive (${remoteProblem}). Hãy đăng nhập và thử xóa lại.` }
    }
    return { ok: true }
  }

  get isRunning(): boolean {
    return this.started
  }
}
