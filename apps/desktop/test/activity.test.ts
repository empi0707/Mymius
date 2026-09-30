import { afterEach, describe, expect, it } from 'vitest'
import { filesActivities, getSnapshot, setActivities, subscribe, summarize } from '../src/renderer/src/activity/activity-core'

afterEach(() => { for (const s of ['a', 'b', 'files']) setActivities(s, []) })

const job = (over: Partial<Parameters<typeof filesActivities>[0]['jobs'][number]> = {}) => ({ id: 'j1', label: 'Đang chép 3 mục', state: 'running' as const, filesDone: 1, filesTotal: 4, bytesDone: 0, bytesTotal: 0, ...over })

describe('the activity store', () => {
  it('holds what each part of the app reports, replaces it as a whole, and clears it', () => {
    setActivities('a', [{ id: '1', label: 'one' }])
    setActivities('b', [{ id: '2', label: 'two' }])
    expect(getSnapshot().map((x) => x.label)).toEqual(['one', 'two'])
    setActivities('a', [{ id: '3', label: 'three' }])
    expect(getSnapshot().map((x) => x.label)).toEqual(['three', 'two'])
    setActivities('a', [])
    setActivities('b', [])
    expect(getSnapshot()).toEqual([])
  })
  it('tells listeners about real changes only', () => {
    let n = 0
    const off = subscribe(() => n++)
    setActivities('a', [{ id: '1', label: 'x' }])
    setActivities('a', [{ id: '1', label: 'x' }]) // identical: nothing to redraw
    setActivities('b', []) // nothing there to clear
    expect(n).toBe(1)
    setActivities('a', [{ id: '1', label: 'x', progress: 0.5 }])
    expect(n).toBe(2)
    off()
    setActivities('a', [])
    expect(n).toBe(2)
  })
})

describe('summarize', () => {
  it('is nothing when idle', () => expect(summarize([])).toBeNull())
  it('shows one thing as it is, with its progress clamped to 0..1', () => {
    expect(summarize([{ id: 'a', label: 'Đang tải lên x.conf…' }])).toEqual({ label: 'Đang tải lên x.conf…' })
    expect(summarize([{ id: 'a', label: 'x', progress: 0.25 }])).toEqual({ label: 'x', progress: 0.25 })
    expect(summarize([{ id: 'a', label: 'x', progress: 7 }])?.progress).toBe(1)
    expect(summarize([{ id: 'a', label: 'x', progress: -1 }])?.progress).toBe(0)
    expect(summarize([{ id: 'a', label: 'x', progress: Number.NaN }])?.progress).toBe(0)
  })
  it('with several things, names the first and counts the rest, and stops claiming a percentage', () => {
    expect(summarize([{ id: 'a', label: 'one', progress: 0.5 }, { id: 'b', label: 'two' }])).toEqual({ label: 'one (+1)' })
  })
})

describe('what the file manager reports', () => {
  it('a server being connected to, by name', () => {
    expect(filesActivities({ connecting: [{ side: 1, host: 'prod' }], jobs: [], edits: [] })).toEqual([{ id: 'connect:1', label: 'Đang kết nối prod…' }])
    expect(filesActivities({ connecting: [{ side: 0 }], jobs: [], edits: [] })[0]!.label).toMatch(/máy chủ/)
  })
  it('running transfers with their progress, by bytes when known and by files otherwise; finished ones not at all', () => {
    const list = filesActivities({ connecting: [], jobs: [job({ bytesTotal: 200, bytesDone: 50 }), job({ id: 'j2', filesDone: 1, filesTotal: 4 }), job({ id: 'j3', filesTotal: 0 }), job({ id: 'j4', state: 'done' as never })], edits: [] })
    expect(list.map((x) => [x.id, x.progress])).toEqual([['job:j1', 0.25], ['job:j2', 0.25], ['job:j3', undefined]])
  })
  it('a remote file being opened or uploaded after a save, and nothing for the other edit states', () => {
    const edits = (['opening', 'uploading', 'synced', 'unsynced', 'conflict', 'error', 'closed'] as const).map((state, i) => ({ id: `e${i}`, name: 'app.conf', state }))
    expect(filesActivities({ connecting: [], jobs: [], edits }).map((x) => x.label)).toEqual(['Đang mở app.conf…', 'Đang tải lên app.conf…'])
  })
})
