import type { SshConnection } from './connection'

interface Slot {
  connection: Promise<SshConnection>
  refs: number
}

/**
 * Shares one SSH connection between everything talking to the same host: several terminal tabs and a
 * file pane cost a single login. The connection is closed when the last user releases it, and a
 * dropped connection is transparently replaced on the next acquire.
 */
export class ConnectionPool {
  private readonly slots = new Map<string, Slot>()

  async acquire(key: string, connect: () => Promise<SshConnection>): Promise<SshConnection> {
    let slot = this.slots.get(key)
    if (slot) {
      const existing = await slot.connection.catch(() => undefined)
      if (existing && !existing.closed) {
        slot.refs++
        return existing
      }
      // Stale: it failed or dropped. Start over, but do not disturb people still holding the old one.
      if (this.slots.get(key) === slot) this.slots.delete(key)
    }
    slot = { connection: connect(), refs: 1 }
    this.slots.set(key, slot)
    try {
      return await slot.connection
    } catch (err) {
      if (this.slots.get(key) === slot) this.slots.delete(key)
      throw err
    }
  }

  async release(key: string, connection: SshConnection): Promise<void> {
    const slot = this.slots.get(key)
    if (!slot || (await slot.connection.catch(() => undefined)) !== connection) {
      // Belonged to a replaced slot; nobody else tracks it.
      return
    }
    if (--slot.refs > 0) return
    this.slots.delete(key)
    await connection.dispose()
  }

  get size(): number {
    return this.slots.size
  }
}
