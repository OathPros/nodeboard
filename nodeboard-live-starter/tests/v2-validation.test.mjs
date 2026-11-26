import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { inspectJsonInput, validateSnapshot } from '../src/domain/validate-v2.js';

function fixture() {
  return {
    format: 'nodeboard', version: 2,
    ontology: {
      id: 'ontology', version: '1',
      classes: [
        { id: 'base', name: 'Base', superclassIds: [], abstract: false, propertyDefinitionIds: ['p'] },
        { id: 'child', name: 'Child', superclassIds: ['base'], abstract: false, propertyDefinitionIds: [] }
      ],
      relationshipTypes: [
        { id: 'r1', predicate: 'ONE', label: 'One', domainClassIds: ['base'], rangeClassIds: ['base'], inversePredicateId: null, symmetric: false, transitive: false },
        { id: 'r2', predicate: 'TWO', label: 'Two', domainClassIds: [], rangeClassIds: [], inversePredicateId: null, symmetric: false, transitive: false }
      ],
      propertyDefinitions: [{ id: 'p', name: 'Label', dataType: 'string' }],
      constraints: []
    },
    graph: {
      entities: [
        { id: 'a', classIds: ['child'], name: 'A', properties: { p: '001' }, externalIds: [], provenance: [], status: 'active' },
        { id: 'b', classIds: ['base'], name: 'B', properties: {}, externalIds: [], provenance: [], status: 'draft' }
      ],
      relationships: [
        { id: 'e1', from: 'a', to: 'b', relationshipTypeId: 'r1', properties: {}, provenance: [], status: 'asserted' },
        { id: 'e2', from: 'a', to: 'b', relationshipTypeId: 'r2', properties: {}, provenance: [], status: 'proposed' }
      ]
    },
    views: [{ id: 'v', name: 'View', scope: 'shared', query: {}, entityIds: ['a'], positions: { a: { x: 0, y: 1 } }, viewport: { x: 0, y: 0, zoom: 1 } }],
    presentation: { classStyles: {}, relationshipStyles: {} }, metadata: {}
  };
}
const codes = input => validateSnapshot(input).map(d => d.code);
const has = (diagnostics, code, path) => diagnostics.some(d => d.code === code && d.path === path);

test('valid multigraph with inherited domain has no errors and states limitations', () => {
  const graph = fixture(), before = structuredClone(graph);
  const result = validateSnapshot(graph);
  assert.equal(result.some(d => d.severity === 'error'), false);
  assert.deepEqual(result.map(d => d.code), ['VALIDATION_INCOMPLETE']);
  assert.deepEqual(graph, before);
});

test('invalid arbitrary inputs and structural rules produce diagnostics, never throws', () => {
  for (const input of [null, [], 2, 'text', {}, { ontology: null }, { graph: [] }, NaN, undefined]) {
    const result = validateSnapshot(input);
    assert.ok(result.some(d => d.severity === 'error'));
  }
  const x = fixture();
  x.version = 3;
  x.ontology.id = 'valid-id\n';
  x.views[0].scope = 'personal';
  x.graph.relationships[0].relationshipTypeId = null;
  x.graph.entities[0].provenance.push({ sourceId: 'source', confidence: 1.1, verifiedAt: 'bad' });
  const result = validateSnapshot(x);
  for (const path of ['/version', '/ontology/id', '/views/0/ownerId', '/graph/relationships/0/legacy', '/graph/entities/0/provenance/0/confidence', '/graph/entities/0/provenance/0/verifiedAt']) {
    assert.ok(has(result, 'INVALID_STRUCTURE', path), path);
  }
  const zeroYear = fixture();
  zeroYear.graph.entities[0].provenance.push({ sourceId: 'source', verifiedAt: '0000-01-01T00:00:00Z' });
  assert.ok(has(validateSnapshot(zeroYear), 'INVALID_STRUCTURE', '/graph/entities/0/provenance/0/verifiedAt'));
});

test('duplicates, dangling references and pointer escaping are reported deterministically', () => {
  const x = fixture();
  x.ontology.classes.push(structuredClone(x.ontology.classes[0]));
  x.ontology.relationshipTypes[1].predicate = 'ONE';
  x.graph.entities.push(structuredClone(x.graph.entities[0]));
  x.graph.entities[0].classIds = ['missing'];
  x.graph.relationships[0].from = 'missing';
  x.graph.relationships[1].relationshipTypeId = 'missing';
  x.views[0].positions['missing/~'] = { x: 1, y: 2 };
  x.ontology.classes[0].propertyDefinitionIds = ['missing'];
  const result = validateSnapshot(x);
  assert.deepEqual(result, validateSnapshot(x));
  for (const [code, path] of [
    ['DUPLICATE_ID', '/ontology/classes/2/id'], ['DUPLICATE_ID', '/ontology/relationshipTypes/1/predicate'],
    ['DUPLICATE_ID', '/graph/entities/2/id'], ['REFERENCE_NOT_FOUND', '/graph/entities/0/classIds/0'],
    ['REFERENCE_NOT_FOUND', '/ontology/classes/0/propertyDefinitionIds/0'],
    ['REFERENCE_NOT_FOUND', '/graph/relationships/0/from'], ['REFERENCE_NOT_FOUND', '/graph/relationships/1/relationshipTypeId'],
    ['REFERENCE_NOT_FOUND', '/views/0/positions/missing~1~0']
  ]) assert.ok(has(result, code, path), path);
});

test('cycles are errors and unresolved or mismatched relationships are warnings', () => {
  const x = fixture();
  x.ontology.classes[0].superclassIds = ['child'];
  x.ontology.classes.push({ id: 'other', name: 'Other', superclassIds: [], abstract: false, propertyDefinitionIds: [] });
  x.ontology.relationshipTypes[0].rangeClassIds = ['other'];
  x.graph.relationships[1].relationshipTypeId = null;
  x.graph.relationships[1].legacy = { label: '', reason: 'unknown' };
  const result = validateSnapshot(x);
  assert.ok(result.some(d => d.code === 'INHERITANCE_CYCLE' && d.severity === 'error'));
  assert.ok(result.some(d => d.code === 'DOMAIN_RANGE_MISMATCH' && d.severity === 'warning' && d.path.endsWith('/to')));
  assert.ok(result.some(d => d.code === 'UNRESOLVED_LEGACY_RELATIONSHIP' && d.severity === 'warning'));
});

