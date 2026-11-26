const { test, expect } = require('../../nodeboard-live-starter/node_modules/@playwright/test');
const { createHmac } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const snapshot = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'v2-draft-valid.json'), 'utf8'));
const token = (sub, email) => {
  const message = `fixture.${Buffer.from(JSON.stringify({ sub, exp: Math.floor(Date.now() / 1000) + 3600, ...(email ? { email } : {}) })).toString('base64url')}`;
  return `${message}.${createHmac('sha256', 'test-only-secret').update(message).digest('base64url')}`;
};
const auth = sub => ({
  Authorization: `Bearer ${token(sub)}`,
  'X-Nodeboard-Protocol': '2',
  'X-Nodeboard-Snapshot': '2',
});
const batch = (operationId, baseRevision, entity) => ({
  protocolVersion: 2, snapshotVersion: 2, operationId, baseRevision,
  operations: [{ type: 'entity.put', entity }],
});

test('isolated owner boards negotiate, enforce identity, commit atomically and replay safely', async ({ request }) => {
  const api = '/api/v2/boards';
  const alice = auth('alice'), bob = auth('bob');
  expect((await request.get(api)).status()).toBe(401);
  expect((await request.get(api, { headers: { ...alice, 'X-Nodeboard-Protocol': '1' } })).status()).toBe(426);
  expect((await request.get(api, { headers: { ...alice, Authorization: 'Bearer forged' } })).status()).toBe(401);
  expect((await request.post(api, { headers: alice, data: { id: 'alice-board', snapshot } })).status()).toBe(201);
  const replayedCreate = await request.post(api, { headers: alice, data: { id: 'alice-board', snapshot } });
  expect(replayedCreate.status()).toBe(200);
  expect((await replayedCreate.json()).replayed).toBe(true);
  expect((await request.post(api, { headers: alice, data: { id: 'alice-board', snapshot: { ...snapshot, metadata: { name: 'Different' } } } })).status()).toBe(409);
  expect((await (await request.get(api, { headers: alice })).json()).ids).toEqual(['alice-board']);
  expect((await (await request.get(api, { headers: bob })).json()).ids).toEqual([]);
  expect((await request.get(`${api}/alice-board`, { headers: bob })).status()).toBe(404);
  expect((await request.get('/api/documents/alice-board', { headers: alice })).status()).toBe(404);
  expect((await request.get(`${api}/alice-board`, { headers: { ...alice, 'X-Nodeboard-Snapshot': '1' } })).status()).toBe(426);
  expect((await (await request.get(`${api}/alice-board`, { headers: alice })).json()).snapshot).toEqual(snapshot);
  expect((await request.get(`${api}?limit=0`, { headers: alice })).status()).toBe(400);

  const first = batch('operation-one', 0, { ...snapshot.graph.entities[0], name: 'Edited A' });
  const competing = batch('operation-two', 0, { ...snapshot.graph.entities[1], name: 'Edited B' });
  const outcomes = await Promise.all([
    request.post(`${api}/alice-board/operations`, { headers: alice, data: first }),
    request.post(`${api}/alice-board/operations`, { headers: alice, data: competing }),
  ]);
  expect(outcomes.map(result => result.status()).sort()).toEqual([200, 409]);
  const winner = outcomes[0].status() === 200 ? first : competing;
  const loser = outcomes[0].status() === 409 ? first : competing;
  const winnerAck = await (outcomes[0].status() === 200 ? outcomes[0] : outcomes[1]).json();
  expect(winnerAck.committedRevision).toBe(1);
  expect(winnerAck.replayed).toBe(false);
  const stale = await (outcomes[0].status() === 409 ? outcomes[0] : outcomes[1]).json();
  expect(stale.code).toBe('REVISION_CONFLICT');
  const rebased = { ...loser, baseRevision: 1 };
  const second = await request.post(`${api}/alice-board/operations`, { headers: alice, data: rebased });
  expect(second.status()).toBe(200);
  expect((await second.json()).committedRevision).toBe(2);
  const replay = await (await request.post(`${api}/alice-board/operations`, { headers: alice, data: winner })).json();
  expect(replay.replayed).toBe(true);
  expect(replay.committedRevision).toBe(1);
  expect(replay.revision).toBe(2);
  expect(replay.snapshot.graph.entities.map(item => item.name)).toEqual(['Edited A', 'Edited B']);
  const reuse = await request.post(`${api}/alice-board/operations`, { headers: alice, data: { ...winner, baseRevision: 2 } });
  expect(reuse.status()).toBe(409);
  expect((await reuse.json()).code).toBe('OPERATION_ID_REUSE');
  const undo = { operationId: 'undo-one', baseRevision: 2, direction: 'undo' };
  const undone = await request.post(`${api}/alice-board/history`, { headers: alice, data: undo });
  expect(undone.status()).toBe(200);
  const undoResult = await undone.json();
  expect(undoResult.revision).toBe(3);
  expect(undoResult.role).toBe('owner');
  expect(undoResult.history).toEqual({ undo: 1, redo: 1, dropped: 0 });
  expect(undoResult.snapshot.graph.entities.find(item => item.id === loser.operations[0].entity.id).name)
    .toBe(snapshot.graph.entities.find(item => item.id === loser.operations[0].entity.id).name);
  const redo = { operationId: 'redo-one', baseRevision: 3, direction: 'redo' };
  const redone = await request.post(`${api}/alice-board/history`, { headers: alice, data: redo });
  expect(redone.status()).toBe(200);
  expect((await redone.json()).snapshot.graph.entities.map(item => item.name)).toEqual(['Edited A', 'Edited B']);
  const undoReplay = await (await request.post(`${api}/alice-board/history`, { headers: alice, data: undo })).json();
  expect(undoReplay).toMatchObject({ role: 'owner', replayed: true, committedRevision: 3, revision: 4 });
  const staleHistory = await request.post(`${api}/alice-board/history`, {
    headers: alice, data: { operationId: 'stale-undo', baseRevision: 3, direction: 'undo' },
  });
  expect(staleHistory.status()).toBe(409);
  expect((await staleHistory.json()).code).toBe('REVISION_CONFLICT');
  const invalid = batch('invalid-op', 4, { ...snapshot.graph.entities[0], classIds: ['missing-class'] });
  const failed = await request.post(`${api}/alice-board/operations`, { headers: alice, data: invalid });
  expect(failed.status()).toBe(400);
  expect((await failed.json()).diagnostics.some(item => item.code === 'REFERENCE_NOT_FOUND')).toBe(true);
  const final = await (await request.get(`${api}/alice-board`, { headers: alice })).json();
  expect(final.revision).toBe(4);
  expect(final.snapshot.graph.entities.map(item => item.name)).toEqual(['Edited A', 'Edited B']);
  expect((await request.post(`${api}/alice-board/operations`, { headers: bob, data: first })).status()).toBe(404);
  expect((await request.post(api, { headers: alice, data: { id: 'invalid-board', snapshot: { ...snapshot, version: 1 } } })).status()).toBe(400);
  const oversized = await request.post(api, {
    headers: { ...alice, 'content-type': 'application/json' },
    data: JSON.stringify({ id: 'large-board', snapshot, padding: 'x'.repeat(5_100_000) }),
  });
  expect(oversized.status()).toBe(413);
  expect((await (await request.get(api, { headers: alice })).json()).ids).toEqual(['alice-board']);
});

