const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

const root = path.resolve(__dirname, '../..');
const app = path.join(root, 'nodeboard-live-starter');
const requireApp = createRequire(path.join(app, 'package.json'));
const { chromium } = requireApp('playwright');
const esbuild = requireApp('esbuild');
const graph = JSON.parse(fs.readFileSync(path.join(root, '.nodeboard-v2/fixtures/v2-draft-valid.json'), 'utf8'));

async function main() {
  const bundle = await esbuild.build({
    entryPoints: [path.join(app, 'src/domain/graph-v2.js')],
    bundle: true,
    format: 'iife',
    globalName: 'nodeboardV2',
    platform: 'browser',
    write: false,
  });
  const validator = await esbuild.build({
    entryPoints: [path.join(app, 'src/domain/validate-v2.js')],
    bundle: true,
    format: 'iife',
    globalName: 'nodeboardValidation',
    platform: 'browser',
    write: false,
  });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setContent('<!doctype html><title>Nodeboard domain smoke test</title>');
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    await page.addScriptTag({ content: validator.outputFiles[0].text });
    const result = await page.evaluate(snapshot => {
      const before = JSON.stringify(snapshot);
      const edge = {
        id: 'browser-edge', from: 'item-b', to: 'item-a', relationshipTypeId: 'rel-support',
        properties: {}, provenance: [], status: 'asserted',
      };
      const batch = { protocolVersion: 2, snapshotVersion: 2, operationId: 'browser-op', baseRevision: 0, operations: [{ type: 'relationship.put', relationship: edge }] };
      const applied = nodeboardV2.applyBatch(snapshot, batch, 0);
      const withInverse = structuredClone(applied.snapshot);
      withInverse.ontology.relationshipTypes[0].inversePredicateId = 'rel-manage';
      const inverse = nodeboardV2.connectionsFor(withInverse, 'item-b').find(
        connection => connection.assertionId === 'edge-a' && connection.derived,
      );
      const ontology = structuredClone(snapshot.ontology);
      Object.assign(ontology.propertyDefinitions[0], {
        dataType: 'list', listItemType: 'enum', enumValues: ['00123', '00456'],
      });
      const entity = structuredClone(snapshot.graph.entities[0]);
      entity.properties['prop-extension'] = ['00123', '00456'];
      const typed = nodeboardV2.applyBatch(snapshot, {
        ...batch,
        operations: [{ type: 'ontology.replace', ontology }, { type: 'entity.put', entity }],
      }, 0);
      const withConstraint = structuredClone(snapshot);
      withConstraint.ontology.constraints.push({
        id: 'required-extension', kind: 'required',
        parameters: { classId: 'class-item', propertyId: 'prop-extension' },
      }, {
        id: 'required-link', kind: 'cardinality',
        parameters: { classId: 'class-item', relationshipTypeId: 'rel-manage', direction: 'out', minimum: 1 },
      });
      const draft = nodeboardValidation.validateSnapshot(withConstraint);
      const publish = nodeboardValidation.validateSnapshot(withConstraint, { profile: 'publish' });
      const withUnique = structuredClone(withConstraint);
      withUnique.ontology.constraints.push({
        id: 'unique-extension', kind: 'uniqueness',
        parameters: { classId: 'class-item', propertyId: 'prop-extension' },
      });
      withUnique.graph.entities[1].properties['prop-extension'] = '00123';
      const uniqueness = nodeboardValidation.validateSnapshot(withUnique);
      const withDisjoint = structuredClone(snapshot);
      withDisjoint.ontology.classes.push({ id: 'class-other', name: 'Other', superclassIds: [], abstract: false, propertyDefinitionIds: [] });
      withDisjoint.ontology.constraints.push({ id: 'disjoint', kind: 'disjointness', parameters: { classIds: ['class-item', 'class-other'] } });
      withDisjoint.graph.entities[0].classIds.push('class-other');
      const disjointness = nodeboardValidation.validateSnapshot(withDisjoint);
      const withAcyclic = structuredClone(applied.snapshot);
      withAcyclic.ontology.constraints.push({ id: 'acyclic', kind: 'acyclic', parameters: { relationshipTypeId: 'rel-support' } });
      const acyclic = nodeboardValidation.validateSnapshot(withAcyclic);
      const withTarget = structuredClone(snapshot);
      withTarget.ontology.classes.push({ id: 'class-other', name: 'Other', superclassIds: [], abstract: false, propertyDefinitionIds: [] });
      withTarget.ontology.constraints.push({
        id: 'target', kind: 'allowedTarget',
        parameters: { classId: 'class-item', relationshipTypeId: 'rel-support', targetClassIds: ['class-other'] },
      });
      const allowedTarget = nodeboardValidation.validateSnapshot(withTarget);
      const withConditional = structuredClone(snapshot);
      withConditional.ontology.propertyDefinitions.push({ id: 'prop-required', name: 'Required', dataType: 'boolean' });
      withConditional.ontology.classes[0].propertyDefinitionIds.push('prop-required');
      withConditional.ontology.constraints.push({
        id: 'conditional', kind: 'conditional',
        parameters: { classId: 'class-item', when: { propertyId: 'prop-extension', equals: '00123' }, requirePropertyIds: ['prop-required'] },
      });
      const conditional = nodeboardValidation.validateSnapshot(withConditional);
      const withPattern = structuredClone(snapshot);
      withPattern.ontology.constraints.push({
        id: 'pattern', kind: 'pattern',
        parameters: { classId: 'class-item', propertyId: 'prop-extension', syntax: 'glob', pattern: '9*' },
      });
      const pattern = nodeboardValidation.validateSnapshot(withPattern);
      const timed = structuredClone(snapshot);
      timed.graph.entities[0].provenance.push({
        sourceId: 'source', confidence: 1,
        validFrom: '2024-01-01T10:00:00.1234001Z', validUntil: '2024-01-01T10:00:00.1234000Z',
      });
      const temporal = nodeboardValidation.validateSnapshot(timed);
      let rejected;
      try {
        nodeboardV2.applyBatch(snapshot, {
          ...batch,
          operations: [{ type: 'relationship.put', relationship: { ...edge, to: 'missing' } }],
        }, 0);
      } catch (error) {
        rejected = error.code;
      }
      return { unchanged: JSON.stringify(snapshot) === before, result: JSON.parse(JSON.stringify(applied)), inverse, typed: typed.snapshot.graph.entities[0].properties['prop-extension'], draft, publish, uniqueness, disjointness, acyclic, allowedTarget, conditional, pattern, temporal, rejected };
    }, graph);
    assert.equal(result.unchanged, true);
    assert.equal(result.result.revision, 1);
    assert.equal(result.result.snapshot.graph.relationships.length, 4);
    assert.equal(result.result.snapshot.graph.relationships[3].id, 'browser-edge');
    assert.deepEqual(result.inverse, { assertionId: 'edge-a', from: 'item-b', to: 'item-a', relationshipTypeId: 'rel-manage', status: 'asserted', derived: true });
    assert.deepEqual(result.typed, ['00123', '00456']);
    assert.ok(result.draft.some(d => d.code === 'CONSTRAINT_VIOLATION' && d.severity === 'warning'));
    assert.ok(result.draft.some(d => d.code === 'CONSTRAINT_VIOLATION' && d.suggestion === 'Review /ontology/constraints/1.'));
    assert.ok(result.publish.some(d => d.code === 'CONSTRAINT_VIOLATION' && d.severity === 'error'));
    assert.ok(result.publish.some(d => d.code === 'PUBLISH_POLICY_INCOMPLETE' && d.severity === 'error'));
    assert.ok(result.uniqueness.some(d => d.code === 'CONSTRAINT_VIOLATION' && d.suggestion === 'Review /ontology/constraints/2 and /graph/entities/0.'));
    assert.ok(result.disjointness.some(d => d.code === 'CONSTRAINT_VIOLATION' && d.path === '/graph/entities/0/classIds'));
    assert.ok(result.acyclic.some(d => d.code === 'CONSTRAINT_VIOLATION' && d.entityId === 'browser-edge'));
    assert.ok(result.allowedTarget.some(d => d.code === 'CONSTRAINT_VIOLATION' && d.entityId === 'edge-a'));
    assert.ok(result.conditional.some(d => d.code === 'CONSTRAINT_VIOLATION' && d.path === '/graph/entities/0/properties/prop-required'));
    assert.ok(result.pattern.some(d => d.code === 'CONSTRAINT_VIOLATION' && d.path === '/graph/entities/0/properties/prop-extension'));
    assert.ok(result.temporal.some(d => d.code === 'INVALID_TEMPORAL_RANGE' && d.severity === 'error'));
    assert.equal(result.rejected, 'INVALID_RESULT');
    assert.deepEqual(errors, []);
    console.log('PASS: v2 domain batch runs in Chromium and preserves the source snapshot');
  } finally {
    await browser.close();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