test('abstract classes can be inherited but cannot be directly instantiated', () => {
  const graph = fixture();
  graph.ontology.classes[0].abstract = true;
  assert.ok(has(validateSnapshot(graph), 'ABSTRACT_CLASS_INSTANTIATION', '/graph/entities/1/classIds/0'));
  assert.equal(has(validateSnapshot(graph), 'ABSTRACT_CLASS_INSTANTIATION', '/graph/entities/0/classIds/0'), false);
  graph.graph.entities[1].classIds = ['child'];
  assert.equal(codes(graph).includes('ABSTRACT_CLASS_INSTANTIATION'), false);
});

test('entity property applicability includes inherited declarations and warns without removing values', () => {
  const graph = fixture();
  assert.equal(codes(graph).includes('PROPERTY_NOT_APPLICABLE'), false);
  graph.ontology.classes.push({ id: 'other', name: 'Other', superclassIds: [], abstract: false, propertyDefinitionIds: [] });
  graph.graph.entities[0].classIds = ['other'];
  const result = validateSnapshot(graph);
  assert.ok(result.some(d => d.code === 'PROPERTY_NOT_APPLICABLE' && d.severity === 'warning' && d.path === '/graph/entities/0/properties/p'));
  assert.equal(graph.graph.entities[0].properties.p, '001');
});

test('required-property constraints follow inheritance and multiple membership in draft and publish', () => {
  const graph = fixture();
  graph.ontology.classes.push({ id: 'other', name: 'Other', superclassIds: [], abstract: false, propertyDefinitionIds: [] });
  graph.graph.entities[0].classIds = ['other', 'child'];
  graph.graph.entities[0].properties = {};
  graph.graph.entities[1].properties.p = '';
  graph.ontology.constraints.push(
    { id: 'req-base', kind: 'required', parameters: { classId: 'base', propertyId: 'p' } },
    { id: 'req-child', kind: 'required', parameters: { classId: 'child', propertyId: 'p' } }
  );
  const draft = validateSnapshot(graph);
  const violation = draft.filter(d => d.code === 'CONSTRAINT_VIOLATION');
  assert.equal(violation.length, 1);
  assert.equal(violation[0].severity, 'warning');
  assert.equal(violation[0].path, '/graph/entities/0/properties/p');
  assert.equal(violation[0].entityId, 'a');
  assert.deepEqual(draft, validateSnapshot(graph, { profile: 'draft' }));
  const publish = validateSnapshot(graph, { profile: 'publish' });
  assert.ok(publish.some(d => d.code === 'CONSTRAINT_VIOLATION' && d.severity === 'error' && d.entityId === 'a'));
  assert.ok(publish.some(d => d.code === 'PUBLISH_POLICY_INCOMPLETE' && d.severity === 'error'));
  graph.graph.entities[0].classIds = ['other'];
  assert.equal(codes(graph).includes('CONSTRAINT_VIOLATION'), false);
});

test('required means absent, not false, zero or empty string', () => {
  const graph = fixture();
  graph.ontology.propertyDefinitions.push(
    { id: 'bool', name: 'Boolean', dataType: 'boolean' },
    { id: 'num', name: 'Number', dataType: 'integer' }
  );
  graph.ontology.classes[0].propertyDefinitionIds.push('bool', 'num');
  graph.ontology.constraints.push(...['p', 'bool', 'num'].map((propertyId, i) => ({
    id: `req-${i}`, kind: 'required', parameters: { classId: 'base', propertyId }
  })));
  for (const entity of graph.graph.entities) entity.properties = { p: '', bool: false, num: 0 };
  assert.equal(codes(graph).includes('CONSTRAINT_VIOLATION'), false);
  assert.equal(codes(graph).includes('INVALID_PROPERTY_VALUE'), false);
  graph.graph.entities[0].properties.p = null;
  assert.equal(codes(graph).includes('CONSTRAINT_VIOLATION'), false);
  assert.ok(codes(graph).includes('INVALID_PROPERTY_VALUE'));
});

test('required constraints reject malformed parameters and missing references', () => {
  const malformed = [
    { classId: 'base' }, { propertyId: 'p' },
    { classId: 'base', propertyId: 'p', extra: true },
    { classId: null, propertyId: 'p' }, { classId: 'base', propertyId: 'bad id' }
  ];
  for (const parameters of malformed) {
    const graph = fixture();
    graph.ontology.constraints.push({ id: 'req', kind: 'required', parameters });
    assert.ok(validateSnapshot(graph).some(d => d.code === 'INVALID_STRUCTURE' && d.severity === 'error'));
  }
  const graph = fixture();
  graph.ontology.constraints.push({ id: 'req', kind: 'required', parameters: { classId: 'missing-class', propertyId: 'missing-property' } });
  const result = validateSnapshot(graph);
  assert.ok(has(result, 'REFERENCE_NOT_FOUND', '/ontology/constraints/0/parameters/classId'));
  assert.ok(has(result, 'REFERENCE_NOT_FOUND', '/ontology/constraints/0/parameters/propertyId'));
  assert.equal(result.some(d => d.code === 'CONSTRAINT_VIOLATION'), false);
});

