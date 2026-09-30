import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { argon2id } from 'hash-wasm'

export interface KdfParams {
  alg: 'argon2id'
  salt: string // base64
  memoryKiB: number
  iterations: number
  parallelism: number
}

/** Interactive-login-grade defaults. Tests pass much smaller values. */
export interface KdfTuning {
  memoryKiB: number
  iterations: number
  parallelism: number
}

export const DEFAULT_KDF: KdfTuning = { memoryKiB: 64 * 1024, iterations: 3, parallelism: 1 }

export class VaultAuthError extends Error {
  constructor(message = 'Wrong passphrase or corrupted vault') {
    super(message)
    this.name = 'VaultAuthError'
  }
}

export async function deriveKey(passphrase: string, kdf: KdfParams): Promise<Buffer> {
  const out = await argon2id({
    password: passphrase.normalize('NFKC'),
    salt: Buffer.from(kdf.salt, 'base64'),
    memorySize: kdf.memoryKiB,
    iterations: kdf.iterations,
    parallelism: kdf.parallelism,
    hashLength: 32,
    outputType: 'binary'
  })
  return Buffer.from(out)
}

export function newKdf(overrides: Partial<KdfTuning> = {}): KdfParams {
  return { alg: 'argon2id', salt: randomBytes(16).toString('base64'), ...DEFAULT_KDF, ...overrides }
}

const VERSION = 'v1'

/**
 * AES-256-GCM. Output is a single self-describing string: v1.<iv>.<tag>.<ciphertext> (base64url).
 * `aad` is authenticated but not stored: bind it to the record id so ciphertexts cannot be swapped.
 */
export function seal(key: Buffer, plaintext: Uint8Array | string, aad = ''): string {
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', key, iv)
  c.setAAD(Buffer.from(aad))
  const ct = Buffer.concat([c.update(typeof plaintext === 'string' ? Buffer.from(plaintext) : plaintext), c.final()])
  return [VERSION, iv, c.getAuthTag(), ct].map((p) => (typeof p === 'string' ? p : p.toString('base64url'))).join('.')
}

export function open(key: Buffer, sealed: string, aad = ''): Buffer {
  const [ver, iv, tag, ct] = sealed.split('.')
  if (ver !== VERSION || !iv || !tag || ct === undefined) throw new VaultAuthError('Unrecognised ciphertext')
  try {
    const d = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'))
    d.setAAD(Buffer.from(aad))
    d.setAuthTag(Buffer.from(tag, 'base64url'))
    return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()])
  } catch {
    throw new VaultAuthError()
  }
}
