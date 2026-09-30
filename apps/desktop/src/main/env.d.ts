// The only build-time variable the main process reads: "e2e" for the test build, "production" otherwise.
interface ImportMetaEnv {
  readonly MODE: string
  /** Optional: a Google Desktop OAuth client baked into the build, so users can sign in without creating their own. */
  readonly MAIN_VITE_GOOGLE_CLIENT_ID?: string
  readonly MAIN_VITE_GOOGLE_CLIENT_SECRET?: string
}
interface ImportMeta {
  readonly env: ImportMetaEnv
}
