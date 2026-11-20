import { test, expect } from '@playwright/test';

const LIVE = /Live · connected|Viewing live/;

async function createSession(browser) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  page.on('pageerror', e => { throw new Error('pageerror A: ' + e); });
  await page.goto('/');
  await page.locator('#collabBtn').click();
  await page.locator('#collabRoomName').fill('E2E Workshop');
  await page.locator('#collabYourName').fill('Alice');
  await page.locator('#collabCreateBtn').click();
  await expect(page.locator('#liveStatus')).toContainText('Live · connected', { timeout: 15000 });
  const editorLink = await page.locator('#collabEditorLink').inputValue();
  const viewerLink = await page.locator('#collabViewerLink').inputValue();
  expect(editorLink).toContain('#s=');
  expect(viewerLink).toContain('#s=');
  await page.keyboard.press('Escape');
  await expect(page.locator('#collabBackdrop')).toBeHidden();
  return { context, page, editorLink, viewerLink };
}

async function join(browser, link, name) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  page.on('pageerror', e => { throw new Error('pageerror: ' + e); });
  await page.goto(link);
  await expect(page.locator('#liveStatus')).toContainText(LIVE, { timeout: 15000 });
  return { context, page };
}

async function createNode(page, x, y, name, rel) {
  await page.locator('#canvas').dblclick({ position: { x, y } });
  await expect(page.locator('#quickedit')).toBeVisible();
  await page.keyboard.type(name);
  await page.keyboard.press('Enter');
  await page.keyboard.type(rel);
  await page.keyboard.press('Enter');
  await expect(page.locator('#quickedit')).toBeHidden();
}

test('two editors and one viewer collaborate in real time', async ({ browser }) => {
  const A = await createSession(browser);
  try {
    // local board preserved separately from the room
    expect((await A.page.evaluate(() => JSON.parse(localStorage.getItem('nodeboard-v1.1')))).nodes).toHaveLength(5);

    const B = await join(browser, A.editorLink, 'Bob');
    try {
      await expect(B.page.locator('#scene .node')).toHaveCount(5);
      await expect(A.page.locator('#presenceStrip')).toContainText('2 online');

      // A creates a node -> appears in B without refresh
      await createNode(A.page, 760, 615, 'From A', 'REL_A');
      await expect(B.page.locator('#scene')).toContainText('From A', { timeout: 10000 });
      await expect(B.page.locator('#scene')).toContainText('REL_A');

      // B creates a node -> appears in A
      await createNode(B.page, 700, 200, 'From B', 'REL_B');
      await expect(A.page.locator('#scene')).toContainText('From B', { timeout: 10000 });
      await expect(A.page.locator('#scene .node')).toHaveCount(7);

      // B renames n1 while A repositions it: both changes survive
      const rectX = page => page.evaluate(() => document.querySelector('[data-node-id="n1"] rect').getAttribute('x'));
      const beforeX = await rectX(B.page);
      await B.page.locator('[data-node-id="n1"]').click({ button: 'right' });
      await B.page.locator('#ctxLabel').fill('Renamed by B');
      await B.page.keyboard.press('Enter');
      const box = await A.page.locator('[data-node-id="n1"]').boundingBox();
      await A.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await A.page.mouse.down();
      await A.page.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2, { steps: 8 });
      await A.page.mouse.up();
      await expect(A.page.locator('#scene')).toContainText('Renamed by B', { timeout: 10000 });
      await expect(B.page.locator('#scene')).toContainText('Renamed by B');
      await expect.poll(() => rectX(B.page), { timeout: 10000 }).not.toBe(beforeX);

      // viewer joins: read-only, presence visible
      const C = await join(browser, A.viewerLink, 'Carol');
      try {
        await expect(C.page.locator('#liveStatus')).toContainText('Viewing live session');
        await expect(C.page.locator('#scene .node')).toHaveCount(7);
        await expect(A.page.locator('#presenceStrip')).toContainText('3 online', { timeout: 10000 });
        const before = await C.page.locator('#scene .node').count();
        await C.page.locator('#canvas').dblclick({ position: { x: 500, y: 550 } });
        await expect(C.page.locator('#scene .node')).toHaveCount(before);
        await expect(C.page.locator('#quickedit')).toBeHidden();

        // editor reload: reconnects and keeps full graph
        await B.page.reload();
        await expect(B.page.locator('#liveStatus')).toContainText('Live · connected', { timeout: 15000 });
        await expect(B.page.locator('#scene .node')).toHaveCount(7);
        await expect(B.page.locator('#scene')).toContainText('Renamed by B');
      } finally {
        await C.context.close();
      }
    } finally {
      await B.context.close();
    }

    // leaving restores the local board untouched
    await A.page.locator('#collabBtn').click();
    await A.page.locator('#collabLeaveBtn').click();
    await expect(A.page.locator('#liveStatus')).toContainText('Local board');
    await expect(A.page.locator('#scene .node')).toHaveCount(5);
  } finally {
    await A.context.close();
  }
});

