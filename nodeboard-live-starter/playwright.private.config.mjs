import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/private',
  timeout: 45_000,
  workers: 1,
  reporter: [['list']],
  use: { baseURL: 'http://127.0.0.1:8790', headless: true, viewport: { width: 1280, height: 800 } },
  webServer: [
    { command: 'node tests/fake-auth.mjs', port: 8899, reuseExistingServer: false },
    { command: 'npx wrangler dev --port 8790 --var SUPABASE_URL:http://127.0.0.1:8899 --var SUPABASE_PUBLISHABLE_KEY:fixture', url: 'http://127.0.0.1:8790/api/health', reuseExistingServer: false, timeout: 90_000 },
  ],
});
