import type { Endpoint } from './types'

/** '/'-separated relative key -> absolute path in the endpoint's own path flavour. */
export function toAbs(ep: Endpoint, rel: string): string {
  return rel === '' ? ep.root : ep.provider.path.join(ep.root, ...rel.split('/'))
}

export function depthOf(rel: string): number {
  return rel === '' ? 0 : rel.split('/').length
}

export function isAncestor(ancestor: string, rel: string): boolean {
  return rel.startsWith(ancestor + '/')
}
