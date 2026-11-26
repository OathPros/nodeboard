const { defineConfig } = require('../../nodeboard-live-starter/node_modules/@playwright/test');
const path = require('node:path');

const state = process.env.NODEBOARD_TEST_STATE;
if (!state || !path.isAbsolute(state) || /["\r\n&|<>^%!]/.test(state)) {
  throw new Error('NODEBOARD_TEST_STATE must be a safe absolute disposable directory.');
}
const app = path.resolve(__dirname, '../../nodeboard-live-starter');

module.exports = defineConfig({
  testDir: __dirname,
  testMatch: 'v2_cloud.spec.cjs',
  outputDir: path.join(state, 'playwright-results'),
  timeout: 60000,
  workers: 1,
  reporter: [['list']],
  use: { baseURL: 'http://127.0.0.1:18880', headless: true },
  webServer: [
    {
      command: 'node tests\\fake-auth.mjs',
      cwd: app,
      port: 18881,
      env: { NODEBOARD_FAKE_AUTH_PORT: '18881' },
      reuseExistingServer: false,
    },
    {
      command: `npx wrangler dev --local --ip 127.0.0.1 --port 18880 --persist-to "${path.join(state, 'wrangler')}" --var SUPABASE_URL:http://127.0.0.1:18881 --var SUPABASE_PUBLISHABLE_KEY:fixture`,
      cwd: app,
      url: 'http://127.0.0.1:18880/api/health',
      reuseExistingServer: false,
      timeout: 90000,
    },
  ],
});
