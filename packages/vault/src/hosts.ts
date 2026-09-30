/**
 * What the app stores in the vault. Everything here ends up encrypted; nothing in this file knows
 * about encryption. Records are validated when they are read back, because what comes out of the
 * vault may have been written by another device or an older version.
 */

export type HostAuth =
  | { type: 'password'; password: string }
  /** A private key stored in the vault, referenced by id: it follows the user to every device. */
  | { type: 'key'; keyId: string }
  /** A key file on this machine only. The path means nothing on another device. */
  | { type: 'keyFile'; path: string; passphrase?: string }
  | { type: 'agent' }

export interface HostProfile {
  name: string
  host: string
  port: number
  username: string
  auth: HostAuth
  /** Folder label, e.g. "Production". */
  group?: string
  /** Connect through this host first (ProxyJump). */
  jumpHostId?: string
  notes?: string
  createdAt: number
  updatedAt: number
}

export interface KeyRecord {
  name: string
  /** The private key text (OpenSSH or PEM). */
  privateKey: string
  passphrase?: string
  /** SHA256:... fingerprint of the public half, for display. */
  fingerprint?: string
  createdAt: number
}

/** What the UI sends when saving. A missing secret means "keep the stored one". */
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

export const HOST_PREFIX = 'host:'
export const KEY_PREFIX = 'key:'

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x)
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/

function str(v: unknown, what: string, opts: { min?: number; max: number; multiline?: boolean } ): string {
  if (typeof v !== 'string') throw new Error(`${what} must be text`)
  if (v.length < (opts.min ?? 0)) throw new Error(`${what} is required`)
  if (v.length > opts.max) throw new Error(`${what} is too long`)
  if (opts.multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v) : CONTROL.test(v)) {
    throw new Error(`${what} contains characters that are not allowed`)
  }
  return v
}

function optStr(v: unknown, what: string, max: number, multiline = false): string | undefined {
  if (v === undefined || v === null || v === '') return undefined
  return str(v, what, { max, multiline })
}

export function validHostname(host: string): boolean {
  // No whitespace, control characters, and never a leading "-" (it would read as an ssh option).
  return host.length > 0 && host.length <= 255 && !host.startsWith('-') && !/[\s\u0000-\u001f\u007f]/.test(host)
}

export function parseHostAuth(a: unknown): HostAuth {
  if (!isObj(a)) throw new Error('Choose how to sign in')
  switch (a.type) {
    case 'password':
      return { type: 'password', password: str(a.password, 'Password', { max: 4096 }) }
    case 'key':
      return { type: 'key', keyId: str(a.keyId, 'Key', { min: 1, max: 100 }) }
    case 'keyFile': {
      const passphrase = optStr(a.passphrase, 'Passphrase', 4096)
      return { type: 'keyFile', path: str(a.path, 'Key file', { min: 1, max: 1024 }), ...(passphrase ? { passphrase } : {}) }
    }
    case 'agent':
      return { type: 'agent' }
    default:
      throw new Error('Choose how to sign in')
  }
}

function parseCommon(x: unknown): Omit<HostProfile, 'auth'> {
  if (!isObj(x)) throw new Error('Invalid host')
  const host = str(x.host, 'Host', { min: 1, max: 255 }).trim()
  if (!validHostname(host)) throw new Error('Enter a valid host name or address')
  const port = x.port === undefined ? 22 : x.port
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Port must be between 1 and 65535')
  }
  const group = optStr(x.group, 'Group', 100)?.trim()
  const jumpHostId = optStr(x.jumpHostId, 'Jump host', 100)
  const notes = optStr(x.notes, 'Notes', 5000, true)
  const now = Date.now()
  return {
    name: str(x.name, 'Name', { min: 1, max: 100 }).trim() || host,
    host,
    port,
    username: str(x.username, 'User', { min: 1, max: 256 }).trim(),
    ...(group ? { group } : {}),
    ...(jumpHostId ? { jumpHostId } : {}),
    ...(notes ? { notes } : {}),
    createdAt: typeof x.createdAt === 'number' ? x.createdAt : now,
    updatedAt: typeof x.updatedAt === 'number' ? x.updatedAt : now
  }
}

