import { describe, expect, it } from 'vitest'
import { ImportFormatError, parseCsv, parseForkLiftFavorites, parseImport, parseSshConfig, parseTermiusCsv } from '../src'

const ME = { defaultUser: 'me' }

describe('CSV reader', () => {
  it('handles quotes, commas, doubled quotes, newlines inside fields, CRLF and a BOM', () => {
    expect(parseCsv('﻿a,b\r\n"x,1","he said ""hi"""\r\n"two\nlines",z')).toEqual([['a', 'b'], ['x,1', 'he said "hi"'], ['two\nlines', 'z']])
  })
  it('ignores blank lines and rejects an unclosed quote', () => {
    expect(parseCsv('a\n\n \nb\n')).toEqual([['a'], ['b']])
    expect(() => parseTermiusCsv('Hostname/IP\n"oops')).toThrow(ImportFormatError)
  })
})

describe('Termius CSV', () => {
  const csv = [
    'Groups,Label,Tags,Hostname/IP,Protocol,Port,Username,Password',
    'Prod/Web,web-1,"a,b",10.0.0.1,ssh,2222,deploy,s3cret',
    ',db,,db.example.com,,,root,',
    ',tel,,10.0.0.3,telnet,23,x,y',
    ',bad,,not a host!,ssh,22,u,',
    ',port,,h.example.com,ssh,99999,u,',
    ',nouser,,h2.example.com,ssh,22,,'
  ].join('\n')

  it('reads hosts, groups, tags and passwords, and defaults the port', () => {
    const r = parseTermiusCsv(csv, ME)
    expect(r.hosts.map((h) => [h.name, h.host, h.port, h.username, h.group, h.password, h.notes])).toEqual([
      ['web-1', '10.0.0.1', 2222, 'deploy', 'Prod/Web', 's3cret', 'Tags: a,b'],
      ['db', 'db.example.com', 22, 'root', undefined, undefined, undefined],
      ['nouser', 'h2.example.com', 22, 'me', undefined, undefined, undefined]
    ])
    expect(r.hosts[2]!.assumed).toEqual(['username'])
    expect(r.warnings.join(' ')).toMatch(/mật khẩu/)
  })
  it('reports what it could not take, each with its reason', () => {
    const r = parseTermiusCsv(csv, ME)
    expect(r.skipped.map((s) => s.label)).toEqual(['tel', 'bad', 'port'])
    expect(r.skipped[0]!.reason).toMatch(/telnet/)
  })
  it('a host name that would be read by ssh as an option is refused', () => {
    const r = parseTermiusCsv('Hostname/IP,Username\n-oProxyCommand=evil,u\nok.example.com,u')
    expect(r.hosts.map((h) => h.host)).toEqual(['ok.example.com'])
    expect(r.skipped).toHaveLength(1)
  })
  it('without a default user, a missing username is skipped rather than invented', () => {
    expect(parseTermiusCsv('Hostname/IP,Username\nh.example.com,\n').skipped).toHaveLength(1)
  })
  it('finds columns by name in any order and case, and needs a host column', () => {
    const r = parseTermiusCsv('USERNAME,port,hostname/ip,LABEL\nu,2200,h.example.com,box')
    expect(r.hosts[0]).toMatchObject({ name: 'box', host: 'h.example.com', port: 2200, username: 'u' })
    expect(() => parseTermiusCsv('a,b\n1,2')).toThrow(/Hostname\/IP/)
    expect(() => parseTermiusCsv('')).toThrow(ImportFormatError)
  })
})

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
  it('never invents a password, and says passwords live in the Keychain', () => {
    expect(r.hosts.every((h) => h.password === undefined)).toBe(true)
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
    expect(parseImport('termius-csv', 'Hostname/IP,Username\na.x,u').hosts).toHaveLength(1)
  })
  it('refuses absurdly large input', () => {
    expect(() => parseSshConfig('#'.repeat(6 * 1024 * 1024))).toThrow(ImportFormatError)
  })
})
