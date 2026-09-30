export class HostKeyRejectedError extends Error {
  constructor(readonly host: string, readonly port: number, readonly fingerprint: string) {
    super(`Host key for ${host}:${port} was not trusted (${fingerprint})`)
    this.name = 'HostKeyRejectedError'
  }
}

/** The server presented a different key than the one we trusted before: possible man-in-the-middle. */
export class HostKeyChangedError extends Error {
  constructor(
    readonly host: string,
    readonly port: number,
    readonly expected: string,
    readonly actual: string
  ) {
    super(`HOST KEY CHANGED for ${host}:${port}. Expected ${expected}, got ${actual}. Refusing to connect.`)
    this.name = 'HostKeyChangedError'
  }
}
