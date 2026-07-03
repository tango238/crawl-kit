import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    passWithNoTests: true,
    exclude: ['dist/**', 'node_modules/**', 'test/integration/**'],
    setupFiles: ['test/setup.ts'],
  },
})
