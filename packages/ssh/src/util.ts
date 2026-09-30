import { createHash } from 'node:crypto'

export function call<T>(fn: (cb: (err: Error | null | undefined, result: T) => void) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    try {
      fn((err, result) => (err ? reject(err) : resolve(result)))
    } catch (err) {
      reject(err)
    }
  })
}

/** Quote for a POSIX shell: everything literal, including spaces, `$`, `;` and quotes. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/** ssh2 hands over the host key hash as hex; OpenSSH prints "SHA256:" + unpadded base64. */
export function toOpenSshFingerprint(hexSha256: string): string {
  return 'SHA256:' + Buffer.from(hexSha256, 'hex').toString('base64').replace(/=+$/, '')
}

export function fingerprintOfPublicKey(publicKeyBlob: Buffer): string {
  return 'SHA256:' + createHash('sha256').update(publicKeyBlob).digest('base64').replace(/=+$/, '')
}
