import { previewV1Migration } from '../domain/migrate-v1.js';
import { validateSnapshot } from '../domain/validate-v2.js';

const SOURCE_KEY = 'nodeboard-v1.1';
const clone = value => JSON.parse(JSON.stringify(value));

export class LocalMigrationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LocalMigrationError';
    this.code = code;
  }
}

function readSource(storage) {
  try {
    return storage.getItem(SOURCE_KEY);
  } catch {
    throw new LocalMigrationError('SOURCE_UNAVAILABLE', 'The local v1 board could not be read.');
  }
}

export async function prepareLocalV1Migration(storage) {
  const sourceText = readSource(storage);
  if (sourceText === null) throw new LocalMigrationError('SOURCE_NOT_FOUND', 'There is no local v1 board to migrate.');
  const preview = previewV1Migration(sourceText);
  if (!preview.ok) return preview;
  if (!globalThis.crypto?.subtle) throw new LocalMigrationError('CRYPTO_UNAVAILABLE', 'The local source backup cannot be hashed.');
  let digest;
  try {
    digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(sourceText));
  } catch {
    throw new LocalMigrationError('CRYPTO_UNAVAILABLE', 'The local source backup cannot be hashed.');
  }
  const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  const snapshot = clone(preview.snapshot);
  snapshot.metadata.migration.sourceText = sourceText;
  snapshot.metadata.migration.sourceHash = `sha256:${hash}`;
  const diagnostics = validateSnapshot(snapshot);
  if (diagnostics.some(item => item.severity === 'error')) {
    return { ...preview, ok: false, snapshot: null, diagnostics: [...preview.diagnostics, ...diagnostics.filter(item => item.severity === 'error')] };
  }
  const reviewedSnapshot = clone(snapshot);
  return {
    ...preview,
    snapshot,
    diagnostics: preview.diagnostics,
    async commit(store, boardId) {
      if (readSource(storage) !== sourceText) {
        throw new LocalMigrationError('SOURCE_CHANGED', 'The local v1 board changed; prepare a new preview.');
      }
      return store.create(boardId, reviewedSnapshot);
    },
  };
}
