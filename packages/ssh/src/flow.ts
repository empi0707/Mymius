/**
 * Coalesces many small chunks into few large ones so the UI is not flooded with IPC messages
 * (a `cat bigfile` can produce thousands of tiny SSH packets per second).
 */
export class OutputBatcher {
  private chunks: Buffer[] = []
  private size = 0
  private timer: ReturnType<typeof setTimeout> | undefined

  constructor(
    private readonly flush: (data: Buffer) => void,
    private readonly opts: { intervalMs?: number; maxBytes?: number } = {}
  ) {}

  push(chunk: Buffer): void {
    this.chunks.push(chunk)
    this.size += chunk.length
    if (this.size >= (this.opts.maxBytes ?? 64 * 1024)) return this.flushNow()
    // The first byte of a burst goes out on the next tick so typing echo stays snappy.
    this.timer ??= setTimeout(() => this.flushNow(), this.opts.intervalMs ?? 8)
  }

  flushNow(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    if (this.size === 0) return
    const data = Buffer.concat(this.chunks, this.size)
    this.chunks = []
    this.size = 0
    this.flush(data)
  }

  dispose(): void {
    this.flushNow()
  }
}

/**
 * Ack-based back-pressure. The receiver reports how many bytes it has actually rendered; while too
 * many are outstanding we pause the SSH channel, so the remote program slows down instead of the app
 * buffering without bound (`yes` or `cat /dev/urandom` would otherwise exhaust memory).
 */
export class FlowControl {
  private outstanding = 0
  private paused = false

  constructor(
    private readonly hooks: { pause(): void; resume(): void },
    private readonly highWater = 512 * 1024,
    private readonly lowWater = 128 * 1024
  ) {}

  sent(bytes: number): void {
    this.outstanding += bytes
    if (!this.paused && this.outstanding > this.highWater) {
      this.paused = true
      this.hooks.pause()
    }
  }

  acked(bytes: number): void {
    this.outstanding = Math.max(0, this.outstanding - bytes)
    if (this.paused && this.outstanding <= this.lowWater) {
      this.paused = false
      this.hooks.resume()
    }
  }

  get isPaused(): boolean {
    return this.paused
  }
}
