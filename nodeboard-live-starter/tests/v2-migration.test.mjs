import test from 'node:test';
import assert from 'node:assert/strict';
import { previewV1Migration, migrateV1ToV2 } from '../src/domain/migrate-v1.js';

const base = {
  format: 'nodeboard',
  version: 1,
  classes: [
    { id: 'cls-offering', key: 1, name: 'Offering', shape: 'pill', color: '#8c77cf',
      relations: [{ to: 'cls-team', label: 'SUPPORTED_BY', inverse: '' }] },
    { id: 'cls-team', key: 2, name: 'Team', shape: 'rectangle', color: '#38a99c' },
  ],
  nodes: [
    { id: 'demo-offering', x: 0, y: 0, name: 'Example offering', classId: 'cls-offering' },
    { id: 'demo-team', x: 300, y: 0, name: 'Example team', classId: 'cls-team' },
  ],
  edges: [{ id: 'demo-edge-support', from: 'demo-offering', to: 'demo-team', label: 'SUPPORTED_BY' }],
};

test('migrates a valid legacy board and preserves IDs, positions, labels, styles, and backup', () => {
  const source = structuredClone(base);
  const result = previewV1Migration(source);
  assert.equal(result.ok, true);
  assert.equal(result.snapshot.graph.entities[0].id, 'demo-offering');
  assert.equal(result.snapshot.graph.relationships[0].id, 'demo-edge-support');
  assert.equal(result.snapshot.graph.relationships[0].relationshipTypeId.startsWith('rel-legacy-SUPPORTED_BY-'), true);
  assert.deepEqual(result.snapshot.views[0].positions['demo-team'], { x: 300, y: 0 });
  assert.equal(result.snapshot.presentation.classStyles['cls-offering'].shape, 'pill');
  assert.equal(result.snapshot.graph.entities[0].status, 'draft');
  assert.deepEqual(result.sourceBackup, source);
  assert.deepEqual(source, base);
  assert.deepEqual(result.snapshot.metadata.migration.sourceBackup, base);
});

test('resolves numeric references by numeric type, not by a stringified collision', () => {
  const source = structuredClone(base);
  source.nodes[0].id = '1';
  source.nodes[1].id = 1;
  source.edges[0].from = 1;
  source.edges[0].to = '1';
  const result = previewV1Migration(source);
  assert.equal(result.ok, true);
  assert.equal(result.snapshot.graph.relationships[0].from, 'legacy-node-1');
  assert.equal(result.snapshot.graph.relationships[0].to, '1');
});

test('accepts an unversioned local v1 graph but rejects explicit format and version mismatches', () => {
  const local = structuredClone(base);
  delete local.format;
  delete local.version;
  assert.equal(previewV1Migration(local).ok, true);
  const badFormat = { ...local, format: 'other' };
  const badVersion = { ...local, version: 2 };
  assert.equal(previewV1Migration(badFormat).ok, false);
  assert.ok(previewV1Migration(badFormat).diagnostics.some(item => item.code === 'UNSUPPORTED_FORMAT'));
  assert.equal(previewV1Migration(badVersion).ok, false);
  assert.ok(previewV1Migration(badVersion).diagnostics.some(item => item.code === 'UNSUPPORTED_VERSION'));
});

test('rejects missing or invalid names, coordinates, and present non-array relations', () => {
  const source = structuredClone(base);
  source.classes[0].relations = {};
  source.classes[0].name = '';
  source.nodes[0].x = '0';
  delete source.nodes[1].name;
  const result = previewV1Migration(source);
  assert.equal(result.ok, false);
  assert.ok(result.diagnostics.some(item => item.code === 'INVALID_LEGACY_RELATIONS'));
  assert.ok(result.diagnostics.some(item => item.code === 'INVALID_LEGACY_CLASS'));
  assert.ok(result.diagnostics.some(item => item.code === 'INVALID_LEGACY_POSITION'));
  assert.ok(result.diagnostics.some(item => item.code === 'INVALID_LEGACY_NODE'));
  assert.deepEqual(result.sourceBackup, source);
});