test('account history has count and byte bounds and clears redo on branching', async ({ request }) => {
  const headers = auth('bob');
  const api = '/api/v2/boards';
  const small = structuredClone(snapshot);
  expect((await request.post(api, { headers, data: { id: 'history-count', snapshot: small } })).status()).toBe(201);
  let latest;
  for (let i = 0; i < 102; i++) {
    const operation = batch(`count-${i}`, i, { ...small.graph.entities[0], name: `Edit ${i}` });
    const response = await request.post(`${api}/history-count/operations`, { headers, data: operation });
    expect(response.status()).toBe(200);
    latest = await response.json();
  }
  expect(latest.history).toEqual({ undo: 100, redo: 0, dropped: 2 });
  expect(latest.historyTruncated).toBe(true);
  const undo = await request.post(`${api}/history-count/history`, {
    headers, data: { operationId: 'count-undo', baseRevision: 102, direction: 'undo' },
  });
  expect((await undo.json()).history.redo).toBe(1);
  const branch = await request.post(`${api}/history-count/operations`, {
    headers, data: batch('count-branch', 103, { ...small.graph.entities[0], name: 'Branch' }),
  });
  const branchResult = await branch.json();
  expect(branchResult.history.redo).toBe(0);
  const nothingToRedo = await request.post(`${api}/history-count/history`, {
    headers, data: { operationId: 'count-redo', baseRevision: 104, direction: 'redo' },
  });
  expect(nothingToRedo.status()).toBe(409);
  expect((await nothingToRedo.json()).code).toBe('NO_HISTORY');

  const large = structuredClone(snapshot);
  large.metadata.payload = 'x'.repeat(2_600_000);
  expect((await request.post(api, { headers, data: { id: 'history-bytes', snapshot: large } })).status()).toBe(201);
  for (let i = 0; i < 4; i++) {
    const response = await request.post(`${api}/history-bytes/operations`, {
      headers, data: batch(`bytes-${i}`, i, { ...large.graph.entities[0], name: `Edit ${i}` }),
    });
    expect(response.status()).toBe(200);
    latest = await response.json();
  }
  expect(latest.history.undo).toBe(3);
  expect(latest.history.dropped).toBe(1);
  expect(latest.historyTruncated).toBe(true);
});

