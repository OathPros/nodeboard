import { test, expect } from '@playwright/test';
import { createHmac } from 'node:crypto';

const token = sub => {
  const message = `fixture.${Buffer.from(JSON.stringify({ sub, exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}`;
  return `${message}.${createHmac('sha256', 'test-only-secret').update(message).digest('base64url')}`;
};
const auth = sub => ({ Authorization: `Bearer ${token(sub)}` });
const graph = { classes: [{ id: 'c1', key: 1, name: 'Service', shape: 'rounded', color: '#e05a72' }], nodes: [{ id: 'n1', x: 0, y: 0, name: 'Private node', classId: 'c1' }], edges: [] };
const api = '/api/documents';

test('private documents enforce ownership, sharing and live revocation', async ({ request, browser }) => {
  for (const user of ['alice', 'bob', 'eve']) expect((await request.get('/api/account', { headers: auth(user) })).status()).toBe(200);
  expect((await request.get(api)).status()).toBe(401);
  expect((await request.get(api, { headers: { Authorization: 'Bearer forged' } })).status()).toBe(401);
  const forged = token('alice').split('.');forged[1] = token('eve').split('.')[1];
  expect((await request.get(api, { headers: { Authorization: `Bearer ${forged.join('.')}` } })).status()).toBe(401);
  const created = await request.post(api, { headers: auth('alice'), data: { name: 'Private board', graph } });
  expect(created.status()).toBe(201);
  const { id } = await created.json();
  try {
    expect((await request.get(`${api}/${id}`, { headers: auth('eve') })).status()).toBe(404);
    expect((await (await request.get(api, { headers: auth('eve') })).json()).documents).toEqual([]);
    expect((await request.get(`${api}/${id}/members`, { headers: auth('eve') })).status()).toBe(404);
    expect((await request.post(`${api}/${id}/share`, { headers: auth('alice'), data: { email: 'unknown@example.test', role: 'editor' } })).status()).toBe(404);
    expect((await request.post(`${api}/${id}/share`, { headers: auth('alice'), data: { email: 'bob@example.test', role: 'viewer' } })).status()).toBe(200);
    expect((await (await request.get(`${api}/${id}`, { headers: auth('bob') })).json()).role).toBe('viewer');
    expect((await request.delete(`${api}/${id}`, { headers: auth('bob') })).status()).toBe(403);

    const page = await browser.newPage();
    const connect = (url, bearer) => page.evaluate(({ url, bearer }) => new Promise(resolve => {
      const ws = new WebSocket(url); window.testSocket = ws;
      ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', token: bearer, clientId: 'testclient', name: 'Test' }));
      ws.onmessage = event => { const m = JSON.parse(event.data); if (m.type === 'welcome' || m.type === 'error') resolve(m); };
      ws.onerror = () => resolve({ type: 'connection-error' });
    }), { url, bearer });
    await page.goto('/');
    const base = `ws://127.0.0.1:8790/api`;
    expect((await connect(`${base}/sessions/${id}/ws`, token('bob'))).type).toBe('connection-error');
    expect((await connect(`${base}/documents/${id}/ws`, token('eve'))).type).toBe('error');
    const welcome = await connect(`${base}/documents/${id}/ws`, token('bob'));
    expect(welcome.role).toBe('viewer');
    expect(welcome.graph.nodes[0].name).toBe('Private node');
    const mutation = await page.evaluate(() => new Promise(resolve => {
      testSocket.onmessage = e => { const m = JSON.parse(e.data); if (m.type === 'error') resolve(m); };
      testSocket.send(JSON.stringify({ type: 'ops', opId: 'attempt', ops: [{ type: 'node.patch', id: 'n1', patch: { name: 'Hacked' } }] }));
    }));
    expect(mutation.code).toBe('FORBIDDEN');
    await page.evaluate(() => { window.socketClosed = false; testSocket.onclose = () => { window.socketClosed = true; }; });
    expect((await request.post(`${api}/${id}/unshare`, { headers: auth('alice'), data: { email: 'bob@example.test' } })).status()).toBe(200);
    await expect.poll(() => page.evaluate(() => window.socketClosed)).toBe(true);
    expect((await request.get(`${api}/${id}`, { headers: auth('bob') })).status()).toBe(404);
    expect((await (await request.get(api, { headers: auth('bob') })).json()).documents).toEqual([]);
    await page.close();
  } finally {
    expect((await request.delete(`${api}/${id}`, { headers: auth('alice') })).status()).toBe(200);
  }
});