test('cardinality counts only asserted stored relationships in the configured direction', () => {
  const graph = fixture();
  graph.ontology.constraints.push({
    id: 'links', kind: 'cardinality',
    parameters: { classId: 'child', relationshipTypeId: 'r2', direction: 'out', minimum: 1 },
  });
  let diagnostics = validateSnapshot(graph);
  assert.ok(diagnostics.some(d => d.code === 'CONSTRAINT_VIOLATION' && d.entityId === 'a' && d.severity === 'warning'));
  assert.ok(validateSnapshot(graph, { profile: 'publish' }).some(d =>
    d.code === 'CONSTRAINT_VIOLATION' && d.entityId === 'a' && d.severity === 'error'));
  graph.graph.relationships[1].status = 'asserted';
  assert.equal(codes(graph).includes('CONSTRAINT_VIOLATION'), false);
  graph.ontology.constraints[0].parameters = { classId: 'base', relationshipTypeId: 'r2', direction: 'in', maximum: 0 };
  diagnostics = validateSnapshot(graph);
  assert.ok(diagnostics.some(d => d.code === 'CONSTRAINT_VIOLATION' && d.entityId === 'b' && d.suggestion === 'Review /ontology/constraints/0.'));
  assert.equal(diagnostics.some(d => d.code === 'CONSTRAINT_VIOLATION' && d.entityId === 'a'), false);
  graph.ontology.relationshipTypes[0].symmetric = true;
  graph.ontology.constraints[0].parameters = { classId: 'child', relationshipTypeId: 'r1', direction: 'in', minimum: 1 };
  assert.ok(validateSnapshot(graph).some(d => d.code === 'CONSTRAINT_VIOLATION' && d.entityId === 'a'));
});

test('cardinality rejects invalid bounds, shapes and unresolved references', () => {
  const values = [
    { classId: 'base', relationshipTypeId: 'r1', direction: 'out' },
    { classId: 'base', relationshipTypeId: 'r1', direction: 'both', minimum: 1 },
    { classId: 'base', relationshipTypeId: 'r1', direction: 'in', minimum: 1.5 },
    { classId: 'base', relationshipTypeId: 'r1', direction: 'in', maximum: -1 },
    { classId: 'base', relationshipTypeId: 'r1', direction: 'in', minimum: 1, extra: true },
  ];
  for (const parameters of values) {
    const graph = fixture();
    graph.ontology.constraints.push({ id: 'card', kind: 'cardinality', parameters });
    assert.ok(codes(graph).includes('INVALID_STRUCTURE'));
  }
  const graph = fixture();
  graph.ontology.constraints.push({
    id: 'card', kind: 'cardinality',
    parameters: { classId: 'missing', relationshipTypeId: 'unknown', direction: 'out', minimum: 2, maximum: 1 },
  });
  const result = validateSnapshot(graph);
  assert.ok(has(result, 'REFERENCE_NOT_FOUND', '/ontology/constraints/0/parameters/classId'));
  assert.ok(has(result, 'REFERENCE_NOT_FOUND', '/ontology/constraints/0/parameters/relationshipTypeId'));
  assert.ok(has(result, 'INVALID_CONSTRAINT', '/ontology/constraints/0/parameters'));
});

test('uniqueness checks inherited membership and compares structured values canonically', () => {
  const graph = fixture();
  graph.ontology.propertyDefinitions[0].dataType = 'structured';
  graph.ontology.constraints.push({
    id: 'unique', kind: 'uniqueness', parameters: { classId: 'base', propertyId: 'p' },
  });
  graph.graph.entities[0].properties.p = { first: 1, second: { a: 2, b: 3 } };
  graph.graph.entities[1].properties.p = { second: { b: 3, a: 2 }, first: 1 };
  const draft = validateSnapshot(graph);
  assert.ok(draft.some(d => d.code === 'CONSTRAINT_VIOLATION' && d.path === '/graph/entities/1/properties/p' &&
    d.severity === 'warning' && d.suggestion === 'Review /ontology/constraints/0 and /graph/entities/0.'));
  assert.ok(validateSnapshot(graph, { profile: 'publish' }).some(d => d.code === 'CONSTRAINT_VIOLATION' && d.severity === 'error'));
  delete graph.graph.entities[1].properties.p;
  assert.equal(codes(graph).includes('CONSTRAINT_VIOLATION'), false);
  graph.ontology.classes.push({ id: 'other', name: 'Other', superclassIds: [], abstract: false, propertyDefinitionIds: ['p'] });
  graph.graph.entities[1].classIds = ['other'];
  graph.graph.entities[1].properties.p = structuredClone(graph.graph.entities[0].properties.p);
  assert.equal(codes(graph).includes('CONSTRAINT_VIOLATION'), false);
});

test('uniqueness rejects malformed parameters and missing references', () => {
  const graph = fixture();
  graph.ontology.constraints.push({ id: 'unique', kind: 'uniqueness', parameters: { classId: 'missing', propertyId: 'unknown' } });
  let diagnostics = validateSnapshot(graph);
  assert.ok(has(diagnostics, 'REFERENCE_NOT_FOUND', '/ontology/constraints/0/parameters/classId'));
  assert.ok(has(diagnostics, 'REFERENCE_NOT_FOUND', '/ontology/constraints/0/parameters/propertyId'));
  graph.ontology.constraints[0].parameters = { classId: 'base', propertyId: 'p', extra: true };
  diagnostics = validateSnapshot(graph);
  assert.ok(diagnostics.some(d => d.code === 'INVALID_STRUCTURE'));
});

test('disjointness detects direct and inherited multiple membership', () => {
  const graph = fixture();
  graph.ontology.classes.push({ id: 'other', name: 'Other', superclassIds: [], abstract: false, propertyDefinitionIds: [] });
  graph.ontology.constraints.push({ id: 'disjoint', kind: 'disjointness', parameters: { classIds: ['base', 'other'] } });
  graph.graph.entities[0].classIds.push('other');
  let diagnostics = validateSnapshot(graph);
  assert.ok(diagnostics.some(d => d.code === 'CONSTRAINT_VIOLATION' && d.path === '/graph/entities/0/classIds' &&
    d.severity === 'warning' && d.suggestion === 'Review /ontology/constraints/0.'));
  assert.ok(validateSnapshot(graph, { profile: 'publish' }).some(d => d.code === 'CONSTRAINT_VIOLATION' && d.severity === 'error'));
  graph.graph.entities[0].classIds = ['child'];
  assert.equal(codes(graph).includes('CONSTRAINT_VIOLATION'), false);
  graph.ontology.classes[1].superclassIds.push('other');
  diagnostics = validateSnapshot(graph);
  assert.ok(diagnostics.some(d => d.code === 'CONSTRAINT_VIOLATION' && d.entityId === 'a'));
});

