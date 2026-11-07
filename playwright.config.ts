import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: 'e2e',
  timeout: 180_000,
  workers: 1,
  reporter: 'list',
  use: { baseURL: 'http://localhost:3000', viewport: { width: 1440, height: 900 }, contextOptions: { reducedMotion: 'reduce' } },
})
