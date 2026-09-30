// The only build-time variable the main process reads: "e2e" for the test build, "production" otherwise.
interface ImportMetaEnv {
  readonly MODE: string
}
interface ImportMeta {
  readonly env: ImportMetaEnv
}
