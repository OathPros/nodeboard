import { inspectJsonInput, validateSnapshot } from './validate-v2.js';

export class GraphCommandError extends Error {
  constructor(code, message, diagnostics = []) {
    super(message);
    this.name = 'GraphCommandError';
    this.code = code;
    this.diagnostics = diagnostics;
  }
}

const ID = /^[A-Za-z0-9_-]{1,120}$(?![\s\S])/;
const MAX_OPERATIONS = 100;
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const hasOnlyKeys = (value, keys) => Object.keys(value).every(key => keys.includes(key));
const cloneJson = value => JSON.parse(JSON.stringify(value));

function assertValidSnapshot(snapshot, code) {
  const diagnostics = validateSnapshot(snapshot);
  if (diagnostics.some(diagnostic => diagnostic.severity === 'error')) {
    throw new GraphCommandError(code, 'The graph is invalid.', diagnostics);
  }
  return diagnostics;
}

function validateBatch(batch, revision) {
  if (!Number.isSafeInteger(revision) || revision < 0 || revision === Number.MAX_SAFE_INTEGER) {
    throw new GraphCommandError('INVALID_REVISION', 'The current revision is invalid.');
  }
  const diagnostics = inspectJsonInput(batch);
  if (diagnostics.some(diagnostic => diagnostic.severity === 'error')) {
    throw new GraphCommandError('INVALID_BATCH', 'The operation batch is not safe JSON.', diagnostics);
  }
  if (!isRecord(batch) ||
      !hasOnlyKeys(batch, ['protocolVersion', 'snapshotVersion', 'operationId', 'baseRevision', 'operations']) ||
      batch.protocolVersion !== 2 || batch.snapshotVersion !== 2 ||
      typeof batch.operationId !== 'string' || !ID.test(batch.operationId) ||
      !Number.isSafeInteger(batch.baseRevision) || batch.baseRevision < 0 ||
      batch.baseRevision === Number.MAX_SAFE_INTEGER ||
      !Array.isArray(batch.operations) || batch.operations.length === 0 ||
      batch.operations.length > MAX_OPERATIONS) {
    throw new GraphCommandError('INVALID_BATCH', 'The operation batch is invalid.');
  }
  if (batch.baseRevision !== revision) {
    throw new GraphCommandError('REVISION_CONFLICT', 'The graph changed before this batch was applied.');
  }
}

function put(collection, value) {
  if (!isRecord(value) || typeof value.id !== 'string' || !ID.test(value.id)) {
    throw new GraphCommandError('INVALID_OPERATION', 'The operation requires an item with a valid ID.');
  }
  const index = collection.findIndex(item => item.id === value.id);
  const copy = cloneJson(value);
  if (index < 0) collection.push(copy);
  else collection[index] = copy;
}

function remove(collection, id) {
  if (typeof id !== 'string' || !ID.test(id)) {
    throw new GraphCommandError('INVALID_OPERATION', 'The operation requires a valid ID.');
  }
  const index = collection.findIndex(item => item.id === id);
  if (index < 0) throw new GraphCommandError('NOT_FOUND', 'The item to delete does not exist.');
  collection.splice(index, 1);
}

function applyOperation(snapshot, operation) {
  if (!isRecord(operation) || typeof operation.type !== 'string') {
    throw new GraphCommandError('INVALID_OPERATION', 'The operation is invalid.');
  }
  const puts = {
    'entity.put': ['entity', snapshot.graph.entities],
    'relationship.put': ['relationship', snapshot.graph.relationships],
    'view.put': ['view', snapshot.views],
  };
  if (Object.hasOwn(puts, operation.type)) {
    const [field, collection] = puts[operation.type];
    if (!hasOnlyKeys(operation, ['type', field])) {
      throw new GraphCommandError('INVALID_OPERATION', 'The operation contains unexpected fields.');
    }
    put(collection, operation[field]);
    return;
  }
  const deletes = {
    'entity.delete': snapshot.graph.entities,
    'relationship.delete': snapshot.graph.relationships,
    'view.delete': snapshot.views,
  };
  if (Object.hasOwn(deletes, operation.type)) {
    if (!hasOnlyKeys(operation, ['type', 'id'])) {
      throw new GraphCommandError('INVALID_OPERATION', 'The operation contains unexpected fields.');
    }
    remove(deletes[operation.type], operation.id);
    return;
  }
  if (operation.type === 'ontology.replace' && hasOnlyKeys(operation, ['type', 'ontology']) && isRecord(operation.ontology)) {
    snapshot.ontology = cloneJson(operation.ontology);
    return;
  }
  throw new GraphCommandError('INVALID_OPERATION', 'The operation type is unsupported or invalid.');
}

export function applyBatch(snapshot, batch, revision) {
  validateBatch(batch, revision);
  assertValidSnapshot(snapshot, 'INVALID_SNAPSHOT');
  const next = cloneJson(snapshot);
  for (const operation of batch.operations) applyOperation(next, operation);
  const diagnostics = assertValidSnapshot(next, 'INVALID_RESULT');
  return { snapshot: next, revision: revision + 1, diagnostics };
}

