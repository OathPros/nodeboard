import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { applyBatch, connectionsFor, inspectConnections, inferTransitivePaths, GraphCommandError } from '../src/domain/graph-v2.js';
import { validateSnapshot } from '../src/domain/validate-v2.js';

const original = JSON.parse(readFileSync(new URL('../../.nodeboard-v2/fixtures/v2-draft-valid.json', import.meta.url), 'utf8'));
const fixture = () => structuredClone(original);
const batch = (operations, baseRevision = 0) => ({
  protocolVersion: 2, snapshotVersion: 2, operationId: 'operation-1', baseRevision, operations,
});
const relationship = (id, type) => ({
  id, from: 'item-a', to: 'item-b', relationshipTypeId: type,
  properties: {}, provenance: [], status: 'asserted',
});

test('parallel assertions round-trip without rewriting existing facts', () => {
  const graph = fixture();
  const before = structuredClone(graph);
  const result = applyBatch(graph, batch([
    { type: 'relationship.put', relationship: relationship('edge-new', 'rel-support') },
  ]), 0);
  assert.equal(result.revision, 1);
  assert.deepEqual(graph, before);
  assert.deepEqual(result.snapshot.graph.relationships.slice(0, 3), before.graph.relationships);
  assert.deepEqual(result.snapshot.graph.relationships[3], relationship('edge-new', 'rel-support'));
  assert.deepEqual(JSON.parse(JSON.stringify(result.snapshot)), result.snapshot);
  assert.equal(result.snapshot.graph.entities[0].properties['prop-extension'], '00123');
});

test('invalid multi-operation batches leave the input unchanged', () => {
  const graph = fixture();
  const before = structuredClone(graph);
  assert.throws(() => applyBatch(graph, batch([
    { type: 'relationship.delete', id: 'edge-a' },
    { type: 'relationship.put', relationship: { ...relationship('bad-edge', 'rel-support'), to: 'missing' } },
  ]), 0), error => error instanceof GraphCommandError && error.code === 'INVALID_RESULT');
  assert.deepEqual(graph, before);
});

test('deleting an entity requires explicit handling of incident assertions and views', () => {
  const graph = fixture();
  assert.throws(() => applyBatch(graph, batch([{ type: 'entity.delete', id: 'item-b' }]), 0),
    error => error instanceof GraphCommandError && error.code === 'INVALID_RESULT');
  assert.equal(graph.graph.entities.length, 2);
  assert.equal(graph.graph.relationships.length, 3);
});

test('one atomic batch can explicitly remove an entity and its references', () => {
  const graph = fixture();
  const sharedView = structuredClone(graph.views[0]);
  sharedView.entityIds = ['item-a'];
  delete sharedView.positions['item-b'];
  const result = applyBatch(graph, batch([
    { type: 'entity.delete', id: 'item-b' },
    ...graph.graph.relationships.map(edge => ({ type: 'relationship.delete', id: edge.id })),
    { type: 'view.put', view: sharedView },
  ]), 0);
  assert.deepEqual(result.snapshot.graph.entities.map(entity => entity.id), ['item-a']);
  assert.deepEqual(result.snapshot.graph.relationships, []);
  assert.deepEqual(result.snapshot.views[0].entityIds, ['item-a']);
  assert.equal(graph.graph.entities.length, 2);
});

test('renaming a predicate does not change stored assertions', () => {
  const graph = fixture();
  const ontology = structuredClone(graph.ontology);
  ontology.relationshipTypes[0].label = 'New display label';
  const result = applyBatch(graph, batch([{ type: 'ontology.replace', ontology }]), 0);
  assert.deepEqual(result.snapshot.graph.relationships, graph.graph.relationships);
  assert.equal(result.snapshot.ontology.relationshipTypes[0].label, 'New display label');
});

test('typed list definition and value change atomically and round-trip', () => {
  const graph = fixture();
  const ontology = structuredClone(graph.ontology);
  ontology.propertyDefinitions[0].dataType = 'list';
  ontology.propertyDefinitions[0].listItemType = 'enum';
  ontology.propertyDefinitions[0].enumValues = ['00123', '00456'];
  const entity = structuredClone(graph.graph.entities[0]);
  entity.properties['prop-extension'] = ['00123', '00456'];
  const operations = [{ type: 'ontology.replace', ontology }, { type: 'entity.put', entity }];
  const result = applyBatch(graph, batch(operations), 0);
  assert.deepEqual(JSON.parse(JSON.stringify(result.snapshot)), result.snapshot);
  assert.deepEqual(result.snapshot.graph.entities[0].properties['prop-extension'], ['00123', '00456']);
  const invalidEntity = structuredClone(entity);
  invalidEntity.properties['prop-extension'].push('unknown');
  assert.throws(() => applyBatch(graph, batch([operations[0], { type: 'entity.put', entity: invalidEntity }]), 0),
    error => error instanceof GraphCommandError && error.code === 'INVALID_RESULT');
  assert.equal(graph.graph.entities[0].properties['prop-extension'], '00123');
});

