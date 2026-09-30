/** The user said no on the consent screen. */
export class OAuthDeniedError extends Error {
  constructor(readonly reason: string) {
    super(reason === 'access_denied' ? 'Quyền truy cập Google Drive chưa được cấp' : `Google từ chối đăng nhập (${reason})`)
    this.name = 'OAuthDeniedError'
  }
}
export class OAuthTimeoutError extends Error {
  constructor() {
    super('Đăng nhập không hoàn tất kịp thời gian')
    this.name = 'OAuthTimeoutError'
  }
}
export class OAuthCancelledError extends Error {
  constructor() {
    super('Đã hủy đăng nhập')
    this.name = 'OAuthCancelledError'
  }
}
/** The refresh token no longer works (revoked, expired, or the app was removed): the user must sign in again. */
export class AuthRevokedError extends Error {
  constructor(detail?: string) {
    super(`Quyền truy cập Google Drive đã bị thu hồi${detail ? ` (${detail})` : ''}. Hãy đăng nhập lại để tiếp tục đồng bộ.`)
    this.name = 'AuthRevokedError'
  }
}
/** Google Drive has no room left. Retrying will not help until the user frees space. */
export class DriveQuotaError extends Error {
  constructor() {
    super('Dung lượng Google Drive của bạn đã đầy')
    this.name = 'DriveQuotaError'
  }
}
export class DriveNotFoundError extends Error {
  constructor() {
    super('File không còn tồn tại trên Google Drive')
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
    super(`Lỗi Google Drive ${status}${reason ? ` (${reason})` : ''}: ${message}`)
    this.name = 'DriveError'
  }
}