test('preserves resolved edge labels and class relation definitions exactly, and reports unsupported properties', () => {
  const source = structuredClone(base);
  source.classes[0].relations[0].extra = { sourceOnly: true };
  source.edges[0].properties = { confidence: 0.8 };
  const result = previewV1Migration(source);
  assert.equal(result.ok, true);
  const predicate = result.snapshot.ontology.relationshipTypes[0];
  const relationship = result.snapshot.graph.relationships[0];
  assert.equal(relationship.metadata.migration.legacyLabel, 'SUPPORTED_BY');
  assert.deepEqual(predicate.metadata.migration.legacyDefinition, source.classes[0].relations[0]);
  assert.ok(result.diagnostics.some(item => item.code === 'UNSUPPORTED_LEGACY_PROPERTIES'));
  assert.deepEqual(relationship.metadata.migration.legacyProperties, { confidence: 0.8 });
});

test('bounds deterministic predicate IDs and names for long labels without collisions', () => {
  const source = structuredClone(base);
  const long = 'x'.repeat(500);
  source.classes[0].relations = [
    { to: 'cls-team', label: long },
    { to: 'cls-team', label: `${long}!` },
  ];
  source.edges = [
    { id: 'edge-a', from: 'demo-offering', to: 'demo-team', label: long },
    { id: 'edge-b', from: 'demo-offering', to: 'demo-team', label: `${long}!` },
  ];
  const result = previewV1Migration(source);
  assert.equal(result.ok, true);
  const predicates = result.snapshot.ontology.relationshipTypes;
  assert.equal(new Set(predicates.map(item => item.id)).size, predicates.length);
  assert.equal(new Set(predicates.map(item => item.predicate)).size, predicates.length);
  for (const predicate of predicates) {
    assert.ok(predicate.id.length <= 120);
    assert.ok(predicate.predicate.length <= 120);
  }
});

test('does not inspect or invoke unused options and does not infer entity lifecycle', () => {
  const source = structuredClone(base);
  source.nodes[0].status = 'retired';
  let invoked = false;
  const options = {};
  Object.defineProperty(options, 'ontologyId', {
    get() { invoked = true; throw new Error('must not be read'); },
  });
  const result = previewV1Migration(source, options);
  assert.equal(result.ok, true);
  assert.equal(invoked, false);
  assert.equal(result.snapshot.graph.entities[0].status, 'draft');
  assert.equal(result.snapshot.graph.entities[0].metadata.migration.legacyStatus, 'retired');
});

test('keeps multiple predicates between the same endpoints and preserves extra properties as metadata', () => {
  const source = structuredClone(base);
  source.classes[0].relations.push({ to: 'cls-team', label: 'MANAGED_BY', inverse: '' });
  source.nodes[0].properties = { extension: '00123' };
  source.edges.push({ id: 'edge-manage', from: 'demo-offering', to: 'demo-team', label: 'MANAGED_BY',
    properties: { confidence: 0.8 } });
  const result = migrateV1ToV2(source);
  assert.equal(result.ok, true);
  assert.equal(result.snapshot.graph.relationships.length, 2);
  assert.notEqual(result.snapshot.graph.relationships[0].relationshipTypeId,
    result.snapshot.graph.relationships[1].relationshipTypeId);
  assert.deepEqual(result.snapshot.graph.entities[0].metadata.migration.legacyProperties, { extension: '00123' });
  assert.deepEqual(result.snapshot.graph.relationships[1].metadata.migration.legacyProperties, { confidence: 0.8 });
});

test('rejects broken endpoints without silently dropping the edge', () => {
  const source = structuredClone(base);
  source.edges[0].to = 'missing-node';
  const result = previewV1Migration(source);
  assert.equal(result.ok, false);
  assert.equal(result.snapshot, null);
  assert.ok(result.diagnostics.some(item => item.code === 'BROKEN_LEGACY_REFERENCE'));
  assert.equal(result.sourceBackup.edges[0].to, 'missing-node');
});