test('document library creates, opens, shares and restores edits', async ({ browser, request }) => {
  async function signedIn(user) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    await page.route('**/auth.js', route => route.fulfill({
      contentType: 'text/javascript',
      body: `window.createNodeboardAuth=()=>({auth:{getSession:async()=>({data:{session:{access_token:${JSON.stringify(token(user))}}}}),onAuthStateChange:()=>{},signOut:async()=>({error:null})}})`,
    }));
    await page.goto('/');
    await expect(page.locator('#documentsBackdrop')).toHaveClass(/show/);
    await page.locator('#closeDocuments').click();
    return { context, page, errors };
  }
  const alice = await signedIn('alice'), bob = await signedIn('bob');
  let id;
  try {
    await expect.poll(async () => (await request.get('/api/account', { headers: auth('bob') })).status()).toBe(200);
    await alice.page.locator('#documentsBtn').click();
    await alice.page.locator('#documentName').fill('Browser document');
    await alice.page.locator('#createDocument').click();
    await expect(alice.page.locator('#liveStatus')).toContainText('Live · connected');
    await expect(alice.page.locator('#scene .node')).toHaveCount(0);
    id = (await (await request.get(api, { headers: auth('alice') })).json()).documents.find(d => d.name === 'Browser document').id;
    await alice.page.locator('#addBtn').click();
    await alice.page.locator('#nodeNameInput').fill('Saved node');
    await alice.page.keyboard.press('Escape');
    await expect(alice.page.locator('#saveLabel')).toContainText('saved to session');
    await alice.page.reload();
    await expect(alice.page.locator('#liveStatus')).toContainText('Live · connected');
    await expect(alice.page.locator('#scene')).toContainText('Saved node');
    await alice.page.locator('#documentsBtn').click();
    await alice.page.locator(`[data-manage-document="${id}"]`).click();
    await alice.page.locator('#shareEmail').fill('bob@example.test');
    await alice.page.locator('#shareRole').selectOption('editor');
    await alice.page.locator('#shareDocument').click();
    await expect(alice.page.locator('#memberList')).toContainText('bob@example.test');
    await bob.page.locator('#documentsBtn').click();
    await expect(bob.page.locator('#documentList')).toContainText('Browser document');
    await bob.page.locator(`[data-open-document="${id}"]`).click();
    await expect(bob.page.locator('#liveStatus')).toContainText('Live · connected');
    await expect(bob.page.locator('#scene')).toContainText('Saved node');
    await bob.page.locator('#scene .node').dblclick();
    await bob.page.locator('#ctxLabel').fill('Edited by Bob');
    await bob.page.keyboard.press('Escape');
    await expect(alice.page.locator('#scene')).toContainText('Edited by Bob');
    await expect(bob.page.locator('#undoBtn')).toBeEnabled();
    await bob.page.locator('#undoBtn').click();
    await expect(alice.page.locator('#scene')).toContainText('Saved node');
    await expect(bob.page.locator('#redoBtn')).toBeEnabled();
    await bob.page.locator('#redoBtn').click();
    await expect(alice.page.locator('#scene')).toContainText('Edited by Bob');
    await alice.page.locator('[data-unshare="bob@example.test"]').click();
    await expect(bob.page.locator('#liveStatus')).toContainText('Local board');
    await alice.page.locator('#returnLocal').click();
    await expect(alice.page.locator('#liveStatus')).toContainText('Local board');
    await expect(alice.page.locator('#scene .node')).toHaveCount(5);
    await alice.page.locator('#documentsBtn').click();
    await alice.page.locator('#documentName').fill('Copy of local');
    await alice.page.locator('#copyDocument').click();
    await expect(alice.page.locator('#liveStatus')).toContainText('Live · connected');
    await expect(alice.page.locator('#scene .node')).toHaveCount(5);
    const docs = (await (await request.get(api, { headers: auth('alice') })).json()).documents;
    const copied = docs.find(d => d.name === 'Copy of local');
    expect(copied).toBeTruthy();
    expect((await request.delete(`${api}/${copied.id}`, { headers: auth('alice') })).status()).toBe(200);
    expect(alice.errors).toEqual([]);
    expect(bob.errors).toEqual([]);
  } finally {
    if (id) await request.delete(`${api}/${id}`, { headers: auth('alice') });
    await alice.context.close();
    await bob.context.close();
  }
});

