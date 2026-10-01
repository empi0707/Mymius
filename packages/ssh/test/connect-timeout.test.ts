import { createServer, type Server, type Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { SshConnection } from '../src/connection'

let silent: Server | undefined
const sockets = new Set<Socket>()
afterEach(() => new Promise<void>((r) => {
  for (const s of sockets) s.destroy()
  sockets.clear()
  silent ? silent.close(() => r()) : r()
}))

describe('a server that accepts the TCP connection but never speaks SSH (overloaded)', () => {
  it('fails with the handshake timeout, and the second error ssh2 emits does not crash the process', async () => {
    silent = createServer((s) => { sockets.add(s) /* accept, say nothing */ })
    await new Promise<void>((r) => silent!.listen(0, '127.0.0.1', r))
    const port = (silent.address() as { port: number }).port
    const uncaught: Error[] = []
    const onUncaught = (e: Error): void => { uncaught.push(e) }
    process.on('uncaughtException', onUncaught)
    try {
      await expect(
        SshConnection.connect({ host: '127.0.0.1', port, username: 'u', password: 'p', readyTimeoutMs: 300, verifyHostKey: () => true })
      ).rejects.toThrow(/handshake/i)
      await new Promise((r) => setTimeout(r, 300)) // ssh2 follows up with "Connection lost before handshake"
    } finally {
      process.off('uncaughtException', onUncaught)
    }
    expect(uncaught).toEqual([])
  })
})
