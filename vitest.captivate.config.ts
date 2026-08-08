import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/captivate-live.integration.test.ts'],
    testTimeout: 10 * 60 * 1000,
    hookTimeout: 60 * 1000
  }
})
