/**
 * Where the unlocked data key and OAuth tokens are cached between launches.
 * Implemented in the desktop app on top of Electron's safeStorage, which maps to
 * macOS Keychain, Windows DPAPI and Linux libsecret/kwallet. Kept as an interface here so this
 * package stays free of Electron and works the same on every OS.
 */
export interface SecretStore {
  get(name: string): Promise<Buffer | null>
  set(name: string, value: Buffer): Promise<void>
  delete(name: string): Promise<void>
}

export class MemorySecretStore implements SecretStore {
  private readonly map = new Map<string, Buffer>()
  async get(name: string) { return this.map.get(name) ?? null }
  async set(name: string, value: Buffer) { this.map.set(name, Buffer.from(value)) }
  async delete(name: string) { this.map.delete(name) }
}
