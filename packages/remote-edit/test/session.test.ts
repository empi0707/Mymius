import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LocalProvider } from '../../providers/src'
import { RemoteEditSession, type ConflictChoice, type ConflictContext } from '../src'

let root: string
let remote: string
let work: string
const T0 = 1_700_000_000

/** Stands in for the server: a different folder on disk, with a hook to simulate a concurrent writer. */
class Server extends LocalProvider {
  /** Runs once, when the first temp file is created; later stat() calls wait for it to finish. */
  onTempCreate?: () => Promise<void>
  private hookDone?: Promise<void>

  override createWriteStream(path: string, opts?: Parameters<LocalProvider['createWriteStream']>[1]) {
    if (path.endsWith('.tmp') && this.onTempCreate) {
      this.hookDone = this.onTempCreate()
      this.onTempCreate = undefined
    }
    return super.createWriteStream(path, opts)
  }

  override async stat(path: string) {
    await this.hookDone
    return super.stat(path)
  }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'mymius-edit-'))
  remote = join(root, 'server')
  work = join(root, 'work')
  await mkdir(remote)
  await mkdir(work)
  await writeFile(join(remote, 'app.conf'), 'listen 80;\n')
  await utimes(join(remote, 'app.conf'), T0, T0)
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

const remoteFile = () => join(remote, 'app.conf')
const serverEdits = async (content: string, mtime = T0 + 500) => {
  await writeFile(remoteFile(), content)
  await utimes(remoteFile(), mtime, mtime)
}

async function openSession(choice: ConflictChoice = 'cancel', provider: LocalProvider = new LocalProvider()) {
  const asked: ConflictContext[] = []
  const openInEditor = vi.fn(async () => {})
  const s = new RemoteEditSession({
    provider,
    remotePath: remoteFile(),
    workRoot: work,
    openInEditor,
    watch: () => ({ close: async () => {} }), // tests drive saves explicitly
    resolveConflict: async (ctx) => { asked.push(ctx); return choice }
  })
  await s.open()
  return { s, asked, openInEditor }
}
const userSaves = async (s: RemoteEditSession, content: string) => {
  await writeFile(s.localPath, content)
  return s.handleLocalChange()
}

describe('open', () => {
  it('downloads to a private work folder and launches the editor', async () => {
    const { s, openInEditor } = await openSession()
    expect(await readFile(s.localPath, 'utf8')).toBe('listen 80;\n')
    expect(openInEditor).toHaveBeenCalledWith(s.localPath)
    expect(s.state).toBe('synced')
    if (process.platform !== 'win32') expect((await stat(s.localPath)).mode & 0o777).toBe(0o600)
  })

  it('does not trust a hostile remote file name', async () => {
    await writeFile(join(remote, 'evil name?.conf'), 'x')
    const s = new RemoteEditSession({
      provider: new LocalProvider(), remotePath: join(remote, 'evil name?.conf'), workRoot: work,
      openInEditor: async () => {}, watch: () => ({ close: async () => {} }), resolveConflict: async () => 'cancel'
    })
    await s.open()
    expect(s.localPath.startsWith(join(work, s.id))).toBe(true)
  })
})

describe('saving without a conflict', () => {
  it('uploads the new content', async () => {
    const { s, asked } = await openSession()
    expect(await userSaves(s, 'listen 8080;\n')).toBe('uploaded')
    expect(await readFile(remoteFile(), 'utf8')).toBe('listen 8080;\n')
    expect(asked).toEqual([])
    expect(s.state).toBe('synced')
  })

  it('skips the upload when the saved bytes did not change', async () => {
    const { s } = await openSession()
    expect(await userSaves(s, 'listen 80;\n')).toBe('unchanged')
  })

  it('a second save after the first upload works (baseline was refreshed)', async () => {
    const { s, asked } = await openSession()
    await userSaves(s, 'one\n')
    expect(await userSaves(s, 'two\n')).toBe('uploaded')
    expect(asked).toEqual([])
    expect(await readFile(remoteFile(), 'utf8')).toBe('two\n')
  })

  it('a server-side touch (same content, new mtime) is not a conflict', async () => {
    const { s, asked } = await openSession()
    await utimes(remoteFile(), T0 + 9999, T0 + 9999)
    expect(await userSaves(s, 'mine\n')).toBe('uploaded')
    expect(asked).toEqual([])
  })

  it('leaves no stray temp or snapshot files on the server or in the work folder', async () => {
    const { s } = await openSession()
    await userSaves(s, 'x\n')
    expect(await readdir(remote)).toEqual(['app.conf'])
    expect((await readdir(join(work, s.id))).filter((n) => n.startsWith('.'))).toEqual([])
  })
})