test('disjointness rejects insufficient, duplicate and unknown classes', () => {
  const graph = fixture();
  graph.ontology.constraints.push({ id: 'disjoint', kind: 'disjointness', parameters: { classIds: ['base'] } });
  assert.ok(codes(graph).includes('INVALID_STRUCTURE'));
  graph.ontology.constraints[0].parameters.classIds = ['base', 'base'];
  assert.ok(codes(graph).includes('INVALID_STRUCTURE'));
  graph.ontology.constraints[0].parameters.classIds = ['base', 'missing'];
  assert.ok(has(validateSnapshot(graph), 'REFERENCE_NOT_FOUND', '/ontology/constraints/0/parameters/classIds/1'));
});

test('acyclic constraints check directed asserted edges without materializing inverses', () => {
  const graph = fixture();
  graph.ontology.constraints.push({ id: 'acyclic', kind: 'acyclic', parameters: { relationshipTypeId: 'r1' } });
  graph.ontology.relationshipTypes[0].symmetric = true;
  graph.graph.relationships.push({
    id: 'reverse', from: 'b', to: 'a', relationshipTypeId: 'r1',
    properties: {}, provenance: [], status: 'proposed',
  });
  assert.equal(codes(graph).includes('CONSTRAINT_VIOLATION'), false);
  graph.graph.relationships[2].status = 'asserted';
  const before = structuredClone(graph);
  const draft = validateSnapshot(graph);
  assert.ok(draft.some(d => d.code === 'CONSTRAINT_VIOLATION' && d.path === '/graph/relationships/2/to' &&
    d.entityId === 'reverse' && d.severity === 'warning' && d.suggestion === 'Review /ontology/constraints/0.'));
  assert.ok(validateSnapshot(graph, { profile: 'publish' }).some(d =>
    d.code === 'CONSTRAINT_VIOLATION' && d.severity === 'error'));
  assert.deepEqual(graph, before);
  graph.graph.relationships[2].relationshipTypeId = 'r2';
  assert.equal(codes(graph).includes('CONSTRAINT_VIOLATION'), false);
  graph.graph.relationships[2].relationshipTypeId = 'r1';
  graph.graph.relationships[2].from = 'a';
  graph.graph.relationships[2].to = 'a';
  assert.ok(validateSnapshot(graph).some(d => d.code === 'CONSTRAINT_VIOLATION' && d.entityId === 'reverse'));
});

test('acyclic constraints reject malformed parameters and missing predicates', () => {
  const graph = fixture();
  graph.ontology.constraints.push({ id: 'acyclic', kind: 'acyclic', parameters: { relationshipTypeId: 'missing' } });
  assert.ok(has(validateSnapshot(graph), 'REFERENCE_NOT_FOUND', '/ontology/constraints/0/parameters/relationshipTypeId'));
  graph.ontology.constraints[0].parameters = {};
  assert.ok(codes(graph).includes('INVALID_STRUCTURE'));
  graph.ontology.constraints[0].parameters = { relationshipTypeId: 'r1', extra: true };
  assert.ok(codes(graph).includes('INVALID_STRUCTURE'));
});

test('acyclic validation handles long directed chains and converging paths', () => {
  const graph = fixture();
  const n = 2000;
  graph.ontology.constraints.push({ id: 'acyclic', kind: 'acyclic', parameters: { relationshipTypeId: 'r1' } });
  graph.graph.entities = Array.from({ length: n }, (_, i) => ({
    id: `e-${i}`, classIds: ['base'], name: '', properties: {}, externalIds: [], provenance: [], status: 'active',
  }));
  graph.graph.relationships = Array.from({ length: n - 1 }, (_, i) => ({
    id: `r-${i}`, from: `e-${i}`, to: `e-${i + 1}`, relationshipTypeId: 'r1',
    properties: {}, provenance: [], status: 'asserted',
  }));
  graph.graph.relationships.push({
    id: 'shortcut', from: 'e-0', to: `e-${n - 1}`, relationshipTypeId: 'r1',
    properties: {}, provenance: [], status: 'asserted',
  });
  graph.views = [];
  assert.equal(validateSnapshot(graph).some(d => d.severity === 'error' || d.code === 'CONSTRAINT_VIOLATION'), false);
  graph.graph.relationships.push({
    id: 'cycle', from: `e-${n - 1}`, to: 'e-0', relationshipTypeId: 'r1',
    properties: {}, provenance: [], status: 'asserted',
  });
  assert.ok(validateSnapshot(graph).some(d => d.code === 'CONSTRAINT_VIOLATION' && d.entityId === 'cycle'));
});

test('allowed-target constraints use inherited source and target classes for asserted edges', () => {
  const graph = fixture();
  graph.ontology.constraints.push({
    id: 'target', kind: 'allowedTarget',
    parameters: { classId: 'base', relationshipTypeId: 'r1', targetClassIds: ['child'] },
  });
  let diagnostics = validateSnapshot(graph);
  assert.ok(diagnostics.some(d => d.code === 'CONSTRAINT_VIOLATION' && d.path === '/graph/relationships/0/to' &&
    d.entityId === 'e1' && d.severity === 'warning' && d.suggestion === 'Review /ontology/constraints/0.'));
  assert.ok(validateSnapshot(graph, { profile: 'publish' }).some(d =>
    d.code === 'CONSTRAINT_VIOLATION' && d.entityId === 'e1' && d.severity === 'error'));
  graph.ontology.classes.push({ id: 'grandchild', name: 'Grandchild', superclassIds: ['child'], abstract: false, propertyDefinitionIds: [] });
  graph.graph.entities[1].classIds = ['grandchild'];
  assert.equal(codes(graph).includes('CONSTRAINT_VIOLATION'), false);
  graph.ontology.classes.push({ id: 'other', name: 'Other', superclassIds: [], abstract: false, propertyDefinitionIds: [] });
  graph.graph.entities[0].classIds.push('other');
  graph.ontology.constraints.push({
    id: 'second-target', kind: 'allowedTarget',
    parameters: { classId: 'other', relationshipTypeId: 'r1', targetClassIds: ['other'] },
  });
  diagnostics = validateSnapshot(graph);
  assert.ok(diagnostics.some(d => d.code === 'CONSTRAINT_VIOLATION' && d.suggestion === 'Review /ontology/constraints/1.'));
  assert.equal(diagnostics.some(d => d.code === 'CONSTRAINT_VIOLATION' && d.suggestion === 'Review /ontology/constraints/0.'), false);
  graph.ontology.constraints.pop();
  graph.graph.entities[1].classIds = ['base'];
  graph.graph.relationships[0].status = 'proposed';
  assert.equal(codes(graph).includes('CONSTRAINT_VIOLATION'), false);
  graph.graph.relationships[0].status = 'asserted';
  graph.graph.entities[0].classIds = [];
  assert.equal(codes(graph).includes('CONSTRAINT_VIOLATION'), false);
});

