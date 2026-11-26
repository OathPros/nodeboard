import { DurableObject } from 'cloudflare:workers';
import { applyBatch, GraphCommandError } from './domain/graph-v2.js';
import { inspectJsonInput, validateSnapshot } from './domain/validate-v2.js';

const ID = /^[A-Za-z0-9_-]{1,120}$(?![\s\S])/;
const MAX_BODY_BYTES = 5_100_000;
const MAX_BOARDS = 1000;
const MAX_OPERATIONS_PER_BOARD = 10000;
const MAX_HISTORY_BYTES = 10000000;
const MAX_HISTORY_ENTRIES = 100;
const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
const reply = (data, status = 200) => Response.json(data, { status, headers });
const canonical = value => JSON.stringify(value, (key, entry) =>
  entry !== null && typeof entry === 'object' && !Array.isArray(entry)
    ? Object.fromEntries(Object.keys(entry).sort().map(name => [name, entry[name]])) : entry);

async function readJson(request) {
  if (!request.body) throw new RequestError(400, 'INVALID_REQUEST', 'A JSON request body is required.');
  const reader = request.body.getReader();
  const parts = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new RequestError(413, 'REQUEST_TOO_LARGE', 'The request exceeds the size limit.');
    }
    parts.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new RequestError(400, 'INVALID_REQUEST', 'The request must be valid UTF-8 JSON.'); }
}

class RequestError extends Error {
  constructor(status, code, message, diagnostics = []) {
    super(message);
    this.status = status;
    this.code = code;
    this.diagnostics = diagnostics;
  }
}

function assertSafe(value, code) {
  const diagnostics = inspectJsonInput(value);
  if (diagnostics.some(item => item.severity === 'error')) {
    throw new RequestError(400, code, 'The request is not safe JSON.', diagnostics);
  }
}

function checkedSnapshot(snapshot) {
  const diagnostics = validateSnapshot(snapshot);
  if (diagnostics.some(item => item.severity === 'error')) {
    throw new RequestError(400, 'INVALID_SNAPSHOT', 'The board snapshot is invalid.', diagnostics);
  }
  return JSON.stringify(snapshot);
}

async function digest(text) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(bytes), value => value.toString(16).padStart(2, '0')).join('');
}