describe('server changed while editing', () => {
  it('overwrite: local content replaces the server copy', async () => {
    const { s, asked } = await openSession('overwrite')
    await serverEdits('someone else\n')
    expect(await userSaves(s, 'mine\n')).toBe('uploaded')
    expect(asked).toHaveLength(1)
    expect(asked[0]?.kind).toBe('modified')
    expect(await readFile(remoteFile(), 'utf8')).toBe('mine\n')
    expect(s.state).toBe('synced')
  })

  it('reload: local copy takes the server content and the user edits survive in a side file', async () => {
    const { s } = await openSession('reload')
    await serverEdits('someone else\n')
    expect(await userSaves(s, 'my precious edits\n')).toBe('reloaded')
    expect(await readFile(remoteFile(), 'utf8')).toBe('someone else\n')
    expect(await readFile(s.localPath, 'utf8')).toBe('someone else\n')
    const backups = (await readdir(join(work, s.id))).filter((n) => n.includes('.local-'))
    expect(backups).toHaveLength(1)
    expect(await readFile(join(work, s.id, backups[0] as string), 'utf8')).toBe('my precious edits\n')
    expect(await s.handleLocalChange()).toBe('unchanged') // our own write must not re-trigger an upload
  })

  it('cancel: nothing is uploaded, and the same unchanged state does not nag again', async () => {
    const { s, asked } = await openSession('cancel')
    await serverEdits('someone else\n')
    expect(await userSaves(s, 'mine\n')).toBe('cancelled')
    expect(s.state).toBe('unsynced')
    expect(await readFile(remoteFile(), 'utf8')).toBe('someone else\n')
    expect(await s.handleLocalChange()).toBe('cancelled')
    expect(asked).toHaveLength(1)
  })

  it('cancel then edit again asks again', async () => {
    const { s, asked } = await openSession('cancel')
    await serverEdits('someone else\n')
    await userSaves(s, 'mine\n')
    await userSaves(s, 'mine, revised\n')
    expect(asked).toHaveLength(2)
  })

  it('a change that lands between the check and the write is caught, not overwritten silently', async () => {
    const server = new Server()
    const { s, asked } = await openSession('cancel', server)
    server.onTempCreate = async () => { await serverEdits('sneaky concurrent write\n') }
    await writeFile(s.localPath, 'mine\n')
    const outcome = await s.handleLocalChange()
    expect(outcome).toBe('cancelled')
    expect(asked).toHaveLength(1)
    expect(await readFile(remoteFile(), 'utf8')).toBe('sneaky concurrent write\n')
  })
})

describe('server file deleted while editing', () => {
  it('overwrite recreates it from the local copy', async () => {
    const { s, asked } = await openSession('overwrite')
    await rm(remoteFile())
    expect(await userSaves(s, 'still here\n')).toBe('recreated')
    expect(asked[0]?.kind).toBe('deleted')
    expect(await readFile(remoteFile(), 'utf8')).toBe('still here\n')
  })

  it('cancel keeps working copy and does not recreate', async () => {
    const { s } = await openSession('cancel')
    await rm(remoteFile())
    expect(await userSaves(s, 'x\n')).toBe('cancelled')
    await expect(stat(remoteFile())).rejects.toThrow()
  })
})

describe('close', () => {
  it('removes the work folder when everything is synced', async () => {
    const { s } = await openSession()
    await userSaves(s, 'x\n')
    expect((await s.close()).kept).toBe(false)
    expect(await readdir(work)).toEqual([])
  })

  it('keeps unsynced work so nothing is lost, unless told to discard', async () => {
    const { s } = await openSession('cancel')
    await serverEdits('other\n')
    await userSaves(s, 'unsaved to server\n')
    const r = await s.close()
    expect(r.kept).toBe(true)
    expect(await readFile(s.localPath, 'utf8')).toBe('unsaved to server\n')
  })
})
