import {
  ConnectionPool,
  KnownHosts,
  SshConnection,
  chainKey,
  chainToOptions,
  resolveChain,
  type HostKeyInfo,
  type HostLookup,
  type ResolvedHost
} from '@mymius/ssh'

export interface BrokerHost {
  knownHostsFile: string
  /** Ask the user whether to trust a host seen for the first time. */
  confirmHostKey(info: HostKeyInfo): Promise<boolean>
}

/** A claim on a shared connection. Give it back when done; the last one out closes the connection. */
export interface Lease {
  connection: SshConnection
  release(): Promise<void>
}

/**
 * The single place SSH connections are opened for the whole app. Terminals and file panes ask for a
 * host and get a lease on one shared connection, so opening a file pane next to a terminal on the
 * same host costs no second login. Host keys are checked here, for every hop of a jump chain.
 */
export class ConnectionBroker {
  private readonly pool = new ConnectionPool()
  private readonly knownHosts: KnownHosts

  constructor(private readonly host: BrokerHost, private readonly saved: HostLookup) {
    this.knownHosts = new KnownHosts(host.knownHostsFile)
  }

  acquireSaved(hostId: string, opts: { dedicated?: boolean } = {}): Promise<Lease> {
    return resolveChain(hostId, this.saved).then((chain) => this.acquireChain(chain, opts))
  }

  /**
   * `dedicated` gives a connection of its own, not shared with anything else. Terminals use it: sshd runs
   * pam_motd (the server status message) once per connection, so a shell opened on a shared connection
   * would show "Last login" but none of the MOTD.
   */
  async acquireChain(chain: ResolvedHost[], opts: { dedicated?: boolean } = {}): Promise<Lease> {
    const key = chainKey(chain)
    const verify = this.knownHosts.verifier((info) => this.host.confirmHostKey(info))
    if (opts.dedicated) {
      const connection = await SshConnection.connect(chainToOptions(chain, () => verify))
      let closed = false
      return {
        connection,
        release: async () => {
          if (closed) return
          closed = true
          await connection.dispose()
        }
      }
    }
    const connection = await this.pool.acquire(key, () => SshConnection.connect(chainToOptions(chain, () => verify)))
    let released = false
    return {
      connection,
      release: async () => {
        if (released) return
        released = true
        await this.pool.release(key, connection)
      }
    }
  }
}