test('saved class templates are private and create documents with relationships', async ({ browser, request }) => {
  const classes = [
    { id: 'service', key: 1, name: 'Service', shape: 'rounded', color: '#e05a72', relations: [{ to: 'offering', label: 'HAS_OFFERING', inverse: 'IS_OFFERING' }] },
    { id: 'offering', key: 2, name: 'Offering', shape: 'pill', color: '#8c77cf' },
  ];
  expect((await request.get('/api/templates')).status()).toBe(401);
  expect((await request.post('/api/templates', { headers: auth('alice'), data: { name: 'Bad', classes: [] } })).status()).toBe(400);
  const created = await request.post('/api/templates', { headers: auth('alice'), data: { name: 'Services', classes } });
  expect(created.status()).toBe(201);
  const { id } = await created.json();
  let documentId, savedId;
  const context = await browser.newContext();
  try {
    expect((await (await request.get('/api/templates', { headers: auth('bob') })).json()).templates).toEqual([]);
    expect((await request.delete(`/api/templates/${id}`, { headers: auth('bob') })).status()).toBe(404);
    const page = await context.newPage();
    await page.route('**/auth.js', route => route.fulfill({ contentType: 'text/javascript', body: `window.createNodeboardAuth=()=>({auth:{getSession:async()=>({data:{session:{access_token:${JSON.stringify(token('alice'))}}}}),onAuthStateChange:()=>{},signOut:async()=>({error:null})}})` }));
    await page.goto('/');
    await expect(page.locator('#profileIdentity')).toHaveText('alice@example.test');
    await expect(page.locator('#documentsBackdrop')).toHaveClass(/show/);
    await page.locator('#closeDocuments').click();
    await page.locator('#profileBtn').click();
    await page.locator('#profileTemplates').click();
    await expect(page.locator('#templateList')).toContainText('Services');
    await page.locator('#documentName').fill('From template');
    await page.locator(`[data-use-template="${id}"]`).click();
    await expect(page.locator('#liveStatus')).toContainText('Live · connected');
    await expect(page.locator('#palette')).toContainText('Offering');
    const docs = (await (await request.get(api, { headers: auth('alice') })).json()).documents;
    documentId = docs.find(d => d.name === 'From template').id;
    await page.locator('#editRelations').click();
    await expect(page.locator('#relationList')).toContainText('HAS_OFFERING');
    await expect(page.locator('#relationList')).toContainText('IS_OFFERING');
    await page.locator('#closeRelations').click();
    await page.locator('#documentsBtn').click();
    await page.locator('#documentSearch').fill('not found');
    await expect(page.locator('#documentList')).toContainText('No matching documents');
    await page.locator('#documentSearch').fill('From template');
    await expect(page.locator('#documentList')).toContainText('From template');
    await page.locator('#templateName').fill('Saved from board');
    await page.locator('#saveTemplate').click();
    await expect(page.locator('#templateList')).toContainText('Saved from board');
    const saved = (await (await request.get('/api/templates', { headers: auth('alice') })).json()).templates.find(t => t.name === 'Saved from board');
    savedId = saved.id;
    expect(saved.classes).toEqual(classes);
  } finally {
    if (documentId) await request.delete(`${api}/${documentId}`, { headers: auth('alice') });
    if (savedId) await request.delete(`/api/templates/${savedId}`, { headers: auth('alice') });
    await request.delete(`/api/templates/${id}`, { headers: auth('alice') });
    await context.close();
  }
});

test('profile menu and dark mode work at narrow widths and persist', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await page.goto('/');
  const button = page.locator('#profileBtn');
  const box = await button.boundingBox();
  expect(box.x + box.width).toBeLessThanOrEqual(320);
  await button.click();
  await expect(page.locator('#profileAccount')).toHaveText('Sign in');
  await page.locator('#canvasSettingsBtn').click();
  await page.locator('#themeToggle').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await button.click();
  await page.locator('#profileAccount').click();
  await expect(page.locator('#signInGoogle')).toBeVisible();
});

