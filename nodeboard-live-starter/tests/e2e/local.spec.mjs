import { test, expect } from '@playwright/test';

const localGraph = page => page.evaluate(() => JSON.parse(localStorage.getItem('nodeboard-v1.1')));

test.beforeEach(async ({ page }) => {
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.errors = errors;
  await page.goto('/');
  await expect(page.locator('#liveStatus')).toContainText('Local board');
});

test.afterEach(async ({ page }) => {
  expect(page.errors, 'no uncaught page errors').toEqual([]);
});

test('sample graph renders and persists locally', async ({ page }) => {
  await expect(page.locator('#scene .node')).toHaveCount(5);
  await expect(page.locator('#scene .edge')).toHaveCount(4);
  await expect(page.locator('#stats')).toContainText('5 nodes · 4 connections');
  const g = await localGraph(page);
  expect(g.nodes).toHaveLength(5);
  expect(g.classes.length).toBeGreaterThanOrEqual(7);
});

test('bulk JSON editing validates atomically and updates changed relationship templates', async ({ page }) => {
  const original = await localGraph(page);
  await page.locator('#editClasses').click();
  await page.locator('#bulkClasses').click();
  const input = page.locator('#bulkJson');
  const classes = JSON.parse(await input.inputValue());
  expect(classes).toEqual(original.classes);
  await input.fill('{broken');
  await page.locator('#applyBulk').click();
  await expect(page.locator('#bulkFeedback')).toContainText('Invalid JSON');
  expect(await localGraph(page)).toEqual(original);
  await input.fill(JSON.stringify(classes.slice(1).map((c, i) => ({ ...c, key: i + 1 }))));
  await page.locator('#applyBulk').click();
  await expect(page.locator('#bulkFeedback')).toContainText('existing nodes use it');
  expect(await localGraph(page)).toEqual(original);
  classes[0].name = 'Service updated';
  classes[0].relations = [{ to: classes[1].id, label: 'OFFERS', inverse: 'OFFERED_BY' }];
  await input.fill(JSON.stringify(classes));
  page.once('dialog', dialog => dialog.accept());
  await page.locator('#applyBulk').click();
  await expect(page.locator('#modalBackdrop')).toBeVisible();
  let graph = await localGraph(page);
  expect(graph.classes[0].name).toBe('Service updated');
  expect(graph.edges.find(e => e.id === 'e1').label).toBe('OFFERS');
  expect(graph.edges.filter(e => e.from === 'n2' && e.to === 'n1').map(e => e.label)).toEqual(['OFFERED_BY']);
  await page.locator('#closeClasses').click();
  await page.locator('#undoBtn').click();
  graph = await localGraph(page);
  expect(graph).toEqual(original);
});

test('board JSON view validates replacement and supports local undo', async ({ page }) => {
  const original = await localGraph(page);
  await page.locator('#jsonViewBtn').click();
  const input = page.locator('#graphJson');
  const board = JSON.parse(await input.inputValue());
  expect(board.nodes).toEqual(original.nodes);
  await input.fill('not json');
  await page.locator('#applyGraphJson').click();
  await expect(page.locator('#graphJsonFeedback')).toContainText('Invalid JSON');
  expect(await localGraph(page)).toEqual(original);
  board.edges[0].to = 'missing';
  await input.fill(JSON.stringify(board));
  await page.locator('#applyGraphJson').click();
  await expect(page.locator('#graphJsonFeedback')).toContainText('Invalid connection');
  expect(await localGraph(page)).toEqual(original);
  board.edges[0].to = 'n2';
  board.nodes[0].name = 'JSON edited';
  await input.fill(JSON.stringify(board));
  page.once('dialog', dialog => dialog.accept());
  await page.locator('#applyGraphJson').click();
  await expect(page.locator('#scene')).toContainText('JSON edited');
  await page.locator('#undoBtn').click();
  expect(await localGraph(page)).toEqual(original);
});

test('double-click creates a connected node with inline naming', async ({ page }) => {
  await page.locator('#canvas').dblclick({ position: { x: 760, y: 615 } });
  await expect(page.locator('#quickedit')).toBeVisible();
  await expect(page.locator('#nodeNameInput')).toBeFocused();
  await page.keyboard.type('Test Node');
  await page.keyboard.press('Enter');
  await expect(page.locator('#relationshipInput')).toBeFocused();
  await page.keyboard.type('DEPENDS_ON');
  await page.keyboard.press('Enter');
  await expect(page.locator('#quickedit')).toBeHidden();
  await expect(page.locator('#scene')).toContainText('Test Node');
  await expect(page.locator('#scene')).toContainText('DEPENDS_ON');
  const g = await localGraph(page);
  expect(g.nodes).toHaveLength(6);
  expect(g.edges).toHaveLength(5);
  expect(g.edges.at(-1).label).toBe('DEPENDS_ON');
});

