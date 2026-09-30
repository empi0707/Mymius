import type { FileVersion } from './types'

export class NotFoundError extends Error {
  readonly code = 'ENOENT'
  constructor(path: string) {
    super(`Not found: ${path}`)
    this.name = 'NotFoundError'
  }
}

export class AlreadyExistsError extends Error {
  readonly code = 'EEXIST'
  constructor(path: string) {
    super(`Already exists: ${path}`)
    this.name = 'AlreadyExistsError'
  }
}

/** The target changed between the moment it was inspected and the moment it was written. */
export class ConflictError extends Error {
  constructor(readonly current: FileVersion | null) {
    super('Target changed since it was last checked')
    this.name = 'ConflictError'
  }
}
