/**
 * Follows what is typed into a terminal and reports a command when Enter is pressed, but only when it is
 * safe to call it a command the person typed: plain printable keys (plus Backspace), nothing that edits
 * the line in ways we cannot see (Tab completion, arrow keys, history recall, paste with newlines), and
 * the caller must then confirm the terminal echoed it. A password typed at a prompt is not echoed, so it is
 * never reported.
 */
export class CommandTracker {
  private buf = ''
  private dirty = false

  /** Returns the candidate command when Enter ends a cleanly typed line, else null. */
  feed(data: string): string | null {
    if (data === '\r') {
      const line = this.buf.trim()
      const ok = !this.dirty && line.length > 0
      this.reset()
      return ok ? line : null
    }
    if (data.length > 1) {
      if (data.startsWith('\x1b') || /[\r\n\x00-\x08\x0b-\x1f]/.test(data)) this.dirty = true
      else this.buf += data // a pasted single line
      return null
    }
    if (data === '\x7f') this.buf = this.buf.slice(0, -1)
    else if (data === '\x03' || data === '\x15') this.reset() // Ctrl+C / Ctrl+U: the line is gone
    else if (data < ' ' || data === '\x1b') this.dirty = true // Tab, other control keys
    else this.buf += data
    return null
  }

  private reset(): void {
    this.buf = ''
    this.dirty = false
  }
}