test('number shortcut reclasses the selected node', async ({ page }) => {
  await page.locator('#scene .node').first().click();
  await page.keyboard.press('2');
  const g = await localGraph(page);
  const first = g.nodes.find(n => n.name === 'Email & Calendaring');
  expect(first.classId).toBe('cls-offering');
  await expect(page.locator('#scene')).toContainText('OFFERING');
});

test('drag repositions a node', async ({ page }) => {
  const node = page.locator('#scene .node').first();
  const box = await node.boundingBox();
  const before = (await localGraph(page)).nodes.find(n => n.id === 'n1');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 90, box.y + box.height / 2 + 60, { steps: 6 });
  await page.mouse.up();
  const after = (await localGraph(page)).nodes.find(n => n.id === 'n1');
  expect(Math.abs(after.x - before.x)).toBeGreaterThan(20);
  expect(Math.abs(after.y - before.y)).toBeGreaterThan(10);
});

test('right-click context menu renames a node', async ({ page }) => {
  await page.locator('#scene .node').first().click({ button: 'right' });
  await expect(page.locator('#context')).toBeVisible();
  await page.locator('#ctxLabel').fill('Renamed Service');
  await page.keyboard.press('Enter');
  await expect(page.locator('#scene')).toContainText('Renamed Service');
  const g = await localGraph(page);
  expect(g.nodes.find(n => n.id === 'n1').name).toBe('Renamed Service');
});

test('undo/redo work in local mode', async ({ page }) => {
  await page.locator('#canvas').dblclick({ position: { x: 760, y: 615 } });
  await page.keyboard.type('Temp');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Escape');
  await expect(page.locator('#scene .node')).toHaveCount(6);
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+z');
  await expect(page.locator('#scene .node')).toHaveCount(5);
  await page.keyboard.press('Control+y');
  await page.keyboard.press('Control+y');
  await expect(page.locator('#scene .node')).toHaveCount(6);
});

test('class modal: add class, duplicate style warning and override', async ({ page }) => {
  await page.locator('#editClasses').click();
  await expect(page.locator('#modalBackdrop')).toBeVisible();
  await page.locator('#addClass').click();
  const g1 = await localGraph(page);
  expect(g1.classes).toHaveLength(8);
  // Force class 8 to the same shape+colour as class 1 -> warning appears
  await page.locator('[data-modal-class="8"] select').selectOption('rounded');
  await page.locator('[data-modal-class="8"] input[type=color]').evaluate(el => {
    el.value = '#e05a72';
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await expect(page.locator('[data-modal-class="8"] .class-collision')).toBeVisible();
  await page.locator('[data-modal-class="8"] .class-collision .approve').click();
  const g2 = await localGraph(page);
  expect(g2.classes[7].shape).toBe('rounded');
  expect(g2.classes[7].color.toLowerCase()).toBe('#e05a72');
  // Escape closes the modal
  await page.keyboard.press('Escape');
  await expect(page.locator('#modalBackdrop')).toBeHidden();
});

test('class jump: 0 then number selects classes beyond 9', async ({ page }) => {
  await page.locator('#editClasses').click();
  for (let i = 0; i < 4; i++) await page.locator('#addClass').click();
  await page.keyboard.press('Escape');
  await page.locator('#scene .node').first().click();
  await page.keyboard.press('0');
  await expect(page.locator('#classJump')).toBeVisible();
  await page.locator('#classJumpInput').fill('11');
  await page.keyboard.press('Enter');
  const g = await localGraph(page);
  const cls11 = g.classes.find(c => c.key === 11);
  expect(g.nodes.find(n => n.id === 'n1').classId).toBe(cls11.id);
});

test('JSON export produces a valid editable graph', async ({ page }) => {
  await page.locator('#exportBtn').click();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('[data-export="json"]').click(),
  ]);
  const path = await download.path();
  const { readFileSync } = await import('node:fs');
  const g = JSON.parse(readFileSync(path, 'utf8'));
  expect(g.format).toBe('nodeboard');
  expect(g.nodes).toHaveLength(5);
  expect(g.edges).toHaveLength(4);
  expect(g.classes.length).toBeGreaterThanOrEqual(7);
});

