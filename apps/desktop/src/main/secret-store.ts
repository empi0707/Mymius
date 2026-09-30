import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { SecretStore } from '@mymius/vault'

/** The bit of Electron's safeStorage this needs, so the class can be tested without Electron. */
export interface Cipher {
  encrypt(plain: string): Buffer
  decrypt(data: Buffer): string
}

/**
 * Keeps small secrets (the vault's data key) encrypted by the operating system: macOS Keychain,
 * Windows DPAPI, or the Linux desktop keyring. The file only ever holds ciphertext that this
 * user account on this machine can open.
 */
export class OsSecretStore implements SecretStore {
  constructor(private readonly file: string, private readonly cipher: Cipher) {}

  private async read(): Promise<Record<string, string>> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.file, 'utf8'))
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {}
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {}
      return {} // unreadable: behave as "nothing remembered" (safe direction: asks for the passphrase)
    }
  }

  private async write(all: Record<string, string>): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    await writeFile(tmp, JSON.stringify(all), { mode: 0o600 })
    await rename(tmp, this.file)
  }

  async get(name: string): Promise<Buffer | null> {
    const enc = (await this.read())[name]
    if (!enc) return null
    try {
      return Buffer.from(this.cipher.decrypt(Buffer.from(enc, 'base64')), 'base64')
    } catch {
      return null // e.g. profile copied to another machine/account: cannot be decrypted, so ignore it
    }
  }

  async set(name: string, value: Buffer): Promise<void> {
    const all = await this.read()
    all[name] = this.cipher.encrypt(value.toString('base64')).toString('base64')
    await this.write(all)
  }

  async delete(name: string): Promise<void> {
    const all = await this.read()
    if (!(name in all)) return
    delete all[name]
    await this.write(all)
  }
}
