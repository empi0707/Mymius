export * from './types'
export { parseSshConfig } from './ssh-config'
export { parseForkLiftFavorites } from './forklift'

import { parseForkLiftFavorites } from './forklift'
import { parseSshConfig } from './ssh-config'
import type { ImportSource, ParseOptions, ParseResult } from './types'

export function parseImport(source: ImportSource, text: string, opts: ParseOptions = {}): ParseResult {
  switch (source) {
    case 'ssh-config': return parseSshConfig(text, opts)
    case 'forklift': return parseForkLiftFavorites(text, opts)
  }
}