test('allowed-target constraints validate parameter shapes and all references', () => {
  const graph = fixture();
  graph.ontology.constraints.push({
    id: 'target', kind: 'allowedTarget',
    parameters: { classId: 'missing-source', relationshipTypeId: 'missing-type', targetClassIds: ['missing-target'] },
  });
  const diagnostics = validateSnapshot(graph);
  assert.ok(has(diagnostics, 'REFERENCE_NOT_FOUND', '/ontology/constraints/0/parameters/classId'));
  assert.ok(has(diagnostics, 'REFERENCE_NOT_FOUND', '/ontology/constraints/0/parameters/relationshipTypeId'));
  assert.ok(has(diagnostics, 'REFERENCE_NOT_FOUND', '/ontology/constraints/0/parameters/targetClassIds/0'));
  assert.equal(diagnostics.some(d => d.code === 'CONSTRAINT_VIOLATION'), false);
  for (const parameters of [
    { classId: 'base', relationshipTypeId: 'r1', targetClassIds: [] },
    { classId: 'base', relationshipTypeId: 'r1', targetClassIds: ['child', 'child'] },
    { classId: 'base', relationshipTypeId: 'r1' },
    { classId: 'base', relationshipTypeId: 'r1', targetClassIds: ['child'], extra: true },
  ]) {
    graph.ontology.constraints[0].parameters = parameters;
    assert.ok(codes(graph).includes('INVALID_STRUCTURE'));
  }
});

test('conditional required properties follow inheritance and compare values canonically', () => {
  const graph = fixture();
  graph.ontology.propertyDefinitions.push(
    { id: 'condition', name: 'Condition', dataType: 'structured' },
    { id: 'required', name: 'Required', dataType: 'boolean' },
  );
  graph.ontology.classes[0].propertyDefinitionIds.push('condition', 'required');
  graph.ontology.constraints.push({
    id: 'conditional', kind: 'conditional',
    parameters: { classId: 'base', when: { propertyId: 'condition', equals: { x: 1, y: 2 } }, requirePropertyIds: ['required'] },
  });
  graph.graph.entities[0].properties.condition = { y: 2, x: 1 };
  let diagnostics = validateSnapshot(graph);
  assert.ok(diagnostics.some(d => d.code === 'CONSTRAINT_VIOLATION' && d.path === '/graph/entities/0/properties/required' &&
    d.entityId === 'a' && d.severity === 'warning' && d.suggestion === 'Review /ontology/constraints/0.'));
  assert.ok(validateSnapshot(graph, { profile: 'publish' }).some(d =>
    d.code === 'CONSTRAINT_VIOLATION' && d.entityId === 'a' && d.severity === 'error'));
  graph.graph.entities[0].properties.required = false;
  assert.equal(codes(graph).includes('CONSTRAINT_VIOLATION'), false);
  delete graph.graph.entities[0].properties.required;
  graph.graph.entities[0].properties.condition = { x: 1, y: 3 };
  assert.equal(codes(graph).includes('CONSTRAINT_VIOLATION'), false);
  delete graph.graph.entities[0].properties.condition;
  assert.equal(codes(graph).includes('CONSTRAINT_VIOLATION'), false);
});

test('conditional rules validate shapes, references, and comparison types', () => {
  const graph = fixture();
  graph.ontology.constraints.push({
    id: 'conditional', kind: 'conditional',
    parameters: { classId: 'missing', when: { propertyId: 'unknown', equals: 'x' }, requirePropertyIds: ['missing'] },
  });
  let diagnostics = validateSnapshot(graph);
  for (const path of ['/ontology/constraints/0/parameters/classId', '/ontology/constraints/0/parameters/when/propertyId', '/ontology/constraints/0/parameters/requirePropertyIds/0']) {
    assert.ok(has(diagnostics, 'REFERENCE_NOT_FOUND', path));
  }
  graph.ontology.constraints[0].parameters = {
    classId: 'base', when: { propertyId: 'p', equals: 1 }, requirePropertyIds: ['p'],
  };
  diagnostics = validateSnapshot(graph);
  assert.ok(has(diagnostics, 'INVALID_CONSTRAINT', '/ontology/constraints/0/parameters/when/equals'));
  graph.ontology.constraints[0].parameters.when.equals = 'x';
  graph.ontology.constraints[0].parameters.requirePropertyIds = [];
  assert.ok(codes(graph).includes('INVALID_STRUCTURE'));
  graph.ontology.constraints[0].parameters.requirePropertyIds = ['p'];
  delete graph.ontology.constraints[0].parameters.when.equals;
  assert.ok(codes(graph).includes('INVALID_STRUCTURE'));
});

