import { RemoteEditSession } from './session'
import type { RemoteEditDeps } from './types'

/** Tracks every open editing session so the UI can list them and shut them down together. */
export class RemoteEditManager {
  private readonly sessions = new Map<string, RemoteEditSession>()

  async open(deps: RemoteEditDeps): Promise<RemoteEditSession> {
    const session = new RemoteEditSession(deps)
    await session.open()
    this.sessions.set(session.id, session)
    return session
  }

  get(id: string): RemoteEditSession | undefined {
    return this.sessions.get(id)
  }

  list(): RemoteEditSession[] {
    return [...this.sessions.values()]
  }

  async close(id: string, opts?: { discard?: boolean }): Promise<void> {
    const s = this.sessions.get(id)
    if (!s) return
    await s.close(opts)
    this.sessions.delete(id)
  }

  async closeAll(opts?: { discard?: boolean }): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((id) => this.close(id, opts)))
  }
}
