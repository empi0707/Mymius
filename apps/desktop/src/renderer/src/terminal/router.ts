import type { TerminalApi, TerminalDataEvent, TerminalExitEvent } from '../../../shared/ipc'

interface Handlers {
  onData(data: Uint8Array): void
  onExit(e: TerminalExitEvent): void
}

/**
 * Fans the two global terminal event streams out to the tab that owns each session id.
 *
 * Output can arrive before the tab has been told its session id (the reply to `open` and the first
 * bytes of the prompt race each other across IPC), so events for unknown ids are held until someone
 * registers for them, instead of being dropped.
 */
export class TerminalRouter {
  private readonly handlers = new Map<string, Handlers>()
  private readonly pendingData = new Map<string, Uint8Array[]>()
  private readonly pendingExit = new Map<string, TerminalExitEvent>()
  private readonly unsubscribe: (() => void)[]

  constructor(api: Pick<TerminalApi, 'onData' | 'onExit'>) {
    this.unsubscribe = [api.onData((e) => this.data(e)), api.onExit((e) => this.exit(e))]
  }

  register(id: string, h: Handlers): () => void {
    this.handlers.set(id, h)
    for (const chunk of this.pendingData.get(id) ?? []) h.onData(chunk)
    this.pendingData.delete(id)
    const exit = this.pendingExit.get(id)
    if (exit) {
      this.pendingExit.delete(id)
      h.onExit(exit)
    }
    return () => this.handlers.delete(id)
  }

  private data(e: TerminalDataEvent): void {
    const h = this.handlers.get(e.id)
    if (h) return h.onData(e.data)
    const list = this.pendingData.get(e.id) ?? []
    list.push(e.data)
    this.pendingData.set(e.id, list)
  }

  private exit(e: TerminalExitEvent): void {
    const h = this.handlers.get(e.id)
    if (h) h.onExit(e)
    else this.pendingExit.set(e.id, e)
  }

  dispose(): void {
    for (const u of this.unsubscribe) u()
  }
}
