import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: resolve('src/main/index.ts')
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: resolve('src/preload/index.ts'),
        output: {
          // Sandboxed Electron preload scripts do not support ESM imports.
          // Keep this bridge as one CommonJS file even though the main process
          // and package use ESM.
          format: 'cjs',
          entryFileNames: 'index.cjs'
        }
      }
    }
  },
  renderer: {
    root: resolve('src/renderer'),
    html: {
      // Vite applies this nonce to development-time style injection so the
      // renderer can keep a restrictive CSP without breaking WebStorm's dev run.
      cspNonce: 'composatoastrenderer'
    },
    build: {
      rollupOptions: {
        input: resolve('src/renderer/index.html')
      }
    }
  }
})
