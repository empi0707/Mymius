import react from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

// Workspace packages are TypeScript sources: bundle them instead of treating them as node_modules.
const workspace = [
  '@mymius/core', '@mymius/platform', '@mymius/providers',
  '@mymius/folder-sync', '@mymius/remote-edit', '@mymius/vault', '@mymius/ssh', '@mymius/transfer', '@mymius/drive-sync', '@mymius/importers'
]

export default defineConfig({
  main: { plugins: [externalizeDepsPlugin({ exclude: workspace })] },
  preload: { plugins: [externalizeDepsPlugin({ exclude: workspace })] },
  renderer: { plugins: [react()] }
})
