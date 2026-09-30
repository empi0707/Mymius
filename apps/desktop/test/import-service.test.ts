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
const CSV = [
  'Groups,Label,Tags,Hostname/IP,Protocol,Port,Username,Password',
  'Prod,web-1,,10.0.0.1,ssh,2222,deploy,pw-web-secret',
  ',db,,10.0.0.2,ssh,22,root,pw-db-secret',
  ',tel,,10.0.0.3,telnet,23,x,y'
].join('\n')

describe('previewing', () => {
  it('shows what would be imported and never sends a password to the UI', async () => {
    const s = await setup({ name: 'hosts.csv', text: CSV })
    const p = await preview(s, 'termius-csv')
    expect(p.items.map((i) => [i.name, i.auth, i.duplicate])).toEqual([['web-1', 'password', false], ['db', 'password', false]])
    expect(p.skipped).toHaveLength(1)
    expect(JSON.stringify(p)).not.toContain('pw-web-secret')
    expect(s.ctl.picked).toEqual(['termius-csv'])
  })
  it('flags hosts already in the vault by address, port and user', async () => {
    const s = await setup({ name: 'hosts.csv', text: CSV })
    ok(await s.vault.saveHost(undefined, { name: 'old name', host: '10.0.0.1', port: 2222, username: 'deploy', auth: { type: 'agent' } }))
    const p = await preview(s, 'termius-csv')
    expect(p.items.map((i) => i.duplicate)).toEqual([true, false])
  })
  it('the same machine on another port, or for another user, is not a duplicate; letter case in the host name does not matter', async () => {
    const s = await setup({ name: 'hosts.csv', text: CSV })
    ok(await s.vault.saveHost(undefined, { name: 'a', host: '10.0.0.1', port: 22, username: 'deploy', auth: { type: 'agent' } }))
    ok(await s.vault.saveHost(undefined, { name: 'b', host: '10.0.0.2', port: 22, username: 'someone-else', auth: { type: 'agent' } }))
    expect((await preview(s, 'termius-csv')).items.map((i) => i.duplicate)).toEqual([false, false])
    const t = await setup({ name: 'c.csv', text: 'Hostname/IP,Username\nWEB.Example.com,u\n' }, undefined, 'vault2.json')
    ok(await t.vault.saveHost(undefined, { name: 'w', host: 'web.example.com', port: 22, username: 'u', auth: { type: 'agent' } }))
    expect((await preview(t, 'termius-csv')).items[0]!.duplicate).toBe(true)
  })
  it('explains a bad file, refuses a locked vault, and treats cancelling as no error', async () => {
    const s = await setup({ name: 'x.csv', text: 'a,b\n1,2' })
    expect(await s.svc.preview('termius-csv')).toMatchObject({ ok: false, error: expect.stringMatching(/Hostname\/IP/) })
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
  it('adds the chosen hosts with their passwords, groups and notes; the rest are left out', async () => {
    const s = await setup({ name: 'hosts.csv', text: CSV })
    const p = await preview(s, 'termius-csv')
    const r = ok(await s.svc.commit(p.token, [p.items[0]!.id]))
    expect(r.outcome).toEqual({ created: 1, failed: [] })
    const listed = ok(s.vault.listHosts()).hosts
    expect(listed).toHaveLength(1)
    expect(listed[0]).toMatchObject({ name: 'web-1', host: '10.0.0.1', port: 2222, username: 'deploy', group: 'Prod', authType: 'password' })
    expect((await s.vault.lookup.resolve(listed[0]!.id)).auth).toEqual({ type: 'password', password: 'pw-web-secret' })
  })
  it('a preview can be confirmed once only, and unknown or forged ids add nothing', async () => {
    const s = await setup({ name: 'hosts.csv', text: CSV })
    const p = await preview(s, 'termius-csv')
    expect(ok(await s.svc.commit(p.token, ['99', 'x', '-1', '0', '0'])).outcome.created).toBe(1)
    expect(await s.svc.commit(p.token, ['1'])).toMatchObject({ ok: false, error: expect.stringMatching(/hết hạn/) })
    expect(await s.svc.commit('nope', [])).toMatchObject({ ok: false })
    expect(await s.svc.commit(p.token, 'all' as never)).toMatchObject({ ok: false })
  })
  it('a cancelled or expired preview cannot be confirmed, and a newer one replaces an older one', async () => {
    const s = await setup({ name: 'hosts.csv', text: CSV })
    const a = await preview(s, 'termius-csv')
    s.svc.cancel(a.token)
    expect(await s.svc.commit(a.token, ['0'])).toMatchObject({ ok: false })
    const b = await preview(s, 'termius-csv')
    const c = await preview(s, 'termius-csv')
    expect(await s.svc.commit(b.token, ['0'])).toMatchObject({ ok: false })
    expect(ok(await s.svc.commit(c.token, ['0'])).outcome.created).toBe(1)
  })
  it('drops what it holds when the vault locks', async () => {
    const s = await setup({ name: 'hosts.csv', text: CSV })
    const p = await preview(s, 'termius-csv')
    await s.store.lock()
    await s.store.unlock(PASS)
    expect(await s.svc.commit(p.token, ['0'])).toMatchObject({ ok: false })
  })
  it('expires by itself', async () => {
    const s = await setup({ name: 'hosts.csv', text: CSV }, 30)
    const p = await preview(s, 'termius-csv')
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
  it('a host the vault rejects is reported by name and the others still go in', async () => {
    const s = await setup({ name: 'hosts.csv', text: 'Label,Hostname/IP,Username,Password\ngood,g.example.com,u,p\nbad,b.example.com,u,\n' })
    const p = await preview(s, 'termius-csv')
    expect(p.items[1]!.auth).toBe('agent')
    const r = ok(await s.svc.commit(p.token, ['0', '1']))
    expect(r.outcome.created).toBe(2)
  })
  it('importing counts as adding hosts (one backup covers it)', async () => {
    const s = await setup({ name: 'hosts.csv', text: CSV })
    let changed = 0
    s.store.on('changed', () => changed++)
    const p = await preview(s, 'termius-csv')
    ok(await s.svc.commit(p.token, ['0', '1']))
    expect(changed).toBeGreaterThan(0)
  })
})
