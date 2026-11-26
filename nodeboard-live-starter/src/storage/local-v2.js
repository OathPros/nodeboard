import { applyBatch, GraphCommandError } from '../domain/graph-v2.js';
import { inspectJsonInput, validateSnapshot } from '../domain/validate-v2.js';

const ID = /^[A-Za-z0-9_-]{1,120}$(?![\s\S])/;
const MAX_HISTORY_BYTES = 10000000;
const MAX_HISTORY_ENTRIES = 100;
const MAX_RETRY_BYTES = 10000000;
const MAX_RETRY_ENTRIES = 100;
const cloneJson = value => JSON.parse(JSON.stringify(value));
const canonicalJson = value => JSON.stringify(value, (key, entry) =>
  entry !== null && typeof entry === 'object' && !Array.isArray(entry)
    ? Object.fromEntries(Object.keys(entry).sort().map(name => [name, entry[name]])) : entry);

export class LocalStoreError extends Error {
  constructor(code, message, diagnostics = []) {
    super(message);
    this.name = 'LocalStoreError';
    this.code = code;
    this.diagnostics = diagnostics;
  }
}

function requireId(id) {
  if (typeof id !== 'string' || !ID.test(id)) {
    throw new LocalStoreError('INVALID_BOARD_ID', 'The board ID is invalid.');
  }
}

function snapshotCopy(snapshot) {
  const diagnostics = validateSnapshot(snapshot);
  if (diagnostics.some(diagnostic => diagnostic.severity === 'error')) {
    throw new LocalStoreError('INVALID_SNAPSHOT', 'The board snapshot is invalid.', diagnostics);
  }
  return cloneJson(snapshot);
}

function storedHistory(record) {
  const history = record.history;
  const denseArray = array => Array.isArray(array) && array.length <= MAX_HISTORY_ENTRIES && Object.getPrototypeOf(array) === Array.prototype &&
    Reflect.ownKeys(array).length === array.length + 1 &&
    Array.from({ length: array.length }, (_, index) => Object.hasOwn(array, index)).every(Boolean);
  if (!history || typeof history !== 'object' || Object.getPrototypeOf(history) !== Object.prototype ||
      !denseArray(history.past) || !denseArray(history.future) ||
      !Number.isSafeInteger(history.dropped) || history.dropped < 0 ||
      history.past.length + history.future.length > MAX_HISTORY_ENTRIES ||
      Reflect.ownKeys(history).some(key => !['past', 'future', 'dropped'].includes(key))) {
    throw new LocalStoreError('CORRUPT_BOARD', 'The stored history is invalid.');
  }
  for (const snapshot of [...history.past, ...history.future]) {
    if (inspectJsonInput(snapshot).some(diagnostic => diagnostic.severity === 'error')) {
      throw new LocalStoreError('CORRUPT_BOARD', 'The stored history is invalid.');
    }
  }
  if (new TextEncoder().encode(JSON.stringify(history)).length > MAX_HISTORY_BYTES) {
    throw new LocalStoreError('CORRUPT_BOARD', 'The stored history exceeds its size limit.');
  }
  return history;
}

function historyInfo(history) {
  return { undo: history.past.length, redo: history.future.length, dropped: history.dropped };
}

function trimHistory(history) {
  let trimmed = false;
  while (history.past.length + history.future.length > MAX_HISTORY_ENTRIES ||
      new TextEncoder().encode(JSON.stringify(history)).length > MAX_HISTORY_BYTES) {
    if (history.past.length) history.past.shift();
    else if (history.future.length) history.future.shift();
    else throw new LocalStoreError('HISTORY_LIMIT', 'History cannot fit within the local storage limit.');
    if (history.dropped === Number.MAX_SAFE_INTEGER) throw new LocalStoreError('HISTORY_LIMIT', 'The history counter is exhausted.');
    history.dropped++;
    trimmed = true;
  }
  return trimmed;
}

function requireRevision(revision) {
  if (!Number.isSafeInteger(revision) || revision < 0 || revision === Number.MAX_SAFE_INTEGER) {
    throw new LocalStoreError('INVALID_REVISION', 'The revision is invalid.');
  }
}

