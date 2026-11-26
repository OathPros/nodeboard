import { inspectJsonInput } from '../domain/validate-v2.js';

const ID = /^[A-Za-z0-9_-]{1,120}$(?![\s\S])/;

export class PendingCloudError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PendingCloudError';
    this.code = code;
  }
}

function validRecord(record, accountId, boardId) {
  return record && typeof record === 'object' && !Array.isArray(record) &&
    record.accountId === accountId && record.boardId === boardId &&
    ['operations', 'history'].includes(record.kind) && record.payload &&
    typeof record.payload === 'object' && !Array.isArray(record.payload) &&
    typeof record.payload.operationId === 'string' && ID.test(record.payload.operationId) &&
    (record.targetBoardId === undefined || (typeof record.targetBoardId === 'string' && ID.test(record.targetBoardId))) &&
    Object.keys(record).every(key => ['accountId', 'boardId', 'targetBoardId', 'kind', 'payload'].includes(key)) &&
    !inspectJsonInput(record.payload).some(item => item.severity === 'error');
}
function validCopy(record, accountId, boardId) {
  return record && typeof record === 'object' && !Array.isArray(record) &&
    record.accountId === accountId && record.boardId === boardId && record.kind === 'create' &&
    record.payload && typeof record.payload === 'object' && !Array.isArray(record.payload) &&
    typeof record.payload.id === 'string' && ID.test(record.payload.id) &&
    Object.keys(record).every(key => ['accountId', 'boardId', 'kind', 'payload'].includes(key)) &&
    Object.keys(record.payload).every(key => ['id', 'snapshot'].includes(key)) &&
    Object.hasOwn(record.payload, 'snapshot') &&
    !inspectJsonInput(record.payload.snapshot).some(item => item.severity === 'error');
}

export function openPendingCloudStore() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('nodeboard-v2-pending-cloud', 2);
    let blocked = false;
    request.onupgradeneeded = event => {
      if (event.oldVersion < 1) request.result.createObjectStore('pending', { keyPath: ['accountId', 'boardId'] });
      if (event.oldVersion < 2) request.result.createObjectStore('copies', { keyPath: ['accountId', 'boardId'] });
    };
    request.onerror = () => reject(new PendingCloudError('PENDING_STORAGE_ERROR', 'Pending account changes could not be opened.'));
    request.onblocked = () => {
      blocked = true;
      reject(new PendingCloudError('PENDING_STORAGE_BLOCKED', 'Pending account changes are blocked by another connection.'));
    };
    request.onsuccess = () => {
      const db = request.result;
      if (blocked) { db.close(); return; }
      db.onversionchange = () => db.close();
      function transact(table, mode, action) {
        return new Promise((finish, fail) => {
          let result, failure;
          const transaction = db.transaction(table, mode);
          transaction.oncomplete = () => finish(result);
          transaction.onabort = () => fail(failure || new PendingCloudError('PENDING_STORAGE_ERROR', 'Pending account changes could not be saved.'));
          transaction.onerror = () => {};
          const setResult = value => { result = value; };
          const abort = error => { failure = error; transaction.abort(); };
          action(transaction.objectStore(table), setResult, abort);
        });
      }
      const checkIds = (accountId, boardId) => {
        if (typeof accountId !== 'string' || !ID.test(accountId) || typeof boardId !== 'string' || !ID.test(boardId)) {
          throw new PendingCloudError('INVALID_PENDING_KEY', 'The pending account change identifier is invalid.');
        }
      };
      function methods(table, valid, requestId) {
        return {
        get(accountId, boardId) {
          checkIds(accountId, boardId);
          return transact(table, 'readonly', (store, done, abort) => {
            const get = store.get([accountId, boardId]);
            get.onsuccess = () => {
              const record = get.result;
              if (record !== undefined && !valid(record, accountId, boardId)) {
                abort(new PendingCloudError('CORRUPT_PENDING_CHANGE', 'The pending account change is invalid.'));
              } else done(record || null);
            };
          });
        },
        add(record) {
          checkIds(record?.accountId, record?.boardId);
          if (!valid(record, record.accountId, record.boardId)) {
            throw new PendingCloudError('INVALID_PENDING_CHANGE', 'The pending account change is invalid.');
          }
          return transact(table, 'readwrite', (store, done, abort) => {
            const add = store.add(record);
            add.onsuccess = () => done(record);
            add.onerror = () => abort(new PendingCloudError(
              add.error?.name === 'ConstraintError' ? 'PENDING_EXISTS' : 'PENDING_STORAGE_ERROR',
              add.error?.name === 'ConstraintError'
                ? (table === 'copies' ? 'Retry the pending account copy before copying again.' : 'Retry the pending account change before editing.')
                : 'The pending account change could not be saved.',
            ));
          });
        },
        remove(accountId, boardId, operationId) {
          checkIds(accountId, boardId);
          if (typeof operationId !== 'string' || !ID.test(operationId)) {
            throw new PendingCloudError('INVALID_PENDING_KEY', 'The pending operation identifier is invalid.');
          }
          return transact(table, 'readwrite', (store, done, abort) => {
            const get = store.get([accountId, boardId]);
            get.onsuccess = () => {
              const record = get.result;
              if (record === undefined) { done(false); return; }
              if (!valid(record, accountId, boardId)) {
                abort(new PendingCloudError('CORRUPT_PENDING_CHANGE', 'The pending account change is invalid.'));
                return;
              }
              if (requestId(record) !== operationId) { done(false); return; }
              const remove = store.delete([accountId, boardId]);
              remove.onsuccess = () => done(true);
            };
          });
        },
        };
      }
      const changes = methods('pending', validRecord, record => record.payload.operationId);
      const copies = methods('copies', validCopy, record => record.payload.id);
      resolve({ ...changes, getCopy: copies.get, addCopy: copies.add, removeCopy: copies.remove });
    };
  });
}
