export type ImportSource = 'termius-csv' | 'ssh-config' | 'forklift'

/** One host as found in someone else's file, before it is checked against the vault. */
export interface ImportedHost {
  name: string
  host: string
  port: number
  username: string
  group?: string
  /** Only ever present when the source file itself contained a password (Termius CSV). */
  password?: string
  /** A key file path from the source; it means something on this device only. */
  keyPath?: string
  /** Name of another imported host (or an existing one) to connect through. */
  jump?: string
  notes?: string
  /** Fields that were filled in with a guess because the file did not say (e.g. "username"). */
  assumed: string[]
}

export interface ImportSkip {
  label: string
  reason: string
}

export interface ParseResult {
  source: ImportSource
  hosts: ImportedHost[]
  skipped: ImportSkip[]
  /** Things the person should know about the file as a whole. */
  warnings: string[]
}

export interface ParseOptions {
  /** Used when a file gives no user name (ssh itself would use the local account). */
  defaultUser?: string
}

export const MAX_IMPORT_BYTES = 5 * 1024 * 1024
export const MAX_IMPORT_HOSTS = 5000

export class ImportFormatError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ImportFormatError'
  }
}

export function checkSize(text: string): void {
  if (Buffer.byteLength(text) > MAX_IMPORT_BYTES) throw new ImportFormatError('File quá lớn để là file danh sách host.')
}

export function validPort(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d{1,5}$/.test(v.trim()) ? Number(v.trim()) : NaN
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : undefined
}

/** Same rule the vault applies, so a bad name is reported here with the host it belongs to. */
export function validHostname(h: string): boolean {
  return h.length > 0 && h.length <= 253 && !h.startsWith('-') && /^[A-Za-z0-9._:\-\[\]%]+$/.test(h) // never an ssh option
}
