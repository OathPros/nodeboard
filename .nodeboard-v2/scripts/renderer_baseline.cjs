const assert = require('node:assert/strict');
const path = require('node:path');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const { performance } = require('node:perf_hooks');

const root = path.resolve(__dirname, '../..');
const app = path.join(root, 'nodeboard-live-starter');
const { chromium } = createRequire(path.join(app, 'package.json'))('playwright');

function graph(nodeCount, edgeCount) {
  return {
    classes: [{ id: 'class-1', key: 1, name: 'Item', shape: 'rounded', color: '#475569' }],
    nodes: Array.from({ length: nodeCount }, (_, i) => ({
      id: `node-${i}`, classId: 'class-1', name: `Item ${i}`,
      x: (i % 50) * 260, y: Math.floor(i / 50) * 140,
    })),
    edges: Array.from({ length: edgeCount }, (_, i) => ({
      id: `edge-${i}`, from: `node-${i % nodeCount}`,
      to: `node-${(i * 13 + 1) % nodeCount}`, label: 'RELATES_TO',
    })),
  };
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  console.log(`Chromium ${browser.version()}, viewport 1280x800, file://, fresh browser contexts`);
  try {
    for (const [nodes, edges] of [[300, 550], [3000, 6000]]) {
      const results = [];
      for (let trial = 0; trial < 3; trial++) {
        const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
        try {
          await context.addInitScript(value => localStorage.setItem('nodeboard-v1.1', JSON.stringify(value)), graph(nodes, edges));
          const page = await context.newPage();
          const errors = [];
          page.on('pageerror', error => errors.push(error.message));
          const started = performance.now();
          await page.goto(pathToFileURL(path.join(app, 'public/index.html')).href, { waitUntil: 'load', timeout: 120000 });
          await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
          results.push(Math.round(performance.now() - started));
          assert.equal(await page.locator('#scene .node').count(), nodes, 'rendered nodes');
          assert.equal(await page.locator('#scene .edge').count(), edges, 'rendered edges');
          assert.deepEqual(errors, [], 'uncaught browser errors');
        } finally {
          await context.close();
        }
      }
      console.log(`${nodes} nodes / ${edges} edges: ${results.join(', ')} ms (navigation through two animation frames)`);
    }
  } finally {
    await browser.close();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
