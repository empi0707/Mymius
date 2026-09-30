import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { HostKeyChangedError } from './errors'
import type { HostKeyInfo } from './connection'

export type HostTrust = 'trusted' | 'unknown' | 'changed'

interface Entry {
  fingerprint: string
  addedAt: string
}

/** Same key format OpenSSH uses: bare host for port 22, [host]:port otherwise. */
export function hostKeyId(host: string, port: number): string {
  return port === 22 ? host.toLowerCase() : `[${host.toLowerCase()}]:${port}`
}

/** Persistent trust-on-first-use store, one JSON file. */
export class KnownHosts {
  private entries: Record<string, Entry> | undefined

  constructor(private readonly file: string) {}

  private async load(): Promise<Record<string, Entry>> {
    if (this.entries) return this.entries
    try {
      const parsed: unknown = JSON.parse(await readFile(this.file, 'utf8'))
      this.entries = parsed && typeof parsed === 'object' ? (parsed as Record<string, Entry>) : {}
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
      this.entries = {}
    }
    return this.entries
  }

  private async save(): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true })
    const tmp = `${this.file}.${process.pid}.tmp`
    await writeFile(tmp, JSON.stringify(this.entries, null, 2) + '\n', { mode: 0o600 })
    await rename(tmp, this.file)
  }

  async check(host: string, port: number, fingerprint: string): Promise<HostTrust> {
    const known = (await this.load())[hostKeyId(host, port)]
    if (!known) return 'unknown'
    return known.fingerprint === fingerprint ? 'trusted' : 'changed'
  }

  async trust(host: string, port: number, fingerprint: string): Promise<void> {
    const entries = await this.load()
    entries[hostKeyId(host, port)] = { fingerprint, addedAt: new Date().toISOString() }
    await this.save()
  }

  async remove(host: string, port: number): Promise<void> {
    delete (await this.load())[hostKeyId(host, port)]
    await this.save()
  }

  async expected(host: string, port: number): Promise<string | undefined> {
    return (await this.load())[hostKeyId(host, port)]?.fingerprint
  }

  /**
   * Ready-made `verifyHostKey`: known hosts pass, a changed key is refused with HostKeyChangedError
   * (never offered for confirmation here), and an unknown host is put to `confirmUnknown`, whose
   * "yes" is remembered.
   */
  verifier(confirmUnknown: (info: HostKeyInfo) => Promise<boolean>): (info: HostKeyInfo) => Promise<boolean> {
    return async (info) => {
      switch (await this.check(info.host, info.port, info.fingerprint)) {
        case 'trusted':
          return true
        case 'changed':
          throw new HostKeyChangedError(info.host, info.port, (await this.expected(info.host, info.port)) ?? '?', info.fingerprint)
        case 'unknown':
          if (!(await confirmUnknown(info))) return false
          await this.trust(info.host, info.port, info.fingerprint)
          return true
      }
    }
  }
}