test('class changes preserve properties and report incompatibility', () => {
  const graph = fixture();
  const ontology = structuredClone(graph.ontology);
  ontology.classes.push({ id: 'other', name: 'Other', superclassIds: [], abstract: false, propertyDefinitionIds: [] });
  const entity = structuredClone(graph.graph.entities[0]);
  entity.classIds = ['other'];
  const result = applyBatch(graph, batch([{ type: 'ontology.replace', ontology }, { type: 'entity.put', entity }]), 0);
  assert.equal(result.snapshot.graph.entities[0].properties['prop-extension'], '00123');
  assert.ok(result.diagnostics.some(d => d.code === 'PROPERTY_NOT_APPLICABLE' && d.severity === 'warning'));
  assert.deepEqual(result.snapshot.graph.relationships, graph.graph.relationships);
});

test('draft batches retain incomplete required properties with diagnostics', () => {
  const graph = fixture();
  const ontology = structuredClone(graph.ontology);
  ontology.constraints.push({
    id: 'required-extension', kind: 'required',
    parameters: { classId: 'class-item', propertyId: 'prop-extension' },
  });
  const result = applyBatch(graph, batch([{ type: 'ontology.replace', ontology }]), 0);
  assert.ok(result.diagnostics.some(d => d.code === 'CONSTRAINT_VIOLATION' &&
    d.severity === 'warning' && d.entityId === 'item-b'));
  assert.equal(Object.hasOwn(result.snapshot.graph.entities[1].properties, 'prop-extension'), false);
  assert.deepEqual(graph.ontology.constraints, []);
});

test('provenance round-trips independently and invalid validity ranges abort the batch', () => {
  const graph = fixture();
  const entity = structuredClone(graph.graph.entities[0]);
  entity.provenance = [{
    sourceId: 'source', confidence: 1, assertedAt: '2024-01-03T00:00:00Z',
    validFrom: '2024-01-01T10:00:00.1234001Z', validUntil: '2024-01-01T10:00:00.1234002Z',
  }];
  const result = applyBatch(graph, batch([{ type: 'entity.put', entity }]), 0);
  assert.deepEqual(JSON.parse(JSON.stringify(result.snapshot)).graph.entities[0].provenance, entity.provenance);
  assert.equal(Object.hasOwn(result.snapshot.graph.entities[0].provenance[0], 'verifiedAt'), false);
  entity.provenance[0].validUntil = '2024-01-01T10:00:00.1234000Z';
  assert.throws(() => applyBatch(graph, batch([{ type: 'entity.put', entity }]), 0),
    error => error.code === 'INVALID_RESULT' && error.diagnostics.some(d => d.code === 'INVALID_TEMPORAL_RANGE'));
  assert.deepEqual(graph.graph.entities[0].provenance, []);
});

test('inverse and symmetric navigation is derived without materializing facts', () => {
  const graph = fixture();
  graph.ontology.relationshipTypes[0].inversePredicateId = 'rel-manage';
  graph.ontology.relationshipTypes[1].symmetric = true;
  const before = structuredClone(graph);
  const connections = connectionsFor(graph, 'item-b');
  assert.deepEqual(connections, [
    { assertionId: 'edge-a', from: 'item-a', to: 'item-b', relationshipTypeId: 'rel-support', status: 'asserted', derived: false },
    { assertionId: 'edge-a', from: 'item-b', to: 'item-a', relationshipTypeId: 'rel-manage', status: 'asserted', derived: true },
    { assertionId: 'edge-b', from: 'item-a', to: 'item-b', relationshipTypeId: 'rel-manage', status: 'proposed', derived: false },
    { assertionId: 'edge-b', from: 'item-b', to: 'item-a', relationshipTypeId: 'rel-manage', status: 'proposed', derived: true },
    { assertionId: 'edge-unresolved', from: 'item-b', to: 'item-a', relationshipTypeId: null, status: 'proposed', derived: false },
  ]);
  assert.deepEqual(graph, before);
  const inspection = inspectConnections(graph, 'item-b');
  assert.deepEqual(inspection.connections, connections);
  assert.deepEqual(inspection.diagnostics, validateSnapshot(graph));
  assert.throws(() => connectionsFor(graph, 'missing'), error => error.code === 'NOT_FOUND');
  graph.graph.relationships[0].to = 'missing';
  assert.throws(() => inspectConnections(graph, 'item-b'), error => error.code === 'INVALID_SNAPSHOT');
});