function inspectBackup(backup) {
  let descriptors;
  try {
    if (!backup || typeof backup !== 'object' || Object.getPrototypeOf(backup) !== Object.prototype) {
      throw new LocalStoreError('INVALID_BACKUP', 'The backup format is invalid.');
    }
    descriptors = Object.getOwnPropertyDescriptors(backup);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.some(key => typeof key !== 'string' ||
        !['format', 'version', 'sourceBoardId', 'sourceRevision', 'snapshot'].includes(key) ||
        !descriptors[key].enumerable || !Object.hasOwn(descriptors[key], 'value'))) {
      throw new LocalStoreError('INVALID_BACKUP', 'The backup format is invalid.');
    }
    const metadata = Object.fromEntries(keys.filter(key => key !== 'snapshot').map(key => [key, descriptors[key].value]));
    const diagnostics = inspectJsonInput(metadata);
    if (diagnostics.some(diagnostic => diagnostic.severity === 'error')) {
      throw new LocalStoreError('INVALID_BACKUP', 'The backup is not safe JSON.', diagnostics);
    }
    if (metadata.format !== 'nodeboard-local-backup' || metadata.version !== 1 ||
        typeof metadata.sourceBoardId !== 'string' || !ID.test(metadata.sourceBoardId) ||
        !Number.isSafeInteger(metadata.sourceRevision) || metadata.sourceRevision < 0 ||
        !Object.hasOwn(descriptors, 'snapshot')) {
      throw new LocalStoreError('INVALID_BACKUP', 'The backup format is invalid.');
    }
    return { sourceBoardId: metadata.sourceBoardId, snapshot: descriptors.snapshot.value };
  } catch (error) {
    if (error instanceof LocalStoreError) throw error;
    throw new LocalStoreError('INVALID_BACKUP', 'The backup could not be safely inspected.');
  }
}

function verifyRecord(record, id) {
  if (!record || typeof record !== 'object' || Object.getPrototypeOf(record) !== Object.prototype ||
      record.id !== id || !Object.hasOwn(record, 'snapshot') || !Object.hasOwn(record, 'history') ||
      !Number.isSafeInteger(record.revision) || record.revision < 0 ||
      Reflect.ownKeys(record).some(key => !['id', 'storageVersion', 'revision', 'snapshot', 'history'].includes(key))) {
    throw new LocalStoreError('CORRUPT_BOARD', 'The stored board record is invalid or unsupported.');
  }
  if (record.storageVersion !== 1) {
    throw new LocalStoreError('UNSUPPORTED_STORAGE_VERSION', 'The local board version is not supported.');
  }
}

function validRetryRecord(record, boardId) {
  if (!(record && typeof record === 'object' && Object.getPrototypeOf(record) === Object.prototype &&
    record.boardId === boardId && typeof record.operationId === 'string' && ID.test(record.operationId) &&
    Number.isSafeInteger(record.revision) && record.revision > 0 && typeof record.payload === 'string' &&
    Number.isSafeInteger(record.bytes) && record.bytes >= 0 && record.bytes <= MAX_RETRY_BYTES &&
    new TextEncoder().encode(record.payload).length === record.bytes &&
    Object.keys(record).every(key => ['boardId', 'operationId', 'revision', 'payload', 'bytes'].includes(key)))) return false;
  try {
    const batch = JSON.parse(record.payload);
    return batch && typeof batch === 'object' && !Array.isArray(batch) &&
      batch.operationId === record.operationId && batch.baseRevision === record.revision - 1 &&
      canonicalJson(batch) === record.payload;
  } catch {
    return false;
  }
}

