import { createHash, randomBytes } from 'node:crypto'

const b64url = (b: Buffer): string => b.toString('base64url')

/** RFC 7636: a random verifier that stays on this machine, and its SHA-256 challenge that goes to Google. */
export function createPkce(): { verifier: string; challenge: string } {
  const verifier = b64url(randomBytes(48)) // 64 characters, within the 43-128 the RFC allows
  return { verifier, challenge: challengeFor(verifier) }
}

export function challengeFor(verifier: string): string {
  return b64url(createHash('sha256').update(verifier, 'ascii').digest())
}
