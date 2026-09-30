import { NetworkError, OAuthDeniedError } from './errors'
import { createPkce } from './pkce'
import type { OAuthConfig, Tokens } from './oauth'

export const DROPBOX_AUTH_ENDPOINT = 'https://www.dropbox.com/oauth2/authorize'
export const DROPBOX_TOKEN_ENDPOINT = 'https://api.dropboxapi.com/oauth2/token'
export const DROPBOX_API = 'https://api.dropboxapi.com'

export interface DropboxEndpoints {
  authEndpoint?: string
  tokenEndpoint?: string
  apiUrl?: string
  fetch?: typeof fetch
}

/**
 * Dropbox sign-in without a redirect: the person approves in their browser and Dropbox shows a short code,
 * which they paste into the app. No listener, no registered redirect address, no client secret (PKCE instead).
 */
export function beginDropboxAuth(appKey: string, endpoints: DropboxEndpoints = {}): { url: string; verifier: string } {
  const { verifier, challenge } = createPkce()
  const q = new URLSearchParams({
    client_id: appKey,
    response_type: 'code',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    token_access_type: 'offline' // a refresh token, so the sign-in lasts
  })
  return { url: `${endpoints.authEndpoint ?? DROPBOX_AUTH_ENDPOINT}?${q}`, verifier }
}

async function post(f: typeof fetch, url: string, form: Record<string, string>, headers: Record<string, string> = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  let res: Response
  try {
    res = await f(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(30_000)
    })
  } catch (err) {
    throw new NetworkError(err)
  }
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> }
}

/** Trade the pasted code for tokens, then ask who signed in (for display only). */
export async function finishDropboxAuth(appKey: string, code: string, verifier: string, endpoints: DropboxEndpoints = {}, now = Date.now): Promise<Tokens> {
  const f = endpoints.fetch ?? fetch
  const trimmed = code.trim()
  if (!/^[A-Za-z0-9_\-.~+/=]{8,512}$/.test(trimmed)) throw new OAuthDeniedError('invalid_code')
  const { status, body } = await post(f, endpoints.tokenEndpoint ?? DROPBOX_TOKEN_ENDPOINT, {
    grant_type: 'authorization_code', code: trimmed, client_id: appKey, code_verifier: verifier
  })
  if (status !== 200 || typeof body.access_token !== 'string') {
    throw new OAuthDeniedError(typeof body.error === 'string' ? body.error : String(status))
  }
  if (typeof body.refresh_token !== 'string') {
    throw new Error('Dropbox không trả về phiên đăng nhập dài hạn. Hãy kiểm tra ứng dụng Dropbox đã bật quyền files.content.read/write và thử lại.')
  }
  const tokens: Tokens = {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    expiresAt: now() + (typeof body.expires_in === 'number' ? body.expires_in : 14_400) * 1000
  }
  try {
    const res = await f(`${endpoints.apiUrl ?? DROPBOX_API}/2/users/get_current_account`, { method: 'POST', headers: { Authorization: `Bearer ${tokens.accessToken}` }, signal: AbortSignal.timeout(30_000) })
    if (res.ok) {
      const a = (await res.json()) as { email?: unknown; name?: { display_name?: unknown } }
      if (typeof a.email === 'string') tokens.email = a.email.slice(0, 254)
      if (typeof a.name?.display_name === 'string') tokens.name = a.name.display_name.replace(/[\u0000-\u001f]/g, '').slice(0, 100)
    }
  } catch { /* the name is a nicety */ }
  return tokens
}

/** The config AuthSession needs to refresh a Dropbox token (public client: no secret). */
export function dropboxOAuthConfig(appKey: string, endpoints: DropboxEndpoints = {}): OAuthConfig {
  return { clientId: appKey, tokenEndpoint: endpoints.tokenEndpoint ?? DROPBOX_TOKEN_ENDPOINT, ...(endpoints.fetch ? { fetch: endpoints.fetch } : {}) }
}

/** Ask Dropbox to invalidate the token. Best effort. */
export async function revokeDropbox(accessToken: string, endpoints: DropboxEndpoints = {}): Promise<boolean> {
  try {
    const res = await (endpoints.fetch ?? fetch)(`${endpoints.apiUrl ?? DROPBOX_API}/2/auth/token/revoke`, { method: 'POST', headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(30_000) })
    return res.ok
  } catch {
    return false
  }
}
