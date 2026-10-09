import type { ClientChannel } from 'ssh2'
import type { TerminalExit, TerminalSession } from '@mymius/core'

/** An interactive shell on an SSH channel, exposed as a TerminalSession. */
export class ShellSession implements TerminalSession {
  private dataListeners: ((d: Buffer) => void)[] = []
  private exitListeners: ((e: TerminalExit) => void)[] = []
  /** The shell prints its prompt immediately, usually before the UI has subscribed. Keep it. */
  private early: Buffer[] = []
  private exit: TerminalExit | undefined
  private closed = false

  constructor(private readonly channel: ClientChannel) {
    channel.on('data', (d: Buffer) => {
      if (this.dataListeners.length === 0) this.early.push(d)
      else for (const l of this.dataListeners) l(d)
    })
    channel.on('exit', (code: number | null, signal: string | null) => {
      this.exit = { ...(code !== null ? { code } : {}), ...(signal ? { signal } : {}) }
    })
    channel.on('error', (error: Error) => {
      this.exit = { ...this.exit, error }
    })
    channel.on('close', () => {
      this.closed = true
      const info = this.exit ?? {}
      for (const l of this.exitListeners) l(info)
    })
  }

  // When the connection is lost ssh2 can throw from these (the channel or its protocol is already gone) a moment before
  // it reports the close. An exception here would surface as an uncaught error in the main process, so it is swallowed:
  // the 'close' event that follows tells the person the session ended.
  write(data: string | Uint8Array): void {
    if (!this.closed) this.safely(() => this.channel.write(data))
  }

  resize(cols: number, rows: number): void {
    if (!this.closed) this.safely(() => this.channel.setWindow(rows, cols, 0, 0))
  }

  pause(): void {
    this.safely(() => this.channel.pause())
  }

  resume(): void {
    this.safely(() => this.channel.resume())
  }

  private safely(fn: () => void): void {
    try { fn() } catch { /* the connection is going away */ }
  }

  onData(listener: (data: Buffer) => void): void {
    this.dataListeners.push(listener)
    if (this.early.length) {
      const pending = this.early
      this.early = []
      for (const chunk of pending) listener(chunk)
    }
  }

  onExit(listener: (info: TerminalExit) => void): void {
    if (this.closed) return listener(this.exit ?? {})
    this.exitListeners.push(listener)
  }

  close(): void {
    if (!this.closed) this.safely(() => this.channel.close())
  }
}
