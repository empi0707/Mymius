import { randomBytes } from 'node:crypto'
import { deriveKey, newKdf, open, seal, VaultAuthError, type KdfParams, type KdfTuning } from './crypto'

/**
 * Stored next to the encrypted records (e.g. in Google Drive appDataFolder). Contains no secret in
 * the clear: the random data key exists only wrapped by the passphrase and by the recovery key.
 */
export interface VaultMeta {
  version: 1
  kdf: KdfParams
  wrappedByPassphrase: string
  wrappedByRecovery: string
}

const AAD_PASS = 'mymius/vault/key/passphrase'
const AAD_RECOVERY = 'mymius/vault/key/recovery'

export interface CreatedVault {
  meta: VaultMeta
  /** Symmetric key that encrypts every record. Keep in memory / OS keychain only. */
  dataKey: Buffer
  /** Show once, ask the user to store it; the only way in if the passphrase is forgotten. */
  recoveryKey: string
}

export async function createVault(passphrase: string, kdfOverrides?: Partial<KdfTuning>): Promise<CreatedVault> {
  const dataKey = randomBytes(32)
  const recovery = randomBytes(32)
  const kdf = newKdf(kdfOverrides)
  const kek = await deriveKey(passphrase, kdf)
  return {
    dataKey,
    recoveryKey: formatRecoveryKey(recovery),
    meta: {
      version: 1,
      kdf,
      wrappedByPassphrase: seal(kek, dataKey, AAD_PASS),
      wrappedByRecovery: seal(recovery, dataKey, AAD_RECOVERY)
    }
  }
}

export async function unlockWithPassphrase(meta: VaultMeta, passphrase: string): Promise<Buffer> {
  return open(await deriveKey(passphrase, meta.kdf), meta.wrappedByPassphrase, AAD_PASS)
}

export function unlockWithRecoveryKey(meta: VaultMeta, recoveryKey: string): Buffer {
  return open(parseRecoveryKey(recoveryKey), meta.wrappedByRecovery, AAD_RECOVERY)
}

/** Records stay as they are: only the wrapper of the data key changes. */
export async function changePassphrase(
  meta: VaultMeta,
  dataKey: Buffer,
  newPassphrase: string,
  kdfOverrides?: Partial<KdfTuning>
): Promise<VaultMeta> {
  const kdf = newKdf(kdfOverrides)
  const kek = await deriveKey(newPassphrase, kdf)
  return { ...meta, kdf, wrappedByPassphrase: seal(kek, dataKey, AAD_PASS) }
}

/** 64 hex chars in groups of 8: easy to read out or print. */
export function formatRecoveryKey(raw: Buffer): string {
  return raw.toString('hex').match(/.{8}/g)!.join('-')
}

export function parseRecoveryKey(text: string): Buffer {
  const hex = text.replace(/[\s-]/g, '').toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new VaultAuthError('Malformed recovery key')
  return Buffer.from(hex, 'hex')
}