test('retains ambiguous labels as unresolved relationships', () => {
  const source = structuredClone(base);
  source.classes[0].relations.push({ to: 'cls-team', label: 'SUPPORTED_BY', inverse: 'OTHER' });
  const result = previewV1Migration(source);
  assert.equal(result.ok, true);
  assert.equal(result.snapshot.graph.relationships[0].relationshipTypeId, null);
  assert.equal(result.snapshot.graph.relationships[0].legacy.reason, 'ambiguous-predicate');
  assert.ok(result.diagnostics.some(item => item.code === 'UNRESOLVED_LEGACY_RELATIONSHIP'));
});

test('numeric class IDs are deterministic, collision-safe, and resolved by key', () => {
  const source = structuredClone(base);
  source.classes = [
    { id: 10, key: 10, name: 'Numeric A', relations: [{ to: 20, label: 'LINKS' }] },
    { id: 20, key: 20, name: 'Numeric B' },
  ];
  source.nodes[0].classId = 10;
  source.nodes[1].classId = 20;
  source.edges[0].label = 'LINKS';
  source.edges[0].from = 'demo-offering';
  source.edges[0].to = 'demo-team';
  const first = previewV1Migration(source);
  const second = previewV1Migration(source);
  assert.equal(first.ok, true);
  assert.deepEqual(first.snapshot, second.snapshot);
  assert.deepEqual(first.snapshot.graph.entities.map(item => item.classIds[0]), ['legacy-class-10', 'legacy-class-20']);
});

test('numeric class references use legacy keys rather than numeric class IDs', () => {
  const source = structuredClone(base);
  source.classes[0].id = 10;
  source.classes[1].id = 20;
  source.classes[0].relations[0].to = 2;
  source.nodes[0].classId = 1;
  source.nodes[1].classId = 2;
  const result = previewV1Migration(source);
  assert.equal(result.ok, true);
  assert.deepEqual(result.snapshot.graph.entities.map(entity => entity.classIds[0]), ['legacy-class-10', 'legacy-class-20']);
  source.nodes[0].classId = 10;
  assert.ok(previewV1Migration(source).diagnostics.some(item => item.code === 'BROKEN_LEGACY_REFERENCE'));
});

test('missing class IDs and keys use deterministic positional keys', () => {
  const source = structuredClone(base);
  for (const cls of source.classes) { delete cls.id; delete cls.key; }
  source.classes[0].relations[0].to = 2;
  source.nodes[0].classId = 1;
  source.nodes[1].classId = 2;
  source.nodes[0].name = '';
  const result = previewV1Migration(source);
  assert.equal(result.ok, true);
  assert.deepEqual(result.snapshot.graph.entities.map(entity => entity.classIds[0]), ['legacy-class-1', 'legacy-class-2']);
  assert.equal(result.snapshot.graph.entities[0].name, '');
  assert.deepEqual(result.sourceBackup, source);
});

test('source text is preserved exactly and non-string edge labels are rejected', () => {
  const text = ` \n${JSON.stringify(base, null, 2)}\n`;
  assert.equal(previewV1Migration(text).sourceText, text);
  const invalid = structuredClone(base);
  invalid.edges[0].label = 12;
  const result = previewV1Migration(invalid);
  assert.equal(result.ok, false);
  assert.ok(result.diagnostics.some(item => item.code === 'INVALID_LEGACY_LABEL'));
  const tooLarge = previewV1Migration('x'.repeat(5000001));
  assert.equal(tooLarge.ok, false);
  assert.ok(tooLarge.diagnostics.some(item => item.code === 'RESOURCE_LIMIT_EXCEEDED'));
});

test('invalid input produces explicit diagnostics and does not mutate input', () => {
  const source = structuredClone(base);
  source.edges[0].from = 'missing';
  const before = structuredClone(source);
  const result = previewV1Migration(source);
  assert.equal(result.ok, false);
  assert.deepEqual(source, before);
  assert.ok(result.diagnostics.some(item => item.severity === 'error'));
});
