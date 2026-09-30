import { createHash, timingSafeEqual } from 'node:crypto'
import * as fs from 'node:fs'
import { realpathSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { Server, utils } from 'ssh2'

const { STATUS_CODE, flagsToString } = utils.sftp

/**
 * ssh2's own generator emits an unparseable ed25519 key about 1 time in 100, so generate until the
 * result round-trips. (Relevant later: an in-app "generate key" feature must verify its output too.)
 */
export function generateEd25519(): { private: string; public: string } {
  for (let i = 0; i < 20; i++) {
    const k = utils.generateKeyPairSync('ed25519')
    if (!(utils.parseKey(k.private) instanceof Error) && !(utils.parseKey(k.public) instanceof Error)) return k
  }
  throw new Error('could not generate a valid ed25519 key')
}

export interface TestServerOptions {
  user?: string
  password?: string
  /** OpenSSH public key line accepted for publickey auth. */
  authorizedKey?: string
  /** false: reject exec requests, like an SFTP-only account. */
  exec?: boolean
}

export interface TestServer {
  port: number
  /** SHA256:... fingerprint of the host key, as OpenSSH would print it. */
  fingerprint: string
  /** Every exec command received, in order. */
  commands: string[]
  /** Names of SFTP extended requests received. */
  extended: string[]
  close(): Promise<void>
}

type Handle =
  | { kind: 'file'; fd: number; path: string }
  | { kind: 'dir'; path: string; sent: boolean }

/**
 * A small in-process SFTP + exec server serving `root` on disk. It mimics the parts of OpenSSH
 * that matter for the provider: whole-second mtimes, "." and ".." in listings, and a rename that
 * refuses to replace an existing target.
 */
export async function startSftpServer(root: string, opts: TestServerOptions = {}): Promise<TestServer> {
  const user = opts.user ?? 'tester'
  const password = opts.password ?? 'secret'
  const realRoot = realpathSync(root)
  const hostKey = generateEd25519()
  const parsedHost = utils.parseKey(hostKey.private)
  if (parsedHost instanceof Error) throw parsedHost
  const fingerprint = 'SHA256:' + createHash('sha256').update(parsedHost.getPublicSSH()).digest('base64').replace(/=+$/, '')
  const allowedKey = opts.authorizedKey ? utils.parseKey(opts.authorizedKey) : undefined

  const clients = new Set<{ end(): void }>()
  const commands: string[] = []
  const extended: string[] = []

  const real = (p: string): string => path.join(realRoot, ...path.posix.normalize('/' + p).split('/').filter(Boolean))
  const attrsOf = (st: fs.Stats) => ({
    mode: st.mode,
    uid: st.uid,
    gid: st.gid,
    size: st.size,
    atime: Math.floor(st.atimeMs / 1000),
    mtime: Math.floor(st.mtimeMs / 1000)
  })
  const code = (err: unknown): number => {
    switch ((err as NodeJS.ErrnoException).code) {
      case 'ENOENT': return STATUS_CODE.NO_SUCH_FILE
      case 'EACCES': case 'EPERM': return STATUS_CODE.PERMISSION_DENIED
      default: return STATUS_CODE.FAILURE
    }
  }

  const server = new Server({ hostKeys: [hostKey.private] }, (client) => {
    ;(client as unknown as { setNoDelay(v: boolean): void }).setNoDelay(true) // missing from @types/ssh2
    clients.add(client)
    client.on('close', () => clients.delete(client))
    client.on('authentication', (ctx) => {
      if (ctx.username !== user) return ctx.reject()
      if (ctx.method === 'password' && ctx.password === password) return ctx.accept()
      if (ctx.method === 'publickey' && allowedKey && !(allowedKey instanceof Error)) {
        const same =
          ctx.key.algo === allowedKey.type &&
          ctx.key.data.length === allowedKey.getPublicSSH().length &&
          timingSafeEqual(ctx.key.data, allowedKey.getPublicSSH())
        if (!same) return ctx.reject()
        if (ctx.signature && allowedKey.verify(ctx.blob as Buffer, ctx.signature, ctx.hashAlgo) !== true) return ctx.reject()
        return ctx.accept()
      }
      ctx.reject(['password', 'publickey'])
    })
    client.on('error', () => {})
    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept()

        session.on('exec', (acceptExec, rejectExec, info) => {
          if (opts.exec === false) return rejectExec()
          const stream = acceptExec()
          commands.push(info.command)
          const m = /^(?:sha256sum|shasum -a 256) -- '((?:[^']|'\\'')*)'$/.exec(info.command)
          if (info.command.startsWith('command -v')) {
            stream.write('sha256sum\n')
            stream.exit(0)
          } else if (m) {
            const p = (m[1] as string).replace(/'\\''/g, "'")
            try {
              stream.write(createHash('sha256').update(fs.readFileSync(real(p))).digest('hex') + '  ' + p + '\n')
              stream.exit(0)
            } catch {
              stream.stderr.write(`sha256sum: ${p}: No such file or directory\n`)
              stream.exit(1)
            }
          } else {
            stream.stderr.write('unsupported command\n')
            stream.exit(127)
          }
          stream.end()
        })

        session.on('sftp', (acceptSftp) => {
          const sftp = acceptSftp()
          const handles = new Map<number, Handle>()
          let next = 1
          const newHandle = (h: Handle): Buffer => {
            const id = next++
            handles.set(id, h)
            const b = Buffer.alloc(4)
            b.writeUInt32BE(id, 0)
            return b
          }
          const get = (b: Buffer): Handle | undefined => (b.length === 4 ? handles.get(b.readUInt32BE(0)) : undefined)
          const fail = (reqid: number, err: unknown) => sftp.status(reqid, code(err))

          sftp.on('REALPATH', (reqid, p) => {
            let resolved: string
            try {
              resolved = fs.realpathSync(real(p))
            } catch {
              resolved = real(p)
            }
            const rel = '/' + path.relative(realRoot, resolved).split(path.sep).filter(Boolean).join('/')
            sftp.name(reqid, [{ filename: rel, longname: rel, attrs: {} as never }])
          })
          sftp.on('STAT', (reqid, p) => {
            try { sftp.attrs(reqid, attrsOf(fs.statSync(real(p)))) } catch (e) { fail(reqid, e) }
          })
          sftp.on('LSTAT', (reqid, p) => {
            try { sftp.attrs(reqid, attrsOf(fs.lstatSync(real(p)))) } catch (e) { fail(reqid, e) }
          })
          sftp.on('FSTAT', (reqid, h) => {
            const f = get(h)
            if (f?.kind !== 'file') return sftp.status(reqid, STATUS_CODE.FAILURE)
            try { sftp.attrs(reqid, attrsOf(fs.fstatSync(f.fd))) } catch (e) { fail(reqid, e) }
          })
          const applyAttrs = (target: string, attrs: { mode?: number; atime?: number; mtime?: number }) => {
            if (attrs.mode !== undefined) fs.chmodSync(target, attrs.mode & 0o7777)
            if (attrs.mtime !== undefined) fs.utimesSync(target, attrs.atime ?? attrs.mtime, attrs.mtime)
          }
          sftp.on('SETSTAT', (reqid, p, attrs) => {
            try { applyAttrs(real(p), attrs); sftp.status(reqid, STATUS_CODE.OK) } catch (e) { fail(reqid, e) }
          })
          sftp.on('OPEN', (reqid, filename, flags, attrs) => {
            const mode = flagsToString(flags)
            if (!mode) return sftp.status(reqid, STATUS_CODE.FAILURE)
            try {
              const fd = fs.openSync(real(filename), mode, attrs.mode !== undefined ? attrs.mode & 0o7777 : 0o644)
              sftp.handle(reqid, newHandle({ kind: 'file', fd, path: filename }))
            } catch (e) { fail(reqid, e) }
          })
          sftp.on('READ', (reqid, h, offset, length) => {
            const f = get(h)
            if (f?.kind !== 'file') return sftp.status(reqid, STATUS_CODE.FAILURE)
            const buf = Buffer.alloc(length)
            try {
              const n = fs.readSync(f.fd, buf, 0, length, offset)
              if (n === 0) sftp.status(reqid, STATUS_CODE.EOF)
              else sftp.data(reqid, buf.subarray(0, n))
            } catch (e) { fail(reqid, e) }
          })
          sftp.on('WRITE', (reqid, h, offset, data) => {
            const f = get(h)
            if (f?.kind !== 'file') return sftp.status(reqid, STATUS_CODE.FAILURE)
            try { fs.writeSync(f.fd, data, 0, data.length, offset); sftp.status(reqid, STATUS_CODE.OK) } catch (e) { fail(reqid, e) }
          })
          sftp.on('FSETSTAT', (reqid, h, attrs) => {
            const f = get(h)
            if (f?.kind !== 'file') return sftp.status(reqid, STATUS_CODE.FAILURE)
            try { applyAttrs(real(f.path), attrs); sftp.status(reqid, STATUS_CODE.OK) } catch (e) { fail(reqid, e) }
          })
          sftp.on('CLOSE', (reqid, h) => {
            const f = get(h)
            if (!f) return sftp.status(reqid, STATUS_CODE.FAILURE)
            if (f.kind === 'file') fs.closeSync(f.fd)
            handles.delete(h.readUInt32BE(0))
            sftp.status(reqid, STATUS_CODE.OK)
          })
          sftp.on('OPENDIR', (reqid, p) => {
            try {
              if (!fs.statSync(real(p)).isDirectory()) return sftp.status(reqid, STATUS_CODE.FAILURE)
              sftp.handle(reqid, newHandle({ kind: 'dir', path: p, sent: false }))
            } catch (e) { fail(reqid, e) }
          })
          sftp.on('READDIR', (reqid, h) => {
            const d = get(h)
            if (d?.kind !== 'dir') return sftp.status(reqid, STATUS_CODE.FAILURE)
            if (d.sent) return sftp.status(reqid, STATUS_CODE.EOF)
            d.sent = true
            try {
              const dir = real(d.path)
              const names = ['.', '..', ...fs.readdirSync(dir)]
              sftp.name(reqid, names.map((n) => {
                const st = fs.lstatSync(path.join(dir, n))
                return { filename: n, longname: n, attrs: attrsOf(st) }
              }))
            } catch (e) { fail(reqid, e) }
          })
          sftp.on('MKDIR', (reqid, p) => {
            try { fs.mkdirSync(real(p)); sftp.status(reqid, STATUS_CODE.OK) } catch (e) { fail(reqid, e) }
          })
          sftp.on('RMDIR', (reqid, p) => {
            try { fs.rmdirSync(real(p)); sftp.status(reqid, STATUS_CODE.OK) } catch (e) { fail(reqid, e) }
          })
          sftp.on('REMOVE', (reqid, p) => {
            try { fs.unlinkSync(real(p)); sftp.status(reqid, STATUS_CODE.OK) } catch (e) { fail(reqid, e) }
          })
          sftp.on('RENAME', (reqid, from, to) => {
            // SFTP v3 semantics as enforced by OpenSSH: never replaces an existing target.
            if (fs.existsSync(real(to))) return sftp.status(reqid, STATUS_CODE.FAILURE)
            try { fs.renameSync(real(from), real(to)); sftp.status(reqid, STATUS_CODE.OK) } catch (e) { fail(reqid, e) }
          })
          sftp.on('EXTENDED', (reqid, name, data: Buffer) => {
            extended.push(name)
            if (name !== 'posix-rename@openssh.com') return sftp.status(reqid, STATUS_CODE.OP_UNSUPPORTED)
            const fromLen = data.readUInt32BE(0)
            const from = data.subarray(4, 4 + fromLen).toString()
            const toLen = data.readUInt32BE(4 + fromLen)
            const to = data.subarray(8 + fromLen, 8 + fromLen + toLen).toString()
            try { fs.renameSync(real(from), real(to)); sftp.status(reqid, STATUS_CODE.OK) } catch (e) { fail(reqid, e) }
          })
        })
      })
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return {
    port,
    fingerprint,
    commands,
    extended,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
        for (const c of clients) c.end() // server.close() alone waits for live sessions forever
      })
  }
}