test('shared boards enforce roles and never expose personal views', async ({ request }) => {
  const alice = auth('alice'), bob = auth('bob'), eve = auth('eve');
  for (const headers of [alice, bob, eve]) expect((await request.get('/api/account', { headers })).status()).toBe(200);
  const owner = '/api/v2/boards/shared-test';
  const shared = '/api/v2/shared/alice/shared-test';
  expect((await request.post('/api/v2/boards', { headers: alice, data: { id: 'shared-test', snapshot } })).status()).toBe(201);
  expect((await request.post(`${owner}/share`, { headers: alice, data: { email: 'bob@example.test', role: 'owner' } })).status()).toBe(400);
  expect((await request.post(`${owner}/share`, { headers: alice, data: { email: '', role: 'viewer' } })).status()).toBe(400);
  expect((await request.post(`${owner}/share`, { headers: alice, data: { email: 'bob@example.test', role: 'viewer', extra: true } })).status()).toBe(400);
  expect((await request.get(shared, { headers: bob })).status()).toBe(404);
  const blocked = await request.post(`${owner}/share`, { headers: alice, data: { email: 'bob@example.test', role: 'viewer' } });
  expect(blocked.status()).toBe(409);
  expect((await blocked.json()).code).toBe('PERSONAL_VIEW_CONFLICT');
  const removeView = {
    protocolVersion: 2, snapshotVersion: 2, operationId: 'remove-personal-view', baseRevision: 0,
    operations: [{ type: 'view.delete', id: 'view-personal' }],
  };
  expect((await request.post(`${owner}/operations`, { headers: alice, data: removeView })).status()).toBe(200);
  expect((await request.post(`${owner}/share`, { headers: alice, data: { email: 'bob@example.test', role: 'viewer' } })).status()).toBe(200);
  expect((await request.get(shared, { headers: eve })).status()).toBe(404);
  const viewed = await (await request.get(shared, { headers: bob })).json();
  expect(viewed.role).toBe('viewer');
  expect(viewed.snapshot.views.every(view => view.scope === 'shared')).toBe(true);
  expect(viewed.history).toEqual({ undo: 0, redo: 0, dropped: 0 });
  expect((await request.get(`${shared}/members`, { headers: bob })).status()).toBe(404);
  expect((await request.post(`${shared}/share`, { headers: bob, data: { email: 'eve@example.test', role: 'viewer' } })).status()).toBe(404);
  expect((await request.post(`${shared}/history`, { headers: bob, data: { operationId: 'viewer-undo', baseRevision: 1, direction: 'undo' } })).status()).toBe(404);
  const edit = batch('shared-edit', 1, { ...snapshot.graph.entities[0], name: 'Shared edit' });
  expect((await request.post(`${shared}/operations`, { headers: bob, data: edit })).status()).toBe(403);
  const forbiddenPersonal = await request.post(`${owner}/history`, {
    headers: alice, data: { operationId: 'unsafe-undo', baseRevision: 1, direction: 'undo' },
  });
  expect(forbiddenPersonal.status()).toBe(409);
  expect((await forbiddenPersonal.json()).code).toBe('PERSONAL_VIEW_CONFLICT');
  expect((await request.post(`${owner}/share`, { headers: alice, data: { email: 'bob@example.test', role: 'editor' } })).status()).toBe(200);
  const edited = await request.post(`${shared}/operations`, { headers: bob, data: edit });
  expect(edited.status()).toBe(200);
  expect((await edited.json()).snapshot.graph.entities[0].name).toBe('Shared edit');
  expect((await request.post(`${shared}/history`, { headers: bob, data: { operationId: 'editor-undo', baseRevision: 2, direction: 'undo' } })).status()).toBe(404);
  expect((await request.post(`${shared}/operations`, {
    headers: bob, data: { protocolVersion: 2, snapshotVersion: 2, operationId: 'editor-personal', baseRevision: 2,
      operations: [{ type: 'view.put', view: snapshot.views.find(view => view.scope === 'personal') }] },
  })).status()).toBe(409);
  const addPersonal = {
    protocolVersion: 2, snapshotVersion: 2, operationId: 'add-personal-view', baseRevision: 2,
    operations: [{ type: 'view.put', view: snapshot.views.find(view => view.scope === 'personal') }],
  };
  const rejected = await request.post(`${owner}/operations`, { headers: alice, data: addPersonal });
  expect(rejected.status()).toBe(409);
  expect((await rejected.json()).code).toBe('PERSONAL_VIEW_CONFLICT');
  const members = await (await request.get(`${owner}/members`, { headers: alice })).json();
  expect(members.members).toContainEqual({ userId: 'bob', email: 'bob@example.test', role: 'editor' });
  const renamedBob = { ...bob, Authorization: `Bearer ${token('bob', 'bob-new@example.test')}` };
  const reassignedEve = { ...eve, Authorization: `Bearer ${token('eve', 'bob@example.test')}` };
  expect((await request.get('/api/account', { headers: renamedBob })).status()).toBe(200);
  expect((await request.get('/api/account', { headers: reassignedEve })).status()).toBe(200);
  expect((await request.post(`${owner}/unshare`, { headers: alice, data: { email: 'bob@example.test' } })).status()).toBe(400);
  expect((await request.post(`${owner}/unshare`, { headers: alice, data: { userId: 'bob' } })).status()).toBe(200);
  expect((await request.get(shared, { headers: bob })).status()).toBe(404);
  expect((await request.post(`${shared}/operations`, { headers: bob, data: edit })).status()).toBe(404);
  expect((await request.get(`${owner}/members`, { headers: alice })).status()).toBe(200);
  expect((await request.get('/api/account', { headers: eve })).status()).toBe(200);
  expect((await request.get('/api/account', { headers: bob })).status()).toBe(200);
});