export function connectionsFor(snapshot, entityId) {
  return inspectConnections(snapshot, entityId).connections;
}

export function inspectConnections(snapshot, entityId) {
  const diagnostics = assertValidSnapshot(snapshot, 'INVALID_SNAPSHOT');
  if (typeof entityId !== 'string' || !ID.test(entityId)) {
    throw new GraphCommandError('INVALID_ENTITY_ID', 'The entity ID is invalid.');
  }
  if (!snapshot.graph.entities.some(entity => entity.id === entityId)) {
    throw new GraphCommandError('NOT_FOUND', 'The entity does not exist.');
  }
  const types = new Map(snapshot.ontology.relationshipTypes.map(type => [type.id, type]));
  const connections = [];
  for (const relationship of snapshot.graph.relationships) {
    if (relationship.from !== entityId && relationship.to !== entityId) continue;
    connections.push({
      assertionId: relationship.id,
      from: relationship.from,
      to: relationship.to,
      relationshipTypeId: relationship.relationshipTypeId,
      status: relationship.status,
      derived: false,
    });
    const type = types.get(relationship.relationshipTypeId);
    if (!type) continue;
    const inverseIds = new Set();
    if (type.inversePredicateId !== null) inverseIds.add(type.inversePredicateId);
    if (type.symmetric) inverseIds.add(type.id);
    for (const inverseId of inverseIds) {
      if (relationship.from === relationship.to && inverseId === relationship.relationshipTypeId) continue;
      connections.push({
        assertionId: relationship.id,
        from: relationship.to,
        to: relationship.from,
        relationshipTypeId: inverseId,
        status: relationship.status,
        derived: true,
      });
    }
  }
  return { connections, diagnostics };
}

export function inferTransitivePaths(snapshot, options) {
  const diagnostics = assertValidSnapshot(snapshot, 'INVALID_SNAPSHOT');
  if (inspectJsonInput(options).some(item => item.severity === 'error') || !isRecord(options) ||
      !hasOnlyKeys(options, ['sourceId', 'relationshipTypeId', 'maxDepth', 'maxResults', 'maxSteps'])) {
    throw new GraphCommandError('INVALID_INFERENCE_OPTIONS', 'The inference options are invalid.');
  }
  const { sourceId, relationshipTypeId, maxDepth = 4, maxResults = 100, maxSteps = 10000 } = options;
  if (typeof sourceId !== 'string' || !ID.test(sourceId) ||
      typeof relationshipTypeId !== 'string' || !ID.test(relationshipTypeId) ||
      !Number.isSafeInteger(maxDepth) || maxDepth < 2 || maxDepth > 6 ||
      !Number.isSafeInteger(maxResults) || maxResults < 1 || maxResults > 1000 ||
      !Number.isSafeInteger(maxSteps) || maxSteps < 1 || maxSteps > 50000) {
    throw new GraphCommandError('INVALID_INFERENCE_OPTIONS', 'The inference limits or identifiers are invalid.');
  }
  if (!snapshot.graph.entities.some(entity => entity.id === sourceId)) {
    throw new GraphCommandError('NOT_FOUND', 'The source entity does not exist.');
  }
  const predicate = snapshot.ontology.relationshipTypes.find(type => type.id === relationshipTypeId);
  if (!predicate || !predicate.transitive) {
    throw new GraphCommandError('INVALID_INFERENCE_PREDICATE', 'Choose a declared transitive predicate.');
  }
  const outgoing = new Map();
  for (const edge of snapshot.graph.relationships) {
    if (edge.relationshipTypeId !== relationshipTypeId || edge.status !== 'asserted') continue;
    if (!outgoing.has(edge.from)) outgoing.set(edge.from, []);
    outgoing.get(edge.from).push(edge);
  }
  const queue = [{ entityIds: [sourceId], assertionIds: [] }];
  const paths = [];
  let cursor = 0, steps = 0, truncated = false;
  while (cursor < queue.length && !truncated) {
    const path = queue[cursor++];
    if (path.assertionIds.length >= maxDepth) continue;
    for (const edge of outgoing.get(path.entityIds[path.entityIds.length - 1]) || []) {
      if (steps === maxSteps) { truncated = true; break; }
      steps++;
      const closesCycle = edge.to === sourceId && path.assertionIds.length > 0;
      if (path.entityIds.includes(edge.to) && !closesCycle) continue;
      const next = {
        entityIds: [...path.entityIds, edge.to],
        assertionIds: [...path.assertionIds, edge.id],
      };
      if (next.assertionIds.length >= 2) {
        paths.push({ relationshipTypeId, ...next, derived: true });
        if (paths.length === maxResults) { truncated = true; break; }
      }
      if (!closesCycle && next.assertionIds.length < maxDepth) queue.push(next);
    }
  }
  return { paths, truncated, steps, diagnostics };
}