test('glob patterns match whole inherited string values with bounded work', () => {
  const graph = fixture();
  graph.ontology.constraints.push({
    id: 'pattern', kind: 'pattern', parameters: { classId: 'base', propertyId: 'p', syntax: 'glob', pattern: '00?' },
  });
  assert.equal(codes(graph).includes('CONSTRAINT_VIOLATION'), false);
  graph.ontology.constraints[0].parameters.pattern = '0\\*?';
  graph.graph.entities[0].properties.p = '0*x';
  assert.equal(codes(graph).includes('CONSTRAINT_VIOLATION'), false);
  graph.graph.entities[0].properties.p = '0xx';
  assert.ok(validateSnapshot(graph).some(d => d.code === 'CONSTRAINT_VIOLATION' &&
    d.entityId === 'a' && d.path === '/graph/entities/0/properties/p' && d.severity === 'warning'));
  assert.ok(validateSnapshot(graph, { profile: 'publish' }).some(d =>
    d.code === 'CONSTRAINT_VIOLATION' && d.severity === 'error'));
  graph.ontology.constraints[0].parameters.pattern = '?';
  graph.graph.entities[0].properties.p = '😀';
  assert.equal(codes(graph).includes('CONSTRAINT_VIOLATION'), false);
  graph.graph.entities[0].properties.p = 'xx';
  assert.ok(codes(graph).includes('CONSTRAINT_VIOLATION'));
  delete graph.graph.entities[0].properties.p;
  assert.equal(codes(graph).includes('CONSTRAINT_VIOLATION'), false);
  graph.graph.entities[0].properties.p = 'x'.repeat(10000);
  graph.ontology.constraints[0].parameters.pattern = 'x'.repeat(100);
  assert.ok(validateSnapshot(graph).some(d => d.code === 'RESOURCE_LIMIT_EXCEEDED' && d.severity === 'error'));
});

test('glob constraints reject malformed syntax and incompatible property types', () => {
  const graph = fixture();
  graph.ontology.constraints.push({
    id: 'pattern', kind: 'pattern', parameters: { classId: 'base', propertyId: 'p', syntax: 'glob', pattern: '\\' },
  });
  assert.ok(has(validateSnapshot(graph), 'INVALID_CONSTRAINT', '/ontology/constraints/0/parameters/pattern'));
  graph.ontology.constraints[0].parameters.pattern = '*';
  graph.ontology.propertyDefinitions[0].dataType = 'integer';
  assert.ok(has(validateSnapshot(graph), 'INVALID_CONSTRAINT', '/ontology/constraints/0/parameters/propertyId'));
  graph.ontology.constraints[0].parameters.syntax = 'regex';
  assert.ok(codes(graph).includes('INVALID_STRUCTURE'));
  graph.ontology.constraints[0].parameters.syntax = 'glob';
  graph.ontology.constraints[0].parameters.pattern = 'x'.repeat(257);
  assert.ok(codes(graph).includes('INVALID_STRUCTURE'));
});

test('domain or legacy warnings cannot be published', () => {
  const graph = fixture();
  graph.ontology.relationshipTypes[0].rangeClassIds = ['child'];
  graph.graph.relationships[1].relationshipTypeId = null;
  graph.graph.relationships[1].legacy = { label: '', reason: 'unknown' };
  const draft = validateSnapshot(graph);
  const publish = validateSnapshot(graph, { profile: 'publish' });
  for (const code of ['DOMAIN_RANGE_MISMATCH', 'UNRESOLVED_LEGACY_RELATIONSHIP']) {
    assert.ok(draft.some(d => d.code === code && d.severity === 'warning'), code);
    assert.ok(publish.some(d => d.code === code && d.severity === 'error'), code);
  }
  assert.ok(draft.some(d => d.code === 'VALIDATION_INCOMPLETE' && d.severity === 'warning'));
  assert.ok(publish.some(d => d.code === 'PUBLISH_POLICY_INCOMPLETE' && d.severity === 'error'));
  assert.ok(validateSnapshot(fixture(), { profile: 'publish' }).some(d => d.code === 'PUBLISH_POLICY_INCOMPLETE' && d.severity === 'error'));
});

test('profile options are explicitly validated without invoking accessors', () => {
  let calls = 0;
  const accessor = { get profile() { calls++; return 'draft'; } };
  for (const options of [null, 'draft', {}, { profile: 'other' }, { profile: 'draft', extra: true }, accessor]) {
    assert.ok(validateSnapshot(fixture(), options).some(d => d.code === 'INVALID_PROFILE' && d.severity === 'error'));
  }
  assert.equal(calls, 0);
  assert.equal(codes(fixture()).includes('INVALID_PROFILE'), false);
});

test('unsafe keys and defined property types are checked on both entities and relationships', () => {
  const x = fixture();
  x.graph.entities[0].properties = JSON.parse('{"p":5,"__proto__":{},"bad/key":true}');
  x.graph.relationships[0].properties = { p: false };
  x.metadata = JSON.parse('{"constructor":{}}');
  const result = validateSnapshot(x);
  for (const [code, path] of [
    ['UNSAFE_PROPERTY_KEY', '/graph/entities/0/properties/__proto__'],
    ['UNSAFE_PROPERTY_KEY', '/graph/entities/0/properties/bad~1key'],
    ['UNSAFE_PROPERTY_KEY', '/metadata/constructor'],
    ['INVALID_PROPERTY_VALUE', '/graph/entities/0/properties/p'],
    ['INVALID_PROPERTY_VALUE', '/graph/relationships/0/properties/p']
  ]) assert.ok(has(result, code, path), path);
});

test('typed values include calendar dates, absolute URIs, lists and numeric distinctions', () => {
  const cases = [
    ['integer', 1.5, false], ['integer', 1, true], ['decimal', 1.5, true], ['boolean', 0, false],
    ['date', '2024-02-29', true], ['date', '2023-02-29', false], ['date', '0000-01-01', false],
    ['datetime', '2024-02-29T12:00:00Z', true], ['datetime', '2024-02-30T12:00:00Z', false], ['datetime', '0000-01-01T00:00:00Z', false],
    ['uri', 'relative', false], ['uri', 'https://example.test/a', true],
    ['list', [], true], ['list', {}, false], ['structured', {}, true], ['structured', [], false]
  ];
  for (const [type, value, valid] of cases) {
    const x = fixture();
    x.ontology.propertyDefinitions[0].dataType = type;
    if (type === 'list') x.ontology.propertyDefinitions[0].listItemType = 'string';
    x.graph.entities[0].properties.p = value;
    assert.equal(codes(x).includes('INVALID_PROPERTY_VALUE'), !valid, `${type}: ${JSON.stringify(value)}`);
  }
});

