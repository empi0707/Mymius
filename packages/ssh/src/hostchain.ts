import type { SshConnectOptions } from './connection'
import { credentialIdentity } from './validate'

export type ResolvedAuth =
  | { type: 'password'; password: string }
  | { type: 'key'; privateKey: string; passphrase?: string }
  | { type: 'agent'; socket: string }

/** A saved host with its credentials filled in, as needed to actually connect. Never leaves the main process. */
export interface ResolvedHost {
  id: string
  name: string
  host: string
  port: number
  username: string
  auth: ResolvedAuth
  jumpHostId?: string
}

export interface HostLookup {
  /** Throws with a user-facing message when the host does not exist or the vault is locked. */
  resolve(id: string): Promise<ResolvedHost>
}

export const MAX_JUMP_HOPS = 5

/** The hops to connect through, outermost bastion first and the target last. */
export async function resolveChain(targetId: string, lookup: HostLookup): Promise<ResolvedHost[]> {
  const chain: ResolvedHost[] = []
  const seen = new Set<string>()
  for (let id: string | undefined = targetId; id !== undefined; ) {
    const hop = await lookup.resolve(id)
    if (seen.has(id)) {
      // chain is outermost-first; read it target-first, ending on the host that closes the loop
      const names = [...chain.map((h) => h.name).reverse(), hop.name].join(' → ')
      throw new Error(`Jump hosts form a loop: ${names}`)
    }
    seen.add(id)
    chain.unshift(hop)
    if (chain.length > MAX_JUMP_HOPS + 1) throw new Error(`Too many jump hosts (more than ${MAX_JUMP_HOPS})`)
    id = hop.jumpHostId
  }
  return chain
}

function hopIdentity(h: ResolvedHost): string {
  const a = h.auth
  const cred =
    a.type === 'password' ? credentialIdentity(['password', a.password])
    : a.type === 'key' ? credentialIdentity(['key', a.privateKey, a.passphrase ?? ''])
    : credentialIdentity(['agent', a.socket])
  return `${h.username}@${h.host.toLowerCase()}:${h.port}#${cred}`
}

/** Key for sharing a connection: identical only for the same hops with the same credentials. */
export function chainKey(chain: readonly ResolvedHost[]): string {
  return chain.map(hopIdentity).join('>')
}

/** Nested connect options: each hop jumps through the previous one. */
export function chainToOptions(
  chain: readonly ResolvedHost[],
  verifyFor: (hop: ResolvedHost) => SshConnectOptions['verifyHostKey']
): SshConnectOptions {
  let options: SshConnectOptions | undefined
  for (const hop of chain) {
    const base = { host: hop.host, port: hop.port, username: hop.username, verifyHostKey: verifyFor(hop), ...(options ? { jump: options } : {}) }
    options =
      hop.auth.type === 'password' ? { ...base, password: hop.auth.password }
      : hop.auth.type === 'key' ? { ...base, privateKey: hop.auth.privateKey, ...(hop.auth.passphrase ? { passphrase: hop.auth.passphrase } : {}) }
      : { ...base, agent: hop.auth.socket }
  }
  if (!options) throw new Error('Không có host để kết nối')
  return options
}
