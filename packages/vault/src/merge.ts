/** One synced item (host, key, snippet, folder-sync favourite...). The payload is opaque ciphertext. */
export interface SyncRecord {
  id: string
  /** HybridClock timestamp of the last change. */
  hlc: string
  /** Tombstone: kept for a while so deletions propagate to devices that were offline. */
  deleted: boolean
  payload: string | null
}

/**
 * Union of several replicas, newest change per id wins. Commutative, associative and idempotent,
 * so devices converge no matter in which order they read each other's files.
 */
export function mergeRecords(...replicas: readonly (readonly SyncRecord[])[]): SyncRecord[] {
  const best = new Map<string, SyncRecord>()
  for (const set of replicas) {
    for (const rec of set) {
      const cur = best.get(rec.id)
      if (!cur || rec.hlc > cur.hlc) best.set(rec.id, rec)
    }
  }
  return [...best.values()].sort((a, b) => (a.id < b.id ? -1 : 1))
}

/** Drop tombstones older than `olderThanMs`. Only safe once every device has had time to sync. */
export function compactTombstones(records: readonly SyncRecord[], nowMs: number, olderThanMs: number): SyncRecord[] {
  return records.filter((r) => !(r.deleted && nowMs - Number(r.hlc.split('-')[0]) > olderThanMs))
}