test('legacy numeric-class JSON is migrated to stable class ids', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('nodeboard-v1.1', JSON.stringify({
      classes: [{ key: 1, name: 'Service', shape: 'rounded', color: '#e05a72' }, { key: 2, name: 'Team', shape: 'rectangle', color: '#38a99c' }],
      nodes: [{ id: 'n1', x: 0, y: 0, name: 'Legacy A', classId: 1 }, { id: 'n2', x: 200, y: 0, name: 'Legacy B', classId: 2 }],
      edges: [{ id: 'e1', from: 'n1', to: 'n2', label: 'X' }],
    }));
  });
  await page.goto('/');
  await expect(page.locator('#scene')).toContainText('Legacy A');
  const g = await localGraph(page);
  expect(g.classes.every(c => typeof c.id === 'string' && c.id.length > 0)).toBe(true);
  const ids = new Set(g.classes.map(c => c.id));
  expect(g.nodes.every(n => ids.has(n.classId))).toBe(true);
  // keys stay sequential for shortcuts
  expect(g.classes.map(c => c.key)).toEqual([1, 2]);
});

test('local graph persists across reload', async ({ page }) => {
  await page.locator('#canvas').dblclick({ position: { x: 760, y: 615 } });
  await page.keyboard.type('Persistent');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Escape');
  await page.reload();
  await expect(page.locator('#scene')).toContainText('Persistent');
  await expect(page.locator('#scene .node')).toHaveCount(6);
});

test('double-click edits existing node and click or tab away saves without Enter', async ({ page }) => {
  await page.locator('[data-node-id="n1"]').dblclick();
  await expect(page.locator('#quickedit')).toBeVisible();
  await expect(page.locator('#nodeNameInput')).toHaveValue('Email & Calendaring');
  await page.locator('#nodeNameInput').fill('Edited on blur');
  await page.locator('#zoomIn').click();
  await expect(page.locator('#quickedit')).toBeHidden();
  expect((await localGraph(page)).nodes.find(n => n.id === 'n1').name).toBe('Edited on blur');
  expect((await localGraph(page)).nodes).toHaveLength(5);
  await page.locator('[data-node-id="n1"]').dblclick();
  await page.locator('#nodeNameInput').fill('Edited on tab');
  await page.keyboard.press('Tab');
  await expect(page.locator('#quickedit')).toBeHidden();
  expect((await localGraph(page)).nodes.find(n => n.id === 'n1').name).toBe('Edited on tab');
  await page.locator('[data-node-id="n1"]').click({ button: 'right' });
  await page.locator('#ctxLabel').fill('Context blur');
  await page.locator('#zoomOut').click();
  expect((await localGraph(page)).nodes.find(n => n.id === 'n1').name).toBe('Context blur');
  await page.locator('#canvas').dblclick({ position: { x: 760, y: 615 } });
  await page.locator('#nodeNameInput').fill('Blurred child');
  await page.keyboard.press('Enter');
  await page.locator('#relationshipInput').fill('BLURRED_REL');
  await page.locator('#zoomOut').click();
  const graph = await localGraph(page);
  expect(graph.nodes.at(-1).name).toBe('Blurred child');
  expect(graph.edges.at(-1).label).toBe('BLURRED_REL');
});

test('editor fits within workspace after zoom and near the edge', async ({ page }) => {
  for (let i = 0; i < 8; i++) await page.locator('#zoomIn').click();
  await page.locator('#canvas').dblclick({ position: { x: 760, y: 615 } });
  await expect(page.locator('#quickedit')).toBeVisible();
  const popup = await page.locator('#quickedit').boundingBox();
  const workspace = await page.locator('#workspace').boundingBox();
  expect(popup.x).toBeGreaterThanOrEqual(workspace.x);
  expect(popup.y).toBeGreaterThanOrEqual(workspace.y);
  expect(popup.x + popup.width).toBeLessThanOrEqual(workspace.x + workspace.width);
  expect(popup.y + popup.height).toBeLessThanOrEqual(workspace.y + workspace.height);
  await expect(page.locator('#relationshipInput')).toBeVisible();
  await page.setViewportSize({ width: 800, height: 480 });
  await expect.poll(async () => {
    const p = await page.locator('#quickedit').boundingBox(), w = await page.locator('#workspace').boundingBox();
    return p.x >= w.x && p.y >= w.y && p.x + p.width <= w.x + w.width && p.y + p.height <= w.y + w.height;
  }).toBe(true);
});