test('provenance validity ranges compare instants and do not imply verification', () => {
  const graph = fixture();
  graph.graph.entities[0].provenance = [{
    sourceId: 'source', confidence: 1, assertedAt: '2024-01-03T00:00:00Z',
    validFrom: '2024-01-01T10:00:00+02:00', validUntil: '2024-01-01T09:00:00Z',
  }];
  graph.graph.relationships[0].provenance = [{
    sourceId: 'source', confidence: 0.9,
    validFrom: '2024-01-01T10:00:00Z', validUntil: '2024-01-01T10:00:00+02:00',
  }];
  const diagnostics = validateSnapshot(graph);
  assert.equal(has(diagnostics, 'INVALID_TEMPORAL_RANGE', '/graph/entities/0/provenance/0/validUntil'), false);
  assert.ok(has(diagnostics, 'INVALID_TEMPORAL_RANGE', '/graph/relationships/0/provenance/0/validUntil'));
  assert.equal(Object.hasOwn(graph.graph.entities[0].provenance[0], 'verifiedAt'), false);
  delete graph.graph.relationships[0].provenance[0].validUntil;
  assert.equal(codes(graph).includes('INVALID_TEMPORAL_RANGE'), false);
  graph.graph.relationships[0].provenance[0].validFrom = '2024-01-01T10:00:00.1234001Z';
  graph.graph.relationships[0].provenance[0].validUntil = '2024-01-01T10:00:00.1234000Z';
  assert.ok(codes(graph).includes('INVALID_TEMPORAL_RANGE'));
  graph.graph.relationships[0].provenance[0].validUntil = '2024-01-01T10:00:00.12340010Z';
  assert.equal(codes(graph).includes('INVALID_TEMPORAL_RANGE'), false);
});

test('enum options and typed list items are enforced for entities and assertions', () => {
  const graph = fixture();
  const property = graph.ontology.propertyDefinitions[0];
  property.dataType = 'enum';
  property.enumValues = ['open', 'closed'];
  graph.graph.entities[0].properties.p = 'open';
  graph.graph.relationships[0].properties.p = 'closed';
  assert.equal(codes(graph).includes('INVALID_PROPERTY_VALUE'), false);
  graph.graph.entities[0].properties.p = 'other';
  graph.graph.relationships[0].properties.p = 5;
  assert.ok(has(validateSnapshot(graph), 'INVALID_PROPERTY_VALUE', '/graph/entities/0/properties/p'));
  assert.ok(has(validateSnapshot(graph), 'INVALID_PROPERTY_VALUE', '/graph/relationships/0/properties/p'));
  property.dataType = 'list';
  property.listItemType = 'enum';
  graph.graph.entities[0].properties.p = ['open', 'closed'];
  graph.graph.relationships[0].properties.p = ['open', 'other'];
  assert.equal(has(validateSnapshot(graph), 'INVALID_PROPERTY_VALUE', '/graph/entities/0/properties/p'), false);
  assert.ok(has(validateSnapshot(graph), 'INVALID_PROPERTY_VALUE', '/graph/relationships/0/properties/p'));
  delete property.enumValues;
  assert.ok(has(validateSnapshot(graph), 'INVALID_STRUCTURE', '/ontology/propertyDefinitions/0/enumValues'));
  property.enumValues = [];
  assert.ok(has(validateSnapshot(graph), 'INVALID_STRUCTURE', '/ontology/propertyDefinitions/0/enumValues'));
  property.enumValues = ['open', 'open'];
  assert.ok(has(validateSnapshot(graph), 'INVALID_STRUCTURE', '/ontology/propertyDefinitions/0/enumValues'));
  property.listItemType = 'integer';
  property.enumValues = ['open'];
  graph.graph.entities[0].properties.p = [1, 2.5];
  assert.ok(has(validateSnapshot(graph), 'INVALID_PROPERTY_VALUE', '/graph/entities/0/properties/p'));
  delete property.listItemType;
  assert.ok(has(validateSnapshot(graph), 'INVALID_STRUCTURE', '/ontology/propertyDefinitions/0/listItemType'));
});

test('depth, size and cyclic input are bounded before structural validation', () => {
  const x = fixture();
  let nested = x.metadata;
  for (let i = 0; i < 70; i++) nested = nested.next = {};
  assert.ok(codes(x).includes('RESOURCE_LIMIT_EXCEEDED'));
  const large = fixture();
  large.metadata.data = 'x'.repeat(5000001);
  assert.ok(codes(large).includes('RESOURCE_LIMIT_EXCEEDED'));
  const cyclic = fixture();
  cyclic.metadata.self = cyclic.metadata;
  assert.ok(codes(cyclic).includes('INVALID_STRUCTURE'));
});

test('diagnostic limits fail closed without losing collected structural or semantic findings', () => {
  const structural = fixture();
  structural.graph.entities = Array.from({ length: 1100 }, (_, i) => ({
    ...structuredClone(structural.graph.entities[0]), id: `e-${i}`, name: 7,
  }));
  const structuralResult = validateSnapshot(structural);
  assert.ok(structuralResult.some(d => d.code === 'RESOURCE_LIMIT_EXCEEDED' && d.severity === 'error'));
  assert.equal(structuralResult.filter(d => d.code === 'INVALID_STRUCTURE').length, 999);
  assert.ok(has(structuralResult, 'INVALID_STRUCTURE', '/graph/entities/0/name'));
  assert.ok(structuralResult.length <= 1001);
  assert.deepEqual(structuralResult, validateSnapshot(structural));

  const semantic = fixture();
  semantic.graph.entities = Array.from({ length: 1100 }, (_, i) => ({
    ...structuredClone(semantic.graph.entities[0]), id: `e-${i}`, classIds: ['missing'],
  }));
  const before = structuredClone(semantic);
  const semanticResult = validateSnapshot(semantic);
  assert.ok(semanticResult.some(d => d.code === 'RESOURCE_LIMIT_EXCEEDED' && d.severity === 'error'));
  assert.ok(semanticResult.some(d => d.code === 'REFERENCE_NOT_FOUND'));
  assert.ok(semanticResult.length <= 1001);
  assert.deepEqual(semantic, before);
  assert.deepEqual(semanticResult, validateSnapshot(semantic));

  const unsafe = Array.from({ length: 1100 }, () => JSON.parse('{"constructor":null}'));
  const preflight = inspectJsonInput(unsafe);
  assert.ok(preflight.some(d => d.code === 'RESOURCE_LIMIT_EXCEEDED' && d.severity === 'error'));
  assert.equal(preflight.filter(d => d.code === 'UNSAFE_PROPERTY_KEY').length, 1000);
  assert.equal(preflight.length, 1001);
});