test('class add/delete sync across editors with node reassignment', async ({ browser }) => {
  const A = await createSession(browser);
  try {
    const B = await join(browser, A.editorLink, 'Bob');
    try {
      // A adds a class -> visible in B's palette
      await A.page.locator('#editClasses').click();
      await A.page.locator('#addClass').click();
      await A.page.locator('[data-modal-class="8"] input[type=text]').fill('Workstream');
      await A.page.keyboard.press('Enter');
      await A.page.keyboard.press('Escape');
      await expect(B.page.locator('#palette')).toContainText('Workstream', { timeout: 10000 });

      // B assigns class 8 to n1 -> A sees the class label
      await B.page.locator('[data-node-id="n1"]').click();
      await B.page.keyboard.press('8');
      await expect(A.page.locator('[data-node-id="n1"]')).toContainText('WORKSTREAM', { timeout: 10000 });

      // A deletes class 8 -> n1 reassigned to another class on both clients
      A.page.on('dialog', d => d.accept());
      await A.page.locator('#editClasses').click();
      await A.page.locator('[data-delete-class="8"]').click();
      await A.page.keyboard.press('Escape');
      await expect(A.page.locator('#palette')).not.toContainText('Workstream');
      await expect(B.page.locator('#palette')).not.toContainText('Workstream', { timeout: 10000 });
      await expect(B.page.locator('[data-node-id="n1"]')).not.toContainText('WORKSTREAM');
      await expect(B.page.locator('#scene .node')).toHaveCount(5);
    } finally {
      await B.context.close();
    }
  } finally {
    await A.context.close();
  }
});

test('remote cursors are visible across clients', async ({ browser }) => {
  const A = await createSession(browser);
  try {
    const B = await join(browser, A.editorLink, 'Bob');
    try {
      await A.page.mouse.move(700, 400);
      await A.page.mouse.move(720, 410);
      await expect(B.page.locator('#cursorLayer .remote-cursor')).toHaveCount(1, { timeout: 10000 });
      await expect(B.page.locator('#cursorLayer')).toContainText('Alice');
      // viewer cursor also relayed
      const C = await join(browser, A.viewerLink, 'Carol');
      try {
        await C.page.mouse.move(500, 300);
        await C.page.mouse.move(520, 310);
        await B.page.mouse.move(600, 350);
        await B.page.mouse.move(620, 360);
        await expect(A.page.locator('#cursorLayer .remote-cursor')).toHaveCount(2, { timeout: 10000 });
      } finally {
        await C.context.close();
      }
    } finally {
      await B.context.close();
    }
  } finally {
    await A.context.close();
  }
});

test('joining with a bad token is rejected', async ({ browser }) => {
  const A = await createSession(browser);
  try {
    const bad = A.editorLink.replace(/key=[0-9a-f]+/, 'key=' + '0'.repeat(48));
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(bad);
    await expect(page.locator('#liveStatus')).toContainText(/Disconnected|Local board/, { timeout: 15000 });
    await expect(page.locator('#scene .node')).toHaveCount(5); // only local sample
    await context.close();
  } finally {
    await A.context.close();
  }
});