export class V2AccountBoards extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS boards (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, snapshot TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS operations (
        board_id TEXT NOT NULL, operation_id TEXT NOT NULL, payload_hash TEXT NOT NULL, revision INTEGER NOT NULL,
        PRIMARY KEY (board_id, operation_id)
      );
      CREATE TABLE IF NOT EXISTS board_creations (board_id TEXT PRIMARY KEY, payload_hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS members (
        board_id TEXT NOT NULL, user_id TEXT NOT NULL, email TEXT NOT NULL, role TEXT NOT NULL,
        PRIMARY KEY (board_id, user_id)
      );
      CREATE TABLE IF NOT EXISTS history (
        board_id TEXT NOT NULL, stack TEXT NOT NULL, seq INTEGER NOT NULL, snapshot TEXT NOT NULL, bytes INTEGER NOT NULL,
        PRIMARY KEY (board_id, stack, seq)
      );
      CREATE TABLE IF NOT EXISTS history_info (board_id TEXT PRIMARY KEY, dropped INTEGER NOT NULL);
    `);
  }

  result(row) {
    const counts = this.sql.exec(`SELECT
      COALESCE(SUM(CASE WHEN stack = 'past' THEN 1 ELSE 0 END), 0) AS undo,
      COALESCE(SUM(CASE WHEN stack = 'future' THEN 1 ELSE 0 END), 0) AS redo
      FROM history WHERE board_id = ?`, row.id).one();
    const info = this.sql.exec('SELECT dropped FROM history_info WHERE board_id = ?', row.id).toArray()[0];
    return {
      id: row.id, revision: row.revision, snapshot: JSON.parse(row.snapshot),
      history: { undo: counts.undo, redo: counts.redo, dropped: info?.dropped || 0 },
    };
  }

  pushHistory(id, stack, seq, snapshot) {
    this.sql.exec('INSERT INTO history (board_id, stack, seq, snapshot, bytes) VALUES (?, ?, ?, ?, ?)',
      id, stack, seq, snapshot, new TextEncoder().encode(snapshot).length);
    let dropped = 0;
    for (;;) {
      const size = this.sql.exec('SELECT COUNT(*) AS count, COALESCE(SUM(bytes), 0) AS bytes FROM history WHERE board_id = ?', id).one();
      if (size.count <= MAX_HISTORY_ENTRIES && size.bytes <= MAX_HISTORY_BYTES) break;
      const oldest = this.sql.exec(`SELECT stack, seq FROM history WHERE board_id = ?
        ORDER BY CASE stack WHEN 'past' THEN 0 ELSE 1 END, seq LIMIT 1`, id).one();
      this.sql.exec('DELETE FROM history WHERE board_id = ? AND stack = ? AND seq = ?', id, oldest.stack, oldest.seq);
      dropped++;
    }
    if (dropped) {
      const existing = this.sql.exec('SELECT dropped FROM history_info WHERE board_id = ?', id).toArray()[0]?.dropped || 0;
      if (!Number.isSafeInteger(existing + dropped)) throw new RequestError(409, 'HISTORY_LIMIT', 'The history counter is exhausted.');
      this.sql.exec('INSERT INTO history_info (board_id, dropped) VALUES (?, ?) ON CONFLICT(board_id) DO UPDATE SET dropped = excluded.dropped',
        id, existing + dropped);
    }
    return dropped > 0;
  }

  async fetch(request) {
    try {
      const url = new URL(request.url);
      const owner = request.headers.get('x-nodeboard-owner');
      const actor = request.headers.get('x-nodeboard-user');
      if (!owner || !actor || !ID.test(owner) || !ID.test(actor)) {
        throw new RequestError(401, 'UNAUTHORIZED', 'A verified account is required.');
      }
      if (url.pathname === '/api/v2/boards' && request.method === 'GET') {
        if (actor !== owner) throw new RequestError(404, 'NOT_FOUND', 'Not found.');
        const keys = [...url.searchParams.keys()];
        const after = url.searchParams.get('after');
        const rawLimit = url.searchParams.get('limit');
        const limit = rawLimit === null ? 50 : Number(rawLimit);
        if (keys.some(key => !['after', 'limit'].includes(key)) ||
            new Set(keys).size !== keys.length || (after !== null && !ID.test(after)) ||
            (rawLimit !== null && !/^[1-9][0-9]*$/.test(rawLimit)) ||
            !Number.isInteger(limit) || limit < 1 || limit > 100) {
          throw new RequestError(400, 'INVALID_LIST_OPTIONS', 'The board list options are invalid.');
        }
        const rows = this.sql.exec('SELECT id FROM boards WHERE id > ? ORDER BY id LIMIT ?', after || '', limit + 1).toArray();
        const ids = rows.slice(0, limit).map(row => row.id);
        return reply({ ids, nextAfter: rows.length > limit ? ids[ids.length - 1] : null });
      }
      if (url.pathname === '/api/v2/boards' && request.method === 'POST') {
        if (actor !== owner) throw new RequestError(404, 'NOT_FOUND', 'Not found.');
        const input = await readJson(request);
        if (!input || typeof input !== 'object' || Array.isArray(input) ||
            Object.keys(input).some(key => !['id', 'snapshot'].includes(key)) ||
            typeof input.id !== 'string' || !ID.test(input.id) || !Object.hasOwn(input, 'snapshot')) {
          throw new RequestError(400, 'INVALID_REQUEST', 'The board creation request is invalid.');
        }
        const snapshot = checkedSnapshot(input.snapshot);
        const hash = await digest(canonical(input.snapshot));
        const result = this.ctx.storage.transactionSync(() => {
          const existing = this.sql.exec('SELECT id, revision, snapshot FROM boards WHERE id = ?', input.id).toArray()[0];
          if (existing) {
            const creation = this.sql.exec('SELECT payload_hash FROM board_creations WHERE board_id = ?', input.id).toArray()[0];
            if (!creation || creation.payload_hash !== hash) {
              throw new RequestError(409, 'ALREADY_EXISTS', 'The board already exists with different creation data.');
            }
            return { ...this.result(existing), replayed: true };
          }
          const count = this.sql.exec('SELECT COUNT(*) AS count FROM boards').one().count;
          if (count >= MAX_BOARDS) throw new RequestError(409, 'BOARD_LIMIT', 'The account board limit has been reached.');
          this.sql.exec('INSERT INTO boards (id, revision, snapshot) VALUES (?, 0, ?)', input.id, snapshot);
          this.sql.exec('INSERT INTO board_creations (board_id, payload_hash) VALUES (?, ?)', input.id, hash);
          return { ...this.result({ id: input.id, revision: 0, snapshot }), replayed: false };
        });
        return reply(result, result.replayed ? 200 : 201);
      }
      const match = /^\/api\/v2\/boards\/([A-Za-z0-9_-]{1,120})(\/operations|\/history|\/members|\/share|\/unshare)?$/.exec(url.pathname);
      if (!match) return reply({ code: 'NOT_FOUND', error: 'Not found.' }, 404);
      const id = match[1];
      const role = actor === owner ? 'owner'
        : this.sql.exec('SELECT role FROM members WHERE board_id = ? AND user_id = ?', id, actor).toArray()[0]?.role;
      if (!role) throw new RequestError(404, 'NOT_FOUND', 'The board does not exist.');
      if (match[2] === '/members' && request.method === 'GET' && role === 'owner') {
        const members = this.sql.exec('SELECT user_id AS userId, email, role FROM members WHERE board_id = ? ORDER BY email', id).toArray();
        return reply({ members });
      }
      if (['/share', '/unshare'].includes(match[2]) && request.method === 'POST' && role === 'owner') {
        const input = await readJson(request);
        assertSafe(input, 'INVALID_REQUEST');
        if (!input || typeof input !== 'object' || Array.isArray(input) ||
            Object.keys(input).some(key => !['target', 'role'].includes(key)) ||
            !input.target || typeof input.target !== 'object' || Array.isArray(input.target) ||
            Object.keys(input.target).some(key => !['id', 'email'].includes(key)) ||
            typeof input.target.id !== 'string' || !ID.test(input.target.id) || input.target.id === owner ||
            (match[2] === '/share' && (typeof input.target.email !== 'string' || !input.target.email || input.target.email.length > 254)) ||
            (match[2] === '/share' && !['viewer', 'editor'].includes(input.role))) {
          throw new RequestError(400, 'INVALID_REQUEST', 'The account sharing request is invalid.');
        }
        return this.ctx.storage.transactionSync(() => {
          const row = this.sql.exec('SELECT snapshot FROM boards WHERE id = ?', id).toArray()[0];
          if (!row) throw new RequestError(404, 'NOT_FOUND', 'The board does not exist.');
          if (match[2] === '/share') {
            if (JSON.parse(row.snapshot).views.some(view => view.scope === 'personal')) {
              throw new RequestError(409, 'PERSONAL_VIEW_CONFLICT', 'Remove personal views from this board before sharing.');
            }
            this.sql.exec(`INSERT INTO members (board_id, user_id, email, role) VALUES (?, ?, ?, ?)
              ON CONFLICT(board_id, user_id) DO UPDATE SET email = excluded.email, role = excluded.role`,
            id, input.target.id, input.target.email, input.role);
          } else {
            this.sql.exec('DELETE FROM members WHERE board_id = ? AND user_id = ?', id, input.target.id);
          }
          return reply({ ok: true });
        });
      }
      if (!match[2] && request.method === 'GET') {
        const row = this.sql.exec('SELECT id, revision, snapshot FROM boards WHERE id = ?', id).toArray()[0];
        if (!row) throw new RequestError(404, 'NOT_FOUND', 'The board does not exist.');
        if (role !== 'owner' && JSON.parse(row.snapshot).views.some(view => view.scope === 'personal')) {
          throw new RequestError(409, 'PERSONAL_VIEW_CONFLICT', 'The board contains a personal view and cannot be shared.');
        }
        const result = this.result(row);
        if (role !== 'owner') result.history = { undo: 0, redo: 0, dropped: 0 };
        return reply({ ...result, role });
      }
      if (match[2] === '/operations' && request.method === 'POST') {
        if (role === 'viewer') throw new RequestError(403, 'FORBIDDEN', 'Viewer access does not permit edits.');
        const batch = await readJson(request);
        assertSafe(batch, 'INVALID_BATCH');
        if (!batch || typeof batch !== 'object' || Array.isArray(batch) ||
            typeof batch.operationId !== 'string' || !ID.test(batch.operationId)) {
          throw new RequestError(400, 'INVALID_BATCH', 'The operation batch is invalid.');
        }
        const hash = await digest(`operations\n${canonical(batch)}`);
        const result = this.ctx.storage.transactionSync(() => {
          const row = this.sql.exec('SELECT id, revision, snapshot FROM boards WHERE id = ?', id).toArray()[0];
          if (!row) throw new RequestError(404, 'NOT_FOUND', 'The board does not exist.');
          const currentRole = actor === owner ? 'owner'
            : this.sql.exec('SELECT role FROM members WHERE board_id = ? AND user_id = ?', id, actor).toArray()[0]?.role;
          if (!currentRole) throw new RequestError(404, 'NOT_FOUND', 'The board does not exist.');
          if (currentRole !== 'owner' && currentRole !== 'editor') throw new RequestError(403, 'FORBIDDEN', 'Viewer access does not permit edits.');
          if (currentRole !== 'owner' && JSON.parse(row.snapshot).views.some(view => view.scope === 'personal')) {
            throw new RequestError(409, 'PERSONAL_VIEW_CONFLICT', 'The board contains a personal view and cannot be shared.');
          }
          const prior = this.sql.exec('SELECT payload_hash, revision FROM operations WHERE board_id = ? AND operation_id = ?', id, batch.operationId).toArray()[0];
          if (prior) {
            if (prior.payload_hash !== hash) throw new RequestError(409, 'OPERATION_ID_REUSE', 'The operation ID was already used for a different batch.');
            const result = this.result(row);
            if (currentRole !== 'owner') result.history = { undo: 0, redo: 0, dropped: 0 };
            return { ...result, role: currentRole, committedRevision: prior.revision, replayed: true, historyTruncated: false };
          }
          const count = this.sql.exec('SELECT COUNT(*) AS count FROM operations WHERE board_id = ?', id).one().count;
          if (count >= MAX_OPERATIONS_PER_BOARD) {
            throw new RequestError(409, 'OPERATION_LIMIT', 'The board operation limit has been reached.');
          }
          const applied = applyBatch(JSON.parse(row.snapshot), batch, row.revision);
          if (applied.snapshot.views.some(view => view.scope === 'personal') &&
              this.sql.exec('SELECT 1 FROM members WHERE board_id = ? LIMIT 1', id).toArray().length) {
            throw new RequestError(409, 'PERSONAL_VIEW_CONFLICT', 'Personal views cannot be added to a shared board.');
          }
          const snapshot = JSON.stringify(applied.snapshot);
          this.sql.exec("DELETE FROM history WHERE board_id = ? AND stack = 'future'", id);
          const historyTruncated = this.pushHistory(id, 'past', applied.revision, row.snapshot);
          this.sql.exec('UPDATE boards SET revision = ?, snapshot = ? WHERE id = ?', applied.revision, snapshot, id);
          this.sql.exec('INSERT INTO operations (board_id, operation_id, payload_hash, revision) VALUES (?, ?, ?, ?)',
            id, batch.operationId, hash, applied.revision);
          const result = this.result({ id, revision: applied.revision, snapshot });
          if (currentRole !== 'owner') result.history = { undo: 0, redo: 0, dropped: 0 };
          return { ...result, role: currentRole, committedRevision: applied.revision, replayed: false, historyTruncated };
        });
        return reply(result);
      }
      if (match[2] === '/history' && request.method === 'POST') {
        if (role !== 'owner') throw new RequestError(403, 'FORBIDDEN', 'Only the owner can apply board history.');
        const input = await readJson(request);
        assertSafe(input, 'INVALID_REQUEST');
        if (!input || typeof input !== 'object' || Array.isArray(input) ||
            Object.keys(input).some(key => !['operationId', 'baseRevision', 'direction'].includes(key)) ||
            typeof input.operationId !== 'string' || !ID.test(input.operationId) ||
            !Number.isSafeInteger(input.baseRevision) || input.baseRevision < 0 ||
            input.baseRevision === Number.MAX_SAFE_INTEGER || !['undo', 'redo'].includes(input.direction)) {
          throw new RequestError(400, 'INVALID_REQUEST', 'The history request is invalid.');
        }
        const hash = await digest(`history\n${canonical(input)}`);
        const result = this.ctx.storage.transactionSync(() => {
          const row = this.sql.exec('SELECT id, revision, snapshot FROM boards WHERE id = ?', id).toArray()[0];
          if (!row) throw new RequestError(404, 'NOT_FOUND', 'The board does not exist.');
          const prior = this.sql.exec('SELECT payload_hash, revision FROM operations WHERE board_id = ? AND operation_id = ?', id, input.operationId).toArray()[0];
          if (prior) {
            if (prior.payload_hash !== hash) throw new RequestError(409, 'OPERATION_ID_REUSE', 'The operation ID was already used for a different request.');
            return { ...this.result(row), role: 'owner', committedRevision: prior.revision, replayed: true, historyTruncated: false };
          }
          if (row.revision !== input.baseRevision) throw new RequestError(409, 'REVISION_CONFLICT', 'The board changed before this history action was applied.');
          const count = this.sql.exec('SELECT COUNT(*) AS count FROM operations WHERE board_id = ?', id).one().count;
          if (count >= MAX_OPERATIONS_PER_BOARD) throw new RequestError(409, 'OPERATION_LIMIT', 'The board operation limit has been reached.');
          const source = input.direction === 'undo' ? 'past' : 'future';
          const destination = input.direction === 'undo' ? 'future' : 'past';
          const target = this.sql.exec('SELECT seq, snapshot FROM history WHERE board_id = ? AND stack = ? ORDER BY seq DESC LIMIT 1', id, source).toArray()[0];
          if (!target) throw new RequestError(409, 'NO_HISTORY', `There is nothing to ${input.direction}.`);
          const snapshot = checkedSnapshot(JSON.parse(target.snapshot));
          if (JSON.parse(snapshot).views.some(view => view.scope === 'personal') &&
              this.sql.exec('SELECT 1 FROM members WHERE board_id = ? LIMIT 1', id).toArray().length) {
            throw new RequestError(409, 'PERSONAL_VIEW_CONFLICT', 'History would restore a personal view to a shared board.');
          }
          this.sql.exec('DELETE FROM history WHERE board_id = ? AND stack = ? AND seq = ?', id, source, target.seq);
          const revision = row.revision + 1;
          const historyTruncated = this.pushHistory(id, destination, revision, row.snapshot);
          this.sql.exec('UPDATE boards SET revision = ?, snapshot = ? WHERE id = ?', revision, snapshot, id);
          this.sql.exec('INSERT INTO operations (board_id, operation_id, payload_hash, revision) VALUES (?, ?, ?, ?)',
            id, input.operationId, hash, revision);
          return { ...this.result({ id, revision, snapshot }), role: 'owner', committedRevision: revision, replayed: false, historyTruncated };
        });
        return reply(result);
      }
      return reply({ code: 'NOT_FOUND', error: 'Not found.' }, 404);
    } catch (error) {
      if (error instanceof RequestError) return reply({ code: error.code, error: error.message, diagnostics: error.diagnostics }, error.status);
      if (error instanceof GraphCommandError) {
        return reply({ code: error.code, error: error.message, diagnostics: error.diagnostics }, error.code === 'REVISION_CONFLICT' ? 409 : 400);
      }
      console.error('V2 account board request failed:', error?.name || 'UnknownError');
      return reply({ code: 'STORAGE_ERROR', error: 'The account board request failed.' }, 500);
    }
  }
}
