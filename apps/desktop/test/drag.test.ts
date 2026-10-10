import { describe, expect, it } from 'vitest'
import { dropMode, isMoveIntoSameFolder, parentOf } from '../src/renderer/src/files/drag'

const local = { kind: 'local' as const }
const host = (id: string) => ({ kind: 'sftp' as const, hostId: id })

describe('dropMode: a move inside one server, a copy between servers', () => {
  it('this computer to this computer moves', () => expect(dropMode(local, local)).toBe('move'))
  it('a host to the same host moves, even from another pane', () => expect(dropMode(host('a'), host('a'))).toBe('move'))
  it('a host to another host copies', () => expect(dropMode(host('a'), host('b'))).toBe('copy'))
  it('this computer to a host, and back, copy', () => {
    expect(dropMode(local, host('a'))).toBe('copy')
    expect(dropMode(host('a'), local)).toBe('copy')
  })
  it('Alt / Option always copies', () => {
    expect(dropMode(local, local, true)).toBe('copy')
    expect(dropMode(host('a'), host('a'), true)).toBe('copy')
  })
  it('a host with no id is never the "same" as anything', () => expect(dropMode({ kind: 'sftp' }, { kind: 'sftp' })).toBe('copy'))
})

describe('moving into the folder the files are already in', () => {
  it('finds the parent for both separators', () => {
    expect(parentOf('/a/b/c.txt', '/')).toBe('/a/b')
    expect(parentOf('/c.txt', '/')).toBe('/')
    expect(parentOf('C:\\a\\b.txt', '\\')).toBe('C:\\a')
  })
  it('is a no-op only when every file is already there', () => {
    expect(isMoveIntoSameFolder(['/a/x', '/a/y'], '/a', '/')).toBe(true)
    expect(isMoveIntoSameFolder(['/a/x', '/b/y'], '/a', '/')).toBe(false)
    expect(isMoveIntoSameFolder(['/a/x'], '/a/', '/')).toBe(true)
    expect(isMoveIntoSameFolder(['/a/x'], '/a/sub', '/')).toBe(false)
    expect(isMoveIntoSameFolder([], '/a', '/')).toBe(false)
  })
})
