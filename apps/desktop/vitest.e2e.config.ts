import { defineConfig } from 'vitest/config'

// Drives the real Electron app. On headless Linux run it as: xvfb-run -a pnpm e2e
export default defineConfig({
  test: { include: ['e2e/**/*.e2e.ts'], testTimeout: 60_000, hookTimeout: 60_000, fileParallelism: false }
})