test('sharing UI grants viewer and editor access and closes after revocation', async ({ browser, request }) => {
  const alice = auth('alice'), bob = auth('bob');
  for (const headers of [alice, bob]) expect((await request.get('/api/account', { headers })).status()).toBe(200);
  const board = structuredClone(snapshot);
  board.views = board.views.filter(view => view.scope === 'shared');
  board.metadata.name = 'Shared UI board';
  expect((await request.post('/api/v2/boards', { headers: alice, data: { id: 'shared-ui-board', snapshot: board } })).status()).toBe(201);
  const contexts = [];
  try {
    async function accountPage(user, initiallySignedIn = true) {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
      contexts.push(context);
      const session = { access_token: token(user), user: { id: user } };
      if (initiallySignedIn) await context.addInitScript(value => localStorage.setItem('test-auth-session', JSON.stringify(value)), session);
      await context.route('**/auth.js', route => route.fulfill({
        contentType: 'text/javascript',
        body: `window.createNodeboardAuth=()=>{const handlers=[];window.fakeSignOut=()=>{localStorage.removeItem('test-auth-session');handlers.forEach(fn=>fn('SIGNED_OUT',null))};return {auth:{
          getSession:async()=>({data:{session:JSON.parse(localStorage.getItem('test-auth-session')||'null')},error:null}),
          onAuthStateChange:fn=>handlers.push(fn),
          signInWithOtp:async()=>({error:null}),
          verifyOtp:async({email,token,type})=>{if(email!==${JSON.stringify(`${user}@example.test`)}||token!=='123456'||type!=='email')return {error:new Error('Invalid code')};
            const session=${JSON.stringify(session)};localStorage.setItem('test-auth-session',JSON.stringify(session));handlers.forEach(fn=>fn('SIGNED_IN',session));return {error:null}},
          signOut:async()=>{window.fakeSignOut();return {error:null}}
        }}};`,
      }));
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      return { page, errors };
    }
    const owner = await accountPage('alice'), recipient = await accountPage('bob', false);
    await owner.page.goto('/v2.html');
    await owner.page.waitForFunction(() => document.documentElement.dataset.v2Ready === 'true');
    await owner.page.locator('#cloud-boards').getByRole('button', { name: 'Shared UI board' }).click();
    await owner.page.getByRole('button', { name: 'Manage sharing' }).click();
    const link = await owner.page.locator('#sharing-link').inputValue();
    expect(await owner.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await owner.page.locator('#sharing-link').evaluate(field => field.clientHeight >= field.scrollHeight)).toBe(true);
    await owner.page.locator('#sharing-email').fill('bob@example.test');
    await owner.page.getByRole('button', { name: 'Grant access' }).click();
    await expect(owner.page.locator('#sharing-members')).toContainText('bob@example.test (viewer)');
    await recipient.page.goto(link);
    await recipient.page.waitForFunction(() => document.documentElement.dataset.v2Ready === 'true');
    await expect(recipient.page.locator('#account-sign-in')).toBeVisible();
    await recipient.page.locator('#account-email').fill('bob@example.test');
    await recipient.page.getByRole('button', { name: 'Send sign-in code' }).click();
    await recipient.page.locator('#account-code').fill('123456');
    await recipient.page.getByRole('button', { name: 'Verify code' }).click();
    await expect(recipient.page.locator('#board-title')).toHaveText('Shared UI board');
    await recipient.page.evaluate(() => window.fakeSignOut());
    await expect(recipient.page.locator('#editor')).toBeHidden();
    await expect(recipient.page.locator('#account-sign-in')).toBeVisible();
    await recipient.page.locator('#account-email').fill('bob@example.test');
    await recipient.page.getByRole('button', { name: 'Send sign-in code' }).click();
    await recipient.page.locator('#account-code').fill('123456');
    await recipient.page.getByRole('button', { name: 'Verify code' }).click();
    await expect(recipient.page.locator('#board-title')).toHaveText('Shared UI board');
    await expect(recipient.page.locator('#add-entity-form')).toBeHidden();
    await expect(recipient.page.locator('#add-property-form')).toBeHidden();
    await expect(recipient.page.locator('#add-required-form')).toBeHidden();
    await recipient.page.getByRole('button', { name: 'Open relationship edge-unresolved' }).click();
    await expect(recipient.page.locator('#relationships li[data-relationship-id="edge-unresolved"]')).toBeFocused();
    await recipient.page.locator('#entity-search').fill('item-a');
    await recipient.page.locator('#entity-search-results').getByRole('button', { name: 'Example A (item-a)' }).click();
    await expect(recipient.page.getByRole('button', { name: 'Save name' })).toHaveCount(0);
    await expect(recipient.page.getByText('Add connected entity', { exact: true })).toHaveCount(0);
    await expect(recipient.page.getByText('Edit relationship', { exact: true })).toHaveCount(0);
    await expect(recipient.page.getByText('Class hierarchy', { exact: true })).toHaveCount(0);
    await expect(recipient.page.getByText('Predicate definition', { exact: true })).toHaveCount(0);
    await expect(recipient.page.locator('#inspector')).toContainText('stored assertion edge-a');
    await recipient.page.getByRole('button', { name: 'Open Example B (item-b)' }).first().click();
    await expect(recipient.page.locator('#inspector')).toContainText('ID: item-b');
    await expect(recipient.page.locator('#board-revision')).toHaveText('Revision 0');
    await owner.page.locator('#sharing-email').fill('bob@example.test');
    await owner.page.getByRole('radio', { name: 'Editor' }).check();
    await owner.page.getByRole('button', { name: 'Grant access' }).click();
    await expect(owner.page.locator('#sharing-members')).toContainText('bob@example.test (editor)');
    await recipient.page.reload();
    await recipient.page.waitForFunction(() => document.documentElement.dataset.v2Ready === 'true');
    await expect(recipient.page.locator('#add-entity-form')).toBeVisible();
    await owner.page.locator('.graph-node').filter({ hasText: 'Example A' }).click();
    await owner.page.locator('#inspector > form textarea').fill('Concurrent owner edit');
    await owner.page.getByRole('button', { name: 'Save name' }).click();
    await expect(owner.page.locator('#graph-nodes')).toContainText('Concurrent owner edit');
    await recipient.page.locator('.graph-node').filter({ hasText: 'Example A' }).click();
    await recipient.page.locator('#inspector > form textarea').fill('Stale shared edit');
    await recipient.page.getByRole('button', { name: 'Save name' }).click();
    await expect(recipient.page.locator('#status')).toContainText('Reload');
    await expect(recipient.page.getByRole('button', { name: 'Retry pending account change' })).toBeHidden();
    await recipient.page.getByRole('button', { name: 'Reload board' }).click();
    await expect(recipient.page.locator('#graph-nodes')).toContainText('Concurrent owner edit');
    await recipient.page.locator('.graph-node').filter({ hasText: 'Concurrent owner edit' }).click();
    await recipient.page.locator('#inspector > form textarea').fill('Shared browser edit');
    await recipient.page.route('**/api/v2/shared/*/*/operations', async route => {
      await route.fetch();
      await route.abort('failed');
    }, { times: 1 });
    await recipient.page.getByRole('button', { name: 'Save name' }).click();
    await expect(recipient.page.getByRole('button', { name: 'Retry pending account change' })).toBeVisible();
    await recipient.page.reload();
    await recipient.page.waitForFunction(() => document.documentElement.dataset.v2Ready === 'true');
    await recipient.page.getByRole('button', { name: 'Retry pending account change' }).click();
    await expect(recipient.page.locator('#graph-nodes')).toContainText('Shared browser edit');
    const sharedRelationship = recipient.page.locator('#relationships li[data-relationship-id="edge-b"]');
    await sharedRelationship.getByText('Edit relationship', { exact: true }).click();
    const sharedPredicate = sharedRelationship.locator('[data-label="Relationship predicate"]');
    await sharedPredicate.locator('summary').click();
    await sharedPredicate.getByRole('button', { name: 'Supports', exact: true }).click();
    await sharedRelationship.getByRole('button', { name: 'Save relationship', exact: true }).click();
    await expect(sharedRelationship).toContainText('Supports → Example B (proposed)');
    await recipient.page.locator('#class-name').fill('Shared base');
    await recipient.page.getByRole('button', { name: 'Add class' }).click();
    const sharedBase = recipient.page.locator('#classes > li').filter({ has: recipient.page.getByText('Shared base', { exact: true }) });
    await expect(sharedBase).toBeVisible();
    const sharedBaseId = await sharedBase.getAttribute('data-ontology-id');
    const sharedClass = recipient.page.locator('#classes > li[data-ontology-id="class-item"]');
    await sharedClass.locator('[data-class-definition-editor] > summary').click();
    await sharedClass.getByRole('checkbox', { name: `Shared base (${sharedBaseId})` }).check();
    await sharedClass.getByRole('button', { name: 'Save class hierarchy' }).click();
    await expect(recipient.page.locator('#status')).toContainText('Class hierarchy saved.');
    await recipient.page.locator('#property-name').fill('Shared property');
    await recipient.page.locator('#property-type summary').click();
    await recipient.page.locator('#property-type').getByRole('button', { name: 'integer', exact: true }).click();
    await recipient.page.getByRole('button', { name: 'Add property' }).click();
    await expect(recipient.page.locator('#status')).toContainText('Property added.');
    const sharedProperty = recipient.page.locator('#properties > li').filter({ hasText: 'Shared property (' });
    const sharedPropertyId = await sharedProperty.getAttribute('data-property-id');
    await sharedClass.locator('[data-class-definition-editor] > summary').click();
    await sharedClass.getByRole('checkbox', { name: `Shared property (${sharedPropertyId})` }).check();
    await sharedClass.getByRole('button', { name: 'Save class hierarchy' }).click();
    await expect(recipient.page.locator('#status')).toContainText('Class hierarchy saved.');
    const sharedPredicateDefinition = recipient.page.locator('#predicates li[data-ontology-id="rel-support"] [data-predicate-definition-editor]');
    await sharedPredicateDefinition.locator('> summary').click();
    await sharedPredicateDefinition.getByRole('checkbox', { name: 'Symmetric' }).check();
    await sharedPredicateDefinition.getByRole('checkbox', { name: 'Transitive' }).check();
    await sharedPredicateDefinition.getByRole('button', { name: 'Save predicate definition' }).click();
    await expect(recipient.page.locator('#status')).toContainText('Predicate definition saved.');
    await recipient.page.locator('.graph-node').filter({ hasText: 'Shared browser edit' }).click();
    await recipient.page.locator('#inspector [data-property-editor] > summary').click();
    const sharedPropertyEditor = recipient.page.locator('#inspector [data-property-editor] details')
      .filter({ hasText: `Shared property (${sharedPropertyId}; integer)` });
    await sharedPropertyEditor.locator('> summary').click();
    await sharedPropertyEditor.getByLabel('Shared property value').fill('42');
    await sharedPropertyEditor.getByRole('button', { name: 'Save Shared property value' }).click();
    await expect(recipient.page.locator('#status')).toContainText('Entity properties saved.');
    await recipient.page.locator('#required-class summary').click();
    await recipient.page.locator('#required-class').getByRole('button', { name: 'Item (class-item)', exact: true }).click();
    await recipient.page.locator('#required-property summary').click();
    await recipient.page.locator('#required-property').getByRole('button', { name: `Shared property (${sharedPropertyId})`, exact: true }).click();
    await recipient.page.getByRole('button', { name: 'Require property' }).click();
    await expect(recipient.page.locator('#status')).toContainText('Required property added.');
    await expect(recipient.page.locator('#diagnostics')).toContainText('Required property');
    await recipient.page.getByRole('button', { name: 'Open entity Example B (item-b)' }).click();
    await expect(recipient.page.locator('.graph-node').filter({ hasText: 'Example B' })).toBeFocused();
    await recipient.page.locator('#inspector [data-connected-entity] > summary').click();
    await recipient.page.getByLabel('New entity name').fill('Shared connected entity');
    const connectedPredicate = recipient.page.locator('#inspector [data-label="Connecting predicate"]');
    await connectedPredicate.locator('summary').click();
    await connectedPredicate.getByRole('button', { name: 'Supports (rel-support)', exact: true }).click();
    await recipient.page.getByRole('button', { name: 'Create connected entity' }).click();
    await expect(recipient.page.locator('#status')).toContainText('Connected entity added.');
    await expect(recipient.page.locator('.graph-node').filter({ hasText: 'Shared connected entity' })).toBeFocused();
    await recipient.page.locator('#view-name').fill('Shared focused view');
    await recipient.page.getByRole('button', { name: 'Save current view' }).click();
    await expect(recipient.page.locator('#status')).toContainText('View saved.');
    const sharedViewId = await recipient.page.locator('#view-choice').getAttribute('data-value');
    await recipient.page.locator('#view-management > details > summary').click();
    await recipient.page.locator('#view-management').getByRole('checkbox', { name: 'Shared browser edit (item-a)' }).uncheck();
    await recipient.page.getByRole('button', { name: 'Save view membership' }).click();
    await expect(recipient.page.locator('#status')).toContainText('View membership saved.');
    await expect(recipient.page.locator('#graph-nodes')).not.toContainText('Shared browser edit');
    await owner.page.getByRole('button', { name: 'Reload board' }).click();
    await expect(owner.page.locator('#graph-nodes')).toContainText('Shared browser edit');
    await expect(owner.page.locator('#graph-nodes')).toContainText('Shared connected entity');
    await owner.page.locator('#view-choice summary').click();
    await owner.page.locator('#view-choice').getByRole('button', { name: `Shared focused view (${sharedViewId}; shared)`, exact: true }).click();
    await expect(owner.page.locator('#graph-nodes')).not.toContainText('Shared browser edit');
    await owner.page.locator('#view-choice summary').click();
    await owner.page.locator('#view-choice').getByRole('button', { name: 'All entities', exact: true }).click();
    await expect(owner.page.locator('#relationships li[data-relationship-id="edge-b"]')).toContainText('Supports → Example B (proposed)');
    await expect(owner.page.locator('#classes')).toContainText('Shared base');
    await expect(owner.page.locator('#properties')).toContainText('Shared property');
    await expect(owner.page.locator('#constraints')).toContainText('Item requires Shared property');
    await expect(owner.page.locator('#diagnostics')).toContainText('Required property');
    await owner.page.locator('.graph-node').filter({ hasText: 'Example B' }).click();
    await expect(owner.page.locator('#inspector')).toContainText('Example B → Supports → Shared browser edit (asserted; derived from edge-a)');
    await owner.page.locator('.graph-node').filter({ hasText: 'Shared browser edit' }).click();
    await owner.page.locator('#inspector [data-property-editor] > summary').click();
    const ownerProperty = owner.page.locator('#inspector [data-property-editor] details')
      .filter({ hasText: `Shared property (${sharedPropertyId}; integer)` });
    await ownerProperty.locator('> summary').click();
    await expect(ownerProperty.getByLabel('Shared property value')).toHaveValue('42');
    await recipient.page.locator('#inspector > form textarea').fill('Ambiguous shared edit');
    await recipient.page.route('**/api/v2/shared/*/*/operations', async route => {
      await route.fetch();
      await route.abort('failed');
    }, { times: 1 });
    await recipient.page.getByRole('button', { name: 'Save name' }).click();
    await expect(recipient.page.getByRole('button', { name: 'Retry pending account change' })).toBeVisible();
    await owner.page.locator('#sharing-email').fill('bob@example.test');
    await owner.page.getByRole('radio', { name: 'Viewer' }).check();
    await owner.page.getByRole('button', { name: 'Grant access' }).click();
    await expect(owner.page.locator('#sharing-members')).toContainText('bob@example.test (viewer)');
    await recipient.page.reload();
    await recipient.page.waitForFunction(() => document.documentElement.dataset.v2Ready === 'true');
    await expect(recipient.page.locator('#graph-nodes')).toContainText('Ambiguous shared edit');
    await recipient.page.locator('#view-choice summary').click();
    await recipient.page.locator('#view-choice').getByRole('button', { name: `Shared focused view (${sharedViewId}; shared)`, exact: true }).click();
    await expect(recipient.page.locator('#graph-nodes')).not.toContainText('Shared browser edit');
    await expect(recipient.page.locator('#create-view-form')).toBeHidden();
    await expect(recipient.page.getByRole('button', { name: 'Delete view' })).toHaveCount(0);
    const viewerRevision = await recipient.page.locator('#board-revision').textContent();
    await recipient.page.locator('#entity-search').fill('item-a');
    await recipient.page.locator('#entity-search-results').getByRole('button', { name: 'Shared browser edit (item-a)' }).click();
    const viewerExplorer = recipient.page.locator('#inspector details').filter({ hasText: 'Explore transitive paths' });
    await viewerExplorer.locator('> summary').click();
    await viewerExplorer.getByRole('button', { name: 'Find transitive paths' }).click();
    await expect(viewerExplorer).toContainText('1 derived path within 4 links');
    await expect(viewerExplorer).toContainText('Ambiguous shared edit');
    expect(await recipient.page.locator('#board-revision').textContent()).toBe(viewerRevision);
    await recipient.page.getByRole('button', { name: 'Retry pending account change' }).click();
    await expect(recipient.page.locator('body')).toHaveAttribute('aria-busy', 'false');
    await expect(recipient.page.getByRole('button', { name: 'Discard pending account retry' })).toBeVisible();
    const pendingDownload = recipient.page.waitForEvent('download');
    await recipient.page.getByRole('button', { name: 'Export pending account change' }).click();
    const downloaded = JSON.parse(fs.readFileSync(await (await pendingDownload).path(), 'utf8'));
    expect(downloaded).toMatchObject({
      format: 'nodeboard-pending-change', version: 1, accountId: 'bob', ownerId: 'alice',
      boardId: 'shared-ui-board', kind: 'operations',
    });
    expect(downloaded.payload.operations[0].entity.name).toBe('Ambiguous shared edit');
    async function discardPending(accept) {
      await expect(recipient.page.locator('body')).toHaveAttribute('aria-busy', 'false');
      const dialogPromise = recipient.page.waitForEvent('dialog', { timeout: 5000 });
      await recipient.page.getByRole('button', { name: 'Discard pending account retry' }).click();
      const dialog = await dialogPromise;
      expect(dialog.message()).toContain('may already have been saved');
      if (accept) await dialog.accept();
      else await dialog.dismiss();
      await expect(recipient.page.locator('body')).toHaveAttribute('aria-busy', 'false');
    }
    await discardPending(false);
    await expect(recipient.page.getByRole('button', { name: 'Retry pending account change' })).toBeVisible();
    await recipient.page.route('**/api/v2/shared/*/*', route => route.abort('failed'), { times: 1 });
    await discardPending(true);
    await expect(recipient.page.locator('#status')).toContainText('Failed to fetch');
    await expect(recipient.page.getByRole('button', { name: 'Retry pending account change' })).toBeVisible();
    await discardPending(true);
    await expect(recipient.page.locator('#status')).toContainText('Pending retry discarded');
    await expect(recipient.page.getByRole('button', { name: 'Retry pending account change' })).toBeHidden();
    await expect(recipient.page.locator('#graph-nodes')).toContainText('Ambiguous shared edit');
    await owner.page.locator('#sharing-email').fill('bob@example.test');
    await owner.page.getByRole('radio', { name: 'Editor' }).check();
    await owner.page.getByRole('button', { name: 'Grant access' }).click();
    await expect(owner.page.locator('#sharing-members')).toContainText('bob@example.test (editor)');
    await recipient.page.reload();
    await recipient.page.waitForFunction(() => document.documentElement.dataset.v2Ready === 'true');
    await recipient.page.locator('.graph-node').filter({ hasText: 'Ambiguous shared edit' }).click();
    await recipient.page.locator('#inspector > form textarea').fill('Unsent shared edit');
    await recipient.page.route('**/api/v2/shared/*/*/operations', route => route.abort('failed'), { times: 1 });
    await recipient.page.getByRole('button', { name: 'Save name' }).click();
    await expect(recipient.page.getByRole('button', { name: 'Retry pending account change' })).toBeVisible();
    await discardPending(true);
    await expect(recipient.page.locator('#status')).toContainText('Pending retry discarded');
    await expect(recipient.page.locator('#graph-nodes')).toContainText('Ambiguous shared edit');
    await expect(recipient.page.locator('#graph-nodes')).not.toContainText('Unsent shared edit');
    await recipient.page.locator('.graph-node').filter({ hasText: 'Ambiguous shared edit' }).click();
    await recipient.page.locator('#inspector > form textarea').fill('Edit after discarding');
    await recipient.page.getByRole('button', { name: 'Save name' }).click();
    await expect(recipient.page.locator('#graph-nodes')).toContainText('Edit after discarding');
    owner.page.once('dialog', dialog => dialog.accept());
    await owner.page.getByRole('button', { name: 'Remove access for bob@example.test' }).click();
    await expect(owner.page.locator('#sharing-members')).not.toContainText('bob@example.test');
    await recipient.page.getByRole('button', { name: 'Reload board' }).click();
    await expect(recipient.page.locator('#editor')).toBeHidden();
    await expect(recipient.page.locator('#status')).toContainText('access has ended');
    expect(owner.errors).toEqual([]);
    expect(recipient.errors).toEqual([]);
  } finally {
    for (const context of contexts) await context.close();
  }
});