test('self-links do not produce identical symmetric derived navigation', () => {
  const graph = fixture();
  graph.ontology.relationshipTypes[1].symmetric = true;
  graph.graph.relationships.push({ ...relationship('self-edge', 'rel-manage'), to: 'item-a' });
  const self = connectionsFor(graph, 'item-a').filter(connection => connection.assertionId === 'self-edge');
  assert.deepEqual(self, [
    { assertionId: 'self-edge', from: 'item-a', to: 'item-a', relationshipTypeId: 'rel-manage', status: 'asserted', derived: false },
  ]);
});

test('bounded transitive paths retain distinct asserted proofs without changing facts', () => {
  const graph = fixture();
  graph.ontology.relationshipTypes[0].transitive = true;
  for (const id of ['item-c', 'item-d']) {
    graph.graph.entities.push({ ...structuredClone(graph.graph.entities[1]), id, name: id });
  }
  graph.graph.relationships.push(
    { ...relationship('bc-one', 'rel-support'), from: 'item-b', to: 'item-c' },
    { ...relationship('bc-two', 'rel-support'), from: 'item-b', to: 'item-c' },
    { ...relationship('cd', 'rel-support'), from: 'item-c', to: 'item-d' },
    { ...relationship('ca', 'rel-support'), from: 'item-c', to: 'item-a' },
    { ...relationship('bd-proposed', 'rel-support'), from: 'item-b', to: 'item-d', status: 'proposed' },
  );
  const before = structuredClone(graph);
  const result = inferTransitivePaths(graph, { sourceId: 'item-a', relationshipTypeId: 'rel-support', maxDepth: 3 });
  assert.deepEqual(result.paths.map(path => path.assertionIds), [
    ['edge-a', 'bc-one'], ['edge-a', 'bc-two'],
    ['edge-a', 'bc-one', 'cd'], ['edge-a', 'bc-one', 'ca'],
    ['edge-a', 'bc-two', 'cd'], ['edge-a', 'bc-two', 'ca'],
  ]);
  assert.deepEqual(result.paths[0].entityIds, ['item-a', 'item-b', 'item-c']);
  assert.ok(result.paths.every(path => path.derived && path.relationshipTypeId === 'rel-support'));
  assert.equal(result.truncated, false);
  assert.deepEqual(graph, before);
  const limited = inferTransitivePaths(graph, {
    sourceId: 'item-a', relationshipTypeId: 'rel-support', maxDepth: 2, maxResults: 1,
  });
  assert.equal(limited.truncated, true);
  assert.deepEqual(limited.paths.map(path => path.assertionIds), [['edge-a', 'bc-one']]);
  const workLimited = inferTransitivePaths(graph, {
    sourceId: 'item-a', relationshipTypeId: 'rel-support', maxSteps: 1,
  });
  assert.equal(workLimited.truncated, true);
  assert.equal(workLimited.steps, 1);
  assert.deepEqual(workLimited.paths, []);
});

test('transitive inference rejects invalid limits, unsafe options and undeclared predicates', () => {
  const graph = fixture();
  assert.throws(() => inferTransitivePaths(graph, { sourceId: 'item-a', relationshipTypeId: 'rel-support' }),
    error => error.code === 'INVALID_INFERENCE_PREDICATE');
  graph.ontology.relationshipTypes[0].transitive = true;
  for (const limits of [{ maxDepth: 1 }, { maxDepth: 7 }, { maxResults: 0 }, { maxSteps: 50001 }]) {
    assert.throws(() => inferTransitivePaths(graph, { sourceId: 'item-a', relationshipTypeId: 'rel-support', ...limits }),
      error => error.code === 'INVALID_INFERENCE_OPTIONS');
  }
  assert.throws(() => inferTransitivePaths(graph, { sourceId: 'missing', relationshipTypeId: 'rel-support' }),
    error => error.code === 'NOT_FOUND');
  let invoked = false;
  const options = { sourceId: 'item-a', relationshipTypeId: 'rel-support' };
  Object.defineProperty(options, 'maxDepth', { enumerable: true, get() { invoked = true; return 2; } });
  assert.throws(() => inferTransitivePaths(graph, options), error => error.code === 'INVALID_INFERENCE_OPTIONS');
  assert.equal(invoked, false);
});

test('independent view changes do not mutate semantic facts', () => {
  const graph = fixture();
  const view = structuredClone(graph.views[1]);
  view.positions['item-a'] = { x: 900, y: 450 };
  const result = applyBatch(graph, batch([{ type: 'view.put', view }]), 0);
  assert.deepEqual(result.snapshot.graph, graph.graph);
  assert.deepEqual(result.snapshot.views[0], graph.views[0]);
  assert.deepEqual(result.snapshot.views[1].positions['item-a'], { x: 900, y: 450 });
  assert.deepEqual(graph.views[1].positions['item-a'], { x: 10, y: 20 });
});

