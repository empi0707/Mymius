import type { DeviceFile, MetaFile } from './sync-format'
import { MAX_SYNC_FILE_BYTES, SyncFormatError, parseMetaFile, recordsFingerprint } from './sync-format'
import type { VaultStore } from './store'
import type { VaultMeta } from './vault'

/**
 * One self-contained JSON file that carries a whole vault: the wrapped key and one full copy of the records
 * per device that has written to it. It is the same content as the Google Drive files, packed together, so it
 * can be a backup, or live in any folder something else already syncs (iCloud Drive, Dropbox, OneDrive,
 * Syncthing, a NAS). It is only ever ciphertext plus a MAC, so the folder does not need to be trusted.
 */
export const BUNDLE_KIND = 'mymius-sync-bundle'
/** Copies of other devices worth keeping; each is a full state, so old ones add size but no information. */
export const MAX_BUNDLE_DEVICES = 10

export interface Bundle {
  kind: typeof BUNDLE_KIND
  version: 1
  exportedAt: number
  meta: MetaFile
  devices: DeviceFile[]
}

const invalid = (msg: string): SyncFormatError => new SyncFormatError('invalid', msg)

/** Checks the shape only; every part is authenticated against the vault key when it is used. */
export function parseBundle(text: string): Bundle {
  if (Buffer.byteLength(text) > MAX_SYNC_FILE_BYTES) throw new SyncFormatError('too-large', 'The file is too large')
  let v: unknown
  try { v = JSON.parse(text) } catch { throw invalid('This is not a Mymius sync file') }
  const o = v as Partial<Bundle> | null
  if (!o || o.kind !== BUNDLE_KIND || o.version !== 1 || typeof o.exportedAt !== 'number' || !o.meta || !Array.isArray(o.devices) || o.devices.length > 100) {
    throw invalid('This is not a Mymius sync file')
  }
  parseMetaFile(JSON.stringify(o.meta)) // shape of the metadata
  return o as Bundle
}

/** The vault metadata inside, for setting up a device that has no vault yet. Unverified until unlocked. */
export function bundleMeta(bundle: Bundle): VaultMeta {
  return parseMetaFile(JSON.stringify(bundle.meta)).meta
}

/**
 * Our copy replaces our entry in the file; other devices' entries are kept as they are (those that pass the
 * integrity check, newest first, up to a limit), so writing never loses what another device put there.
 */
export function buildBundle(store: VaultStore, existing?: Bundle, now = Date.now()): Bundle {
  const own = store.deviceId
  const others: DeviceFile[] = []
  for (const d of existing?.devices ?? []) {
    if (d.deviceId === own) continue
    if (store.isAuthenticDeviceFile(JSON.stringify(d))) others.push(d) // damaged or forged copies are not carried forward
  }
  others.sort((a, b) => b.updatedAt - a.updatedAt)
  return { kind: BUNDLE_KIND, version: 1, exportedAt: now, meta: store.buildMetaFile(), devices: [store.buildDeviceFile(now), ...others.slice(0, MAX_BUNDLE_DEVICES)] }
}

export interface ApplyResult {
  /** Records that changed on this device. */
  changed: number
  /** Other devices' copies that were merged. */
  devices: number
  /** Copies that failed the integrity check and were skipped. */
  ignored: number
}

/** Merge everything in the file into the open vault. A different vault or a forged metadata block throws. */
export async function applyBundle(store: VaultStore, bundle: Bundle): Promise<ApplyResult> {
  await store.applyMetaFile(JSON.stringify(bundle.meta)) // throws VaultMismatchError / SyncFormatError
  const result: ApplyResult = { changed: 0, devices: 0, ignored: 0 }
  for (const d of bundle.devices) {
    if (d.deviceId === store.deviceId) continue
    try {
      result.changed += await store.applyDeviceFile(JSON.stringify(d))
      result.devices++
    } catch (err) {
      if (!(err instanceof SyncFormatError)) throw err
      result.ignored++
    }
  }
  return result
}

/** What our own entry in the file says, to tell whether the file still needs writing. */
export function ownFingerprint(bundle: Bundle, deviceId: string): string | undefined {
  const d = bundle.devices.find((x) => x.deviceId === deviceId)
  return d ? recordsFingerprint(d.records) : undefined
}
