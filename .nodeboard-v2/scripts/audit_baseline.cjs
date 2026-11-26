const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '../..');
const app = path.join(root, 'nodeboard-live-starter');
const requireApp = createRequire(path.join(app, 'package.json'));
const { chromium } = requireApp('playwright');
const fixtures = [
  ['legacy-valid', true],
  ['legacy-multi-predicate', false],
  ['legacy-invalid-endpoint', false],
];

async function restoreRehearsal(browser) {
  const graph = JSON.parse(fs.readFileSync(path.join(root, '.nodeboard-v2/fixtures/legacy-valid.json'), 'utf8'));
  const url = pathToFileURL(path.join(app, 'public/index.html')).href;
  const source = await browser.newContext({ acceptDownloads: true });
  let backup;
  try {
    const page = await source.newPage();
    page.on('dialog', dialog => dialog.accept());
    await page.goto(url);
    await page.locator('#localFile').setInputFiles({
      name: 'synthetic-v1.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(graph)),
    });
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('nodeboard-v1.1')).nodes.some(node => node.id === 'demo-offering'));
    await page.locator('#profileBtn').click();
    const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#profileExport').click()]);
    backup = fs.readFileSync(await download.path());
    const exported = JSON.parse(backup);
    for (const field of ['classes', 'nodes', 'edges']) assert.deepEqual(exported[field], graph[field]);
  } finally {
    await source.close();
  }
  const target = await browser.newContext();
  try {
    const page = await target.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', dialog => dialog.accept());
    await page.goto(url);
    await page.locator('#localFile').setInputFiles({ name: 'backup.json', mimeType: 'application/json', buffer: backup });
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('nodeboard-v1.1')).nodes.some(node => node.id === 'demo-offering'));
    await page.reload();
    const restored = await page.evaluate(() => JSON.parse(localStorage.getItem('nodeboard-v1.1')));
    for (const field of ['classes', 'nodes', 'edges']) assert.deepEqual(restored[field], graph[field]);
    assert.deepEqual(errors, [], 'restore: uncaught browser errors');
  } finally {
    await target.close();
  }
  console.log('legacy-valid: exported, restored in a fresh context and reloaded without data loss');
}

async function main() {
  const source = fs.readFileSync(path.join(app, 'src/index.js'), 'utf8');
  const start = source.indexOf('const MAX_NODES');
  const end = source.indexOf('export default');
  assert.ok(start >= 0 && end > start, 'Worker validator not found');
  const browser = await chromium.launch({ headless: true });
  try {
    for (const [name, valid] of fixtures) {
      const text = fs.readFileSync(path.join(root, '.nodeboard-v2/fixtures', `${name}.json`), 'utf8');
      const graph = JSON.parse(text);
      const sandbox = vm.createContext({ TextEncoder, Uint8Array, crypto: globalThis.crypto, structuredClone, Response, console, graph });
      vm.runInContext(source.slice(start, end), sandbox);
      assert.equal(vm.runInContext('validGraph(graph)', sandbox), valid, `${name}: Worker validation`);

      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        page.on('dialog', dialog => dialog.accept());
        await page.goto(pathToFileURL(path.join(app, 'public/index.html')).href);
        const before = await page.evaluate(() => localStorage.getItem('nodeboard-v1.1'));
        await page.locator('#jsonViewBtn').click();
        await page.locator('#graphJson').fill(text);
        await page.locator('#applyGraphJson').click();
        if (valid) {
          await page.locator('#graphJsonBackdrop').waitFor({ state: 'hidden' });
          const imported = JSON.parse(await page.evaluate(() => localStorage.getItem('nodeboard-v1.1')));
          assert.deepEqual(imported.classes, graph.classes);
          assert.deepEqual(imported.nodes, graph.nodes);
          assert.deepEqual(imported.edges, graph.edges);
        } else {
          await page.locator('#graphJsonBackdrop').waitFor({ state: 'visible' });
          assert.match(await page.locator('#graphJsonFeedback').textContent(), /Invalid/);
          assert.equal(await page.evaluate(() => localStorage.getItem('nodeboard-v1.1')), before);
        }
        assert.deepEqual(errors, [], `${name}: uncaught browser errors`);
      } finally {
        await context.close();
      }
      console.log(`${name}: Worker and browser ${valid ? 'accepted' : 'rejected'} as expected`);
    }
    await restoreRehearsal(browser);
  } finally {
    await browser.close();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