test('JSON-equivalent shared references do not couple output records', () => {
  const graph = fixture();
  graph.graph.entities[1].properties = graph.graph.entities[0].properties;
  const result = applyBatch(graph, batch([{ type: 'view.put', view: graph.views[0] }]), 0);
  result.snapshot.graph.entities[0].properties['prop-extension'] = 'changed';
  assert.equal(result.snapshot.graph.entities[1].properties['prop-extension'], '00123');
  assert.equal(graph.graph.entities[0].properties['prop-extension'], '00123');
});

test('batch and revision limits include their documented upper bounds', () => {
  const graph = fixture();
  const operations = Array.from({ length: 100 }, () => ({
    type: 'entity.put', entity: graph.graph.entities[0],
  }));
  const result = applyBatch(graph, batch(operations, Number.MAX_SAFE_INTEGER - 1), Number.MAX_SAFE_INTEGER - 1);
  assert.equal(result.revision, Number.MAX_SAFE_INTEGER);
  assert.deepEqual(result.snapshot, graph);
});

test('batch payloads are inspected before access or cloning', () => {
  const graph = fixture();
  const before = structuredClone(graph);
  let getterCalls = 0;
  const unsafe = batch([{ type: 'entity.put', entity: structuredClone(graph.graph.entities[0]) }]);
  Object.defineProperty(unsafe.operations[0].entity, 'name', {
    enumerable: true,
    get() { getterCalls++; throw new Error('must not run'); },
  });
  assert.throws(() => applyBatch(graph, unsafe, 0), error =>
    error instanceof GraphCommandError && error.code === 'INVALID_BATCH' &&
    error.diagnostics.some(d => d.code === 'INVALID_STRUCTURE'));
  assert.equal(getterCalls, 0);

  const large = batch([{ type: 'entity.put', entity: { ...graph.graph.entities[0], name: 'x'.repeat(5000001) } }]);
  assert.throws(() => applyBatch(graph, large, 0), error =>
    error instanceof GraphCommandError && error.code === 'INVALID_BATCH' &&
    error.diagnostics.some(d => d.code === 'RESOURCE_LIMIT_EXCEEDED'));
  assert.deepEqual(graph, before);
});

test('stale or malformed batches fail explicitly without touching the graph', () => {
  const graph = fixture();
  const before = structuredClone(graph);
  assert.throws(() => applyBatch(graph, batch([{ type: 'entity.delete', id: 'item-a' }], 1), 0),
    error => error instanceof GraphCommandError && error.code === 'REVISION_CONFLICT');
  assert.throws(() => applyBatch(graph, batch([{ type: 'entity.delete', id: 'unknown' }]), 0),
    error => error instanceof GraphCommandError && error.code === 'NOT_FOUND');
  assert.throws(() => applyBatch(graph, batch([{ type: 'not-supported' }]), 0),
    error => error instanceof GraphCommandError && error.code === 'INVALID_OPERATION');
  assert.throws(() => applyBatch(graph, { ...batch([]), protocolVersion: 1 }, 0),
    error => error instanceof GraphCommandError && error.code === 'INVALID_BATCH');
  assert.throws(() => applyBatch(graph, { ...batch([{ type: 'view.delete', id: 'view-shared' }]), operationId: 'operation\n' }, 0),
    error => error instanceof GraphCommandError && error.code === 'INVALID_BATCH');
  assert.throws(() => applyBatch(graph, batch([{ type: 'view.delete', id: 'view-shared\n' }]), 0),
    error => error instanceof GraphCommandError && error.code === 'INVALID_OPERATION');
  assert.throws(() => applyBatch(graph, { ...batch([{ type: 'entity.delete', id: 'item-a' }]), extra: true }, 0),
    error => error instanceof GraphCommandError && error.code === 'INVALID_BATCH');
  assert.throws(() => applyBatch(graph, batch([{ type: 'view.delete', id: 'view-shared' }], Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER),
    error => error instanceof GraphCommandError && error.code === 'INVALID_REVISION');
  assert.throws(() => applyBatch(graph, batch([{ type: 'view.delete', id: 'view-shared' }], Number.MAX_SAFE_INTEGER), 0),
    error => error instanceof GraphCommandError && error.code === 'INVALID_BATCH');
  assert.throws(() => applyBatch(graph, batch(Array.from({ length: 101 }, () => ({ type: 'view.delete', id: 'view-shared' }))), 0),
    error => error instanceof GraphCommandError && error.code === 'INVALID_BATCH');
  assert.deepEqual(graph, before);
});
