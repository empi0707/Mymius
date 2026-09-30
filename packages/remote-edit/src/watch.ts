import path from 'node:path'
import chokidar from 'chokidar'
import type { FileWatcher } from './types'

/**
 * Watch one file by watching its folder: many editors save by writing a temp file and renaming it
 * over the original, which silently detaches a watcher attached to the file itself.
 */
export function watchFile(localPath: string, onChange: () => void): FileWatcher {
  const target = path.resolve(localPath)
  const watcher = chokidar.watch(path.dirname(target), { depth: 0, ignoreInitial: true, atomic: true })
  const handle = (changed: string): void => {
    if (path.resolve(changed) === target) onChange()
  }
  watcher.on('add', handle).on('change', handle)
  const ready = new Promise<void>((resolve) => watcher.once('ready', () => resolve()))
  return { ready, close: () => watcher.close() }
}
