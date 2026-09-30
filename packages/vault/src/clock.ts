/**
 * Hybrid logical clock. Timestamps sort correctly as plain strings, follow wall time, and stay
 * monotonic even when a device's clock is behind the one that wrote a record it just received.
 * Format: <wall ms, 15 digits>-<counter, 5 digits>-<node id>
 */
export class HybridClock {
  private wall = 0
  private counter = 0

  constructor(
    private readonly node: string,
    private readonly now: () => number = Date.now
  ) {}

  tick(): string {
    const t = this.now()
    if (t > this.wall) {
      this.wall = t
      this.counter = 0
    } else {
      this.counter++
    }
    return this.format()
  }

  /** Call for every remote timestamp seen so local edits always sort after what we have read. */
  receive(remote: string): void {
    const [w, c] = remote.split('-')
    const rw = Number(w)
    const rc = Number(c)
    if (!Number.isFinite(rw) || !Number.isFinite(rc)) return
    const wall = Math.max(this.wall, rw, this.now())
    if (wall === this.wall && wall === rw) this.counter = Math.max(this.counter, rc) + 1
    else if (wall === this.wall) this.counter++
    else if (wall === rw) this.counter = rc + 1
    else this.counter = 0
    this.wall = wall
  }

  private format(): string {
    return `${String(this.wall).padStart(15, '0')}-${String(this.counter).padStart(5, '0')}-${this.node}`
  }
}
