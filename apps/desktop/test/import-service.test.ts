import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { VaultStore } from '@mymius/vault'
import { ImportService } from '../src/main/import-service'
import { VaultService, type Result } from '../src/main/vault-service'
import type { ImportPreview, ImportSourceId } from '../src/shared/ipc'

const FAST = { memoryKiB: 64, iterations: 1, parallelism: 1 }
const PASS = 'a decent passphrase'
let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'mymius-imp-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

const ok = <T extends object>(r: Result<T>): Extract<Result<T>, { ok: true }> => {
  if (!r.ok) throw new Error('expected success, got: ' + r.error)
  return r
}

async function setup(file?: { name: string; text: string }, keepMs?: number, vaultName = 'vault.json') {
  const store = new VaultStore(join(dir, vaultName), { kdf: FAST })
  const vault = new VaultService(store, { readTextFile: (p) => readFile(p, 'utf8'), agentSocket: () => undefined })
  await vault.create(PASS, false)
  let path: string | undefined
  if (file) { path = join(dir, file.name); await writeFile(path, file.text) }
  const ctl = { path, picked: [] as ImportSourceId[] }
  const svc = new ImportService(vault, { defaultUser: 'me', pick: async (s) => { ctl.picked.push(s); return ctl.path }, ...(keepMs ? { keepMs } : {}) })
  return { store, vault, svc, ctl }
}
const preview = async (s: Awaited<ReturnType<typeof setup>>, src: ImportSourceId): Promise<ImportPreview> => ok(await s.svc.preview(src)).preview
const CONFIG = [
  'Host web-1',
  ' HostName 10.0.0.1',
  ' Port 2222',
  ' User deploy',
  ' IdentityFile ~/.ssh/web_key',
  'Host db',
  ' HostName 10.0.0.2',
  ' User root',
  'Host tokens',
  ' HostName %h.example.com',
  ' User x',
  ''
].join('\n')
const FILE = { name: 'config', text: CONFIG }
const SRC = 'ssh-config' as const

describe('previewing', () => {
  it('shows what would be imported, and what was left out and why', async () => {
    const s = await setup(FILE)
    const p = await preview(s, SRC)
    expect(p.items.map((i) => [i.name, i.auth, i.duplicate])).toEqual([['web-1', 'keyFile', false], ['db', 'agent', false]])
    expect(p.skipped.map((x) => x.label)).toEqual(['tokens'])
    expect(s.ctl.picked).toEqual([SRC])
  })
  it('flags hosts already in the vault by address, port and user', async () => {
    const s = await setup(FILE)
    ok(await s.vault.saveHost(undefined, { name: 'old name', host: '10.0.0.1', port: 2222, username: 'deploy', auth: { type: 'agent' } }))
    expect((await preview(s, SRC)).items.map((i) => i.duplicate)).toEqual([true, false])
  })
  it('the same machine on another port, or for another user, is not a duplicate; letter case in the host name does not matter', async () => {
    const s = await setup(FILE)
    ok(await s.vault.saveHost(undefined, { name: 'a', host: '10.0.0.1', port: 22, username: 'deploy', auth: { type: 'agent' } }))
    ok(await s.vault.saveHost(undefined, { name: 'b', host: '10.0.0.2', port: 22, username: 'someone-else', auth: { type: 'agent' } }))
    expect((await preview(s, SRC)).items.map((i) => i.duplicate)).toEqual([false, false])
    const t = await setup({ name: 'c', text: 'Host w\n HostName WEB.Example.com\n User u\n' }, undefined, 'vault2.json')
    ok(await t.vault.saveHost(undefined, { name: 'w', host: 'web.example.com', port: 22, username: 'u', auth: { type: 'agent' } }))
    expect((await preview(t, SRC)).items[0]!.duplicate).toBe(true)
  })
  it('explains a bad file, refuses a locked vault, and treats cancelling as no error', async () => {
    const s = await setup({ name: 'x.json', text: 'not json' })
    expect(await s.svc.preview('forklift')).toMatchObject({ ok: false, error: expect.stringMatching(/JSON/) })
    expect(await s.svc.preview('termius-csv')).toMatchObject({ ok: false })
    expect(await s.svc.preview('nonsense')).toMatchObject({ ok: false })
    s.ctl.path = undefined
    expect(await s.svc.preview('ssh-config')).toEqual({ ok: false, error: '' })
    s.ctl.path = join(dir, 'missing')
    expect(await s.svc.preview('ssh-config')).toMatchObject({ ok: false, error: expect.stringMatching(/Không tìm thấy/) })
    await s.store.lock()
    expect(await s.svc.preview('ssh-config')).toMatchObject({ ok: false })
  })
})

