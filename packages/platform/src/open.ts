import type { OS } from './paths'

export interface OpenCommand {
  command: string
  args: string[]
}

/**
 * Command line to open `file` with the default handler, or with a specific application.
 * Always used with execFile (never through a shell) so file names cannot inject anything.
 * Inside Electron, shell.openPath() is preferred for the default-handler case.
 */
export function buildOpenCommand(opts: { file: string; app?: string; os?: OS }): OpenCommand {
  const os = opts.os ?? (process.platform as OS)
  const { file, app } = opts
  switch (os) {
    case 'darwin':
      return { command: 'open', args: app ? ['-a', app, file] : [file] }
    case 'win32':
      // `start` is a cmd builtin; the empty string is the (required) window title argument.
      return app
        ? { command: app, args: [file] }
        : { command: 'cmd.exe', args: ['/c', 'start', '', file] }
    default:
      return { command: app ?? 'xdg-open', args: [file] }
  }
}
