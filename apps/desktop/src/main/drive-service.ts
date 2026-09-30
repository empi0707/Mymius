import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  AuthSession, DriveClient, DriveSync, DropboxClient, NoRemoteVaultError, authorize, beginDropboxAuth, dropboxOAuthConfig,
  finishDropboxAuth, restoreVault, revoke, revokeDropbox,
  type DropboxEndpoints, type OAuthConfig, type RemoteStore, type StateStorage, type SyncState, type Tokens
} from '@mymius/drive-sync'
import type { VaultStore } from '@mymius/vault'
import type { CloudProvider, DriveClientSettings, DriveStatus, Result } from '../shared/ipc'

export interface DriveHost {
  /** Where the OAuth client ID is kept. It is configuration, not a secret. */
  settingsFile: string
  /** Credentials shipped with the build; used when the user has not entered their own. */
  defaultClient?: DriveClientSettings
  /** A Dropbox app key shipped with the build. */
  defaultDropboxAppKey?: string
  /** Point at a fake Dropbox. Never set in a real build. */
  dropboxEndpoints?: DropboxEndpoints & { contentUrl?: string }
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
const NO_DROPBOX_KEY = 'Hãy nhập Dropbox app key trước (xem hướng dẫn cài đặt)'

/** Sign-in credentials as kept in the vault's sealed area: the tokens and which service they belong to. */
type Saved = Tokens & { provider?: CloudProvider }

function friendly(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Turns cloud syncing (Google Drive or Dropbox) on and off for the app: the browser sign-in, keeping the credentials, starting
 * the background sync when the vault is unlocked, and restoring a vault onto a new device. Credentials live
 * in the vault's device-local sealed area, so they are protected by the vault key and never synced.
 */
export class DriveSyncService {
  private settings: DriveClientSettings | undefined
  private dropboxKey: string | undefined
  private provider: CloudProvider = 'google'
  /** A Dropbox sign-in waiting for the code the person copies from the Dropbox page. */
  private dropboxLogin: { verifier: string; appKey: string } | undefined
  private engine: DriveSync | undefined
  private auth: AuthSession | undefined
  private email: string | undefined
  private name: string | undefined
  private connecting = false
  private cancel: (() => void) | undefined
  /** Credentials obtained while the vault is locked or missing: kept in memory until it can hold them. */
  private pending: { tokens: Tokens; provider: CloudProvider } | undefined
  private lastError: string | undefined
  private started = false

  constructor(private readonly host: DriveHost, private readonly store: VaultStore) {}

  /** Call once at startup, after any automatic unlock. */
  async init(): Promise<void> {
    await this.readSettings()
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

  private async readSettings(): Promise<void> {
    try {
      const o = JSON.parse(await readFile(this.host.settingsFile, 'utf8')) as Partial<DriveClientSettings> & { dropboxAppKey?: unknown }
      this.settings = typeof o?.clientId === 'string' && o.clientId ? { clientId: o.clientId, ...(typeof o.clientSecret === 'string' && o.clientSecret ? { clientSecret: o.clientSecret } : {}) } : undefined
      this.dropboxKey = typeof o?.dropboxAppKey === 'string' && o.dropboxAppKey ? o.dropboxAppKey : undefined
    } catch {
      this.settings = undefined
      this.dropboxKey = undefined
    }
  }

  private async writeSettings(): Promise<void> {
    await mkdir(path.dirname(this.host.settingsFile), { recursive: true })
    const tmp = `${this.host.settingsFile}.tmp`
    await writeFile(tmp, JSON.stringify({ ...(this.settings ?? {}), ...(this.dropboxKey ? { dropboxAppKey: this.dropboxKey } : {}) }), { mode: 0o600 })
    await rename(tmp, this.host.settingsFile)
  }

  async setClient(input: unknown): Promise<Result> {
    const o = (input ?? {}) as Partial<DriveClientSettings>
    const clientId = typeof o.clientId === 'string' ? o.clientId.trim() : ''
    const clientSecret = typeof o.clientSecret === 'string' ? o.clientSecret.trim() : ''
    if (!clientId || clientId.length > 300 || /\s/.test(clientId)) return { ok: false, error: 'Đây không giống một Google client ID' }
    if (clientSecret.length > 300 || /\s/.test(clientSecret)) return { ok: false, error: 'Đây không giống một client secret' }
    if (this.engine || this.connecting) return { ok: false, error: 'Hãy đăng xuất khỏi dịch vụ lưu trữ trước khi đổi client ID' }
    this.settings = { clientId, ...(clientSecret ? { clientSecret } : {}) }
    await this.writeSettings()
    this.publish()
    return { ok: true }
  }

  async setDropboxKey(input: unknown): Promise<Result> {
    const key = typeof input === 'string' ? input.trim() : ''
    if (!/^[A-Za-z0-9]{6,64}$/.test(key)) return { ok: false, error: 'Đây không giống một Dropbox app key' }
    if (this.engine || this.connecting) return { ok: false, error: 'Hãy đăng xuất khỏi dịch vụ lưu trữ trước khi đổi app key' }
    this.dropboxKey = key
    await this.writeSettings()
    this.publish()
    return { ok: true }
  }

  private get appKey(): string | undefined {
    return this.dropboxKey ?? this.host.defaultDropboxAppKey
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
      dropboxConfigured: this.appKey !== undefined,
      builtInDropbox: this.dropboxKey === undefined && this.host.defaultDropboxAppKey !== undefined,
      provider: this.pending?.provider ?? this.provider,
      awaitingCode: this.dropboxLogin !== undefined,
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

  async connect(provider: unknown = 'google'): Promise<Result> {
    if (provider !== 'google' && provider !== 'dropbox') return { ok: false, error: 'Dịch vụ lưu trữ không hợp lệ' }
    if (this.connecting) return { ok: false, error: 'Một phiên đăng nhập đang diễn ra' }
    if (this.engine) {
      if (this.engine.status.phase !== 'needs-auth') return { ok: false, error: 'Đã kết nối với dịch vụ lưu trữ' }
      // Access was withdrawn: signing in again replaces the dead credentials, keeping everything else.
      this.engine.stop()
      this.engine = undefined
      this.auth = undefined
    }
    if (provider === 'dropbox') return this.dropboxBegin()

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
      return await this.afterSignIn(tokens, 'google')
    } catch (err) {
      this.lastError = friendly(err)
      return { ok: false, error: this.lastError }
    } finally {
      this.connecting = false
      this.cancel = undefined
      this.publish()
    }
  }

  /** Dropbox, step one: show the consent page. The person then pastes the code Dropbox displays (step two). */
  private async dropboxBegin(): Promise<Result> {
    const appKey = this.appKey
    if (!appKey) return { ok: false, error: NO_DROPBOX_KEY }
    this.lastError = undefined
    try {
      const { url, verifier } = beginDropboxAuth(appKey, this.host.dropboxEndpoints)
      await this.open(url)
      this.dropboxLogin = { verifier, appKey }
      this.connecting = true
      return { ok: true }
    } catch (err) {
      this.lastError = friendly(err)
      return { ok: false, error: this.lastError }
    } finally {
      this.publish()
    }
  }

  /** Dropbox, step two: trade the pasted code for a sign-in. */
  async submitDropboxCode(code: unknown): Promise<Result> {
    const login = this.dropboxLogin
    if (!login) return { ok: false, error: 'Chưa bắt đầu đăng nhập Dropbox. Hãy bấm Sign in with Dropbox trước.' }
    if (typeof code !== 'string') return { ok: false, error: 'Mã không hợp lệ' }
    this.lastError = undefined
    try {
      const tokens = await finishDropboxAuth(login.appKey, code, login.verifier, this.host.dropboxEndpoints)
      this.dropboxLogin = undefined
      return await this.afterSignIn(tokens, 'dropbox')
    } catch (err) {
      // A wrong or expired code can be retried with the same page; a network error can too.
      this.lastError = err instanceof Error && err.name === 'OAuthDeniedError' ? 'Mã không đúng hoặc đã hết hạn. Hãy sao chép lại mã trên trang Dropbox, hoặc bấm Cancel và đăng nhập lại.' : friendly(err)
      return { ok: false, error: this.lastError }
    } finally {
      if (!this.dropboxLogin) this.connecting = false
      this.publish()
    }
  }

  /** What follows a successful sign-in with either service. */
  private async afterSignIn(tokens: Tokens, provider: CloudProvider): Promise<Result> {
    this.provider = provider
    this.email = tokens.email
    this.name = tokens.name
    const state = await this.store.state()
    if (state === 'uninitialized') return await this.restore(tokens, provider)
    this.pending = { tokens, provider }
    if (state === 'unlocked') await this.onUnlocked()
    const started = this.engine as DriveSync | undefined // set by onUnlocked() above
    return started?.status.phase === 'error' ? { ok: false, error: started.status.error ?? 'Đồng bộ thất bại' } : { ok: true }
  }

  private async open(url: string): Promise<void> {
    const u = new URL(url)
    if (u.protocol !== 'https:' && !(this.host.allowInsecureHttp && u.protocol === 'http:')) {
      throw new Error('Từ chối mở trang đăng nhập không dùng HTTPS')
    }
    await this.host.openExternal(url)
  }

  cancelConnect(): void {
    if (this.dropboxLogin) {
      this.dropboxLogin = undefined
      this.connecting = false
      this.lastError = undefined
      this.publish()
      return
    }
    this.cancel?.()
  }

  private authFor(tokens: Tokens, provider: CloudProvider, hooks: { onChange?(t: Tokens): void } = {}): AuthSession {
    if (provider === 'dropbox') {
      const key = this.appKey
      if (!key) throw new Error(NO_DROPBOX_KEY)
      return new AuthSession(dropboxOAuthConfig(key, this.host.dropboxEndpoints), tokens, hooks)
    }
    return new AuthSession(this.oauth(), tokens, hooks)
  }

  private remoteFor(auth: AuthSession, provider: CloudProvider): RemoteStore {
    if (provider === 'dropbox') {
      const e = this.host.dropboxEndpoints
      return new DropboxClient({ auth, ...(e?.apiUrl ? { apiUrl: e.apiUrl } : {}), ...(e?.contentUrl ? { contentUrl: e.contentUrl } : {}) })
    }
    return new DriveClient({ auth, ...(this.host.endpoints?.baseUrl ? { baseUrl: this.host.endpoints.baseUrl } : {}) })
  }

  /** A device with no vault: fetch the metadata from the cloud so the passphrase can unlock it. */
  private async restore(tokens: Tokens, provider: CloudProvider): Promise<Result> {
    try {
      await restoreVault(this.remoteFor(this.authFor(tokens, provider), provider), this.store)
    } catch (err) {
      if (!(err instanceof NoRemoteVaultError)) {
        this.lastError = friendly(err)
        return { ok: false, error: this.lastError }
      }
      // A brand-new account: stay signed in, and start syncing the moment a vault has been created here.
    }
    this.pending = { tokens, provider } // held in memory until the vault is unlocked and can store them
    return { ok: true }
  }

  private configuredFor(provider: CloudProvider): boolean {
    return provider === 'dropbox' ? this.appKey !== undefined : this.client !== undefined
  }

  /** The vault is open: adopt any credentials waiting for it, or load the saved ones, and start syncing. */
  private async onUnlocked(): Promise<void> {
    if (this.engine) return
    let saved: Saved | undefined
    if (this.pending) {
      if (!this.configuredFor(this.pending.provider)) return
      saved = { ...this.pending.tokens, provider: this.pending.provider }
      await this.store.setLocal(TOKENS, JSON.stringify(saved))
    } else {
      const raw = this.store.getLocal(TOKENS)
      if (raw) saved = JSON.parse(raw) as Saved
    }
    this.pending = undefined
    if (!saved) return
    const provider: CloudProvider = saved.provider === 'dropbox' ? 'dropbox' : 'google'
    if (!this.configuredFor(provider)) return

    this.provider = provider
    this.email = saved.email
    this.name = saved.name
    const auth = this.authFor(saved, provider, {
      onChange: (t) => { void this.store.setLocal(TOKENS, JSON.stringify({ ...t, provider, ...(this.email ? { email: this.email } : {}), ...(this.name ? { name: this.name } : {}) })).catch(() => undefined) }
    })
    this.auth = auth
    const drive = this.remoteFor(auth, provider)
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
    if (!this.engine) return { ok: false, error: 'Chưa kết nối với dịch vụ lưu trữ' }
    try {
      await this.engine.syncNow()
      return { ok: true }
    } catch (err) {
      return { ok: false, error: friendly(err) }
    }
  }

  // ---- leaving -------------------------------------------------------------------------------------

  /**
   * Sign out. Signing out on this computer always completes; the part that touches the cloud (leaving,
   * or erasing everything) is best effort, and if it fails the caller is told exactly what was not done.
   */
  async disconnect(deleteRemote: boolean): Promise<Result> {
    const engine = this.engine
    const auth = this.auth
    const tokens = auth?.current ?? this.pending?.tokens
    const provider = this.pending?.provider ?? this.provider
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
    this.dropboxLogin = undefined
    this.connecting = false
    this.lastError = undefined
    this.email = undefined
    this.name = undefined
    try {
      if (tokens) {
        if (provider === 'dropbox') await revokeDropbox((await (auth ?? this.authFor(tokens, provider)).getAccessToken().catch(() => tokens.accessToken)), this.host.dropboxEndpoints)
        else await revoke(this.oauth(), tokens.refreshToken)
      }
      if ((await this.store.state()) === 'unlocked') {
        await this.store.deleteLocal(TOKENS)
        await this.store.deleteLocal(SYNC_STATE)
      }
    } catch (err) {
      remoteProblem ??= friendly(err)
    }
    this.publish()
    if (deleteRemote && remoteProblem) {
      return { ok: false, error: `Đã đăng xuất trên máy này, nhưng chưa xóa được dữ liệu đã đồng bộ khỏi ${provider === 'dropbox' ? 'Dropbox' : 'Google Drive'} (${remoteProblem}). Hãy đăng nhập và thử xóa lại.` }
    }
    return { ok: true }
  }

  get isRunning(): boolean {
    return this.started
  }
}
