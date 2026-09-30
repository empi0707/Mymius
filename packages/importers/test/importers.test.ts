import { describe, expect, it } from 'vitest'
import { ImportFormatError, parseForkLiftFavorites, parseImport, parseSshConfig } from '../src'

const ME = { defaultUser: 'me' }

describe('ssh config', () => {
  const cfg = `
# comment
Host *
  User fallback
  IdentityFile ~/.ssh/default
  ServerAliveInterval 30

Host web db
  HostName 10.0.0.5
  Port 2200

Host db
  User dbadmin

Host prod-*
  User prod

Host prod-1
  HostName p1.example.com
  ProxyJump web
  IdentityFile ~/.ssh/prod_key

Host lonely !web
  ProxyJump admin@bastion.example.com:2222
  ProxyCommand nc %h %p

Host tokens
  HostName %h.example.com

Match host foo
  User nobody
`
  const r = parseSshConfig(cfg, ME)
  const by = (n: string) => r.hosts.find((h) => h.name === n)

  it('makes a host of every concrete alias, and none of the wildcard patterns', () => {
    expect(r.hosts.map((h) => h.name).sort()).toEqual(['db', 'lonely', 'prod-1', 'web'])
  })
  it('resolves options like ssh does: first value wins, across matching blocks in file order', () => {
    expect(by('web')).toMatchObject({ host: '10.0.0.5', port: 2200, username: 'fallback', keyPath: '~/.ssh/default' })
    expect(by('db')).toMatchObject({ host: '10.0.0.5', port: 2200, username: 'fallback' }) // Host * came first, so it wins over the later "db" block
    expect(by('prod-1')).toMatchObject({ host: 'p1.example.com', username: 'fallback', keyPath: '~/.ssh/default' })
  })
  it('connects ProxyJump to another host in the file, and explains one it cannot connect', () => {
    expect(by('prod-1')!.jump).toBe('web')
    expect(by('lonely')!.jump).toBeUndefined()
    expect(by('lonely')!.notes).toMatch(/ProxyJump admin@bastion/)
    expect(by('lonely')!.notes).toMatch(/ProxyCommand/)
  })
  it('skips hosts whose name needs token expansion, and warns about Match', () => {
    expect(r.skipped.map((s) => s.label)).toEqual(['tokens'])
    expect(r.warnings.join(' ')).toMatch(/Match/)
  })
  it('a host name that would be read by ssh as an option is refused', () => {
    const r = parseSshConfig('Host bad\n HostName -oProxyCommand=evil\n User u\nHost ok\n HostName ok.example.com\n User u', ME)
    expect(r.hosts.map((h) => h.host)).toEqual(['ok.example.com'])
    expect(r.skipped).toHaveLength(1)
  })
  it('without a default user, a missing username is skipped rather than invented', () => {
    expect(parseSshConfig('Host h\n HostName h.example.com').skipped).toHaveLength(1)
  })
  it('understands Key=value, quoted values, tabs and trailing comments', () => {
    const one = parseSshConfig('Host=x\n\tHostName="h.example.com" # note\n  User = bob\n  Port=2022', ME).hosts[0]!
    expect(one).toMatchObject({ name: 'x', host: 'h.example.com', username: 'bob', port: 2022 })
  })
  it('a chain of jumps connects the last hop and says so', () => {
    const c = parseSshConfig('Host a\n HostName a.x\n User u\nHost b\n HostName b.x\n User u\nHost t\n HostName t.x\n User u\n ProxyJump a,b', ME).hosts.find((h) => h.name === 't')!
    expect(c.jump).toBe('b')
    expect(c.notes).toMatch(/2 chặng/)
  })
})

describe('ForkLift favorites', () => {
  const doc = {
    favorites: [
      { name: 'Web', children: [
        { name: 'Prod', url: 'sftp://deploy@web.example.com:2222/var/www', type: 'SFTP' },
        { name: 'Files', server: 'ftp.example.com', protocol: 'FTP', user: 'ftpuser' }
      ] },
      { name: 'Bucket', url: 's3://my-bucket' },
      { name: 'Plain', server: 'box.example.com', protocol: 'sftp', username: 'me2', port: '22' }
    ]
  }
  const r = parseForkLiftFavorites(JSON.stringify(doc), ME)

  it('imports SFTP entries with user, port and folder, from a URL or from separate fields', () => {
    expect(r.hosts.map((h) => [h.name, h.host, h.port, h.username, h.group])).toEqual([
      ['Prod', 'web.example.com', 2222, 'deploy', 'Web'],
      ['Plain', 'box.example.com', 22, 'me2', undefined]
    ])
    expect(r.hosts[0]!.notes).toMatch(/\/var\/www/)
  })
  it('lists other protocols as skipped with the protocol named', () => {
    expect(r.skipped.map((s) => [s.label, s.reason.split(' ')[0]])).toEqual([['Files', 'FTP'], ['Bucket', 'Amazon']])
  })
  it('says that passwords live in the Keychain and are not imported', () => {
    expect(r.warnings.join(' ')).toMatch(/Keychain/)
  })
  it('says plainly when nothing is recognised or the file is not JSON', () => {
    expect(() => parseForkLiftFavorites('{"settings":{"a":1}}')).toThrow(/Không nhận ra/)
    expect(() => parseForkLiftFavorites('not json')).toThrow(/JSON/)
  })
})

describe('parseImport and limits', () => {
  it('dispatches by source', () => {
    expect(parseImport('ssh-config', 'Host a\n HostName a.x\n User u').source).toBe('ssh-config')
    expect(parseImport('forklift', '{\"favorites\":[{\"name\":\"n\",\"url\":\"sftp://u@a.x\"}]}').hosts).toHaveLength(1)
  })
  it('refuses absurdly large input', () => {
    expect(() => parseSshConfig('#'.repeat(6 * 1024 * 1024))).toThrow(ImportFormatError)
  })
})
