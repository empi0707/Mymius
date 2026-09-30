import { createHash, createHmac, hkdfSync, timingSafeEqual } from 'node:crypto'
import type { SyncRecord } from './merge'
import type { VaultMeta } from './vault'

/**
 * What goes to the cloud. Records are already ciphertext, but their ids, clock stamps and tombstone
 * flags are not, and that is enough for someone with access to the storage to erase or shadow records.
 * So every file also carries a MAC keyed by the vault's data key: without the key nothing can be forged,
 * and a forged or damaged file is simply refused.
 */

export const SYNC_FORMAT = 1
/** Anything larger than this is not a file this app wrote. */
export const MAX_SYNC_FILE_BYTES = 20 * 1024 * 1024

export class SyncFormatError extends Error {
  constructor(readonly reason: 'invalid' | 'tampered' | 'too-large', message: string) {
    super(message)
    this.name = 'SyncFormatError'
  }
}

export interface DeviceFile {
  format: 1
  deviceId: string
  updatedAt: number
  records: SyncRecord[]
  mac: string
}

export interface MetaFile {
  format: 1
  meta: VaultMeta
  mac: string
}

/** JSON with object keys sorted, so the same data always produces the same bytes. */
export function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>
    return `{${Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonicalize(o[k])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function macKey(dataKey: Buffer): Buffer {
  return Buffer.from(hkdfSync('sha256', dataKey, Buffer.alloc(0), 'mymius/sync/mac/v1', 32))
}

function mac(dataKey: Buffer, domain: string, body: string): string {
  return createHmac('sha256', macKey(dataKey)).update(domain).update('\0').update(body).digest('hex')
}

function sameMac(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex'), y = Buffer.from(b, 'hex')
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y)
}

const sortedRecords = (records: readonly SyncRecord[]): SyncRecord[] =>
  records.map((r) => ({ id: r.id, hlc: r.hlc, deleted: r.deleted, payload: r.payload })).sort((a, b) => (a.id < b.id ? -1 : 1))

export function buildDeviceFile(dataKey: Buffer, deviceId: string, records: readonly SyncRecord[], now = Date.now()): DeviceFile {
  const sorted = sortedRecords(records)
  return { format: SYNC_FORMAT, deviceId, updatedAt: now, records: sorted, mac: mac(dataKey, 'device', `${deviceId}\n${canonicalize(sorted)}`) }
}

/** A stable fingerprint of what a device would publish, ignoring the timestamp: "did anything change?" */
export function recordsFingerprint(records: readonly SyncRecord[]): string {
  return createHash('sha256').update(canonicalize(sortedRecords(records))).digest('hex')
}

const isRecord = (r: unknown): r is SyncRecord => {
  const x = r as Partial<SyncRecord> | null
  return !!x && typeof x.id === 'string' && x.id.length > 0 && x.id.length < 200 && typeof x.hlc === 'string' && x.hlc.length < 100 &&
    typeof x.deleted === 'boolean' && (x.payload === null || typeof x.payload === 'string')
}

function parseJson(text: string): Record<string, unknown> {
  if (Buffer.byteLength(text) > MAX_SYNC_FILE_BYTES) throw new SyncFormatError('too-large', 'The file is too large')
  try {
    const v: unknown = JSON.parse(text)
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>
  } catch { /* fall through */ }
  throw new SyncFormatError('invalid', 'The file is not valid')
}

/** Parse and authenticate a device file. Throws SyncFormatError for anything that is not exactly what we wrote. */
export function parseDeviceFile(text: string, dataKey: Buffer): { deviceId: string; records: SyncRecord[]; updatedAt: number } {
  const f = parseJson(text)
  if (f.format !== SYNC_FORMAT || typeof f.deviceId !== 'string' || !/^[0-9a-f]{4,32}$/.test(f.deviceId) ||
      !Array.isArray(f.records) || typeof f.mac !== 'string' || typeof f.updatedAt !== 'number' || !f.records.every(isRecord)) {
    throw new SyncFormatError('invalid', 'The file is not a valid device file')
  }
  const records = sortedRecords(f.records as SyncRecord[])
  if (!sameMac(f.mac, mac(dataKey, 'device', `${f.deviceId}\n${canonicalize(records)}`))) {
    throw new SyncFormatError('tampered', 'The file failed its integrity check')
  }
  return { deviceId: f.deviceId, records, updatedAt: f.updatedAt }
}

export function buildMetaFile(dataKey: Buffer, meta: VaultMeta): MetaFile {
  return { format: SYNC_FORMAT, meta, mac: mac(dataKey, 'meta', canonicalize(meta)) }
}

function asMeta(m: unknown): VaultMeta {
  const x = m as Partial<VaultMeta> | null
  if (!x || x.version !== 1 || typeof x.wrappedByPassphrase !== 'string' || typeof x.wrappedByRecovery !== 'string' ||
      typeof x.check !== 'string' || typeof x.rev !== 'number' || !Number.isInteger(x.rev) || x.rev < 1 || !x.kdf ||
      x.kdf.alg !== 'argon2id' || typeof x.kdf.salt !== 'string') {
    throw new SyncFormatError('invalid', 'The vault metadata is not valid')
  }
  return x as VaultMeta
}

/** Without a key (a device that has no vault yet) this only checks the shape: the caller must verify later. */
export function parseMetaFile(text: string, dataKey?: Buffer): { meta: VaultMeta; verified: boolean } {
  const f = parseJson(text)
  if (f.format !== SYNC_FORMAT || typeof f.mac !== 'string') throw new SyncFormatError('invalid', 'The file is not a valid vault file')
  const meta = asMeta(f.meta)
  if (!dataKey) return { meta, verified: false }
  if (!sameMac(f.mac, mac(dataKey, 'meta', canonicalize(meta)))) throw new SyncFormatError('tampered', 'The file failed its integrity check')
  return { meta, verified: true }
}

export function metaFileMacMatches(text: string, dataKey: Buffer): boolean {
  try {
    return parseMetaFile(text, dataKey).verified
  } catch {
    return false
  }
}
