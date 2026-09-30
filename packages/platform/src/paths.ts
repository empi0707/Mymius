import { homedir } from 'node:os'
import path from 'node:path'

export type OS = 'darwin' | 'win32' | 'linux'

export interface AppPaths {
  /** Settings and the local database. */
  data: string
  /** Re-creatable files: downloaded copies for remote edit, thumbnails. */
  cache: string
  logs: string
}

/**
 * Where an app keeps its files on each OS. Electron code should prefer app.getPath();
 * this exists for workers, CLIs and tests that run without Electron.
 */
export function getAppPaths(
  appName: string,
  os: OS = process.platform as OS,
  env: Record<string, string | undefined> = process.env,
  home: string = homedir()
): AppPaths {
  switch (os) {
    case 'darwin':
      return {
        data: path.posix.join(home, 'Library', 'Application Support', appName),
        cache: path.posix.join(home, 'Library', 'Caches', appName),
        logs: path.posix.join(home, 'Library', 'Logs', appName)
      }
    case 'win32': {
      const roaming = env.APPDATA ?? path.win32.join(home, 'AppData', 'Roaming')
      const local = env.LOCALAPPDATA ?? path.win32.join(home, 'AppData', 'Local')
      return {
        data: path.win32.join(roaming, appName),
        cache: path.win32.join(local, appName, 'Cache'),
        logs: path.win32.join(local, appName, 'Logs')
      }
    }
    default: {
      const config = env.XDG_CONFIG_HOME ?? path.posix.join(home, '.config')
      const cache = env.XDG_CACHE_HOME ?? path.posix.join(home, '.cache')
      const state = env.XDG_STATE_HOME ?? path.posix.join(home, '.local', 'state')
      return {
        data: path.posix.join(config, appName),
        cache: path.posix.join(cache, appName),
        logs: path.posix.join(state, appName, 'logs')
      }
    }
  }
}