test('schema alternatives can match after a large failing branch', async () => {
  const source = readFileSync(new URL('../src/domain/validate-v2.js', import.meta.url), 'utf8');
  const schema = JSON.parse(readFileSync(new URL('../../.nodeboard-v2/contracts/snapshot.schema.json', import.meta.url), 'utf8'));
  schema.properties.metadata = {
    anyOf: [
      { type: 'object', additionalProperties: { type: 'string' } },
      { type: 'object' },
    ],
  };
  const moduleSource = source.replace(/^import schema[^\n]*\n/, `const schema = ${JSON.stringify(schema)};\n`);
  const module = await import(`data:text/javascript;base64,${Buffer.from(moduleSource).toString('base64')}`);
  const graph = fixture();
  graph.metadata = Object.fromEntries(Array.from({ length: 1100 }, (_, i) => [`key-${i}`, 0]));
  assert.equal(module.validateSnapshot(graph).some(d => d.severity === 'error'), false);
});

test('input inspection rejects values that JSON serialization would alter', () => {
  const sparse = [1, 2]; delete sparse[0];
  const extra = [1]; extra.extra = true;
  const symbolObject = { [Symbol('hidden')]: true };
  const symbolArray = [1]; symbolArray[Symbol('hidden')] = true;
  const nonEnumerable = {}; Object.defineProperty(nonEnumerable, 'hidden', { value: 1 });
  class Custom { constructor() { this.value = 1; } }
  for (const value of [new Date(), new Map(), new Set(), new Custom(), Object.create(null),
    sparse, extra, symbolObject, symbolArray, nonEnumerable, -0]) {
    const diagnostics = inspectJsonInput({ value });
    assert.ok(diagnostics.some(d => d.code === 'INVALID_STRUCTURE' && d.severity === 'error'));
    const x = fixture(); x.metadata.value = value;
    assert.ok(validateSnapshot(x).some(d => d.code === 'INVALID_STRUCTURE'));
  }
  const dense = { values: [null, 0, true, 'x', { key: 'value' }] };
  assert.deepEqual(inspectJsonInput(dense), []);
  assert.deepEqual(JSON.parse(JSON.stringify(dense)), dense);
});

test('accessor properties are rejected without invoking getters', () => {
  let calls = 0;
  const getter = () => { calls++; throw new Error('must not run'); };
  const object = {}; Object.defineProperty(object, 'hidden', { enumerable: true, get: getter });
  const array = [1]; Object.defineProperty(array, '0', { enumerable: true, get: getter });
  for (const value of [object, array]) {
    assert.ok(inspectJsonInput({ value }).some(d => d.code === 'INVALID_STRUCTURE'));
    const x = fixture(); x.metadata.value = value;
    assert.ok(validateSnapshot(x).some(d => d.code === 'INVALID_STRUCTURE'));
  }
  assert.equal(calls, 0);
});

test('input inspection bounds serialized bytes, including escaped characters and numbers', () => {
  const small = { value: '\n'.repeat(1000), numbers: [1, 2, 3] };
  assert.deepEqual(inspectJsonInput(small), []);
  const escaped = { value: '\n'.repeat(2500000) };
  assert.ok(new TextEncoder().encode(JSON.stringify(escaped)).length > 5000000);
  assert.ok(inspectJsonInput(escaped).some(d => d.code === 'RESOURCE_LIMIT_EXCEEDED'));
  const exact = { value: 'a'.repeat(4999988) };
  assert.equal(new TextEncoder().encode(JSON.stringify(exact)).length, 5000000);
  assert.deepEqual(inspectJsonInput(exact), []);
  exact.value += 'a';
  assert.ok(inspectJsonInput(exact).some(d => d.code === 'RESOURCE_LIMIT_EXCEEDED'));
});

test('unsupported schema keywords and unsupported references fail closed', async () => {
  const source = readFileSync(new URL('../src/domain/validate-v2.js', import.meta.url), 'utf8');
  const schema = JSON.parse(readFileSync(new URL('../../.nodeboard-v2/contracts/snapshot.schema.json', import.meta.url), 'utf8'));
  const variants = [
    draft => { draft.unevaluatedProperties = false; },
    draft => { draft.$defs.entity.properties.name.maxLength = 10; draft.$defs.entity.properties.name.not = { const: 'A' }; },
    draft => { draft.$defs.unused = { type: 'string', minLength: 1, maxLength: 10, format: 'email' }; },
    draft => { draft.$defs.entity.properties.name.$ref = '#/$defs/id'; },
    draft => { draft.$defs.entity.properties.name = { $ref: '#/$defs/loop' }; draft.$defs.loop = { $ref: '#/$defs/loop' }; }
  ];
  for (const modify of variants) {
    const changed = structuredClone(schema);
    modify(changed);
    const moduleSource = source.replace(/^import schema[^\n]*\n/, `const schema = ${JSON.stringify(changed)};\n`);
    const module = await import(`data:text/javascript;base64,${Buffer.from(moduleSource).toString('base64')}`);
    const result = module.validateSnapshot(fixture());
    assert.ok(result.some(d => d.code === 'UNSUPPORTED_SCHEMA' && d.severity === 'error'));
  }
});