/** Strict: throws on anything malformed. Used both on save and when reading records back. */
export function parseHostProfile(x: unknown): HostProfile {
  const common = parseCommon(x)
  return { ...common, auth: parseHostAuth((x as Record<string, unknown>).auth) }
}

export function parseKeyRecord(x: unknown): KeyRecord {
  if (!isObj(x)) throw new Error('Invalid key')
  const privateKey = str(x.privateKey, 'Private key', { min: 1, max: 64 * 1024, multiline: true })
  const passphrase = optStr(x.passphrase, 'Passphrase', 4096)
  const fingerprint = optStr(x.fingerprint, 'Fingerprint', 200)
  return {
    name: str(x.name, 'Name', { min: 1, max: 100 }).trim(),
    privateKey,
    ...(passphrase ? { passphrase } : {}),
    ...(fingerprint ? { fingerprint } : {}),
    createdAt: typeof x.createdAt === 'number' ? x.createdAt : Date.now()
  }
}

/**
 * Build the profile to store from what the UI submitted, keeping stored secrets the UI never saw
 * (it only ever receives redacted hosts, so an unchanged password arrives as "missing").
 */
export function applyHostInput(existing: HostProfile | undefined, raw: unknown, now = Date.now()): HostProfile {
  if (!isObj(raw) || !isObj(raw.auth)) throw new Error('Invalid host')
  const input = raw as unknown as HostInput
  let auth: unknown = input.auth
  if (input.auth.type === 'password' && (input.auth.password === undefined || input.auth.password === '')) {
    if (existing?.auth.type !== 'password') throw new Error('Enter a password')
    auth = existing.auth
  } else if (input.auth.type === 'keyFile' && input.auth.passphrase === undefined) {
    // undefined = keep; '' = explicitly none
    auth = { ...input.auth, ...(existing?.auth.type === 'keyFile' && existing.auth.path === input.auth.path && existing.auth.passphrase ? { passphrase: existing.auth.passphrase } : {}) }
  }
  return parseHostProfile({
    ...input,
    auth,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now
  })
}

/** Would making `hostId` jump through `jumpHostId` create a loop (a -> b -> a)? */
export function wouldCreateJumpCycle(
  jumpOf: (id: string) => string | undefined,
  hostId: string,
  jumpHostId: string | undefined
): boolean {
  const seen = new Set<string>([hostId])
  for (let cur = jumpHostId; cur !== undefined; cur = jumpOf(cur)) {
    if (seen.has(cur)) return true
    seen.add(cur)
  }
  return false
}

export interface HostSummary {
  id: string
  name: string
  host: string
  port: number
  username: string
  authType: HostAuth['type']
  /** Name of the vault key, when authType is "key". */
  keyName?: string
  group?: string
  jumpHostId?: string
  notes?: string
}

/** The view of a host that is safe to hand to the UI: no passwords, passphrases or key material. */
export function summarizeHost(id: string, h: HostProfile, keyName?: string): HostSummary {
  return {
    id,
    name: h.name,
    host: h.host,
    port: h.port,
    username: h.username,
    authType: h.auth.type,
    ...(keyName ? { keyName } : {}),
    ...(h.group ? { group: h.group } : {}),
    ...(h.jumpHostId ? { jumpHostId: h.jumpHostId } : {}),
    ...(h.notes ? { notes: h.notes } : {})
  }
}

export interface KeySummary {
  id: string
  name: string
  fingerprint?: string
  hasPassphrase: boolean
}

export function summarizeKey(id: string, k: KeyRecord): KeySummary {
  return { id, name: k.name, ...(k.fingerprint ? { fingerprint: k.fingerprint } : {}), hasPassphrase: Boolean(k.passphrase) }
}