describe('importing', () => {
  it('adds only the chosen hosts, with their key file setting', async () => {
    const s = await setup(FILE)
    const p = await preview(s, SRC)
    const r = ok(await s.svc.commit(p.token, [p.items[0]!.id]))
    expect(r.outcome).toEqual({ created: 1, failed: [] })
    const listed = ok(s.vault.listHosts()).hosts
    expect(listed).toHaveLength(1)
    expect(listed[0]).toMatchObject({ name: 'web-1', host: '10.0.0.1', port: 2222, username: 'deploy', authType: 'keyFile' })
  })
  it('a preview can be confirmed once only, and unknown or forged ids add nothing', async () => {
    const s = await setup(FILE)
    const p = await preview(s, SRC)
    expect(ok(await s.svc.commit(p.token, ['99', 'x', '-1', '0', '0'])).outcome.created).toBe(1)
    expect(await s.svc.commit(p.token, ['1'])).toMatchObject({ ok: false, error: expect.stringMatching(/hết hạn/) })
    expect(await s.svc.commit('nope', [])).toMatchObject({ ok: false })
    expect(await s.svc.commit(p.token, 'all' as never)).toMatchObject({ ok: false })
  })
  it('a cancelled or expired preview cannot be confirmed, and a newer one replaces an older one', async () => {
    const s = await setup(FILE)
    const a = await preview(s, SRC)
    s.svc.cancel(a.token)
    expect(await s.svc.commit(a.token, ['0'])).toMatchObject({ ok: false })
    const b = await preview(s, SRC)
    const c = await preview(s, SRC)
    expect(await s.svc.commit(b.token, ['0'])).toMatchObject({ ok: false })
    expect(ok(await s.svc.commit(c.token, ['0'])).outcome.created).toBe(1)
  })
  it('drops what it holds when the vault locks', async () => {
    const s = await setup(FILE)
    const p = await preview(s, SRC)
    await s.store.lock()
    await s.store.unlock(PASS)
    expect(await s.svc.commit(p.token, ['0'])).toMatchObject({ ok: false })
  })
  it('expires by itself', async () => {
    const s = await setup(FILE, 30)
    const p = await preview(s, SRC)
    await new Promise((r) => setTimeout(r, 80))
    expect(await s.svc.commit(p.token, ['0'])).toMatchObject({ ok: false })
  })
  it('ssh config: key files stay as paths on this device, and ProxyJump is wired to the imported bastion', async () => {
    const cfg = 'Host bastion\n HostName b.example.com\n User jump\n IdentityFile ~/.ssh/b_key\nHost inner\n HostName 10.1.1.1\n User app\n ProxyJump bastion\nHost ghost\n HostName g.example.com\n User u\n ProxyJump nowhere\n'
    const s = await setup({ name: 'config', text: cfg })
    const p = await preview(s, 'ssh-config')
    expect(p.items.map((i) => [i.name, i.auth, i.jump])).toEqual([['bastion', 'keyFile', undefined], ['inner', 'agent', 'bastion'], ['ghost', 'agent', 'nowhere']])
    const r = ok(await s.svc.commit(p.token, p.items.map((i) => i.id)))
    expect(r.outcome.created).toBe(3)
    expect(r.outcome.failed).toEqual([{ name: 'ghost', error: expect.stringMatching(/không tìm thấy jump host "nowhere"/) }])
    const by = new Map(ok(s.vault.listHosts()).hosts.map((h) => [h.name, h]))
    expect(by.get('inner')!.jumpHostId).toBe(by.get('bastion')!.id)
    expect(by.get('bastion')!.authType).toBe('keyFile')
    expect(by.get('ghost')!.jumpHostId).toBeUndefined()
  })
  it('a jump host can be one that is already in the vault, and a missing one is reported without losing the host', async () => {
    const s = await setup({ name: 'config', text: 'Host inner\n HostName 10.1.1.1\n User app\n ProxyJump bastion\n' })
    const { id } = ok(await s.vault.saveHost(undefined, { name: 'bastion', host: 'b.example.com', port: 22, username: 'j', auth: { type: 'agent' } }))
    let p = await preview(s, 'ssh-config')
    expect(ok(await s.svc.commit(p.token, ['0'])).outcome).toEqual({ created: 1, failed: [] })
    expect(ok(s.vault.listHosts()).hosts.find((h) => h.name === 'inner')!.jumpHostId).toBe(id)

    await s.vault.deleteHost(ok(s.vault.listHosts()).hosts.find((h) => h.name === 'inner')!.id)
    await s.vault.deleteHost(id)
    p = await preview(s, 'ssh-config')
    const r = ok(await s.svc.commit(p.token, ['0']))
    expect(r.outcome.created).toBe(1)
    expect(r.outcome.failed[0]).toMatchObject({ name: 'inner', error: expect.stringMatching(/không tìm thấy jump host/) })
  })
  it('importing counts as adding hosts (one backup covers it)', async () => {
    const s = await setup(FILE)
    let changed = 0
    s.store.on('changed', () => changed++)
    const p = await preview(s, SRC)
    ok(await s.svc.commit(p.token, ['0', '1']))
    expect(changed).toBeGreaterThan(0)
  })
})