test('email sign-in sends and verifies a one-time code', async ({ page }) => {
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.route('**/auth.js', route => route.fulfill({
    contentType: 'text/javascript',
    body: `window.createNodeboardAuth=()=>{let session=null,callback=()=>{};window.otpRequests=[];return {auth:{
      getSession:async()=>({data:{session}}),
      onAuthStateChange:fn=>{callback=fn},
      signInWithOtp:async args=>{window.otpRequests.push(args);return {error:args.email==='error@example.test'?{message:'Email service unavailable'}:null}},
      verifyOtp:async args=>{window.otpRequests.push(args);if(args.token!=='123456')return {error:{message:'Invalid code'}};session={access_token:${JSON.stringify(token('alice'))}};callback('SIGNED_IN',session);return {error:null}},
      signOut:async()=>({error:null})
    }}}`,
  }));
  await page.goto('/');
  await page.locator('#profileBtn').click();
  await page.locator('#profileAccount').click();
  await expect(page.locator('#sendEmailCode')).toBeEnabled();
  await page.locator('#signInEmail').fill('error@example.test');
  await page.locator('#sendEmailCode').click();
  await expect(page.locator('#documentsError')).toContainText('Email service unavailable');
  await page.locator('#signInEmail').fill('Alice@example.test');
  await page.locator('#sendEmailCode').click();
  await expect(page.locator('#codeSentStatus')).toContainText('alice@example.test');
  await page.locator('#emailCode').fill('000000');
  await page.locator('#verifyEmailCode').click();
  await expect(page.locator('#documentsError')).toContainText('Invalid code');
  await page.locator('#signInEmail').fill('bob@example.test');
  await expect(page.locator('#codeForm')).toBeHidden();
  await page.locator('#signInEmail').fill('alice@example.test');
  await page.locator('#sendEmailCode').click();
  await page.locator('#emailCode').fill('123456');
  await page.locator('#verifyEmailCode').click();
  await expect(page.locator('#accountStatus')).toContainText('alice@example.test');
  await expect(page.locator('#signedIn')).toBeVisible();
  const requests = await page.evaluate(() => window.otpRequests);
  expect(requests[1]).toEqual({ email: 'alice@example.test', options: { shouldCreateUser: true } });
  expect(requests.at(-1)).toEqual({ email: 'alice@example.test', token: '123456', type: 'email' });
  expect(errors).toEqual([]);
});

test('importing JSON creates a separate private document', async ({ browser, request }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.route('**/auth.js', route => route.fulfill({ contentType: 'text/javascript', body: `window.createNodeboardAuth=()=>({auth:{getSession:async()=>({data:{session:{access_token:${JSON.stringify(token('alice'))}}}}),onAuthStateChange:()=>{},signOut:async()=>({error:null})}})` }));
  let originalId, importedId;
  try {
    await page.goto('/');
    await expect(page.locator('#signedIn')).toBeVisible();
    await page.locator('#documentName').fill('Original import test');
    await page.locator('#copyDocument').click();
    await expect(page.locator('#liveStatus')).toContainText('Live · connected');
    originalId = (await (await request.get(api, { headers: auth('alice') })).json()).documents.find(d => d.name === 'Original import test').id;
    await page.locator('#documentsBtn').click();
    await page.locator('#documentName').fill('Imported project');
    await page.locator('#importProjectFile').setInputFiles({ name: 'invalid.json', mimeType: 'application/json', buffer: Buffer.from('{bad') });
    await expect(page.locator('#documentsError')).toContainText('Invalid JSON');
    expect((await (await request.get(api, { headers: auth('alice') })).json()).documents.some(d => d.name === 'Imported project')).toBe(false);
    await page.locator('#importProjectFile').setInputFiles({ name: 'board.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(graph)) });
    await expect(page.locator('#liveStatus')).toContainText('Live · connected');
    await expect(page.locator('#scene')).toContainText('Private node');
    importedId = (await (await request.get(api, { headers: auth('alice') })).json()).documents.find(d => d.name === 'Imported project').id;
    expect(importedId).not.toBe(originalId);
    await page.locator('#documentsBtn').click();
    await page.locator(`[data-open-document="${originalId}"]`).click();
    await expect(page.locator('#scene .node')).toHaveCount(5);
    await expect(page.locator('#scene')).not.toContainText('Private node');
  } finally {
    if (originalId) await request.delete(`${api}/${originalId}`, { headers: auth('alice') });
    if (importedId) await request.delete(`${api}/${importedId}`, { headers: auth('alice') });
    await context.close();
  }
});