function trimRetryLog(operations, id, transaction, done, fail) {
  const records = [];
  let bytes = 0;
  const range = IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER]);
  const request = operations.index('byBoardRevision').openCursor(range);
  request.onsuccess = () => {
    try {
      const cursor = request.result;
      if (cursor) {
        const record = cursor.value;
        if (!validRetryRecord(record, id) || records.length > MAX_RETRY_ENTRIES) {
          throw new LocalStoreError('CORRUPT_BOARD', 'The local retry history is invalid.');
        }
        records.push({ key: cursor.primaryKey, bytes: record.bytes });
        bytes += record.bytes;
        cursor.continue();
        return;
      }
      let dropped = false;
      while (records.length > MAX_RETRY_ENTRIES || bytes > MAX_RETRY_BYTES) {
        const oldest = records.shift();
        bytes -= oldest.bytes;
        operations.delete(oldest.key);
        dropped = true;
      }
      done(dropped);
    } catch (error) {
      fail(error instanceof LocalStoreError ? error : new LocalStoreError('STORAGE_ERROR', 'The retry history could not be updated.'));
      transaction.abort();
    }
  };
}

function transact(db, mode, action, stores = ['boards']) {
  return new Promise((resolve, reject) => {
    let transaction, result, failure;
    try {
      transaction = db.transaction(stores, mode);
      transaction.oncomplete = () => resolve(result);
      transaction.onabort = () => reject(failure || new LocalStoreError('STORAGE_ERROR', 'The local transaction failed.'));
      action(transaction.objectStore('boards'), value => { result = value; }, error => { failure = error; }, transaction);
    } catch (error) {
      if (transaction) transaction.abort();
      reject(error instanceof LocalStoreError ? error : new LocalStoreError('STORAGE_ERROR', 'The local transaction could not start.'));
    }
  });
}

