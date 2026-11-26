const { defineConfig } = require('../../nodeboard-live-starter/node_modules/@playwright/test');
const path = require('node:path');

const state = process.env.NODEBOARD_TEST_STATE;
if (!state || !path.isAbsolute(state) || /["\r\n&|<>^%!]/.test(state)) {
  throw new Error('NODEBOARD_TEST_STATE must be a safe absolute disposable directory.');
}
const app = path.resolve(__dirname, '../../nodeboard-live-starter');
module.exports = defineConfig({
  testDir: path.join(app, 'tests', 'private'),
  outputDir: path.join(state, 'playwright-results'),
  timeout: 45000,
  workers: 1,
  reporter: [['list']],
  use: { baseURL: 'http://127.0.0.1:18882', headless: true, viewport: { width: 1280, height: 800 } },
  webServer: [
    { command: 'node tests\\fake-auth.mjs', cwd: app, port: 18883, env: { NODEBOARD_FAKE_AUTH_PORT: '18883' }, reuseExistingServer: false },
    {
      command: `npx wrangler dev --local --ip 127.0.0.1 --port 18882 --persist-to "${path.join(state, 'wrangler')}" --var SUPABASE_URL:http://127.0.0.1:18883 --var SUPABASE_PUBLISHABLE_KEY:fixture`,
      cwd: app, url: 'http://127.0.0.1:18882/api/health', reuseExistingServer: false, timeout: 90000,
    },
  ],
});
