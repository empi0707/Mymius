export class HostKeyRejectedError extends Error {
  constructor(readonly host: string, readonly port: number, readonly fingerprint: string) {
    super(`Khóa của host ${host}:${port} chưa được tin cậy (${fingerprint})`)
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
    super(`KHÓA HOST ĐÃ THAY ĐỔI ở ${host}:${port}. Mong đợi ${expected}, nhận được ${actual}. Từ chối kết nối.`)
    this.name = 'HostKeyChangedError'
  }
}
