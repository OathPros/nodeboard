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
const legacy = JSON.parse(fs.readFileSync(path.join(root, '.nodeboard-v2', 'fixtures', 'legacy-multi-predicate.json'), 'utf8'));

async function main() {
  const bundle = await esbuild.build({
    entryPoints: [path.join(app, 'src/storage/local-v2.js')],
    bundle: true,
    format: 'iife',
    globalName: 'nodeboardStorage',
    platform: 'browser',
    write: false,
  });
  const migration = await esbuild.build({
    entryPoints: [path.join(app, 'src/domain/migrate-v1.js')],
    bundle: true,
    format: 'iife',
    globalName: 'nodeboardMigration',
    platform: 'browser',
    write: false,
  });
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(pathToFileURL(path.join(app, 'public/index.html')).href);
      await page.addScriptTag({ content: bundle.outputFiles[0].text });
      await page.addScriptTag({ content: migration.outputFiles[0].text });
      const result = await page.evaluate(async ({ graph, source }) => {
        const one = await nodeboardStorage.openLocalV2Store('v2-isolated-test');
        const two = await nodeboardStorage.openLocalV2Store('v2-isolated-test');
        const created = await one.create('board-1', graph);
        const preview = nodeboardMigration.previewV1Migration(source);
        if (!preview.ok) throw new Error('Synthetic migration preview failed.');
        await one.create('migrated', preview.snapshot);
        let duplicate;
        try { await one.create('board-1', graph); } catch (error) { duplicate = error.code; }
        const command = id => ({
          protocolVersion: 2, snapshotVersion: 2, operationId: id, baseRevision: 0,
          operations: [{ type: 'relationship.put', relationship: {
            id, from: 'item-a', to: 'item-b', relationshipTypeId: 'rel-support',
            properties: {}, provenance: [], status: 'proposed',
          } }],
        });
        const concurrent = await Promise.allSettled([one.apply('board-1', command('one')), two.apply('board-1', command('two'))]);
        const afterConcurrent = await one.read('board-1');
        const invalid = command('invalid');
        invalid.baseRevision = 1;
        invalid.operations[0].relationship.to = 'missing';
        let invalidCode;
        try { await one.apply('board-1', invalid); } catch (error) { invalidCode = error.code; }
        const afterInvalid = await one.read('board-1');
        const entity = structuredClone(graph.graph.entities[0]);
        entity.name = 'At submission';
        const pending = one.apply('board-1', {
          protocolVersion: 2, snapshotVersion: 2, operationId: 'rename', baseRevision: 1,
          operations: [{ type: 'entity.put', entity }],
        });
        entity.name = 'After submission';
        const changed = await pending;
        const backup = await one.exportBackup('board-1');
        const restoredCopy = await one.restoreAsNew('board-copy', backup);
        let sameId, duplicateRestore, invalidBackup, unsafeBackup, unsafeNested, getterCalls = 0;
        try { await one.restoreAsNew('board-1', backup); } catch (error) { sameId = error.code; }
        try { await one.restoreAsNew('board-copy', backup); } catch (error) { duplicateRestore = error.code; }
        try { await one.restoreAsNew('invalid-copy', { ...backup, version: 2 }); } catch (error) { invalidBackup = error.code; }
        const unsafe = { ...backup };
        Object.defineProperty(unsafe, 'snapshot', { enumerable: true, get() { getterCalls++; throw new Error('must not run'); } });
        try { await one.restoreAsNew('unsafe-copy', unsafe); } catch (error) { unsafeBackup = error.code; }
        const nested = structuredClone(backup);
        Object.defineProperty(nested.snapshot.metadata, 'hidden', { enumerable: true, get() { getterCalls++; throw new Error('must not run'); } });
        try { await one.restoreAsNew('unsafe-nested-copy', nested); } catch (error) { unsafeNested = error.code; }
        await one.create('history-board', graph);
        const historyEdge = command('history-edge');
        await one.apply('history-board', historyEdge);
        const historyEntity = structuredClone(graph.graph.entities[0]);
        historyEntity.name = 'Edited';
        historyEntity.provenance = [{
          sourceId: 'source', confidence: 1,
          validFrom: '2024-01-01T00:00:00Z', validUntil: '2024-01-02T00:00:00Z',
        }];
        await one.apply('history-board', {
          protocolVersion: 2, snapshotVersion: 2, operationId: 'history-rename', baseRevision: 1,
          operations: [{ type: 'entity.put', entity: historyEntity }],
        });
        const undone = await one.undo('history-board', 2);
        const redone = await one.redo('history-board', 3);
        let staleHistory, missingRedo;
        try { await two.undo('history-board', 2); } catch (error) { staleHistory = error.code; }
        const undoneAgain = await one.undo('history-board', 4);
        const newEdit = command('new-history-edge');
        newEdit.baseRevision = 5;
        const branched = await one.apply('history-board', newEdit);
        try { await one.redo('history-board', 6); } catch (error) { missingRedo = error.code; }
        const missing = await one.read('missing');
        one.close(); two.close();
        return {
          created, duplicate,
          concurrent: concurrent.map(entry => entry.status === 'fulfilled' ? 'committed' : entry.reason.code),
          afterConcurrent, invalidCode, afterInvalid, changed, backup, restoredCopy, sameId, duplicateRestore, invalidBackup, unsafeBackup, unsafeNested, getterCalls,
          undone, redone, undoneAgain, branched, staleHistory, missingRedo, missing,
        };
      }, { graph: snapshot, source: legacy });
      assert.equal(result.created.revision, 0);
      assert.deepEqual(result.created.snapshot, snapshot);
      assert.equal(result.duplicate, 'ALREADY_EXISTS');
      assert.deepEqual(result.concurrent.sort(), ['REVISION_CONFLICT', 'committed'].sort());
      assert.equal(result.afterConcurrent.revision, 1);
      assert.equal(result.afterConcurrent.snapshot.graph.relationships.length, 4);
      assert.equal(result.invalidCode, 'INVALID_RESULT');
      assert.deepEqual(result.afterInvalid, result.afterConcurrent);
      assert.equal(result.changed.revision, 2);
      assert.equal(result.changed.snapshot.graph.entities[0].name, 'At submission');
      assert.equal(result.backup.sourceRevision, 2);
      assert.equal(result.restoredCopy.revision, 0);
      assert.deepEqual(result.restoredCopy.snapshot, result.changed.snapshot);
      assert.equal(result.sameId, 'INVALID_BOARD_ID');
      assert.equal(result.duplicateRestore, 'ALREADY_EXISTS');
      assert.equal(result.invalidBackup, 'INVALID_BACKUP');
      assert.equal(result.unsafeBackup, 'INVALID_BACKUP');
      assert.equal(result.unsafeNested, 'INVALID_BACKUP');
      assert.equal(result.getterCalls, 0);
      assert.equal(result.undone.revision, 3);
      assert.equal(result.undone.snapshot.graph.entities[0].name, snapshot.graph.entities[0].name);
      assert.equal(result.undone.snapshot.graph.relationships.length, 4);
      assert.equal(result.redone.revision, 4);
      assert.equal(result.redone.snapshot.graph.entities[0].name, 'Edited');
      assert.deepEqual(result.redone.snapshot.graph.entities[0].provenance, [{
        sourceId: 'source', confidence: 1,
        validFrom: '2024-01-01T00:00:00Z', validUntil: '2024-01-02T00:00:00Z',
      }]);
      assert.equal(result.staleHistory, 'REVISION_CONFLICT');
      assert.equal(result.undoneAgain.history.redo, 1);
      assert.equal(result.branched.revision, 6);
      assert.equal(result.branched.history.redo, 0);
      assert.equal(result.missingRedo, 'NO_REDO');
      assert.equal(result.missing, null);
      const bounded = await page.evaluate(async graph => {
        const store = await nodeboardStorage.openLocalV2Store('v2-isolated-test');
        try {
          await store.create('bounded-history', graph);
          let result;
          for (let i = 0; i < 101; i++) {
            const entity = structuredClone(graph.graph.entities[0]);
            entity.name = `Revision ${i + 1}`;
            result = await store.apply('bounded-history', {
              protocolVersion: 2, snapshotVersion: 2, operationId: `bounded-${i}`, baseRevision: i,
              operations: [{ type: 'entity.put', entity }],
            });
          }
          return result;
        } finally {
          store.close();
        }
      }, snapshot);
      assert.equal(bounded.revision, 101);
      assert.equal(bounded.history.undo, 100);
      assert.equal(bounded.history.dropped, 1);
      assert.equal(bounded.historyTruncated, true);
      assert.equal(bounded.retryHistoryTruncated, true);
      const retries = await page.evaluate(async graph => {
        const one = await nodeboardStorage.openLocalV2Store('v2-retry-test');
        const two = await nodeboardStorage.openLocalV2Store('v2-retry-test');
        const entity = structuredClone(graph.graph.entities[0]);
        const first = {
          protocolVersion: 2, snapshotVersion: 2, operationId: 'retry-op', baseRevision: 0,
          operations: [{ type: 'entity.put', entity: { ...entity, name: 'First edit' } }],
        };
        try {
          await one.create('board', graph);
          const concurrent = await Promise.all([one.apply('board', first), two.apply('board', first)]);
          const second = {
            protocolVersion: 2, snapshotVersion: 2, operationId: 'second-op', baseRevision: 1,
            operations: [{ type: 'entity.put', entity: { ...entity, name: 'Later edit' } }],
          };
          await one.apply('board', second);
          const reordered = {
            operations: first.operations, baseRevision: first.baseRevision, operationId: first.operationId,
            snapshotVersion: first.snapshotVersion, protocolVersion: first.protocolVersion,
          };
          const replay = await two.apply('board', reordered);
          let reuse;
          try { await one.apply('board', { ...first, operations: second.operations }); }
          catch (error) { reuse = error.code; }
          const unchanged = await one.read('board');
          await one.undo('board', 2);
          const afterUndo = await one.apply('board', first);
          const invalid = {
            protocolVersion: 2, snapshotVersion: 2, operationId: 'failed-op', baseRevision: 3,
            operations: [{ type: 'relationship.put', relationship: {
              id: 'bad-edge', from: 'item-a', to: 'missing', relationshipTypeId: 'rel-support',
              properties: {}, provenance: [], status: 'asserted',
            } }],
          };
          let invalidCode;
          try { await one.apply('board', invalid); } catch (error) { invalidCode = error.code; }
          invalid.operations[0].relationship.to = 'item-b';
          const fixed = await one.apply('board', invalid);
          return {
            concurrent: concurrent.map(result => ({ revision: result.revision, replayed: result.replayed })),
            replay: { revision: replay.revision, committedRevision: replay.committedRevision, name: replay.snapshot.graph.entities[0].name, replayed: replay.replayed },
            reuse, unchangedRevision: unchanged.revision,
            afterUndo: { revision: afterUndo.revision, committedRevision: afterUndo.committedRevision, name: afterUndo.snapshot.graph.entities[0].name },
            invalidCode, fixedRevision: fixed.revision,
          };
        } finally {
          one.close(); two.close();
        }
      }, snapshot);
      assert.deepEqual(retries.concurrent.map(item => item.replayed).sort(), [false, true]);
      assert.ok(retries.concurrent.every(item => item.revision === 1));
      assert.deepEqual(retries.replay, { revision: 2, committedRevision: 1, name: 'Later edit', replayed: true });
      assert.equal(retries.reuse, 'OPERATION_ID_REUSE');
      assert.equal(retries.unchangedRevision, 2);
      assert.deepEqual(retries.afterUndo, { revision: 3, committedRevision: 1, name: 'First edit' });
      assert.equal(retries.invalidCode, 'INVALID_RESULT');
      assert.equal(retries.fixedRevision, 4);
      const reopenedRetry = await page.evaluate(async graph => {
        const store = await nodeboardStorage.openLocalV2Store('v2-retry-test');
        try {
          const entity = { ...graph.graph.entities[0], name: 'First edit' };
          const result = await store.apply('board', {
            protocolVersion: 2, snapshotVersion: 2, operationId: 'retry-op', baseRevision: 0,
            operations: [{ type: 'entity.put', entity }],
          });
          return { replayed: result.replayed, revision: result.revision, committedRevision: result.committedRevision };
        } finally {
          store.close();
        }
      }, snapshot);
      assert.deepEqual(reopenedRetry, { replayed: true, revision: 4, committedRevision: 1 });
      const corruptRetry = await page.evaluate(async graph => {
        const request = indexedDB.open('v2-retry-test', 2);
        const db = await new Promise((resolve, reject) => {
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        await new Promise((resolve, reject) => {
          const transaction = db.transaction('operations', 'readwrite');
          const store = transaction.objectStore('operations');
          const get = store.get(['board', 'retry-op']);
          get.onsuccess = () => {
            const record = get.result;
            const payload = JSON.parse(record.payload);
            payload.baseRevision = 8;
            record.payload = JSON.stringify(payload);
            record.bytes = new TextEncoder().encode(record.payload).length;
            store.put(record);
          };
          transaction.oncomplete = resolve;
          transaction.onabort = () => reject(transaction.error);
        });
        db.close();
        const store = await nodeboardStorage.openLocalV2Store('v2-retry-test');
        try {
          let code;
          try {
            await store.apply('board', {
              protocolVersion: 2, snapshotVersion: 2, operationId: 'retry-op', baseRevision: 0,
              operations: [{ type: 'entity.put', entity: { ...graph.graph.entities[0], name: 'First edit' } }],
            });
          } catch (error) { code = error.code; }
          const current = await store.read('board');
          return { code, revision: current.revision };
        } finally {
          store.close();
        }
      }, snapshot);
      assert.deepEqual(corruptRetry, { code: 'CORRUPT_BOARD', revision: 4 });
      const expiredRetry = await page.evaluate(async graph => {
        const store = await nodeboardStorage.openLocalV2Store('v2-isolated-test');
        try {
          const entity = structuredClone(graph.graph.entities[0]);
          entity.name = 'Revision 1';
          try {
            await store.apply('bounded-history', {
              protocolVersion: 2, snapshotVersion: 2, operationId: 'bounded-0', baseRevision: 0,
              operations: [{ type: 'entity.put', entity }],
            });
          } catch (error) { return error.code; }
          return 'unexpected-success';
        } finally {
          store.close();
        }
      }, snapshot);
      assert.equal(expiredRetry, 'REVISION_CONFLICT');
      const upgrade = await page.evaluate(async graph => {
        const request = indexedDB.open('v2-upgrade-test', 1);
        const old = await new Promise((resolve, reject) => {
          request.onupgradeneeded = () => request.result.createObjectStore('boards', { keyPath: 'id' });
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        await new Promise((resolve, reject) => {
          const transaction = old.transaction('boards', 'readwrite');
          transaction.objectStore('boards').add({
            id: 'existing', storageVersion: 1, revision: 7, snapshot: graph,
            history: { past: [], future: [], dropped: 0 },
          });
          transaction.oncomplete = resolve;
          transaction.onabort = () => reject(transaction.error);
        });
        old.close();
        const store = await nodeboardStorage.openLocalV2Store('v2-upgrade-test');
        try {
          const before = await store.read('existing');
          let oldRetry;
          try {
            await store.apply('existing', {
              protocolVersion: 2, snapshotVersion: 2, operationId: 'old-op', baseRevision: 6,
              operations: [{ type: 'entity.put', entity: graph.graph.entities[0] }],
            });
          } catch (error) { oldRetry = error.code; }
          const batch = {
            protocolVersion: 2, snapshotVersion: 2, operationId: 'upgrade-op', baseRevision: 7,
            operations: [{ type: 'entity.put', entity: graph.graph.entities[0] }],
          };
          const applied = await store.apply('existing', batch);
          const replay = await store.apply('existing', batch);
          return { preserved: JSON.stringify(before.snapshot) === JSON.stringify(graph), revision: applied.revision, replayed: replay.replayed, oldRetry };
        } finally {
          store.close();
        }
      }, snapshot);
      assert.deepEqual(upgrade, { preserved: true, revision: 8, replayed: true, oldRetry: 'REVISION_CONFLICT' });
      const byteLimitedRetries = await page.evaluate(async graph => {
        const store = await nodeboardStorage.openLocalV2Store('v2-retry-bytes');
        try {
          await store.create('board', graph);
          let latest, first;
          for (let i = 0; i < 5; i++) {
            const entity = { ...graph.graph.entities[0], name: `${'x'.repeat(2100000)}${i}` };
            const batch = {
              protocolVersion: 2, snapshotVersion: 2, operationId: `large-retry-${i}`, baseRevision: i,
              operations: [{ type: 'entity.put', entity }],
            };
            if (!i) first = batch;
            latest = await store.apply('board', batch);
          }
          let expired;
          try { await store.apply('board', first); } catch (error) { expired = error.code; }
          return { truncated: latest.retryHistoryTruncated, revision: latest.revision, expired };
        } finally {
          store.close();
        }
      }, snapshot);
      assert.deepEqual(byteLimitedRetries, { truncated: true, revision: 5, expired: 'REVISION_CONFLICT' });
      const failedLogWrite = await page.evaluate(async graph => {
        const request = indexedDB.open('v2-broken-retry', 2);
        const db = await new Promise((resolve, reject) => {
          request.onupgradeneeded = () => {
            request.result.createObjectStore('boards', { keyPath: 'id' });
            request.result.createObjectStore('operations', { keyPath: ['boardId', 'operationId'] });
          };
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        await new Promise((resolve, reject) => {
          const transaction = db.transaction('boards', 'readwrite');
          transaction.objectStore('boards').add({
            id: 'board', storageVersion: 1, revision: 0, snapshot: graph,
            history: { past: [], future: [], dropped: 0 },
          });
          transaction.oncomplete = resolve;
          transaction.onabort = () => reject(transaction.error);
        });
        db.close();
        const store = await nodeboardStorage.openLocalV2Store('v2-broken-retry');
        try {
          let code;
          try {
            await store.apply('board', {
              protocolVersion: 2, snapshotVersion: 2, operationId: 'fail-op', baseRevision: 0,
              operations: [{ type: 'entity.put', entity: { ...graph.graph.entities[0], name: 'Must not persist' } }],
            });
          } catch (error) { code = error.code; }
          const record = await store.read('board');
          return { code, revision: record.revision, unchanged: JSON.stringify(record.snapshot) === JSON.stringify(graph) };
        } finally {
          store.close();
        }
      }, snapshot);
      assert.deepEqual(failedLogWrite, { code: 'STORAGE_ERROR', revision: 0, unchanged: true });
      const byteBounded = await page.evaluate(async graph => {
        graph.metadata.padding = 'x'.repeat(2100000);
        const store = await nodeboardStorage.openLocalV2Store('v2-isolated-test');
        try {
          await store.create('byte-bounded-history', graph);
          let result;
          for (let i = 0; i < 5; i++) {
            const entity = structuredClone(graph.graph.entities[0]);
            entity.name = `Large revision ${i + 1}`;
            result = await store.apply('byte-bounded-history', {
              protocolVersion: 2, snapshotVersion: 2, operationId: `large-${i}`, baseRevision: i,
              operations: [{ type: 'entity.put', entity }],
            });
          }
          return { revision: result.revision, history: result.history, historyTruncated: result.historyTruncated };
        } finally {
          store.close();
        }
      }, snapshot);
      assert.equal(byteBounded.revision, 5);
      assert.equal(byteBounded.history.undo, 4);
      assert.equal(byteBounded.history.dropped, 1);
      assert.equal(byteBounded.historyTruncated, true);
      const largeBackup = await page.evaluate(async graph => {
        graph.metadata.padding = '';
        const encoder = new TextEncoder();
        const baseBytes = encoder.encode(JSON.stringify(graph)).length;
        graph.metadata.padding = 'x'.repeat(5000000 - baseBytes);
        const store = await nodeboardStorage.openLocalV2Store('v2-isolated-test');
        let summary;
        try {
          await store.create('large-backup-source', graph);
          const backup = await store.exportBackup('large-backup-source');
          const copy = await store.restoreAsNew('large-backup-copy', backup);
          const oversized = structuredClone(backup);
          oversized.snapshot.metadata.padding += 'x';
          let oversizedCode;
          try { await store.restoreAsNew('oversized-backup-copy', oversized); }
          catch (error) { oversizedCode = error.code; }
          summary = {
            snapshotBytes: encoder.encode(JSON.stringify(graph)).length,
            backupBytes: encoder.encode(JSON.stringify(backup)).length,
            equal: JSON.stringify(copy.snapshot) === JSON.stringify(graph),
            oversizedCode,
            oversizedMissing: await store.read('oversized-backup-copy') === null,
          };
        } finally {
          store.close();
        }
        const reopened = await nodeboardStorage.openLocalV2Store('v2-isolated-test');
        try {
          const copy = await reopened.read('large-backup-copy');
          summary.persisted = JSON.stringify(copy.snapshot) === JSON.stringify(graph);
        } finally {
          reopened.close();
        }
        return summary;
      }, snapshot);
      assert.equal(largeBackup.snapshotBytes, 5000000);
      assert.ok(largeBackup.backupBytes > 5000000);
      assert.equal(largeBackup.equal, true);
      assert.equal(largeBackup.persisted, true);
      assert.equal(largeBackup.oversizedCode, 'INVALID_BACKUP');
      assert.equal(largeBackup.oversizedMissing, true);
      const diagnosticLimit = await page.evaluate(async graph => {
        graph.graph.entities = Array.from({ length: 1100 }, (_, i) => ({
          ...structuredClone(graph.graph.entities[0]), id: `invalid-${i}`, classIds: ['missing'],
        }));
        const store = await nodeboardStorage.openLocalV2Store('v2-isolated-test');
        try {
          let code, diagnostics;
          try { await store.create('diagnostic-limit', graph); }
          catch (error) { code = error.code; diagnostics = error.diagnostics; }
          return {
            code,
            limited: diagnostics.some(item => item.code === 'RESOURCE_LIMIT_EXCEEDED' && item.severity === 'error'),
            missing: await store.read('diagnostic-limit') === null,
          };
        } finally {
          store.close();
        }
      }, snapshot);
      assert.deepEqual(diagnosticLimit, { code: 'INVALID_SNAPSHOT', limited: true, missing: true });
      const patternLimit = await page.evaluate(async graph => {
        graph.ontology.constraints.push({
          id: 'pattern', kind: 'pattern',
          parameters: { classId: 'class-item', propertyId: 'prop-extension', syntax: 'glob', pattern: 'x'.repeat(100) },
        });
        graph.graph.entities[0].properties['prop-extension'] = 'x'.repeat(10000);
        const store = await nodeboardStorage.openLocalV2Store('v2-isolated-test');
        try {
          let code, diagnostics;
          try { await store.create('pattern-limit', graph); }
          catch (error) { code = error.code; diagnostics = error.diagnostics; }
          return {
            code,
            limited: diagnostics.some(item => item.code === 'RESOURCE_LIMIT_EXCEEDED' && item.severity === 'error'),
            missing: await store.read('pattern-limit') === null,
          };
        } finally {
          store.close();
        }
      }, snapshot);
      assert.deepEqual(patternLimit, { code: 'INVALID_SNAPSHOT', limited: true, missing: true });
      const cycleHistory = await page.evaluate(async graph => {
        graph.ontology.constraints.push({ id: 'acyclic', kind: 'acyclic', parameters: { relationshipTypeId: 'rel-support' } });
        const store = await nodeboardStorage.openLocalV2Store('v2-isolated-test');
        try {
          await store.create('acyclic-board', graph);
          const edit = await store.apply('acyclic-board', {
            protocolVersion: 2, snapshotVersion: 2, operationId: 'cycle-op', baseRevision: 0,
            operations: [{ type: 'relationship.put', relationship: {
              id: 'cycle-edge', from: 'item-b', to: 'item-a', relationshipTypeId: 'rel-support',
              properties: {}, provenance: [], status: 'asserted',
            } }],
          });
          const undone = await store.undo('acyclic-board', edit.revision);
          const redone = await store.redo('acyclic-board', undone.revision);
          return {
            warned: edit.diagnostics.some(d => d.code === 'CONSTRAINT_VIOLATION' && d.entityId === 'cycle-edge'),
            undoRemoved: !undone.snapshot.graph.relationships.some(edge => edge.id === 'cycle-edge'),
            redoRestored: redone.snapshot.graph.relationships.some(edge => edge.id === 'cycle-edge'),
          };
        } finally {
          store.close();
        }
      }, snapshot);
      assert.deepEqual(cycleHistory, { warned: true, undoRemoved: true, redoRestored: true });
      const listing = await page.evaluate(async graph => {
        const store = await nodeboardStorage.openLocalV2Store('v2-list-test');
        try {
          for (const id of ['third', 'first', 'second']) await store.create(id, graph);
          const first = await store.list({ limit: 2 });
          const second = await store.list({ limit: 2, after: first.nextAfter });
          const all = await store.list();
          let invalidLimit, invalidId, invalidBoard, getterCalls = 0, accessor;
          try { await store.list({ limit: 0 }); } catch (error) { invalidLimit = error.code; }
          try { await store.list({ after: 'first\n' }); } catch (error) { invalidId = error.code; }
          try { await store.create('invalid\n', graph); } catch (error) { invalidBoard = error.code; }
          const options = {};
          Object.defineProperty(options, 'limit', { enumerable: true, get() { getterCalls++; return 2; } });
          try { await store.list(options); } catch (error) { accessor = error.code; }
          return { first, second, all, invalidLimit, invalidId, invalidBoard, accessor, getterCalls };
        } finally {
          store.close();
        }
      }, snapshot);
      assert.deepEqual(listing.first, { ids: ['first', 'second'], nextAfter: 'second' });
      assert.deepEqual(listing.second, { ids: ['third'], nextAfter: null });
      assert.deepEqual(listing.all, { ids: ['first', 'second', 'third'], nextAfter: null });
      assert.equal(listing.invalidLimit, 'INVALID_LIST_OPTIONS');
      assert.equal(listing.invalidId, 'INVALID_LIST_OPTIONS');
      assert.equal(listing.invalidBoard, 'INVALID_BOARD_ID');
      assert.equal(listing.accessor, 'INVALID_LIST_OPTIONS');
      assert.equal(listing.getterCalls, 0);
      const corruptKey = await page.evaluate(async () => {
        const request = indexedDB.open('v2-list-test', 2);
        const db = await new Promise((resolve, reject) => {
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        await new Promise((resolve, reject) => {
          const transaction = db.transaction('boards', 'readwrite');
          transaction.objectStore('boards').add({ id: 'bad key' });
          transaction.oncomplete = resolve;
          transaction.onabort = () => reject(transaction.error);
        });
        db.close();
        const store = await nodeboardStorage.openLocalV2Store('v2-list-test');
        try {
          try { await store.list(); } catch (error) { return error.code; }
          return 'unexpected-success';
        } finally {
          store.close();
        }
      });
      assert.equal(corruptKey, 'CORRUPT_BOARD');
      const otherPage = await context.newPage();
      otherPage.on('pageerror', error => errors.push(error.message));
      await otherPage.goto(pathToFileURL(path.join(app, 'public/index.html')).href);
      await otherPage.addScriptTag({ content: bundle.outputFiles[0].text });
      const applyFromTab = async (target, name) => target.evaluate(async name => {
        const store = await nodeboardStorage.openLocalV2Store('v2-isolated-test');
        try {
          const current = await store.read('board-1');
          const entity = current.snapshot.graph.entities[0];
          entity.name = name;
          await store.apply('board-1', {
            protocolVersion: 2, snapshotVersion: 2, operationId: name, baseRevision: 2,
            operations: [{ type: 'entity.put', entity }],
          });
          return 'committed';
        } catch (error) {
          return error.code;
        } finally {
          store.close();
        }
      }, name);
      const tabs = await Promise.all([applyFromTab(page, 'tab-one'), applyFromTab(otherPage, 'tab-two')]);
      assert.deepEqual(tabs.sort(), ['REVISION_CONFLICT', 'committed'].sort());
      await otherPage.close();
      await page.reload();
      await page.addScriptTag({ content: bundle.outputFiles[0].text });
      const reopened = await page.evaluate(async () => {
        const store = await nodeboardStorage.openLocalV2Store('v2-isolated-test');
        const board = await store.read('board-1');
        const migrated = await store.read('migrated');
        const copy = await store.read('board-copy');
        const history = await store.read('history-board');
        const invalidCopy = await store.read('invalid-copy');
        store.close();
        return { board, migrated, copy, history, invalidCopy };
      });
      assert.equal(reopened.board.revision, 3);
      assert.ok(['tab-one', 'tab-two'].includes(reopened.board.snapshot.graph.entities[0].name));
      assert.equal(reopened.migrated.snapshot.graph.relationships.length, 2);
      assert.deepEqual(reopened.migrated.snapshot.metadata.migration.sourceBackup, legacy);
      assert.deepEqual(reopened.copy.snapshot, result.changed.snapshot);
      assert.equal(reopened.copy.history.undo, 0);
      assert.equal(reopened.history.revision, 6);
      assert.equal(reopened.history.history.undo, 2);
      assert.equal(reopened.history.history.redo, 0);
      assert.equal(reopened.invalidCopy, null);
      const corruption = await page.evaluate(async graph => {
        const request = indexedDB.open('v2-isolated-test', 2);
        const db = await new Promise((resolve, reject) => {
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        await new Promise((resolve, reject) => {
          const transaction = db.transaction('boards', 'readwrite');
          transaction.objectStore('boards').add({
            id: 'corrupt', storageVersion: 1, revision: 0, snapshot: {},
            history: { past: [], future: [], dropped: 0 },
          });
          transaction.objectStore('boards').add({
            id: 'corrupt-history', storageVersion: 1, revision: 0, snapshot: graph,
            history: { past: [null], future: [], dropped: 0 },
          });
          transaction.objectStore('boards').add({
            id: 'future', storageVersion: 2, revision: 0, snapshot: graph,
            history: { past: [], future: [], dropped: 0 },
          });
          transaction.oncomplete = resolve;
          transaction.onabort = () => reject(transaction.error);
        });
        db.close();
        const store = await nodeboardStorage.openLocalV2Store('v2-isolated-test');
        let code, historyCode, futureCode, futureApply;
        try { await store.read('corrupt'); }
        catch (error) { code = error.code; }
        try { await store.undo('corrupt-history', 0); }
        catch (error) { historyCode = error.code; }
        try { await store.read('future'); }
        catch (error) { futureCode = error.code; }
        try {
          await store.apply('future', {
            protocolVersion: 2, snapshotVersion: 2, operationId: 'future-op', baseRevision: 0,
            operations: [{ type: 'entity.put', entity: graph.graph.entities[0] }],
          });
        } catch (error) { futureApply = error.code; }
        store.close();
        const check = indexedDB.open('v2-isolated-test', 2);
        const checkDb = await new Promise((resolve, reject) => {
          check.onsuccess = () => resolve(check.result);
          check.onerror = () => reject(check.error);
        });
        const record = await new Promise((resolve, reject) => {
          const transaction = checkDb.transaction('boards', 'readonly');
          const get = transaction.objectStore('boards').get('corrupt');
          get.onsuccess = () => resolve(get.result);
          get.onerror = () => reject(get.error);
        });
        checkDb.close();
        return { code, historyCode, futureCode, futureApply, record };
      }, snapshot);
      assert.equal(corruption.code, 'CORRUPT_BOARD');
      assert.equal(corruption.historyCode, 'CORRUPT_BOARD');
      assert.equal(corruption.futureCode, 'UNSUPPORTED_STORAGE_VERSION');
      assert.equal(corruption.futureApply, 'UNSUPPORTED_STORAGE_VERSION');
      assert.deepEqual(corruption.record, {
        id: 'corrupt', storageVersion: 1, revision: 0, snapshot: {},
        history: { past: [], future: [], dropped: 0 },
      });
      assert.deepEqual(errors, []);
      console.log('PASS: isolated IndexedDB transactions, conflicts, rollback and reload');
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
