const path = require('node:path');
const { createRequire } = require('node:module');

const app = path.resolve(__dirname, '../../nodeboard-live-starter');
const { defineConfig } = createRequire(path.join(app, 'package.json'))('@playwright/test');
const portText = process.env.NODEBOARD_TEST_PORT;
const state = process.env.NODEBOARD_TEST_STATE;
if (!/^\d+$/.test(portText || '') || Number(portText) < 1 || Number(portText) > 65535) {
  throw new Error('Set NODEBOARD_TEST_PORT to an available local port.');
}
if (!state || !path.isAbsolute(state) || /["\r\n&|<>^%!]/.test(state)) {
  throw new Error('Set NODEBOARD_TEST_STATE to a safe absolute directory for disposable Wrangler data.');
}
const url = `http://127.0.0.1:${Number(portText)}`;

module.exports = defineConfig({
  testDir: path.join(app, 'tests/e2e'),
  outputDir: path.join(state, 'playwright-results'),
  timeout: 45000,
  workers: 1,
  reporter: [['list']],
  use: { baseURL: url, headless: true, viewport: { width: 1280, height: 800 } },
  webServer: {
    command: `npx wrangler dev --ip 127.0.0.1 --port ${Number(portText)} --persist-to "${state}"`,
    cwd: app,
    url: `${url}/api/health`,
    reuseExistingServer: false,
    timeout: 90000,
  },
});
