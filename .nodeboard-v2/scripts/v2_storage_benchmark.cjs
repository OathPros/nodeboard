const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '../..');
const app = path.join(root, 'nodeboard-live-starter');
const requireApp = createRequire(path.join(app, 'package.json'));
const { chromium } = requireApp('playwright');
const esbuild = requireApp('esbuild');
const snapshot = JSON.parse(fs.readFileSync(path.join(root, '.nodeboard-v2', 'fixtures', 'v2-draft-valid.json'), 'utf8'));
const entity = snapshot.graph.entities[0];
const relationship = snapshot.graph.relationships[0];
snapshot.graph.entities = Array.from({ length: 3000 }, (_, i) => ({ ...entity, id: `e${i}` }));
snapshot.graph.relationships = Array.from({ length: 6000 }, (_, i) => ({
  ...relationship, id: `r${i}`, from: `e${i % 3000}`, to: `e${(i + 1) % 3000}`,
}));
snapshot.views = [];

async function main() {
  const bundle = await esbuild.build({
    entryPoints: [path.join(app, 'src/storage/local-v2.js')], bundle: true,
    format: 'iife', globalName: 'nodeboardStorage', platform: 'browser', write: false,
  });
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await page.goto(pathToFileURL(path.join(app, 'public/index.html')).href);
      await page.addScriptTag({ content: bundle.outputFiles[0].text });
      const result = await page.evaluate(async graph => {
        const store = await nodeboardStorage.openLocalV2Store('v2-benchmark-isolated');
        try {
          await store.create('board', graph);
          const elapsed = [];
          for (let i = 0; i < 3; i++) {
            const changed = structuredClone(graph.graph.entities[0]);
            changed.name = `Edit ${i}`;
            const start = performance.now();
            await store.apply('board', {
              protocolVersion: 2, snapshotVersion: 2, operationId: `edit-${i}`, baseRevision: i,
              operations: [{ type: 'entity.put', entity: changed }],
            });
            elapsed.push(Math.round(performance.now() - start));
          }
          const start = performance.now();
          const undone = await store.undo('board', 3);
          return { elapsed, undo: Math.round(performance.now() - start), name: undone.snapshot.graph.entities[0].name, revision: undone.revision };
        } finally {
          store.close();
        }
      }, snapshot);
      assert.equal(result.revision, 4);
      assert.equal(result.name, 'Edit 1');
      console.log(JSON.stringify({ entities: 3000, relationships: 6000, editMs: result.elapsed, undoMs: result.undo }));
    } finally {
      await context.close();
    }
  } finally {
    await browser.close();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
