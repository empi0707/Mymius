/** The user said no on the consent screen. */
export class OAuthDeniedError extends Error {
  constructor(readonly reason: string) {
    super(reason === 'access_denied' ? 'Access to Google Drive was not granted' : `Google refused the sign-in (${reason})`)
    this.name = 'OAuthDeniedError'
  }
}
export class OAuthTimeoutError extends Error {
  constructor() {
    super('The sign-in was not completed in time')
    this.name = 'OAuthTimeoutError'
  }
}
export class OAuthCancelledError extends Error {
  constructor() {
    super('The sign-in was cancelled')
    this.name = 'OAuthCancelledError'
  }
}
/** The refresh token no longer works (revoked, expired, or the app was removed): the user must sign in again. */
export class AuthRevokedError extends Error {
  constructor(detail?: string) {
    super(`Google Drive access was withdrawn${detail ? ` (${detail})` : ''}. Sign in again to continue syncing.`)
    this.name = 'AuthRevokedError'
  }
}
/** Google Drive has no room left. Retrying will not help until the user frees space. */
export class DriveQuotaError extends Error {
  constructor() {
    super('Your Google Drive storage is full')
    this.name = 'DriveQuotaError'
  }
}
export class DriveNotFoundError extends Error {
  constructor() {
    super('The file no longer exists in Google Drive')
    this.name = 'DriveNotFoundError'
  }
}
/** Could not reach Google (offline, DNS, timeout). Worth retrying later. */
export class NetworkError extends Error {
  constructor(cause: unknown) {
    super(`Cannot reach Google: ${cause instanceof Error ? cause.message : String(cause)}`)
    this.name = 'NetworkError'
  }
}
export class DriveError extends Error {
  constructor(readonly status: number, readonly reason: string, message: string) {
    super(`Google Drive error ${status}${reason ? ` (${reason})` : ''}: ${message}`)
    this.name = 'DriveError'
  }
}
