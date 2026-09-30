import { randomBytes } from 'node:crypto'
import { AuthRevokedError, NetworkError, OAuthDeniedError } from './errors'
import { startLoopback } from './loopback'
import { createPkce } from './pkce'

export const DRIVE_APPDATA_SCOPE = 'https://www.googleapis.com/auth/drive.appdata'

export interface OAuthConfig {
  clientId: string
  /** Google issues one for "Desktop app" clients and its token endpoint expects it, though it is not confidential. */
  clientSecret?: string
  authEndpoint?: string
  tokenEndpoint?: string
  revokeEndpoint?: string
  /** Least privilege: only the app's own hidden folder, plus who is signed in. */
  scopes?: string[]
  fetch?: typeof fetch
}

export interface Tokens {
  accessToken: string
  refreshToken: string
  /** Milliseconds since epoch. */
  expiresAt: number
  email?: string
  /** Display name from the Google profile. */
  name?: string
}

const DEFAULTS = {
  authEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenEndpoint: 'https://oauth2.googleapis.com/token',
  revokeEndpoint: 'https://oauth2.googleapis.com/revoke',
  scopes: ['openid', 'email', 'profile', DRIVE_APPDATA_SCOPE]
}

interface TokenResponse {
  access_token?: string
  refresh_token?: string
  expires_in?: number
  id_token?: string
  error?: string
  error_description?: string
}

async function postForm(cfg: OAuthConfig, url: string, form: Record<string, string>): Promise<{ status: number; body: TokenResponse }> {
  const f = cfg.fetch ?? fetch
  let res: Response
  try {
    res = await f(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(30_000)
    })
  } catch (err) {
    throw new NetworkError(err)
  }
  const body = (await res.json().catch(() => ({}))) as TokenResponse
  return { status: res.status, body }
}

/** Display name of who signed in, read from the ID token for display only. */
export function nameFromIdToken(idToken: string | undefined): string | undefined {
  try {
    const payload = JSON.parse(Buffer.from(idToken?.split('.')[1] ?? '', 'base64url').toString('utf8')) as { name?: unknown }
    const n = typeof payload.name === 'string' ? payload.name.replace(/[\u0000-\u001f]/g, '').trim().slice(0, 100) : ''
    return n || undefined
  } catch {
    return undefined
  }
}

/** Who signed in, read from the ID token for display only. It is not used for any decision. */
export function emailFromIdToken(idToken: string | undefined): string | undefined {
  try {
    const payload = JSON.parse(Buffer.from(idToken?.split('.')[1] ?? '', 'base64url').toString('utf8')) as { email?: unknown }
    return typeof payload.email === 'string' ? payload.email.slice(0, 254) : undefined
  } catch {
    return undefined
  }
}

export interface AuthorizeOptions {
  /** Show this URL in the user's own browser (never an embedded web view: Google refuses those). */
  openBrowser(url: string): Promise<void>
  timeoutMs?: number
  now?: () => number
  /** Called with a function that abandons the sign-in (a Cancel button). */
  onCancelable?(cancel: () => void): void
}

/** The whole desktop sign-in: system browser, PKCE, loopback redirect, code exchange. */
export async function authorize(cfg: OAuthConfig, opts: AuthorizeOptions): Promise<Tokens> {
  const pkce = createPkce()
  const state = randomBytes(24).toString('base64url')
  const loop = await startLoopback({ state, timeoutMs: opts.timeoutMs ?? 5 * 60_000 })
  opts.onCancelable?.(loop.cancel)
  try {
    const url = new URL(cfg.authEndpoint ?? DEFAULTS.authEndpoint)
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: cfg.clientId,
      redirect_uri: loop.redirectUri,
      scope: (cfg.scopes ?? DEFAULTS.scopes).join(' '),
      state,
      code_challenge: pkce.challenge,
      code_challenge_method: 'S256',
      access_type: 'offline', // we need a refresh token, or sync would stop after an hour
      prompt: 'consent' //       and Google only reliably sends one when consent is shown
    }).toString()
    await opts.openBrowser(url.toString())
    const code = await loop.code

    const { status, body } = await postForm(cfg, cfg.tokenEndpoint ?? DEFAULTS.tokenEndpoint, {
      grant_type: 'authorization_code',
      code,
      redirect_uri: loop.redirectUri,
      client_id: cfg.clientId,
      code_verifier: pkce.verifier,
      ...(cfg.clientSecret ? { client_secret: cfg.clientSecret } : {})
    })
    if (status !== 200 || !body.access_token) throw new OAuthDeniedError(body.error_description ?? body.error ?? `HTTP ${status}`)
    if (!body.refresh_token) {
      throw new Error('Google không trả về phiên đăng nhập dài hạn. Hãy gỡ ứng dụng này trong phần truy cập của bên thứ ba ở tài khoản Google, rồi thử lại.')
    }
    const now = (opts.now ?? Date.now)()
    const email = emailFromIdToken(body.id_token)
    const name = nameFromIdToken(body.id_token)
    return { accessToken: body.access_token, refreshToken: body.refresh_token, expiresAt: now + (body.expires_in ?? 3600) * 1000, ...(email ? { email } : {}), ...(name ? { name } : {}) }
  } finally {
    await loop.close()
  }
}

/** Keeps an access token fresh. Only one refresh runs at a time, however many requests want one. */
export class AuthSession {
  private refreshing: Promise<void> | undefined

  constructor(
    private readonly cfg: OAuthConfig,
    private tokens: Tokens,
    private readonly hooks: { onChange?(t: Tokens): void; now?: () => number } = {}
  ) {}

  get current(): Tokens {
    return this.tokens
  }

  async getAccessToken(force = false): Promise<string> {
    const now = (this.hooks.now ?? Date.now)()
    if (force || this.tokens.expiresAt - now < 60_000) await this.refresh()
    return this.tokens.accessToken
  }

  private refresh(): Promise<void> {
    this.refreshing ??= (async () => {
      const { status, body } = await postForm(this.cfg, this.cfg.tokenEndpoint ?? DEFAULTS.tokenEndpoint, {
        grant_type: 'refresh_token',
        refresh_token: this.tokens.refreshToken,
        client_id: this.cfg.clientId,
        ...(this.cfg.clientSecret ? { client_secret: this.cfg.clientSecret } : {})
      })
      if (status === 400 || status === 401) {
        if (body.error === 'invalid_grant' || body.error === 'invalid_client' || body.error === 'unauthorized_client') throw new AuthRevokedError(body.error)
      }
      if (status !== 200 || !body.access_token) throw new Error(`Could not refresh the Google sign-in (${body.error ?? status})`)
      this.tokens = {
        ...this.tokens,
        accessToken: body.access_token,
        expiresAt: (this.hooks.now ?? Date.now)() + (body.expires_in ?? 3600) * 1000,
        ...(body.refresh_token ? { refreshToken: body.refresh_token } : {}) // Google may rotate it
      }
      this.hooks.onChange?.(this.tokens)
    })().finally(() => { this.refreshing = undefined })
    return this.refreshing
  }
}

/** Tell Google to forget this sign-in. Best effort: failing to reach Google must not block signing out here. */
export async function revoke(cfg: OAuthConfig, refreshToken: string): Promise<boolean> {
  try {
    const { status } = await postForm(cfg, cfg.revokeEndpoint ?? DEFAULTS.revokeEndpoint, { token: refreshToken })
    return status === 200
  } catch {
    return false
  }
}