test('keyboard and context menu copy and paste nodes and lines', async ({ page }) => {
  await page.locator('[data-node-id="n1"]').click();
  await page.keyboard.press('Control+c');
  await page.keyboard.press('Control+v');
  let g = await localGraph(page);
  expect(g.nodes).toHaveLength(6);
  expect(g.nodes.at(-1)).toMatchObject({ name: 'Email & Calendaring', classId: 'cls-service', x: -260, y: -40 });
  await page.locator('[data-node-id="n2"]').click({ button: 'right' });
  await page.locator('[data-clipboard="copy"]').click();
  await page.locator('#canvas').click({ button: 'right', position: { x: 850, y: 600 } });
  await page.locator('[data-clipboard="paste"]').click();
  g = await localGraph(page);
  expect(g.nodes).toHaveLength(7);
  expect(g.nodes.at(-1).name).toBe('Faculty & Staff Email');
  await page.locator('[data-edge-id="e1"] path').first().click({ force: true });
  await page.keyboard.press('Control+c');
  await page.keyboard.press('Control+v');
  g = await localGraph(page);
  expect(g.edges).toHaveLength(5);
  expect(g.edges.at(-1)).toMatchObject({ from: 'n1', to: 'n2', label: 'HAS_OFFERING' });
  const paths = await page.locator('[data-edge-id="e1"] path.svg-edge-line, [data-edge-id="' + g.edges.at(-1).id + '"] path.svg-edge-line').evaluateAll(els => els.map(el => el.getAttribute('d')));
  expect(paths[0]).not.toBe(paths[1]);
  await page.locator('[data-edge-id="e1"] path').first().click({ button: 'right', force: true });
  await page.locator('[data-clipboard="copy"]').click();
  await page.locator('#canvas').click({ button: 'right', position: { x: 850, y: 600 } });
  await page.locator('[data-clipboard="paste"]').click();
  expect((await localGraph(page)).edges).toHaveLength(6);
});

test('relationship templates apply to existing and future lines with inverse titles', async ({ page }) => {
  await page.locator('#editRelations').click();
  await page.locator('#relationFrom').selectOption('cls-service');
  await page.locator('#relationTo').selectOption('cls-offering');
  await page.locator('#relationLabel').fill('has_offering');
  await page.locator('#relationInverse').fill('is_offering');
  await page.locator('#saveRelation').click();
  let g = await localGraph(page);
  expect(g.edges.find(e => e.id === 'e1').label).toBe('has_offering');
  expect(g.edges.find(e => e.from === 'n2' && e.to === 'n1').label).toBe('is_offering');
  expect(g.edges.find(e => e.id === 'e2').label).toBe('USES');
  await page.locator('[data-edit-relation="cls-service"]').click();
  await page.locator('#relationLabel').fill('offers');
  await page.locator('#relationInverse').fill('offered_by');
  await page.locator('#saveRelation').click();
  await page.locator('#closeRelations').click();
  g = await localGraph(page);
  expect(g.edges.find(e => e.id === 'e1').label).toBe('offers');
  expect(g.edges.find(e => e.from === 'n2' && e.to === 'n1').label).toBe('offered_by');
  await page.locator('[data-node-id="n1"]').click();
  await page.keyboard.press('Tab');
  await page.locator('#nodeNameInput').fill('New offering');
  await page.keyboard.press('Escape');
  await page.keyboard.press('2');
  g = await localGraph(page);
  const child = g.nodes.find(n => n.name === 'New offering');
  expect(g.edges.find(e => e.from === 'n1' && e.to === child.id).label).toBe('offers');
  expect(g.edges.find(e => e.from === child.id && e.to === 'n1').label).toBe('offered_by');
  await page.reload();
  await page.locator('#editRelations').click();
  await expect(page.locator('#relationList')).toContainText('offered_by');
  await page.locator('[data-delete-relation="cls-service"]').click();
  expect((await localGraph(page)).edges).toHaveLength(g.edges.length);
});

test('class deletion removes templates that reference the deleted class', async ({ page }) => {
  await page.locator('#editRelations').click();
  await page.locator('#relationFrom').selectOption('cls-service');
  await page.locator('#relationTo').selectOption('cls-offering');
  await page.locator('#relationLabel').fill('offers');
  await page.locator('#saveRelation').click();
  await page.locator('#closeRelations').click();
  page.once('dialog', dialog => dialog.accept());
  await page.locator('#editClasses').click();
  await page.locator('[data-delete-class="2"]').click();
  await page.locator('#closeClasses').click();
  await page.reload();
  const g = await localGraph(page);
  expect(g.classes.find(c => c.id === 'cls-service').relations).toEqual([]);
  expect(g.classes.some(c => c.id === 'cls-offering')).toBe(false);
  expect(g.nodes.find(n => n.id === 'n2').classId).toBe('cls-service');
});
