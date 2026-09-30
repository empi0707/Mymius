import { createHash, randomBytes } from 'node:crypto'

export type OpenAuth =
  | { type: 'password'; password: string }
  | { type: 'key'; keyPath: string; passphrase?: string }
  | { type: 'agent' }

export interface OpenRequest {
  host: string
  port: number
  username: string
  auth: OpenAuth
  cols: number
  rows: number
}

/**
 * Checks a request that came from the UI process and returns a clean copy, or throws with a message
 * fit to show the user. Nothing here trusts the caller's types.
 */
export function parseOpenRequest(input: unknown): OpenRequest {
  if (!input || typeof input !== 'object') throw new Error('Invalid request')
  const r = input as Record<string, unknown>

  const host = typeof r.host === 'string' ? r.host.trim() : ''
  // No whitespace, control characters or option-looking values (a host starting with "-" is a classic injection).
  // eslint-disable-next-line no-control-regex
  if (!host || host.length > 255 || host.startsWith('-') || /[\s\u0000-\u001f\u007f]/.test(host)) {
    throw new Error('Enter a valid host name or address')
  }
  const port = r.port === undefined ? 22 : r.port
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Port must be between 1 and 65535')
  }
  const username = typeof r.username === 'string' ? r.username.trim() : ''
  // eslint-disable-next-line no-control-regex
  if (!username || username.length > 256 || /[\u0000-\u001f\u007f]/.test(username)) throw new Error('Enter a user name')

  const cols = r.cols
  const rows = r.rows
  if (!dim(cols) || !dim(rows)) throw new Error('Invalid terminal size')

  const a = r.auth as Record<string, unknown> | undefined
  let auth: OpenAuth
  switch (a?.type) {
    case 'password':
      if (typeof a.password !== 'string') throw new Error('Enter a password')
      auth = { type: 'password', password: a.password }
      break
    case 'key':
      if (typeof a.keyPath !== 'string' || !a.keyPath.trim()) throw new Error('Choose a private key file')
      auth = {
        type: 'key',
        keyPath: a.keyPath.trim(),
        ...(typeof a.passphrase === 'string' && a.passphrase ? { passphrase: a.passphrase } : {})
      }
      break
    case 'agent':
      auth = { type: 'agent' }
      break
    default:
      throw new Error('Choose how to sign in')
  }
  return { host, port, username, auth, cols, rows }
}

function dim(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= 1000
}

/** Random per process: the identity below is only ever compared in memory, never stored or logged. */
const SALT = randomBytes(16)

function authIdentity(auth: OpenAuth): string {
  const h = createHash('sha256').update(SALT).update(auth.type).update('\0')
  if (auth.type === 'password') h.update(auth.password)
  else if (auth.type === 'key') h.update(auth.keyPath).update('\0').update(auth.passphrase ?? '')
  return h.digest('hex').slice(0, 16)
}

/**
 * Identity of a connection for sharing: same host, port, user AND same credentials. Including the
 * credentials matters: without it a tab given a wrong password would silently reuse a session that
 * another tab authenticated with the right one, and the user would never learn it was wrong.
 */
export function connectionKey(r: Pick<OpenRequest, 'host' | 'port' | 'username' | 'auth'>): string {
  return `${r.username}@${r.host.toLowerCase()}:${r.port}#${authIdentity(r.auth)}`
}