export function openLocalV2Store(databaseName) {
  if (typeof databaseName !== 'string' || !ID.test(databaseName)) {
    return Promise.reject(new LocalStoreError('INVALID_DATABASE_NAME', 'The database name is invalid.'));
  }
  return new Promise((resolve, reject) => {
    let request, blocked = false;
    try { request = indexedDB.open(databaseName, 2); }
    catch { reject(new LocalStoreError('STORAGE_ERROR', 'The local database could not be opened.')); return; }
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains('boards')) {
        request.result.createObjectStore('boards', { keyPath: 'id' });
      }
      if (!request.result.objectStoreNames.contains('operations')) {
        const operations = request.result.createObjectStore('operations', { keyPath: ['boardId', 'operationId'] });
        operations.createIndex('byBoardRevision', ['boardId', 'revision'], { unique: true });
      }
    };
    request.onerror = () => reject(new LocalStoreError('STORAGE_ERROR', 'The local database could not be opened.'));
    request.onblocked = () => {
      blocked = true;
      reject(new LocalStoreError('STORAGE_BLOCKED', 'The local database is blocked by another connection.'));
    };
    request.onsuccess = () => {
      const db = request.result;
      if (blocked) { db.close(); return; }
      db.onversionchange = () => db.close();
      resolve({
        close() { db.close(); },
        list(options = {}) {
          const diagnostics = inspectJsonInput(options);
          if (diagnostics.some(diagnostic => diagnostic.severity === 'error') ||
              !options || typeof options !== 'object' || Array.isArray(options) ||
              Object.keys(options).some(key => !['after', 'limit'].includes(key)) ||
              (options.after !== undefined && (typeof options.after !== 'string' || !ID.test(options.after))) ||
              (options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100))) {
            throw new LocalStoreError('INVALID_LIST_OPTIONS', 'The local board list options are invalid.', diagnostics);
          }
          const limit = options.limit === undefined ? 50 : options.limit;
          const range = options.after === undefined ? null : IDBKeyRange.lowerBound(options.after, true);
          return transact(db, 'readonly', (store, done, fail, transaction) => {
            const ids = [], request = store.openKeyCursor(range);
            request.onsuccess = () => {
              const cursor = request.result;
              if (!cursor) { done({ ids, nextAfter: null }); return; }
              if (typeof cursor.primaryKey !== 'string' || !ID.test(cursor.primaryKey)) {
                fail(new LocalStoreError('CORRUPT_BOARD', 'The local database contains an invalid board identifier.'));
                transaction.abort();
                return;
              }
              if (ids.length === limit) { done({ ids, nextAfter: ids[ids.length - 1] }); return; }
              ids.push(cursor.primaryKey);
              cursor.continue();
            };
          });
        },
        create(id, snapshot) {
          requireId(id);
          const record = { id, storageVersion: 1, revision: 0, snapshot: snapshotCopy(snapshot), history: { past: [], future: [], dropped: 0 } };
          return transact(db, 'readwrite', (store, done, fail) => {
            const add = store.add(record);
            add.onsuccess = () => done({ id, revision: 0, snapshot: cloneJson(record.snapshot), history: historyInfo(record.history) });
            add.onerror = () => fail(new LocalStoreError(
              add.error?.name === 'ConstraintError' ? 'ALREADY_EXISTS' : 'STORAGE_ERROR',
              add.error?.name === 'ConstraintError' ? 'The board already exists.' : 'The board could not be created.',
            ));
          });
        },
        read(id) {
          requireId(id);
          return transact(db, 'readonly', (store, done, fail, transaction) => {
            const get = store.get(id);
            get.onsuccess = () => {
              if (get.result === undefined) { done(null); return; }
              try {
                verifyRecord(get.result, id);
                const history = storedHistory(get.result);
                done({ id, revision: get.result.revision, snapshot: snapshotCopy(get.result.snapshot), history: historyInfo(history) });
              } catch (error) {
                fail(error instanceof LocalStoreError
                  ? error.code === 'INVALID_SNAPSHOT' ? new LocalStoreError('CORRUPT_BOARD', 'The stored board is invalid.', error.diagnostics) : error
                  : new LocalStoreError('STORAGE_ERROR', 'The stored board could not be read.'));
                transaction.abort();
              }
            };
          });
        },
        async exportBackup(id) {
          const record = await this.read(id);
          if (!record) throw new LocalStoreError('NOT_FOUND', 'The board does not exist.');
          return {
            format: 'nodeboard-local-backup',
            version: 1,
            sourceBoardId: record.id,
            sourceRevision: record.revision,
            snapshot: record.snapshot,
          };
        },
        restoreAsNew(id, backup) {
          requireId(id);
          const input = inspectBackup(backup);
          const diagnostics = inspectJsonInput(input.snapshot);
          if (diagnostics.some(diagnostic => diagnostic.severity === 'error')) {
            throw new LocalStoreError('INVALID_BACKUP', 'The backup is not safe JSON.', diagnostics);
          }
          if (id === input.sourceBoardId) {
            throw new LocalStoreError('INVALID_BOARD_ID', 'Restore the backup to a different board ID.');
          }
          return this.create(id, input.snapshot);
        },
        apply(id, batch) {
          requireId(id);
          const diagnostics = inspectJsonInput(batch);
          if (diagnostics.some(diagnostic => diagnostic.severity === 'error')) {
            throw new LocalStoreError('INVALID_BATCH', 'The operation batch is not safe JSON.', diagnostics);
          }
          const input = cloneJson(batch);
          if (!input || typeof input !== 'object' || Array.isArray(input) ||
              typeof input.operationId !== 'string' || !ID.test(input.operationId)) {
            throw new LocalStoreError('INVALID_BATCH', 'The operation batch is invalid.');
          }
          const payload = canonicalJson(input);
          const bytes = new TextEncoder().encode(payload).length;
          return transact(db, 'readwrite', (store, done, fail, transaction) => {
            const get = store.get(id);
            get.onsuccess = () => {
              if (!get.result) {
                fail(new LocalStoreError('NOT_FOUND', 'The board does not exist.'));
                transaction.abort();
                return;
              }
              try {
                verifyRecord(get.result, id);
                const operations = transaction.objectStore('operations');
                const prior = operations.get([id, input.operationId]);
                prior.onsuccess = () => {
                  try {
                    if (prior.result !== undefined) {
                      if (!validRetryRecord(prior.result, id) || prior.result.revision > get.result.revision) {
                        throw new LocalStoreError('CORRUPT_BOARD', 'The local retry record is invalid.');
                      }
                      if (prior.result.payload !== payload) {
                        throw new LocalStoreError('OPERATION_ID_REUSE', 'The operation ID was already used for a different batch.');
                      }
                      const replayDiagnostics = validateSnapshot(get.result.snapshot);
                      if (replayDiagnostics.some(item => item.severity === 'error')) {
                        throw new LocalStoreError('CORRUPT_BOARD', 'The stored board is invalid.', replayDiagnostics);
                      }
                      const history = storedHistory(get.result);
                      done({
                        id, revision: get.result.revision, snapshot: cloneJson(get.result.snapshot),
                        history: historyInfo(history), historyTruncated: false, diagnostics: replayDiagnostics,
                        replayed: true, committedRevision: prior.result.revision, retryHistoryTruncated: false,
                      });
                      return;
                    }
                    const applied = applyBatch(get.result.snapshot, input, get.result.revision);
                    const history = storedHistory(get.result);
                    history.past.push(get.result.snapshot);
                    history.future = [];
                    const historyTruncated = trimHistory(history);
                    const record = { id, storageVersion: 1, revision: applied.revision, snapshot: applied.snapshot, history };
                    store.put(record);
                    operations.add({ boardId: id, operationId: input.operationId, revision: applied.revision, payload, bytes });
                    trimRetryLog(operations, id, transaction, retryHistoryTruncated => done({
                      id, revision: record.revision, snapshot: record.snapshot,
                      history: historyInfo(history), historyTruncated, diagnostics: applied.diagnostics,
                      replayed: false, committedRevision: applied.revision, retryHistoryTruncated,
                    }), fail);
                  } catch (error) {
                    fail(error instanceof GraphCommandError
                      ? new LocalStoreError(error.code, error.message, error.diagnostics)
                      : error instanceof LocalStoreError ? error : new LocalStoreError('STORAGE_ERROR', 'The local batch could not be applied.'));
                    transaction.abort();
                  }
                };
              } catch (error) {
                fail(error instanceof GraphCommandError
                  ? new LocalStoreError(error.code, error.message, error.diagnostics)
                  : error instanceof LocalStoreError ? error : new LocalStoreError('STORAGE_ERROR', 'The local batch could not be applied.'));
                transaction.abort();
              }
            };
          }, ['boards', 'operations']);
        },
        undo(id, expectedRevision) { return travel(db, id, expectedRevision, 'undo'); },
        redo(id, expectedRevision) { return travel(db, id, expectedRevision, 'redo'); },
      });
    };
  });
}

