import type { OS } from './paths'

/**
 * Where the system ssh-agent listens, in the form ssh2's `agent` option accepts. undefined = none found.
 *  - macOS / Linux: the socket named by SSH_AUTH_SOCK (launchd or the desktop session provides it)
 *  - Windows: the OpenSSH agent service's named pipe. Pageant users pass 'pageant' explicitly.
 * Not available inside the macOS App Sandbox, which is one reason to distribute outside the Mac App Store.
 */
export function defaultSshAgent(
  os: OS = process.platform as OS,
  env: Record<string, string | undefined> = process.env
): string | undefined {
  if (os === 'win32') return '\\\\.\\pipe\\openssh-ssh-agent'
  return env.SSH_AUTH_SOCK || undefined
}
