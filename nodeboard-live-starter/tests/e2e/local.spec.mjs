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