test('relationship templates and bulk line updates sync and survive reconnect', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  page.on('pageerror', e => { throw e; });
  try {
    await page.goto('/');
    const graph = await page.evaluate(() => {
      const g = JSON.parse(localStorage.getItem('nodeboard-v1.1'));
      for (let i = 0; i < 105; i++) g.edges.push({ id: 'bulk' + i, from: 'n1', to: 'n2', label: 'old' });
      return g;
    });

    await page.addInitScript(g => localStorage.setItem('nodeboard-v1.1', JSON.stringify(g)), graph);
    await page.reload();
    await page.locator('#collabBtn').click();
    await page.locator('#collabCreateBtn').click();
    await expect(page.locator('#liveStatus')).toContainText('Live · connected', { timeout: 15000 });
    const link = await page.locator('#collabEditorLink').inputValue();
    await page.keyboard.press('Escape');
    const B = await join(browser, link, 'Bob');
    try {
      await page.locator('#editRelations').click();
      await page.locator('#relationFrom').selectOption('cls-service');
      await page.locator('#relationTo').selectOption('cls-offering');
      await page.locator('#relationLabel').fill('offers');
      await page.locator('#relationInverse').fill('offered_by');
      await page.locator('#saveRelation').click();
      await expect.poll(() => B.page.locator('#scene .edge text').filter({ hasText: 'offers' }).count(), { timeout: 15000 }).toBe(106);
      await expect(B.page.locator('#scene')).toContainText('offered_by');
      await expect(page.locator('#saveLabel')).toContainText('saved to session', { timeout: 15000 });
      await B.page.reload();
      await expect(B.page.locator('#liveStatus')).toContainText('Live · connected', { timeout: 15000 });
      await expect(B.page.locator('#scene .edge text').filter({ hasText: 'offers' })).toHaveCount(106);
      await B.page.locator('#editRelations').click();
      await expect(B.page.locator('#relationList')).toContainText('offered_by');
      await page.locator('#bulkRelations').click();
      const classes = JSON.parse(await page.locator('#bulkJson').inputValue());
      classes[0].relations[0].label = 'provides';
      await page.locator('#bulkJson').fill(JSON.stringify(classes));
      page.once('dialog', dialog => dialog.accept());
      await page.locator('#applyBulk').click();
      await expect.poll(() => B.page.locator('#scene .edge text').filter({ hasText: 'provides' }).count(), { timeout: 15000 }).toBe(106);
      await expect(page.locator('#saveLabel')).toContainText('saved to session', { timeout: 15000 });
    } finally {
      await B.context.close();
    }
  } finally {
    await context.close();
  }
});

test('pasted classes and relationship changes sync across editors', async ({ browser }) => {
  const A = await createSession(browser);
  const B = await join(browser, A.editorLink, 'Bob');
  try {
    await A.page.locator('#editRelations').click();
    await A.page.locator('#bulkRelations').click();
    const classes = JSON.parse(await A.page.locator('#bulkJson').inputValue());
    classes[0].name = 'Services revised';
    classes[0].relations = [{ to: classes[1].id, label: 'HAS_OFFERING', inverse: 'IS_OFFERING' }];
    await A.page.locator('#bulkJson').fill(JSON.stringify(classes));
    A.page.once('dialog', dialog => dialog.accept());
    await A.page.locator('#applyBulk').click();
    await expect(B.page.locator('#palette')).toContainText('Services revised');
    await expect(B.page.locator('#scene')).toContainText('IS_OFFERING');
    await expect(A.page.locator('#saveLabel')).toContainText('saved to session');
    await B.page.reload();
    await expect(B.page.locator('#liveStatus')).toContainText('Live · connected');
    await expect(B.page.locator('#scene')).toContainText('IS_OFFERING');
    await A.page.locator('#bulkRelations').click();
    await B.page.locator('#editClasses').click();
    await B.page.locator('[data-classname="1"]').fill('Changed elsewhere');
    await B.page.locator('[data-classname="1"]').blur();
    await expect(A.page.locator('#palette')).toContainText('Changed elsewhere');
    await A.page.locator('#applyBulk').click();
    await expect(A.page.locator('#bulkFeedback')).toContainText('Classes changed while this editor was open');
  } finally {
    await A.context.close();
    await B.context.close();
  }
});

