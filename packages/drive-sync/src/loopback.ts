import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { OAuthCancelledError, OAuthDeniedError, OAuthTimeoutError } from './errors'

export interface Loopback {
  /** Where to tell the authorization server to send the browser back to. */
  redirectUri: string
  /** Resolves with the authorization code once the browser comes back with the right state. */
  code: Promise<string>
  cancel(): void
  close(): Promise<void>
}

const PAGE = (title: string, body: string): string =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font:16px system-ui;max-width:32em;margin:15vh auto;padding:0 1em"><h2>${title}</h2><p>${body}</p>`

/**
 * The one-shot local web server that catches the browser's redirect at the end of the sign-in.
 *
 * It listens on 127.0.0.1 only, answers a single path, and accepts a result only when the `state`
 * value matches the one we generated: other pages that poke at the port cannot complete or spoil the
 * sign-in. It also checks the Host header so a DNS-rebinding page cannot talk to it.
 */
export async function startLoopback(opts: { state: string; timeoutMs: number }): Promise<Loopback> {
  let settle!: { resolve(c: string): void; reject(e: Error): void }
  const code = new Promise<string>((resolve, reject) => { settle = { resolve, reject } })
  code.catch(() => undefined) // the caller decides when to look; never an unhandled rejection
  let done = false
  let server: Server

  const finish = (fn: () => void): void => {
    if (done) return
    done = true
    fn()
  }

  server = createServer((req, res) => {
    const port = (server.address() as AddressInfo).port
    const headers = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'" }
    const reply = (status: number, title: string, body: string): void => { res.writeHead(status, headers); res.end(PAGE(title, body)) }

    if (req.headers.host !== `127.0.0.1:${port}`) return reply(400, 'Bad request', 'Unexpected host.')
    if (req.method !== 'GET') return reply(405, 'Not allowed', 'Only GET is accepted here.')
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)
    if (url.pathname !== '/callback') return reply(404, 'Not found', 'Nothing here.')
    if (done) return reply(410, 'Already finished', 'This sign-in has already been completed. You can close this tab.')
    if (url.searchParams.get('state') !== opts.state) return reply(400, 'Sign-in not recognised', 'This request did not come from the sign-in this app started, so it was ignored.')

    const error = url.searchParams.get('error')
    const authCode = url.searchParams.get('code')
    if (error) {
      reply(200, 'Sign-in was not completed', 'You can close this tab and return to the app.')
      return finish(() => settle.reject(new OAuthDeniedError(error)))
    }
    if (!authCode) return reply(400, 'Sign-in incomplete', 'No authorization code was received.')
    reply(200, 'You are signed in', 'You can close this tab and return to the app.')
    finish(() => settle.resolve(authCode))
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const port = (server.address() as AddressInfo).port
  const timer = setTimeout(() => finish(() => settle.reject(new OAuthTimeoutError())), opts.timeoutMs)
  timer.unref()

  const close = (): Promise<void> => {
    clearTimeout(timer)
    server.closeAllConnections()
    return new Promise((resolve) => server.close(() => resolve()))
  }
  void code.then(close, close)

  return {
    redirectUri: `http://127.0.0.1:${port}/callback`,
    code,
    cancel: () => finish(() => settle.reject(new OAuthCancelledError())),
    close
  }
}
