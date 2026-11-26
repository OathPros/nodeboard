const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '../..');
const app = path.join(root, 'nodeboard-live-starter');
const requireApp = createRequire(path.join(app, 'package.json'));
const { chromium } = requireApp('playwright');
const { expect } = requireApp('@playwright/test');
const workspaceUrl = pathToFileURL(path.join(app, 'public', 'v2.html')).href;
const classicUrl = pathToFileURL(path.join(app, 'public', 'index.html')).href;
const fixture = fs.readFileSync(path.join(root, '.nodeboard-v2', 'fixtures', 'legacy-valid.json'));

async function ready(page) {
  await page.waitForFunction(() => document.documentElement.dataset.v2Ready === 'true');
}
async function choose(page, selector, name) {
  const choice = page.locator(selector);
  await choice.locator('summary').click();
  await choice.getByRole('button', { name, exact: true }).click();
}
async function downloadBuffer(download) {
  const stream = await download.createReadStream();
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}
async function main() {
  const browser = await chromium.launch({ headless: true });
  let nativeBoard;
  try {
    const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1400, height: 900 } });
    try {
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('dialog', dialog => dialog.accept());
      await page.goto(workspaceUrl);
      await ready(page);
      await page.locator('#board-name').fill('Workspace test');
      await page.getByRole('button', { name: 'Create board' }).click();
      await expect(page.locator('#board-title')).toHaveText('Workspace test');
      await page.locator('#class-name').fill('Service');
      await page.getByRole('button', { name: 'Add class' }).click();
      await expect(page.locator('#classes')).toContainText('Service');
      for (const predicate of ['SUPPORTS', 'MANAGES']) {
        await page.locator('#predicate-name').fill(predicate);
        await page.getByRole('button', { name: 'Add predicate' }).click();
        await expect(page.locator('#predicates')).toContainText(predicate);
      }
      const longName = `Source <img src=x onerror=alert(1)> ${'long'.repeat(35)}`;
      for (const name of [longName, 'Target']) {
        await page.locator('#entity-name').fill(name);
        const field = await page.locator('#entity-name').evaluate(node => ({
          height: node.clientHeight, scrollHeight: node.scrollHeight,
        }));
        assert.ok(field.scrollHeight <= field.height + 1, JSON.stringify(field));
        await page.getByRole('button', { name: 'Add entity' }).click();
        await expect(page.locator('#graph-nodes')).toContainText(name);
      }
      await choose(page, '#relationship-from', longName);
      const summary = page.locator('#relationship-from summary');
      await summary.focus();
      await page.keyboard.press('Enter');
      await expect(page.locator('#relationship-from')).toHaveAttribute('open', '');
      await page.keyboard.press('Tab');
      await expect(page.locator('#relationship-from .choice-options button').first()).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(page.locator('#relationship-from')).not.toHaveAttribute('open', '');
      for (const scheme of ['light', 'dark']) {
        await page.emulateMedia({ colorScheme: scheme });
        await page.setViewportSize({ width: 390, height: 844 });
        const dimensions = await summary.evaluate(node => ({
          width: node.clientWidth, scrollWidth: node.scrollWidth,
          height: node.clientHeight, scrollHeight: node.scrollHeight,
          pageWidth: document.documentElement.clientWidth, pageScrollWidth: document.documentElement.scrollWidth,
        }));
        assert.ok(dimensions.scrollWidth <= dimensions.width + 1, JSON.stringify(dimensions));
        assert.ok(dimensions.scrollHeight <= dimensions.height + 1, JSON.stringify(dimensions));
        assert.ok(dimensions.pageScrollWidth <= dimensions.pageWidth + 1, JSON.stringify(dimensions));
      }
      await page.locator('#entity-search').fill(longName);
      await expect(page.locator('#entity-search-count')).toHaveText('1 entity found.');
      const resultDimensions = await page.locator('#entity-search-results button').evaluate(node => ({
        width: node.clientWidth, scrollWidth: node.scrollWidth, height: node.clientHeight, scrollHeight: node.scrollHeight,
        pageWidth: document.documentElement.clientWidth, pageScrollWidth: document.documentElement.scrollWidth,
      }));
      assert.ok(resultDimensions.scrollWidth <= resultDimensions.width + 1, JSON.stringify(resultDimensions));
      assert.ok(resultDimensions.scrollHeight <= resultDimensions.height + 1, JSON.stringify(resultDimensions));
      assert.ok(resultDimensions.pageScrollWidth <= resultDimensions.pageWidth + 1, JSON.stringify(resultDimensions));
      assert.equal(await page.locator('#entity-search-results img').count(), 0);
      await page.locator('#entity-search').fill('');
      await page.setViewportSize({ width: 1400, height: 900 });
      await choose(page, '#relationship-to', 'Target');
      for (const predicate of ['SUPPORTS', 'MANAGES']) {
        await choose(page, '#relationship-type', predicate);
        await page.getByRole('button', { name: 'Add relationship' }).click();
        await expect(page.locator('#relationships')).toContainText(predicate);
      }
      await expect(page.locator('#graph-lines > path')).toHaveCount(2);
      assert.equal(await page.locator('#graph-nodes img').count(), 0);
      const paths = await page.locator('#graph-lines > path').evaluateAll(nodes => nodes.map(node => node.getAttribute('d')));
      assert.notEqual(paths[0], paths[1]);
      const deleteButtons = page.locator('#relationships button[aria-label^="Delete relationship "]');
      const relationshipIds = await deleteButtons.evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label')));
      await page.locator('#predicates summary').filter({ hasText: 'SUPPORTS' }).click();
      await page.locator('#predicates details[open]').getByLabel('Predicate name', { exact: true }).fill('SUPPORTS renamed');
      await page.getByRole('button', { name: 'Save predicate name' }).click();
      await expect(page.locator('#relationships')).toContainText('SUPPORTS renamed');
      await expect(page.locator('#predicates summary').filter({ hasText: 'SUPPORTS renamed' })).toBeFocused();
      assert.deepEqual(await deleteButtons.evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label'))), relationshipIds);
      await page.locator('#classes summary').filter({ hasText: 'Service' }).click();
      await page.locator('#classes details[open]').getByLabel('Class name', { exact: true }).fill('Renamed service');
      await page.getByRole('button', { name: 'Save class name' }).click();
      await expect(page.locator('#graph-nodes')).toContainText('Renamed service');
      await page.getByRole('button', { name: 'Undo' }).click();
      await expect(page.locator('#graph-nodes')).toContainText('Service');
      await page.getByRole('button', { name: 'Redo' }).click();
      await expect(page.locator('#graph-nodes')).toContainText('Renamed service');
      await page.locator('.graph-node').filter({ hasText: longName }).click();
      await page.setViewportSize({ width: 390, height: 844 });
      const inspector = await page.locator('#inspector > form textarea').evaluate(node => ({
        height: node.clientHeight, scrollHeight: node.scrollHeight,
      }));
      assert.ok(inspector.scrollHeight <= inspector.height + 1, JSON.stringify(inspector));
      await page.setViewportSize({ width: 1400, height: 900 });
      await page.locator('#inspector > form textarea').fill('Renamed source');
      if (process.env.NODEBOARD_V2_SCREENSHOT) await page.screenshot({ path: process.env.NODEBOARD_V2_SCREENSHOT, fullPage: true });
      await page.getByRole('button', { name: 'Save name' }).click();
      await expect(page.locator('#graph-nodes')).toContainText('Renamed source');
      await page.getByRole('button', { name: 'Undo' }).click();
      await expect(page.locator('#graph-nodes')).toContainText(longName);
      await page.getByRole('button', { name: 'Redo' }).click();
      await expect(page.locator('#graph-nodes')).toContainText('Renamed source');
      if (process.env.NODEBOARD_V2_SCREENSHOT) await page.screenshot({ path: process.env.NODEBOARD_V2_SCREENSHOT, fullPage: true });
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(page.locator('#graph-nodes')).toContainText('Renamed source');
      const geometry = await page.locator('.graph-node').first().evaluate(node => ({
        height: node.clientHeight, scrollHeight: node.scrollHeight,
      }));
      assert.ok(geometry.scrollHeight <= geometry.height + 1);
      await page.setViewportSize({ width: 1400, height: 900 });
      await page.locator('.graph-node').filter({ hasText: 'Renamed source' }).click();
      await page.getByRole('button', { name: 'Delete entity' }).click();
      await expect(page.locator('#graph-nodes .graph-node')).toHaveCount(1);
      await expect(page.locator('#relationships li')).toHaveCount(0);
      await page.getByRole('button', { name: 'Undo' }).click();
      await expect(page.locator('#graph-nodes .graph-node')).toHaveCount(2);
      await expect(page.locator('#relationships li')).toHaveCount(2);

      const other = await context.newPage();
      other.on('pageerror', error => errors.push(error.message));
      await other.goto(workspaceUrl);
      await ready(other);
      await other.getByRole('button', { name: 'Workspace test' }).click();
      await expect(other.locator('#board-title')).toHaveText('Workspace test');
      await page.locator('#class-name').fill('New class');
      await page.getByRole('button', { name: 'Add class' }).click();
      await expect(page.locator('#classes')).toContainText('New class');
      await other.locator('#class-name').fill('Stale class');
      await other.getByRole('button', { name: 'Add class' }).click();
      await expect(other.locator('#status')).toContainText('Reload');
      await other.getByRole('button', { name: 'Reload board' }).click();
      await expect(other.locator('#classes')).toContainText('New class');
      assert.equal(await other.locator('#classes').getByText('Stale class').count(), 0);
      await other.close();

      const downloading = page.waitForEvent('download');
      await page.getByRole('button', { name: 'Download backup' }).click();
      const backup = await downloadBuffer(await downloading);
      const exported = JSON.parse(backup.toString());
      assert.equal(exported.format, 'nodeboard-local-backup');
      const renamedPredicate = exported.snapshot.ontology.relationshipTypes.find(item => item.label === 'SUPPORTS renamed');
      assert.equal(renamedPredicate.predicate, 'SUPPORTS');
      assert.ok(exported.snapshot.graph.relationships.some(item => item.relationshipTypeId === renamedPredicate.id));
      const nativeDownload = page.waitForEvent('download');
      await page.getByRole('button', { name: 'Export native board' }).click();
      nativeBoard = await downloadBuffer(await nativeDownload);
      assert.deepEqual(JSON.parse(nativeBoard.toString()), exported.snapshot);
      await page.getByRole('button', { name: 'Boards', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Workspace test' })).toBeVisible();
      await page.locator('#restore-file').setInputFiles({ name: 'backup.json', mimeType: 'application/json', buffer: backup });
      await expect(page.locator('#board-title')).toHaveText('Workspace test');
      await expect(page.locator('#graph-nodes .graph-node')).toHaveCount(2);
      await expect(page.locator('#relationships li')).toHaveCount(2);
      await page.reload();
      await ready(page);
      await expect(page.getByRole('button', { name: 'Workspace test' })).toHaveCount(2);
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }

    const nativeContext = await browser.newContext({ acceptDownloads: true });
    try {
      const page = await nativeContext.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(workspaceUrl);
      await ready(page);
      const file = page.locator('#import-native');
      for (let attempt = 0; attempt < 2; attempt++) {
        await file.setInputFiles({ name: 'broken.json', mimeType: 'application/json', buffer: Buffer.from('{') });
        await expect(page.locator('#status')).toContainText('not valid JSON');
        await expect(file).toHaveValue('');
        await expect(page.locator('#boards button')).toHaveCount(0);
      }
      const invalid = JSON.parse(nativeBoard.toString());
      invalid.graph.relationships[0].to = 'missing-entity';
      await file.setInputFiles({ name: 'invalid.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(invalid)) });
      await expect(page.locator('#status')).toContainText('snapshot is invalid');
      await expect(page.locator('#status')).toContainText('REFERENCE_NOT_FOUND /graph/relationships/0/to');
      await expect(file).toHaveValue('');
      await expect(page.locator('#boards button')).toHaveCount(0);
      await file.setInputFiles({ name: 'board.json', mimeType: 'application/json', buffer: nativeBoard });
      await expect(page.locator('#board-title')).toHaveText('Workspace test');
      await expect(page.locator('#relationships li')).toHaveCount(2);
      const downloading = page.waitForEvent('download');
      await page.getByRole('button', { name: 'Export native board' }).click();
      assert.deepEqual(JSON.parse((await downloadBuffer(await downloading)).toString()), JSON.parse(nativeBoard.toString()));
      await page.locator('#ontology-editor summary').click();
      const editor = page.locator('#ontology-json');
      await expect(editor).not.toHaveValue('');
      const ontology = JSON.parse(await editor.inputValue());
      const classId = ontology.classes[0].id;
      ontology.propertyDefinitions.push({ id: 'test-property', name: 'Owner', dataType: 'string' });
      ontology.propertyDefinitions.push({ id: 'test-count', name: 'Count', dataType: 'integer' });
      ontology.propertyDefinitions.push({ id: 'test-edge', name: 'Confirmed', dataType: 'boolean' });
      ontology.classes[0].propertyDefinitionIds.push('test-property');
      ontology.classes[0].propertyDefinitionIds.push('test-count');
      ontology.constraints.push({ id: 'test-required', kind: 'required', parameters: { classId, propertyId: 'test-property' } });
      await editor.fill(JSON.stringify(ontology, null, 2));
      const revision = await page.locator('#board-revision').textContent();
      await page.getByRole('button', { name: 'Preview ontology changes' }).click();
      await expect(page.locator('#ontology-report')).toContainText('Added Property: test-property');
      await expect(page.locator('#ontology-report')).toContainText('CONSTRAINT_VIOLATION');
      assert.equal(await page.locator('#board-revision').textContent(), revision);
      await page.getByRole('button', { name: 'Apply ontology changes' }).click();
      await expect(page.locator('#diagnostics')).toContainText('Required property');
      await page.getByRole('button', { name: 'Undo' }).click();
      await expect(page.locator('#diagnostics')).not.toContainText('Required property');
      await page.getByRole('button', { name: 'Redo' }).click();
      await expect(page.locator('#diagnostics')).toContainText('Required property');
      await page.locator('.graph-node').filter({ hasText: 'Renamed source' }).click();
      await page.locator('#inspector summary').filter({ hasText: 'Entity properties' }).click();
      const entityProperties = page.getByLabel('Entity properties JSON');
      await entityProperties.fill('{"test-count":"not a number"}');
      const propertyRevision = await page.locator('#board-revision').textContent();
      await page.getByRole('button', { name: 'Save entity properties' }).click();
      await expect(page.locator('#status')).toContainText('INVALID_PROPERTY_VALUE');
      assert.equal(await page.locator('#board-revision').textContent(), propertyRevision);
      await entityProperties.fill('{"test-count":5}');
      await page.getByRole('button', { name: 'Save entity properties' }).click();
      await expect(page.locator('#status')).toContainText('Entity properties saved');
      await expect(page.locator('#inspector summary').filter({ hasText: 'Entity properties' })).toBeFocused();
      const firstRelationship = page.locator('#relationships li').first();
      await firstRelationship.locator('summary').filter({ hasText: 'Relationship properties' }).click();
      await firstRelationship.getByLabel('Relationship properties JSON').fill('{"test-edge":true}');
      await firstRelationship.getByRole('button', { name: 'Save relationship properties' }).click();
      await expect(page.locator('#status')).toContainText('Relationship properties saved');
      await expect(firstRelationship.locator('summary').filter({ hasText: 'Relationship properties' })).toBeFocused();
      await page.getByRole('button', { name: 'Undo' }).click();
      await firstRelationship.locator('summary').filter({ hasText: 'Relationship properties' }).click();
      assert.deepEqual(JSON.parse(await firstRelationship.getByLabel('Relationship properties JSON').inputValue()), {});
      await page.getByRole('button', { name: 'Redo' }).click();
      const propertyDownload = page.waitForEvent('download');
      await page.getByRole('button', { name: 'Export native board' }).click();
      const withProperties = JSON.parse((await downloadBuffer(await propertyDownload)).toString());
      assert.equal(withProperties.graph.entities.find(item => item.name === 'Renamed source').properties['test-count'], 5);
      assert.equal(withProperties.graph.relationships[0].properties['test-edge'], true);
      await firstRelationship.locator('summary').filter({ hasText: 'Relationship status and provenance' }).click();
      await firstRelationship.getByRole('radio', { name: 'proposed' }).check();
      const provenance = firstRelationship.getByLabel('Relationship provenance JSON');
      await provenance.fill(JSON.stringify([{ sourceId: 'source-test', validFrom: '2026-03-01T00:00:00Z', validUntil: '2026-02-01T00:00:00Z' }]));
      const provenanceRevision = await page.locator('#board-revision').textContent();
      await firstRelationship.getByRole('button', { name: 'Save relationship status and provenance' }).click();
      await expect(page.locator('#status')).toContainText('INVALID_TEMPORAL_RANGE');
      assert.equal(await page.locator('#board-revision').textContent(), provenanceRevision);
      await provenance.fill(JSON.stringify([{ sourceId: 'source-test', assertedAt: '2026-03-01T00:00:00Z', confidence: 0.8 }]));
      await firstRelationship.getByRole('button', { name: 'Save relationship status and provenance' }).click();
      await expect(page.locator('#status')).toContainText('Relationship status and provenance saved');
      await expect(firstRelationship.locator('summary').filter({ hasText: 'Relationship status and provenance' })).toBeFocused();
      await expect(firstRelationship).toContainText('(proposed)');
      const provenanceDownload = page.waitForEvent('download');
      await page.getByRole('button', { name: 'Export native board' }).click();
      const withProvenance = JSON.parse((await downloadBuffer(await provenanceDownload)).toString());
      assert.deepEqual(withProvenance.graph.relationships[0].provenance, [{ sourceId: 'source-test', assertedAt: '2026-03-01T00:00:00Z', confidence: 0.8 }]);
      assert.equal(withProvenance.graph.relationships[0].status, 'proposed');
      await page.getByRole('button', { name: 'Undo' }).click();
      await expect(firstRelationship).toContainText('(asserted)');
      await page.getByRole('button', { name: 'Redo' }).click();
      await expect(firstRelationship).toContainText('(proposed)');
      await page.locator('#inspector summary').filter({ hasText: 'Entity status and provenance' }).click();
      await page.getByRole('radio', { name: 'draft', exact: true }).check();
      await page.getByLabel('Entity provenance JSON').fill('[{"sourceId":"entity-source"}]');
      await page.getByRole('button', { name: 'Save entity status and provenance' }).click();
      await expect(page.locator('#status')).toContainText('Entity status and provenance saved');
      await expect(page.locator('#inspector summary').filter({ hasText: 'Entity status and provenance' })).toBeFocused();
      const entityDownload = page.waitForEvent('download');
      await page.getByRole('button', { name: 'Export native board' }).click();
      const withEntityProvenance = JSON.parse((await downloadBuffer(await entityDownload)).toString());
      const savedEntity = withEntityProvenance.graph.entities.find(item => item.name === 'Renamed source');
      assert.equal(savedEntity.status, 'draft');
      assert.deepEqual(savedEntity.provenance, [{ sourceId: 'entity-source' }]);
      assert.equal(savedEntity.properties['test-count'], 5);
      await page.locator('#class-name').fill('Alternative class');
      await page.getByRole('button', { name: 'Add class' }).click();
      await page.locator('#inspector summary').filter({ hasText: 'Entity classes' }).click();
      await page.getByRole('checkbox', { name: 'Renamed service' }).uncheck();
      await page.getByRole('checkbox', { name: 'Alternative class' }).check();
      await page.getByRole('button', { name: 'Save entity classes' }).click();
      await expect(page.locator('#diagnostics')).toContainText('Property is not declared');
      await expect(page.locator('#inspector summary').filter({ hasText: 'Entity classes' })).toBeFocused();
      const classDownload = page.waitForEvent('download');
      await page.getByRole('button', { name: 'Export native board' }).click();
      const withClassChange = JSON.parse((await downloadBuffer(await classDownload)).toString());
      const changedEntity = withClassChange.graph.entities.find(item => item.name === 'Renamed source');
      assert.equal(changedEntity.properties['test-count'], 5);
      assert.deepEqual(changedEntity.classIds, [withClassChange.ontology.classes.find(item => item.name === 'Alternative class').id]);
      assert.equal(withClassChange.graph.relationships.length, 2);
      await page.getByRole('button', { name: 'Undo' }).click();
      await expect(page.locator('#diagnostics')).not.toContainText('Property is not declared');
      await page.getByRole('button', { name: 'Load current ontology' }).click();
      const invalidOntology = JSON.parse(await editor.inputValue());
      invalidOntology.classes = [];
      await editor.fill(JSON.stringify(invalidOntology, null, 2));
      await page.getByRole('button', { name: 'Preview ontology changes' }).click();
      await expect(page.locator('#ontology-report')).toContainText('REFERENCE_NOT_FOUND');
      await expect(page.getByRole('button', { name: 'Apply ontology changes' })).toBeDisabled();
      page.once('dialog', dialog => dialog.accept());
      await page.getByRole('button', { name: 'Load current ontology' }).click();
      const nextOntology = JSON.parse(await editor.inputValue());
      nextOntology.propertyDefinitions.push({ id: 'another-property', name: 'Notes', dataType: 'string' });
      await editor.fill(JSON.stringify(nextOntology, null, 2));
      await page.getByRole('button', { name: 'Preview ontology changes' }).click();
      await expect(page.getByRole('button', { name: 'Apply ontology changes' })).toBeEnabled();
      await page.locator('#class-name').fill('Concurrent class');
      await page.getByRole('button', { name: 'Add class' }).click();
      await expect(page.getByRole('button', { name: 'Apply ontology changes' })).toBeDisabled();
      await page.getByRole('button', { name: 'Preview ontology changes' }).click();
      await expect(page.locator('#status')).toContainText('board changed since the ontology was loaded');
      page.once('dialog', dialog => dialog.accept());
      await page.getByRole('button', { name: 'Load current ontology' }).click();
      const concurrentOntology = JSON.parse(await editor.inputValue());
      concurrentOntology.propertyDefinitions.push({ id: 'concurrent-property', name: 'Concurrent', dataType: 'string' });
      await editor.fill(JSON.stringify(concurrentOntology, null, 2));
      await page.getByRole('button', { name: 'Preview ontology changes' }).click();
      await expect(page.getByRole('button', { name: 'Apply ontology changes' })).toBeEnabled();
      const secondPage = await nativeContext.newPage();
      await secondPage.goto(workspaceUrl);
      await ready(secondPage);
      await secondPage.getByRole('button', { name: 'Workspace test' }).click();
      await secondPage.locator('#class-name').fill('Other tab class');
      await secondPage.getByRole('button', { name: 'Add class' }).click();
      await expect(secondPage.locator('#classes')).toContainText('Other tab class');
      await page.getByRole('button', { name: 'Apply ontology changes' }).click();
      await expect(page.locator('#status')).toContainText('Reload');
      await page.getByRole('button', { name: 'Reload board' }).click();
      await expect(page.locator('#classes')).toContainText('Other tab class');
      page.once('dialog', dialog => dialog.accept());
      await page.getByRole('button', { name: 'Load current ontology' }).click();
      const reloadedOntology = JSON.parse(await editor.inputValue());
      assert.equal(reloadedOntology.propertyDefinitions.some(item => item.id === 'concurrent-property'), false);
      await secondPage.close();
      await page.reload();
      await ready(page);
      await expect(page.locator('#boards button')).toHaveCount(1);
      assert.deepEqual(errors, []);
    } finally {
      await nativeContext.close();
    }

    const navigationContext = await browser.newContext({ acceptDownloads: true });
    try {
      const page = await navigationContext.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      const graph = JSON.parse(fs.readFileSync(path.join(root, '.nodeboard-v2', 'fixtures', 'v2-draft-valid.json'), 'utf8'));
      graph.ontology.relationshipTypes[0].inversePredicateId = 'rel-manage';
      graph.ontology.relationshipTypes[1].symmetric = true;
      graph.graph.relationships[1].properties['prop-extension'] = '00123';
      graph.graph.relationships[1].provenance = [{ sourceId: 'source-fixture', confidence: 0.5 }];
      graph.graph.relationships.push({
        id: 'edge-self', from: 'item-a', to: 'item-a', relationshipTypeId: 'rel-manage',
        properties: {}, provenance: [], status: 'asserted',
      });
      await page.goto(workspaceUrl);
      await ready(page);
      await page.locator('#import-native').setInputFiles({
        name: 'navigation.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(graph)),
      });
      await expect(page.locator('#board-revision')).toHaveText('Revision 0');
      await page.getByRole('button', { name: 'Open relationship edge-unresolved' }).click();
      await expect(page.locator('#relationships li[data-relationship-id="edge-unresolved"]')).toBeFocused();
      const searchRevision = await page.locator('#board-revision').textContent();
      await page.locator('#entity-search').fill('00123');
      await expect(page.locator('#entity-search-count')).toHaveText('1 entity found.');
      await expect(page.locator('#entity-search-results')).toContainText('Example A (item-a)');
      await page.locator('#entity-search').fill('ITEM-B');
      await expect(page.locator('#entity-search-results')).toContainText('Example B (item-b)');
      await page.locator('#entity-search').fill('Item');
      await expect(page.locator('#entity-search-count')).toHaveText('2 entities found.');
      await page.locator('#entity-search').fill('no matching entity');
      await expect(page.locator('#entity-search-count')).toHaveText('0 entities found.');
      await page.locator('#entity-search').fill('item-b');
      await page.locator('#entity-search-results').getByRole('button', { name: 'Example B (item-b)' }).click();
      await expect(page.locator('.graph-node').filter({ hasText: 'Example B' })).toBeFocused();
      assert.equal(await page.locator('#board-revision').textContent(), searchRevision);
      const connections = page.locator('#inspector section').filter({ has: page.getByRole('heading', { name: 'Connections' }) });
      await expect(connections.locator('li')).toHaveCount(5);
      await expect(connections).toContainText('Example B → Manages → Example A (asserted; derived from edge-a)');
      await expect(connections).toContainText('Example B → Manages → Example A (proposed; derived from edge-b)');
      await expect(connections).toContainText('Example B → (unlabeled) → Example A (proposed; stored assertion edge-unresolved)');
      const revision = await page.locator('#board-revision').textContent();
      await connections.getByRole('button', { name: 'Open Example A (item-a)' }).first().click();
      await expect(page.locator('.graph-node').filter({ hasText: 'Example A' })).toBeFocused();
      await expect(page.locator('#inspector')).toContainText('ID: item-a');
      await expect(page.locator('#inspector section li')).toHaveCount(6);
      assert.equal(await page.locator('#board-revision').textContent(), revision);
      const download = page.waitForEvent('download');
      await page.getByRole('button', { name: 'Export native board' }).click();
      assert.deepEqual(JSON.parse((await downloadBuffer(await download)).toString()), graph);
      const unresolved = page.locator('#relationships li[data-relationship-id="edge-unresolved"]');
      await unresolved.getByText('Edit relationship', { exact: true }).click();
      const unresolvedEditor = unresolved.locator('[data-relationship-editor]');
      await expect(unresolvedEditor.locator('summary[aria-label^="Relationship predicate:"]'))
        .toHaveText('Unresolved: (unlabeled)');
      await choose(page, '#relationships li[data-relationship-id="edge-unresolved"] [data-label="Relationship source"]', 'Example A');
      await unresolvedEditor.getByRole('button', { name: 'Save relationship', exact: true }).click();
      await expect(page.locator('#status')).toContainText('Relationship saved.');
      await expect(unresolved.locator('[data-relationship-editor] > summary')).toBeFocused();
      const changedDownload = page.waitForEvent('download');
      await page.getByRole('button', { name: 'Export native board' }).click();
      const changed = JSON.parse((await downloadBuffer(await changedDownload)).toString());
      assert.deepEqual(changed.graph.relationships.find(item => item.id === 'edge-unresolved'),
        { ...graph.graph.relationships.find(item => item.id === 'edge-unresolved'), from: 'item-a' });
      await page.getByRole('button', { name: 'Undo' }).click();
      await expect(page.locator('#relationships li[data-relationship-id="edge-unresolved"]')).toContainText('Example B →');
      const restoredDownload = page.waitForEvent('download');
      await page.getByRole('button', { name: 'Export native board' }).click();
      assert.deepEqual(JSON.parse((await downloadBuffer(await restoredDownload)).toString()), graph);
      await unresolved.getByText('Edit relationship', { exact: true }).click();
      await choose(page, '#relationships li[data-relationship-id="edge-unresolved"] [data-label="Relationship predicate"]', 'Supports');
      await unresolved.getByRole('button', { name: 'Save relationship', exact: true }).click();
      await expect(page.locator('#status')).toContainText('Relationship saved.');
      const resolvedDownload = page.waitForEvent('download');
      await page.getByRole('button', { name: 'Export native board' }).click();
      const newlyResolved = JSON.parse((await downloadBuffer(await resolvedDownload)).toString());
      assert.deepEqual(newlyResolved.graph.relationships.find(item => item.id === 'edge-unresolved'),
        { ...graph.graph.relationships.find(item => item.id === 'edge-unresolved'), relationshipTypeId: 'rel-support' });
      await page.getByRole('button', { name: 'Undo' }).click();
      await expect(unresolved).toContainText('(unlabeled)');
      const resolved = page.locator('#relationships li[data-relationship-id="edge-b"]');
      await resolved.getByText('Edit relationship', { exact: true }).click();
      await choose(page, '#relationships li[data-relationship-id="edge-b"] [data-label="Relationship predicate"]', 'Supports');
      await choose(page, '#relationships li[data-relationship-id="edge-b"] [data-label="Relationship target"]', 'Example A');
      await resolved.getByRole('button', { name: 'Save relationship', exact: true }).click();
      await expect(page.locator('#status')).toContainText('Relationship saved.');
      const changedResolvedDownload = page.waitForEvent('download');
      await page.getByRole('button', { name: 'Export native board' }).click();
      const changedResolved = JSON.parse((await downloadBuffer(await changedResolvedDownload)).toString());
      assert.deepEqual(changedResolved.graph.relationships.find(item => item.id === 'edge-b'),
        { ...graph.graph.relationships.find(item => item.id === 'edge-b'), relationshipTypeId: 'rel-support', to: 'item-a' });
      await page.locator('#class-name').fill('Base class');
      await page.getByRole('button', { name: 'Add class' }).click();
      const base = page.locator('#classes > li').filter({ has: page.getByText('Base class', { exact: true }) });
      await expect(base).toBeVisible();
      const baseId = await base.getAttribute('data-ontology-id');
      const baseHierarchy = base.locator('[data-class-definition-editor]');
      await baseHierarchy.locator('> summary').click();
      await baseHierarchy.getByRole('checkbox', { name: 'Abstract class' }).check();
      await baseHierarchy.getByRole('button', { name: 'Save class hierarchy' }).click();
      await expect(page.locator('#status')).toContainText('Class hierarchy saved.');
      await expect(base.locator('[data-class-definition-editor] > summary')).toBeFocused();
      const itemClass = page.locator('#classes > li[data-ontology-id="class-item"]');
      await itemClass.locator('[data-class-definition-editor] > summary').click();
      let itemHierarchy = itemClass.locator('[data-class-definition-editor]');
      await itemHierarchy.getByRole('checkbox', { name: 'Abstract class' }).check();
      const hierarchyRevision = await page.locator('#board-revision').textContent();
      await itemHierarchy.getByRole('button', { name: 'Save class hierarchy' }).click();
      await expect(page.locator('#status')).toContainText('ABSTRACT_CLASS_INSTANTIATION');
      assert.equal(await page.locator('#board-revision').textContent(), hierarchyRevision);
      await itemHierarchy.getByRole('checkbox', { name: 'Abstract class' }).uncheck();
      await itemHierarchy.getByRole('checkbox', { name: `Base class (${baseId})` }).check();
      await itemHierarchy.getByRole('button', { name: 'Save class hierarchy' }).click();
      await expect(page.locator('#status')).toContainText('Class hierarchy saved.');
      const hierarchyDownload = page.waitForEvent('download');
      await page.getByRole('button', { name: 'Export native board' }).click();
      const hierarchy = JSON.parse((await downloadBuffer(await hierarchyDownload)).toString());
      assert.equal(hierarchy.ontology.classes.find(item => item.id === baseId).abstract, true);
      assert.deepEqual(hierarchy.ontology.classes.find(item => item.id === 'class-item').superclassIds, [baseId]);
      assert.deepEqual(hierarchy.graph, changedResolved.graph);
      await base.locator('[data-class-definition-editor] > summary').click();
      await base.locator('[data-class-definition-editor]').getByRole('checkbox', { name: 'Item (class-item)' }).check();
      await base.locator('[data-class-definition-editor]').getByRole('button', { name: 'Save class hierarchy' }).click();
      await expect(page.locator('#status')).toContainText('INHERITANCE_CYCLE');
      await page.getByRole('button', { name: 'Undo' }).click();
      const hierarchyUndoDownload = page.waitForEvent('download');
      await page.getByRole('button', { name: 'Export native board' }).click();
      const hierarchyUndo = JSON.parse((await downloadBuffer(await hierarchyUndoDownload)).toString());
      assert.deepEqual(hierarchyUndo.ontology.classes.find(item => item.id === 'class-item').superclassIds, []);
      assert.equal(hierarchyUndo.ontology.classes.find(item => item.id === baseId).abstract, true);
      assert.deepEqual(hierarchyUndo.graph, changedResolved.graph);
      const support = page.locator('#predicates > li[data-ontology-id="rel-support"]');
      await support.locator('[data-predicate-definition-editor] > summary').click();
      const predicateDefinition = support.locator('[data-predicate-definition-editor]');
      await choose(page, '#predicates li[data-ontology-id="rel-support"] [data-label="Inverse predicate"]', 'No inverse');
      await predicateDefinition.getByRole('checkbox', { name: 'Symmetric' }).check();
      await predicateDefinition.getByRole('checkbox', { name: 'Transitive' }).check();
      await predicateDefinition.getByRole('group', { name: 'Source classes' }).getByRole('checkbox', { name: 'Item (class-item)' }).check();
      await predicateDefinition.getByRole('group', { name: 'Target classes' }).getByRole('checkbox', { name: 'Item (class-item)' }).check();
      await predicateDefinition.getByRole('button', { name: 'Save predicate definition' }).click();
      await expect(page.locator('#status')).toContainText('Predicate definition saved.');
      await expect(support.locator('[data-predicate-definition-editor] > summary')).toBeFocused();
      const definitionDownload = page.waitForEvent('download');
      await page.getByRole('button', { name: 'Export native board' }).click();
      const definition = JSON.parse((await downloadBuffer(await definitionDownload)).toString());
      assert.deepEqual(definition.ontology.relationshipTypes.find(item => item.id === 'rel-support'), {
        ...graph.ontology.relationshipTypes[0], inversePredicateId: null, symmetric: true, transitive: true,
        domainClassIds: ['class-item'], rangeClassIds: ['class-item'],
      });
      assert.deepEqual(definition.graph, hierarchyUndo.graph);
      await page.locator('.graph-node').filter({ hasText: 'Example B' }).click();
      await expect(page.locator('#inspector')).toContainText('Example B → Supports → Example A (asserted; derived from edge-a)');
      await page.getByRole('button', { name: 'Undo' }).click();
      const definitionUndoDownload = page.waitForEvent('download');
      await page.getByRole('button', { name: 'Export native board' }).click();
      const definitionUndo = JSON.parse((await downloadBuffer(await definitionUndoDownload)).toString());
      assert.deepEqual(definitionUndo, hierarchyUndo);
      await page.locator('#property-name').fill('State');
      await choose(page, '#property-type', 'enum');
      await page.locator('#property-enum-values textarea').first().fill('open');
      await page.getByRole('button', { name: 'Add choice' }).click();
      await page.locator('#property-enum-values textarea').last().fill('closed');
      await page.getByRole('button', { name: 'Add property' }).click();
      await expect(page.locator('#status')).toContainText('Property added.');
      const stateProperty = page.locator('#properties > li').filter({ hasText: 'State (' });
      const stateId = await stateProperty.getAttribute('data-property-id');
      await itemClass.locator('[data-class-definition-editor] > summary').click();
      itemHierarchy = itemClass.locator('[data-class-definition-editor]');
      await itemHierarchy.getByRole('checkbox', { name: `State (${stateId})` }).check();
      await itemHierarchy.getByRole('button', { name: 'Save class hierarchy' }).click();
      await expect(page.locator('#status')).toContainText('Class hierarchy saved.');
      await page.locator('.graph-node').filter({ hasText: 'Example A' }).click();
      await page.locator('#inspector summary').filter({ hasText: 'Entity properties' }).click();
      const guidedValues = page.getByLabel('Entity properties JSON');
      await guidedValues.fill(JSON.stringify({ 'prop-extension': '00123', [stateId]: 'invalid' }));
      const invalidPropertyRevision = await page.locator('#board-revision').textContent();
      await page.getByRole('button', { name: 'Save entity properties' }).click();
      await expect(page.locator('#status')).toContainText('INVALID_PROPERTY_VALUE');
      assert.equal(await page.locator('#board-revision').textContent(), invalidPropertyRevision);
      const stateEditor = page.locator('#inspector [data-property-editor] details').filter({ hasText: `State (${stateId}; enum)` });
      await stateEditor.locator('> summary').click();
      await choose(page, '#inspector [data-label="State value"]', '"closed"');
      await stateEditor.getByRole('button', { name: 'Save State value' }).click();
      await expect(page.locator('#status')).toContainText('Entity properties saved.');
      const propertyCheck = page.waitForEvent('download');
      await page.getByRole('button', { name: 'Export native board' }).click();
      const withGuidedProperty = JSON.parse((await downloadBuffer(await propertyCheck)).toString());
      assert.deepEqual(withGuidedProperty.ontology.propertyDefinitions.find(item => item.id === stateId),
        { id: stateId, name: 'State', dataType: 'enum', enumValues: ['open', 'closed'] });
      assert.ok(withGuidedProperty.ontology.classes.find(item => item.id === 'class-item').propertyDefinitionIds.includes(stateId));
      assert.equal(withGuidedProperty.graph.entities.find(item => item.id === 'item-a').properties[stateId], 'closed');
      assert.equal(withGuidedProperty.graph.entities.find(item => item.id === 'item-a').properties['prop-extension'], '00123');
      await page.locator('#inspector [data-property-editor] > summary').click();
      await stateEditor.locator('> summary').click();
      await stateEditor.getByRole('button', { name: 'Remove State value' }).click();
      await expect(page.locator('#status')).toContainText('Entity properties saved.');
      const removalDownload = page.waitForEvent('download');
      await page.getByRole('button', { name: 'Export native board' }).click();
      const removedState = JSON.parse((await downloadBuffer(await removalDownload)).toString());
      assert.equal(Object.hasOwn(removedState.graph.entities.find(item => item.id === 'item-a').properties, stateId), false);
      assert.equal(removedState.graph.entities.find(item => item.id === 'item-a').properties['prop-extension'], '00123');
      await page.getByRole('button', { name: 'Undo' }).click();
      const valueUndoDownload = page.waitForEvent('download');
      await page.getByRole('button', { name: 'Export native board' }).click();
      assert.deepEqual(JSON.parse((await downloadBuffer(await valueUndoDownload)).toString()), withGuidedProperty);
      await page.locator('#property-name').fill('Flags');
      await choose(page, '#property-type', 'list');
      await choose(page, '#property-item-type', 'enum');
      await page.locator('#property-enum-values textarea').first().fill('same');
      await page.getByRole('button', { name: 'Add choice' }).click();
      await page.locator('#property-enum-values textarea').last().fill('same');
      await page.getByRole('button', { name: 'Remove choice 1' }).click();
      await expect(page.getByRole('button', { name: 'Add choice' })).toBeFocused();
      await expect(page.getByLabel('Choice 1', { exact: true })).toHaveValue('same');
      await page.getByRole('button', { name: 'Add choice' }).click();
      await page.getByLabel('Choice 2', { exact: true }).fill('same');
      const duplicateRevision = await page.locator('#board-revision').textContent();
      await page.getByRole('button', { name: 'Add property' }).click();
      await expect(page.locator('#status')).toContainText('INVALID_STRUCTURE');
      assert.equal(await page.locator('#board-revision').textContent(), duplicateRevision);
      await page.locator('#property-enum-values textarea').last().fill('different');
      await page.getByRole('button', { name: 'Add property' }).click();
      await expect(page.locator('#status')).toContainText('Property added.');
      const flagsId = await page.locator('#properties > li').filter({ hasText: 'Flags (' }).getAttribute('data-property-id');
      const listDownload = page.waitForEvent('download');
      await page.getByRole('button', { name: 'Export native board' }).click();
      const listProperty = JSON.parse((await downloadBuffer(await listDownload)).toString())
        .ontology.propertyDefinitions.find(item => item.id === flagsId);
      assert.deepEqual(listProperty, { id: flagsId, name: 'Flags', dataType: 'list', listItemType: 'enum', enumValues: ['same', 'different'] });
      await resolved.locator('summary').filter({ hasText: 'Relationship properties' }).click();
      const flagsEditor = resolved.locator('[data-property-editor] details').filter({ hasText: `Flags (${flagsId}; list of enum)` });
      await flagsEditor.locator('> summary').click();
      await flagsEditor.getByLabel('Flags value').fill('["same","different"]');
      await flagsEditor.getByRole('button', { name: 'Save Flags value' }).click();
      await expect(page.locator('#status')).toContainText('Relationship properties saved.');
      const flagsValueDownload = page.waitForEvent('download');
      await page.getByRole('button', { name: 'Export native board' }).click();
      const flagsValue = JSON.parse((await downloadBuffer(await flagsValueDownload)).toString())
        .graph.relationships.find(item => item.id === 'edge-b');
      assert.deepEqual(flagsValue.properties, { 'prop-extension': '00123', [flagsId]: ['same', 'different'] });
      assert.deepEqual(flagsValue.provenance, [{ sourceId: 'source-fixture', confidence: 0.5 }]);
      assert.equal(flagsValue.status, 'proposed');
      await page.locator('#property-name').fill('Review');
      await choose(page, '#property-type', 'boolean');
      await page.getByRole('button', { name: 'Add property' }).click();
      await expect(page.locator('#status')).toContainText('Property added.');
      const reviewId = await page.locator('#properties > li').filter({ hasText: 'Review (' }).getAttribute('data-property-id');
      await resolved.locator('summary').filter({ hasText: 'Relationship properties' }).click();
      const reviewEditor = resolved.locator('[data-property-editor] details').filter({ hasText: `Review (${reviewId}; boolean)` });
      await reviewEditor.locator('> summary').click();
      await expect(reviewEditor.getByRole('checkbox', { name: 'Review value' })).not.toBeChecked();
      await reviewEditor.getByRole('button', { name: 'Save Review value' }).click();
      await expect(page.locator('#status')).toContainText('Relationship properties saved.');
      const booleanDownload = page.waitForEvent('download');
      await page.getByRole('button', { name: 'Export native board' }).click();
      const reviewed = JSON.parse((await downloadBuffer(await booleanDownload)).toString())
        .graph.relationships.find(item => item.id === 'edge-b');
      assert.equal(reviewed.properties[reviewId], false);
      assert.deepEqual(reviewed.provenance, flagsValue.provenance);
      assert.equal(reviewed.status, flagsValue.status);
      await choose(page, '#required-class', 'Item (class-item)');
      await choose(page, '#required-property', `State (${stateId})`);
      await page.getByRole('button', { name: 'Require property' }).click();
      await expect(page.locator('#status')).toContainText('Required property added.');
      await expect(page.locator('#diagnostics')).toContainText('Required property');
      await page.getByRole('button', { name: 'Open entity Example B (item-b)' }).click();
      await expect(page.locator('.graph-node').filter({ hasText: 'Example B' })).toBeFocused();
      await expect(page.locator('#inspector')).toContainText('ID: item-b');
      const requiredEntry = page.locator('#constraints > li').filter({ hasText: 'Item requires State' });
      const requiredId = await requiredEntry.getAttribute('data-constraint-id');
      const constraintRevision = await page.locator('#board-revision').textContent();
      await page.getByRole('button', { name: 'Require property' }).click();
      await expect(page.locator('#status')).toContainText('already requires');
      assert.equal(await page.locator('#board-revision').textContent(), constraintRevision);
      const constraintDownload = page.waitForEvent('download');
      await page.getByRole('button', { name: 'Export native board' }).click();
      const constrained = JSON.parse((await downloadBuffer(await constraintDownload)).toString());
      assert.deepEqual(constrained.ontology.constraints.find(item => item.id === requiredId),
        { id: requiredId, kind: 'required', parameters: { classId: 'class-item', propertyId: stateId } });
      assert.deepEqual(constrained.graph.relationships.find(item => item.id === 'edge-b'), reviewed);
      await page.getByRole('button', { name: 'Undo' }).click();
      await expect(page.locator('#diagnostics')).not.toContainText('Required property');
      await page.getByRole('button', { name: 'Redo' }).click();
      await expect(page.locator('#diagnostics')).toContainText('Required property');
      page.once('dialog', dialog => dialog.accept());
      await page.getByRole('button', { name: `Remove constraint ${requiredId}` }).click();
      await expect(page.locator('#diagnostics')).not.toContainText('Required property');
      const beforeConnectedDownload = page.waitForEvent('download');
      await page.getByRole('button', { name: 'Export native board' }).click();
      const beforeConnected = JSON.parse((await downloadBuffer(await beforeConnectedDownload)).toString());
      await page.locator('#inspector [data-connected-entity] > summary').click();
      await page.getByLabel('New entity name').fill('Connected example');
      await choose(page, '#inspector [data-label="New entity class"]', 'Item (class-item)');
      await choose(page, '#inspector [data-label="Connecting predicate"]', 'Supports (rel-support)');
      await page.getByRole('button', { name: 'Create connected entity' }).click();
      await expect(page.locator('#status')).toContainText('Connected entity added.');
      await expect(page.locator('.graph-node').filter({ hasText: 'Connected example' })).toBeFocused();
      const connectedDownload = page.waitForEvent('download');
      await page.getByRole('button', { name: 'Export native board' }).click();
      const connected = JSON.parse((await downloadBuffer(await connectedDownload)).toString());
      const addedEntity = connected.graph.entities.find(item => item.name === 'Connected example');
      const addedRelationship = connected.graph.relationships.find(item => item.to === addedEntity.id);
      assert.deepEqual(addedEntity.classIds, ['class-item']);
      assert.equal(addedRelationship.from, 'item-b');
      assert.equal(addedRelationship.relationshipTypeId, 'rel-support');
      assert.equal(addedRelationship.status, 'asserted');
      assert.deepEqual(connected.graph.entities.slice(0, -1), beforeConnected.graph.entities);
      assert.deepEqual(connected.graph.relationships.slice(0, -1), beforeConnected.graph.relationships);
      assert.ok(connected.views[0].entityIds.includes(addedEntity.id));
      await page.getByRole('button', { name: 'Undo' }).click();
      await expect(page.locator('#graph-nodes')).not.toContainText('Connected example');
      const connectedUndoDownload = page.waitForEvent('download');
      await page.getByRole('button', { name: 'Export native board' }).click();
      assert.deepEqual(JSON.parse((await downloadBuffer(await connectedUndoDownload)).toString()), beforeConnected);
      await page.getByRole('button', { name: 'Redo' }).click();
      await expect(page.locator('#graph-nodes')).toContainText('Connected example');
      await page.locator('#view-name').fill('Focused view');
      await page.getByRole('button', { name: 'Save current view' }).click();
      await expect(page.locator('#status')).toContainText('View saved.');
      const newViewDownload = page.waitForEvent('download');
      await page.getByRole('button', { name: 'Export native board' }).click();
      const newViewSnapshot = JSON.parse((await downloadBuffer(await newViewDownload)).toString());
      const focusedView = newViewSnapshot.views.find(view => view.name === 'Focused view');
      assert.deepEqual(newViewSnapshot.graph, connected.graph);
      assert.deepEqual(focusedView.entityIds, connected.graph.entities.map(entity => entity.id));
      await page.locator('#view-management > details > summary').click();
      await page.locator('#view-management').getByRole('checkbox', { name: 'Example A (item-a)' }).uncheck();
      await page.getByRole('button', { name: 'Save view membership' }).click();
      await expect(page.locator('#status')).toContainText('View membership saved.');
      await expect(page.locator('#graph-nodes')).not.toContainText('Example A');
      await expect(page.locator('#graph-nodes')).toContainText('Example B');
      const focusedDownload = page.waitForEvent('download');
      await page.getByRole('button', { name: 'Export native board' }).click();
      const focusedSnapshot = JSON.parse((await downloadBuffer(await focusedDownload)).toString());
      assert.deepEqual(focusedSnapshot.graph, connected.graph);
      assert.deepEqual(focusedSnapshot.views.filter(view => view.id !== focusedView.id),
        connected.views);
      assert.deepEqual(focusedSnapshot.views.find(view => view.id === focusedView.id).entityIds,
        focusedView.entityIds.filter(entityId => entityId !== 'item-a'));
      await page.getByRole('button', { name: 'Undo' }).click();
      await expect(page.locator('#graph-nodes')).toContainText('Example A');
      await page.locator('.graph-node').filter({ hasText: 'Example A' }).click();
      await page.getByRole('button', { name: 'Redo' }).click();
      await expect(page.locator('#graph-nodes')).not.toContainText('Example A');
      await expect(page.locator('#inspector')).toContainText('Select an entity');
      await page.locator('.graph-node').filter({ hasText: 'Example B' }).click();
      await page.locator('#inspector [data-connected-entity] > summary').click();
      await page.getByLabel('New entity name').fill('View child');
      await choose(page, '#inspector [data-label="Connecting predicate"]', 'Supports (rel-support)');
      await page.getByRole('button', { name: 'Create connected entity' }).click();
      await expect(page.locator('#graph-nodes')).toContainText('View child');
      const childDownload = page.waitForEvent('download');
      await page.getByRole('button', { name: 'Export native board' }).click();
      const withChild = JSON.parse((await downloadBuffer(await childDownload)).toString());
      const childId = withChild.graph.entities.find(entity => entity.name === 'View child').id;
      assert.ok(withChild.views.find(view => view.id === focusedView.id).entityIds.includes(childId));
      assert.deepEqual(withChild.views.filter(view => view.id !== focusedView.id), connected.views);
      await page.getByRole('button', { name: 'Undo' }).click();
      await expect(page.locator('#graph-nodes')).not.toContainText('View child');
      await page.locator('#entity-search').fill('item-a');
      await page.locator('#entity-search-results').getByRole('button', { name: 'Example A (item-a)' }).click();
      await expect(page.locator('.graph-node').filter({ hasText: 'Example A' })).toBeFocused();
      await expect(page.locator('#view-choice summary')).toContainText('All entities');
      await choose(page, '#view-choice', `Focused view (${focusedView.id}; shared)`);
      page.once('dialog', dialog => dialog.accept());
      await page.getByRole('button', { name: 'Delete view' }).click();
      await expect(page.locator('#status')).toContainText('View deleted.');
      await expect(page.locator('#graph-nodes')).toContainText('Example A');
      await page.getByRole('button', { name: 'Undo' }).click();
      await choose(page, '#view-choice', `Focused view (${focusedView.id}; shared)`);
      await expect(page.locator('#graph-nodes')).not.toContainText('Example A');
      const collisionPage = await navigationContext.newPage();
      await collisionPage.goto(workspaceUrl);
      await ready(collisionPage);
      const collisionGraph = structuredClone(graph);
      collisionGraph.graph.entities.push({ ...structuredClone(graph.graph.entities[0]), id: 'edge-unresolved', name: 'ID collision' });
      await collisionPage.locator('#import-native').setInputFiles({
        name: 'collision.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(collisionGraph)),
      });
      await expect(collisionPage.locator('#board-revision')).toHaveText('Revision 0');
      await collisionPage.getByRole('button', { name: 'Open relationship edge-unresolved' }).click();
      await expect(collisionPage.locator('#relationships li[data-relationship-id="edge-unresolved"]')).toBeFocused();
      await collisionPage.close();
      const inferencePage = await navigationContext.newPage();
      await inferencePage.setViewportSize({ width: 390, height: 844 });
      await inferencePage.goto(workspaceUrl);
      await ready(inferencePage);
      const inferenceGraph = structuredClone(graph);
      inferenceGraph.ontology.relationshipTypes[0].transitive = true;
      inferenceGraph.graph.entities.push({ ...structuredClone(inferenceGraph.graph.entities[1]), id: 'item-c', name: 'Example C' });
      inferenceGraph.graph.relationships.push(
        { id: 'edge-bc', from: 'item-b', to: 'item-c', relationshipTypeId: 'rel-support', properties: {}, provenance: [], status: 'asserted' },
        { id: 'edge-bc-second', from: 'item-b', to: 'item-c', relationshipTypeId: 'rel-support', properties: {}, provenance: [], status: 'asserted' },
        { id: 'edge-ca-proposed', from: 'item-c', to: 'item-a', relationshipTypeId: 'rel-support', properties: {}, provenance: [], status: 'proposed' },
      );
      await inferencePage.locator('#import-native').setInputFiles({
        name: 'inference.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(inferenceGraph)),
      });
      await inferencePage.locator('.graph-node').filter({ hasText: 'Example A' }).click();
      const explorer = inferencePage.locator('#inspector details').filter({ hasText: 'Explore transitive paths' });
      await explorer.locator('> summary').click();
      await explorer.getByRole('button', { name: 'Find transitive paths' }).click();
      await expect(explorer).toContainText('2 derived paths');
      await expect(explorer).toContainText('Example A (item-a) → Example B (item-b) → Example C (item-c)');
      await explorer.getByRole('button', { name: 'Open assertion edge-bc-second' }).click();
      await expect(inferencePage.locator('#relationships li[data-relationship-id="edge-bc-second"]')).toBeFocused();
      await explorer.getByRole('button', { name: 'Open Example C (item-c)' }).first().click();
      await expect(inferencePage.locator('.graph-node').filter({ hasText: 'Example C' })).toBeFocused();
      assert.equal(await inferencePage.locator('#board-revision').textContent(), 'Revision 0');
      const inferenceDownload = inferencePage.waitForEvent('download');
      await inferencePage.getByRole('button', { name: 'Export native board' }).click();
      assert.deepEqual(JSON.parse((await downloadBuffer(await inferenceDownload)).toString()), inferenceGraph);
      assert.equal(await inferencePage.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await inferencePage.close();
      assert.deepEqual(errors, []);
    } finally {
      await navigationContext.close();
    }

    const migrationContext = await browser.newContext();
    try {
      const page = await migrationContext.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('dialog', dialog => dialog.accept());
      await page.goto(classicUrl);
      await page.locator('#localFile').setInputFiles({ name: 'source.json', mimeType: 'application/json', buffer: fixture });
      await page.waitForFunction(() => JSON.parse(localStorage.getItem('nodeboard-v1.1')).nodes.some(node => node.id === 'demo-offering'));
      const source = await page.evaluate(() => localStorage.getItem('nodeboard-v1.1'));
      await page.goto(workspaceUrl);
      await ready(page);
      await page.getByRole('button', { name: 'Preview classic board import' }).click();
      await expect(page.getByRole('button', { name: 'Import as new board' })).toBeVisible();
      await page.getByRole('button', { name: 'Import as new board' }).click();
      await expect(page.locator('#graph-nodes')).toContainText('Offering');
      assert.equal(await page.evaluate(() => localStorage.getItem('nodeboard-v1.1')), source);
      await page.reload();
      await ready(page);
      await expect(page.locator('#boards button')).toHaveCount(1);
      assert.deepEqual(errors, []);
    } finally {
      await migrationContext.close();
    }
    console.log('PASS: isolated v2 workspace creation, editing, history, conflicts, backup, native round-trip and v1 import');
  } finally {
    await browser.close();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
