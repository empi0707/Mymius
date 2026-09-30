import { createHash } from 'node:crypto'
import { utils } from 'ssh2'

export interface KeyInfo {
  /** e.g. ssh-ed25519, ssh-rsa, ecdsa-sha2-nistp256 */
  type: string
  /** SHA256:... of the public half, as `ssh-keygen -l` prints it. */
  fingerprint: string
  /** The key file itself is passphrase-protected. */
  encrypted: boolean
}

/**
 * Check that `text` really is a usable private key (and that `passphrase` opens it) before it is
 * stored, so a wrong file or a mistyped passphrase is caught now rather than at the first login.
 * Throws with a message fit to show the user.
 */
export function inspectPrivateKey(text: string, passphrase?: string): KeyInfo {
  if (text.length > 64 * 1024) throw new Error('That file is too large to be a private key')
  const plain = utils.parseKey(text)
  let parsed = plain
  let encrypted = false
  if (plain instanceof Error) {
    if (!/passphrase|encrypted/i.test(plain.message)) throw new Error('This is not a valid private key file')
    encrypted = true
    if (!passphrase) throw new Error('This key is protected by a passphrase; enter it to continue')
    parsed = utils.parseKey(text, passphrase)
    if (parsed instanceof Error) throw new Error('Wrong passphrase for this key')
  }
  const key = Array.isArray(parsed) ? parsed[0] : parsed
  if (!key || key instanceof Error) throw new Error('This is not a valid private key file')
  if (!key.isPrivateKey()) throw new Error('This is a public key; a private key is needed to sign in')
  return {
    type: key.type,
    encrypted,
    fingerprint: 'SHA256:' + createHash('sha256').update(key.getPublicSSH()).digest('base64').replace(/=+$/, '')
  }
}