function travel(db, id, expectedRevision, direction) {
  requireId(id);
  requireRevision(expectedRevision);
  return transact(db, 'readwrite', (store, done, fail, transaction) => {
    const get = store.get(id);
    get.onsuccess = () => {
      try {
        const record = get.result;
        if (!record) throw new LocalStoreError('NOT_FOUND', 'The board does not exist.');
        verifyRecord(record, id);
        requireRevision(record.revision);
        if (record.revision !== expectedRevision) throw new LocalStoreError('REVISION_CONFLICT', 'The graph changed before history was applied.');
        const history = storedHistory(record);
        const source = direction === 'undo' ? history.past : history.future;
        const target = direction === 'undo' ? history.future : history.past;
        if (!source.length) throw new LocalStoreError(direction === 'undo' ? 'NO_UNDO' : 'NO_REDO', 'There is no history in that direction.');
        const current = snapshotCopy(record.snapshot);
        let next;
        try { next = snapshotCopy(source.pop()); }
        catch (error) {
          if (error instanceof LocalStoreError) throw new LocalStoreError('CORRUPT_BOARD', 'The stored history contains an invalid snapshot.', error.diagnostics);
          throw error;
        }
        target.push(current);
        const historyTruncated = trimHistory(history);
        const updated = { id, storageVersion: 1, revision: record.revision + 1, snapshot: next, history };
        const put = store.put(updated);
        put.onsuccess = () => done({
          id, revision: updated.revision, snapshot: next,
          history: historyInfo(history), historyTruncated,
        });
      } catch (error) {
        fail(error instanceof LocalStoreError ? error : new LocalStoreError('STORAGE_ERROR', 'The local history could not be applied.'));
        transaction.abort();
      }
    };
  });
}