test('board JSON replaces a live board and reconnects all participants', async ({ browser }) => {
  const A = await createSession(browser);
  const B = await join(browser, A.editorLink, 'Bob');
  const V = await join(browser, A.viewerLink, 'Viewer');
  try {
    await V.page.locator('#jsonViewBtn').click();
    await expect(V.page.locator('#graphJson')).toHaveAttribute('readonly');
    await expect(V.page.locator('#applyGraphJson')).toBeDisabled();
    await V.page.locator('#closeGraphJson').click();
    await A.page.locator('#jsonViewBtn').click();
    const board = JSON.parse(await A.page.locator('#graphJson').inputValue());
    const oldClassId = board.classes[0].id;
    board.classes[0].id = 'replacement-class';
    for (const node of board.nodes) if (node.classId === oldClassId) node.classId = 'replacement-class';
    for (let i = 0; i < 120; i++) board.nodes.push({ id: `new${i}`, x: i * 10, y: 200, name: `New ${i}`, classId: 'replacement-class' });
    board.nodes[0].name = 'Replacement board';
    await A.page.locator('#graphJson').fill(JSON.stringify(board));
    A.page.once('dialog', dialog => dialog.accept());
    await A.page.locator('#applyGraphJson').click();
    await expect(A.page.locator('#graphJsonBackdrop')).toBeHidden({ timeout: 15000 });
    await expect(A.page.locator('#liveStatus')).toContainText('Live · connected', { timeout: 15000 });
    await expect(B.page.locator('#scene')).toContainText('Replacement board', { timeout: 15000 });
    await expect(B.page.locator('#scene .node')).toHaveCount(125);
    await expect(V.page.locator('#scene')).toContainText('Replacement board', { timeout: 15000 });
    await B.page.reload();
    await expect(B.page.locator('#scene')).toContainText('Replacement board', { timeout: 15000 });
    await A.page.locator('#jsonViewBtn').click();
    const changed = JSON.parse(await A.page.locator('#graphJson').inputValue());
    changed.nodes[0].name = 'Unapplied edit';
    await A.page.locator('#graphJson').fill(JSON.stringify(changed));
    await B.page.locator('#scene .node').first().dblclick();
    await B.page.locator('#nodeNameInput').fill('Edited elsewhere');
    await B.page.keyboard.press('Escape');
    await expect(A.page.locator('#scene')).toContainText('Edited elsewhere');
    await A.page.locator('#applyGraphJson').click();
    await expect(A.page.locator('#graphJsonFeedback')).toContainText('board changed');
  } finally {
    await A.context.close();
    await B.context.close();
    await V.context.close();
  }
});

test('server rejects stale and view-only full-board replacements', async ({ browser }) => {
  const A = await createSession(browser);
  try {
    const attempt = (link, baseRevision) => A.page.evaluate(({ link, baseRevision }) => new Promise((resolve, reject) => {
      const invite = new URLSearchParams(new URL(link).hash.slice(1));
      const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/api/sessions/${invite.get('s')}/ws`);
      ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', token: invite.get('key'), clientId: crypto.randomUUID(), name: 'Test' }));
      ws.onmessage = event => {
        const msg = JSON.parse(event.data);
        if (msg.type === 'welcome') ws.send(JSON.stringify({ type: 'replace-graph', requestId: 'replacement-attempt', baseRevision, graph: msg.graph }));
        if (msg.type === 'graph.replace-error') { resolve(msg.code); ws.close(); }
      };
      ws.onerror = () => reject(new Error('WebSocket connection failed'));
      setTimeout(() => reject(new Error('No replacement response')), 10000);
    }), { link, baseRevision });
    expect(await attempt(A.editorLink, -1)).toBe('REVISION_CONFLICT');
    expect(await attempt(A.viewerLink, 0)).toBe('FORBIDDEN');
    await expect(A.page.locator('#scene .node')).toHaveCount(5);
  } finally {
    await A.context.close();
  }
});
