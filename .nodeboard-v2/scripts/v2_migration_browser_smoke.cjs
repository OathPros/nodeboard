const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const { createHash } = require('node:crypto');

const root = path.resolve(__dirname, '../..');
const app = path.join(root, 'nodeboard-live-starter');
const requireApp = createRequire(path.join(app, 'package.json'));
const { chromium } = requireApp('playwright');
const esbuild = requireApp('esbuild');
const fixture = name => JSON.parse(fs.readFileSync(path.join(root, '.nodeboard-v2', 'fixtures', name), 'utf8'));

async function main() {
  const bundle = await esbuild.build({
    entryPoints: [path.join(app, 'src/domain/migrate-v1.js')],
    bundle: true,
    format: 'iife',
    globalName: 'nodeboardMigration',
    platform: 'browser',
    write: false,
  });
  const localMigration = await esbuild.build({
    entryPoints: [path.join(app, 'src/application/local-migration-v2.js')],
    bundle: true,
    format: 'iife',
    globalName: 'nodeboardLocalMigration',
    platform: 'browser',
    write: false,
  });
  const localStorage = await esbuild.build({
    entryPoints: [path.join(app, 'src/storage/local-v2.js')],
    bundle: true,
    format: 'iife',
    globalName: 'nodeboardStorage',
    platform: 'browser',
    write: false,
  });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setContent('<!doctype html><title>Nodeboard migration smoke test</title>');
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    const results = await page.evaluate(fixtures => fixtures.map(source => {
      const before = JSON.stringify(source);
      const result = nodeboardMigration.previewV1Migration(source);
      return {
        ok: result.ok,
        unchanged: before === JSON.stringify(source),
        snapshot: result.snapshot,
        backup: result.sourceBackup,
      };
    }), [fixture('legacy-valid.json'), fixture('legacy-multi-predicate.json'), fixture('legacy-invalid-endpoint.json')]);
    assert.equal(results[0].ok, true);
    assert.equal(results[1].ok, true);
    assert.equal(results[1].snapshot.graph.relationships.length, 2);
    assert.notEqual(results[1].snapshot.graph.relationships[0].relationshipTypeId, results[1].snapshot.graph.relationships[1].relationshipTypeId);
    assert.equal(results[2].ok, false);
    assert.equal(results[2].snapshot, null);
    for (const result of results) assert.equal(result.unchanged, true);
    assert.deepEqual(results[0].backup, fixture('legacy-valid.json'));
    assert.deepEqual(errors, []);
    const restoredContext = await browser.newContext();
    try {
      const restoredPage = await restoredContext.newPage();
      const restoreErrors = [];
      restoredPage.on('pageerror', error => restoreErrors.push(error.message));
      restoredPage.on('dialog', dialog => dialog.accept());
      await restoredPage.goto(pathToFileURL(path.join(app, 'public/index.html')).href);
      await restoredPage.locator('#localFile').setInputFiles({
        name: 'migration-source-backup.json',
        mimeType: 'application/json',
        buffer: Buffer.from(JSON.stringify(results[0].backup)),
      });
      await restoredPage.waitForFunction(() => JSON.parse(localStorage.getItem('nodeboard-v1.1')).nodes.some(node => node.id === 'demo-offering'));
      await restoredPage.reload();
      const restored = await restoredPage.evaluate(() => JSON.parse(localStorage.getItem('nodeboard-v1.1')));
      for (const field of ['classes', 'nodes', 'edges']) assert.deepEqual(restored[field], results[0].backup[field]);
      await restoredPage.addScriptTag({ content: localMigration.outputFiles[0].text });
      await restoredPage.addScriptTag({ content: localStorage.outputFiles[0].text });
      const localResult = await restoredPage.evaluate(async () => {
        const key = 'nodeboard-v1.1';
        const source = window.localStorage.getItem(key);
        const store = await nodeboardStorage.openLocalV2Store('local-migration-test');
        try {
          const preview = await nodeboardLocalMigration.prepareLocalV1Migration(window.localStorage);
          if (!preview.ok) throw new Error('The local migration preview failed.');
          const originalName = preview.snapshot.graph.entities[0].name;
          preview.snapshot.graph.entities[0].name = 'Unreviewed mutation';
          window.localStorage.setItem(key, `${source} `);
          let stale;
          try { await preview.commit(store, 'stale'); } catch (error) { stale = error.code; }
          const staleMissing = await store.read('stale') === null;
          window.localStorage.setItem(key, source);
          const created = await preview.commit(store, 'migrated');
          let duplicate;
          try { await preview.commit(store, 'migrated'); } catch (error) { duplicate = error.code; }
          const sourceUnchanged = window.localStorage.getItem(key) === source;
          window.localStorage.setItem(key, '{"not":"a board"}');
          const invalid = await nodeboardLocalMigration.prepareLocalV1Migration(window.localStorage);
          window.localStorage.setItem(key, source);
          let missing, unavailable;
          try { await nodeboardLocalMigration.prepareLocalV1Migration({ getItem() { return null; } }); }
          catch (error) { missing = error.code; }
          try { await nodeboardLocalMigration.prepareLocalV1Migration({ getItem() { throw new Error('denied'); } }); }
          catch (error) { unavailable = error.code; }
          const largeSource = source + ' '.repeat(4999000 - source.length);
          const oversized = await nodeboardLocalMigration.prepareLocalV1Migration({ getItem() { return largeSource; } });
          return {
            source, sourceUnchanged, stale, staleMissing, duplicate, invalid: invalid.ok, missing, unavailable,
            oversized: oversized.ok,
            oversizedLimited: oversized.diagnostics.some(item => item.code === 'RESOURCE_LIMIT_EXCEEDED'),
            name: created.snapshot.graph.entities[0].name, originalName,
            backup: created.snapshot.metadata.migration.sourceBackup,
            sourceText: created.snapshot.metadata.migration.sourceText,
            sourceHash: created.snapshot.metadata.migration.sourceHash,
          };
        } finally {
          store.close();
        }
      });
      assert.equal(localResult.sourceUnchanged, true);
      assert.equal(localResult.stale, 'SOURCE_CHANGED');
      assert.equal(localResult.staleMissing, true);
      assert.equal(localResult.duplicate, 'ALREADY_EXISTS');
      assert.equal(localResult.invalid, false);
      assert.equal(localResult.missing, 'SOURCE_NOT_FOUND');
      assert.equal(localResult.unavailable, 'SOURCE_UNAVAILABLE');
      assert.equal(localResult.oversized, false);
      assert.equal(localResult.oversizedLimited, true);
      assert.equal(localResult.name, localResult.originalName);
      assert.deepEqual(localResult.backup, restored);
      assert.equal(localResult.sourceText, localResult.source);
      assert.equal(localResult.sourceHash, `sha256:${createHash('sha256').update(localResult.source).digest('hex')}`);
      await restoredPage.reload();
      await restoredPage.addScriptTag({ content: localStorage.outputFiles[0].text });
      const reopened = await restoredPage.evaluate(async () => {
        const store = await nodeboardStorage.openLocalV2Store('local-migration-test');
        try { return await store.read('migrated'); }
        finally { store.close(); }
      });
      assert.equal(reopened.snapshot.metadata.migration.sourceText, localResult.source);
      assert.equal(reopened.snapshot.metadata.migration.sourceHash, localResult.sourceHash);
      assert.deepEqual(restoreErrors, []);
    } finally {
      await restoredContext.close();
    }
    console.log('PASS: isolated migration preview preserves sources, rejects broken references, and restores a v1 backup');
  } finally {
    await browser.close();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
