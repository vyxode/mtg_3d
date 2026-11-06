import { defineConfig } from '@playwright/test';

// The GitHub Pages build (no game server): the same two-player test, with the host's browser running the room and
// the guest connecting over WebRTC. Needs internet access to PeerJS's public broker, so it runs in CI, not in `pnpm e2e`.
// With PAGES_URL set it plays against the published site instead (the smoke test after each GitHub Pages deploy).
const live = process.env.PAGES_URL;

export default defineConfig({
  testDir: 'e2e',
  testMatch: ['two-players.spec.ts', 'click-to-play.spec.ts', 'full-game.spec.ts', 'practice.spec.ts'],
  timeout: 90_000,
  use: { channel: 'chrome', baseURL: live ?? 'http://localhost:5175', screenshot: 'only-on-failure' },
  webServer: live ? [] : {
    command: 'pnpm --filter @mtg3d/web build && pnpm --filter @mtg3d/web exec vite preview --port 5175 --strictPort',
    env: { VITE_P2P: '1' },
    port: 5175,
    timeout: 180_000,
    reuseExistingServer: false,
  },
});
