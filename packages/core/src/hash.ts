import { createHash } from 'node:crypto'
import type { Readable } from 'node:stream'
import type { FileSystemProvider } from './types'

export async function hashStream(stream: Readable, algorithm = 'sha256'): Promise<string> {
  const h = createHash(algorithm)
  for await (const chunk of stream) h.update(chunk as Buffer)
  return h.digest('hex')
}

/** Uses the provider's server-side hash when available, otherwise streams the file. */
export async function hashFile(provider: FileSystemProvider, path: string): Promise<string> {
  if (provider.capabilities.remoteHash && provider.hash) return provider.hash(path, 'sha256')
  return hashStream(provider.createReadStream(path))
}