test('email-code account copies and edits an isolated board across browser tabs', async ({ browser, request }) => {
  const context = await browser.newContext();
  try {
    const errors = [];
    await context.route('**/auth.js', route => route.fulfill({
      contentType: 'text/javascript',
      body: `window.createNodeboardAuth=()=>{let handlers=[];const get=()=>JSON.parse(localStorage.getItem('test-auth-session')||'null');return {auth:{
        getSession:async()=>({data:{session:get()},error:null}),
        onAuthStateChange:fn=>{handlers.push(fn)},
        signInWithOtp:async({email,options})=>{window.sentCode={email,options};return {error:null}},
        verifyOtp:async({email,token,type})=>{if(email!=='alice@example.test'||token!=='123456'||type!=='email')return {error:new Error('Invalid code')};
          const session={access_token:${JSON.stringify(token('alice'))},user:{id:'alice'}};localStorage.setItem('test-auth-session',JSON.stringify(session));handlers.forEach(fn=>fn('SIGNED_IN',session));return {error:null}},
        signOut:async()=>{window.fakeSignOut();return {error:null}}
      },_setup:window.fakeSignOut=()=>{localStorage.removeItem('test-auth-session');handlers.forEach(fn=>fn('SIGNED_OUT',null));}}};`,
    }));
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('/v2.html');
    await page.waitForFunction(() => document.documentElement.dataset.v2Ready === 'true');
    await page.evaluate(() => new Promise((resolve, reject) => {
      const request = indexedDB.open('nodeboard-v2-pending-cloud', 1);
      request.onupgradeneeded = () => {
        const store = request.result.createObjectStore('pending', { keyPath: ['accountId', 'boardId'] });
        store.add({ accountId: 'alice', boardId: 'old-board', kind: 'history',
          payload: { operationId: 'old-op', baseRevision: 0, direction: 'undo' } });
      };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => { request.result.close(); resolve(); };
    }));
    await expect(page.locator('#account-area')).toBeVisible();
    await page.locator('#account-email').fill('alice@example.test');
    await page.getByRole('button', { name: 'Send sign-in code' }).click();
    await expect(page.locator('#account-code')).toBeVisible();
    expect(await page.evaluate(() => window.sentCode)).toEqual({ email: 'alice@example.test', options: { shouldCreateUser: true } });
    await page.locator('#account-code').fill('123456');
    await page.getByRole('button', { name: 'Verify code' }).click();
    await expect(page.locator('#account-identity')).toHaveText('alice@example.test');
    await page.locator('#board-name').fill('Cloud workspace');
    await page.getByRole('button', { name: 'Create board' }).click();
    await page.locator('#class-name').fill('Service');
    await page.getByRole('button', { name: 'Add class' }).click();
    await page.locator('#entity-name').fill('Local original');
    await page.getByRole('button', { name: 'Add entity' }).click();
    await expect(page.locator('#graph-nodes')).toContainText('Local original');
    const interceptCreate = async route => {
      if (route.request().method() !== 'POST') { await route.continue(); return; }
      await route.fetch();
      await route.abort('failed');
      await page.unroute('**/api/v2/boards', interceptCreate);
    };
    await page.route('**/api/v2/boards', interceptCreate);
    await page.getByRole('button', { name: 'Copy board to account' }).click();
    await expect(page.getByRole('button', { name: 'Retry pending account copy' })).toBeVisible();
    await expect(page.locator('body')).toHaveAttribute('aria-busy', 'false');
    await page.reload();
    await page.waitForFunction(() => document.documentElement.dataset.v2Ready === 'true');
    await page.locator('#boards').getByRole('button', { name: 'Cloud workspace' }).click();
    await expect(page.getByRole('button', { name: 'Retry pending account copy' })).toBeVisible();
    await page.getByRole('button', { name: 'Retry pending account copy' }).click();
    await expect(page.locator('#status')).toContainText('Board copied to your account.');
    const upgraded = await page.evaluate(() => new Promise((resolve, reject) => {
      const request = indexedDB.open('nodeboard-v2-pending-cloud', 2);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const get = db.transaction('pending').objectStore('pending').get(['alice', 'old-board']);
        get.onerror = () => { db.close(); reject(get.error); };
        get.onsuccess = () => { db.close(); resolve(get.result); };
      };
    }));
    expect(upgraded.payload.operationId).toBe('old-op');
    await expect(page.getByRole('button', { name: 'Undo' })).toBeDisabled();
    await page.locator('.graph-node').filter({ hasText: 'Local original' }).click();
    await page.locator('#inspector > form textarea').fill('Cloud edit');
    await page.getByRole('button', { name: 'Save name' }).click();
    await expect(page.locator('#graph-nodes')).toContainText('Cloud edit');
    await page.getByRole('button', { name: 'Undo' }).click();
    await expect(page.locator('#graph-nodes')).toContainText('Local original');
    await page.getByRole('button', { name: 'Redo' }).click();
    await expect(page.locator('#graph-nodes')).toContainText('Cloud edit');
    const beforeRetryRevision = Number((await page.locator('#board-revision').textContent()).replace('Revision ', ''));
    await page.route('**/api/v2/boards/*/operations', async route => {
      await route.fetch();
      await route.abort('failed');
    }, { times: 1 });
    await page.locator('#class-name').fill('Reconciled class');
    await page.getByRole('button', { name: 'Add class' }).click();
    await expect(page.getByRole('button', { name: 'Retry pending account change' })).toBeVisible();
    await expect(page.locator('body')).toHaveAttribute('aria-busy', 'false');
    await page.locator('#class-name').fill('Blocked while pending');
    await page.getByRole('button', { name: 'Add class' }).click();
    await expect(page.locator('#status')).toContainText('Retry the pending account change');
    await page.reload();
    await page.waitForFunction(() => document.documentElement.dataset.v2Ready === 'true');
    await page.locator('#cloud-boards').getByRole('button', { name: 'Cloud workspace' }).click();
    await expect(page.getByRole('button', { name: 'Retry pending account change' })).toBeVisible();
    await page.getByRole('button', { name: 'Retry pending account change' }).click();
    await expect(page.locator('#classes')).toContainText('Reconciled class');
    expect(await page.locator('#classes').getByText('Reconciled class', { exact: true }).count()).toBe(1);
    await expect(page.locator('#board-revision')).toHaveText(`Revision ${beforeRetryRevision + 1}`);
    await expect(page.getByRole('button', { name: 'Retry pending account change' })).toBeHidden();
    await expect(page.locator('#classes')).not.toContainText('Blocked while pending');
    await page.route('**/api/v2/boards/*/history', async route => {
      await route.fetch();
      await route.abort('failed');
    }, { times: 1 });
    await page.getByRole('button', { name: 'Undo' }).click();
    await expect(page.getByRole('button', { name: 'Retry pending account change' })).toBeVisible();
    await page.reload();
    await page.waitForFunction(() => document.documentElement.dataset.v2Ready === 'true');
    await page.locator('#cloud-boards').getByRole('button', { name: 'Cloud workspace' }).click();
    await page.getByRole('button', { name: 'Retry pending account change' }).click();
    await expect(page.getByRole('button', { name: 'Retry pending account change' })).toBeHidden();
    await expect(page.locator('body')).toHaveAttribute('aria-busy', 'false');
    await expect(page.locator('#classes')).not.toContainText('Reconciled class');
    await page.getByRole('button', { name: 'Redo' }).click();
    await expect(page.locator('#classes')).toContainText('Reconciled class');
    await expect(page.getByRole('button', { name: 'Manage sharing' })).toBeVisible();
    await page.route('**/api/v2/boards/*/operations', route => route.abort('failed'), { times: 1 });
    await page.locator('#class-name').fill('Offline class');
    await page.getByRole('button', { name: 'Add class' }).click();
    await expect(page.getByRole('button', { name: 'Retry pending account change' })).toBeVisible();
    const accountBoards = await (await request.get('/api/v2/boards', { headers: auth('alice') })).json();
    let remoteBoard;
    for (const boardId of accountBoards.ids) {
      const candidate = await (await request.get(`/api/v2/boards/${boardId}`, { headers: auth('alice') })).json();
      if (candidate.snapshot.metadata.name === 'Cloud workspace') remoteBoard = candidate;
    }
    expect(remoteBoard).toBeTruthy();
    const remoteOntology = structuredClone(remoteBoard.snapshot.ontology);
    remoteOntology.classes.push({ id: 'remote-class', name: 'Remote class', superclassIds: [], abstract: false, propertyDefinitionIds: [] });
    const remoteEdit = await request.post(`/api/v2/boards/${remoteBoard.id}/operations`, {
      headers: auth('alice'), data: {
        protocolVersion: 2, snapshotVersion: 2, operationId: 'independent-device-edit',
        baseRevision: remoteBoard.revision, operations: [{ type: 'ontology.replace', ontology: remoteOntology }],
      },
    });
    expect(remoteEdit.status()).toBe(200);
    await page.getByRole('button', { name: 'Retry pending account change' }).click();
    await expect(page.locator('#status')).toContainText('Reload');
    await expect(page.getByRole('button', { name: 'Retry pending account change' })).toBeHidden();
    await page.getByRole('button', { name: 'Reload board' }).click();
    await expect(page.locator('#classes')).toContainText('Remote class');
    await expect(page.locator('#classes')).not.toContainText('Offline class');
    await page.getByRole('button', { name: 'Boards', exact: true }).click();
    await expect(page.locator('body')).toHaveAttribute('aria-busy', 'false');
    await page.locator('#boards').getByRole('button', { name: 'Cloud workspace' }).click();
    await expect(page.locator('#graph-nodes')).toContainText('Local original');
    await expect(page.locator('#graph-nodes')).not.toContainText('Cloud edit');
    await page.getByRole('button', { name: 'Boards', exact: true }).click();
    await expect(page.locator('body')).toHaveAttribute('aria-busy', 'false');
    await page.locator('#cloud-boards').getByRole('button', { name: 'Cloud workspace' }).click();
    await expect(page.locator('#graph-nodes')).toContainText('Cloud edit');

    const other = await context.newPage();
    other.on('pageerror', error => errors.push(error.message));
    await other.goto('/v2.html');
    await other.waitForFunction(() => document.documentElement.dataset.v2Ready === 'true');
    await other.locator('#cloud-boards').getByRole('button', { name: 'Cloud workspace' }).click();
    await page.locator('#class-name').fill('Cloud class');
    await page.getByRole('button', { name: 'Add class' }).click();
    await expect(page.locator('#classes')).toContainText('Cloud class');
    await other.locator('#class-name').fill('Stale class');
    await other.getByRole('button', { name: 'Add class' }).click();
    await expect(other.locator('#status')).toContainText('Reload');
    await other.getByRole('button', { name: 'Reload board' }).click();
    await expect(other.locator('#classes')).toContainText('Cloud class');
    await expect(other.locator('#classes')).not.toContainText('Stale class');
    await page.getByRole('button', { name: 'Copy displayed board to local' }).click();
    await expect(page.locator('#status')).toContainText('Displayed board copied locally.');
    await expect(page.locator('#graph-nodes')).toContainText('Cloud edit');
    await page.getByRole('button', { name: 'Boards', exact: true }).click();
    await expect(page.locator('body')).toHaveAttribute('aria-busy', 'false');
    await expect(page.locator('#boards').getByRole('button', { name: 'Cloud workspace' })).toHaveCount(2);
    let releaseResponse, observedRequest;
    const gate = new Promise(resolve => { releaseResponse = resolve; });
    const observed = new Promise(resolve => { observedRequest = resolve; });
    await other.route('**/api/v2/boards/*/operations', async route => {
      const response = await route.fetch();
      observedRequest();
      await gate;
      await route.fulfill({ response });
    });
    await other.locator('#class-name').fill('Pending class');
    await other.getByRole('button', { name: 'Add class' }).click();
    await observed;
    await other.evaluate(() => window.fakeSignOut());
    await expect(other.locator('#editor')).toBeHidden();
    await expect(other.locator('#account-sign-in')).toBeVisible();
    releaseResponse();
    await expect(other.locator('#status')).toContainText('board changed while the operation was pending');
    await expect(other.locator('#editor')).toBeHidden();
    await other.close();
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page.locator('#account-sign-in')).toBeVisible();
    await expect(page.locator('#account-signed-in')).toBeHidden();
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});
