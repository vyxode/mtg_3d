import { defineConfig } from '@playwright/test';

// Uses the locally installed Google Chrome (channel 'chrome'), so no browser download is needed.
export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  use: { channel: 'chrome', baseURL: 'http://localhost:5174', screenshot: 'only-on-failure' },
  webServer: [
    { command: 'pnpm --filter @mtg3d/server start', env: { PORT: '3101', CORS_ORIGINS: '' }, port: 3101, reuseExistingServer: false },
    { command: 'pnpm --filter @mtg3d/web exec vite --port 5174 --strictPort', env: { SERVER_URL: 'http://localhost:3101' }, port: 5174, reuseExistingServer: false },
  ],
});
