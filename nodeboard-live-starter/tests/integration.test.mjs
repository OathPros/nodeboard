import test from 'node:test';
import assert from 'node:assert/strict';

// Integration tests run against a live `wrangler dev` instance on 127.0.0.1:8787.
// They self-skip when no dev server is reachable so `npm test` stays usable offline.
const BASE = 'http://127.0.0.1:8787';
const WS_BASE = 'ws://127.0.0.1:8787';

async function serverUp() {
  try { const r = await fetch(BASE + '/api/health', { signal: AbortSignal.timeout(1500) }); return r.ok; }
  catch { return false; }
}

const fixture = () => ({
  classes: [
    { id: 'c1', key: 1, name: 'Service', shape: 'rounded', color: '#e05a72' },
    { id: 'c2', key: 2, name: 'Offering', shape: 'pill', color: '#8c77cf' },
  ],
  nodes: [
    { id: 'n1', x: 0, y: 0, name: 'Service A', classId: 'c1' },
    { id: 'n2', x: 10, y: 20, name: 'Offering A', classId: 'c2' },
  ],
  edges: [{ id: 'e1', from: 'n1', to: 'n2', label: 'HAS_OFFERING' }],
});

async function createSession(graph = fixture(), name = 'integration') {
  const r = await fetch(BASE + '/api/sessions', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, graph }),
  });
  assert.equal(r.status, 201, 'session created');
  return r.json();
}

function connect(session, token, name, extra = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS_BASE}/api/sessions/${session.id}/ws`);
    const client = { ws, msgs: [], name };
    const timer = setTimeout(() => reject(new Error('ws timeout')), 8000);
    ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', token, clientId: 'c-' + name, name, ...extra }));
    ws.onmessage = e => {
      const m = JSON.parse(e.data);
      client.msgs.push(m);
      if (m.type === 'welcome') { clearTimeout(timer); resolve(client); }
      if (m.type === 'error' && m.code === 'UNAUTHORIZED') { clearTimeout(timer); reject(new Error('unauthorized')); }
    };
    ws.onerror = () => { clearTimeout(timer); reject(new Error('ws error')); };
  });
}

const waitFor = (client, pred, ms = 8000) => new Promise((resolve, reject) => {
  const t0 = Date.now();
  const iv = setInterval(() => {
    const m = client.msgs.find(pred);
    if (m) { clearInterval(iv); resolve(m); }
    else if (Date.now() - t0 > ms) { clearInterval(iv); reject(new Error('waitFor timeout')); }
  }, 25);
});

test('integration: collaboration protocol', async (t) => {
  if (!await serverUp()) { t.skip('wrangler dev not running on 127.0.0.1:8787'); return; }

  await t.test('health endpoint responds', async () => {
    const r = await fetch(BASE + '/api/health');
    const body = await r.json();
    assert.equal(body.ok, true);
  });

  await t.test('create/join, broadcast, dedupe, roles, persistence', async () => {
    const s = await createSession();
    const a = await connect(s, s.editToken, 'A');
    assert.equal(a.msgs[0].role, 'editor');
    assert.equal(a.msgs[0].graph.nodes.length, 2);

    const b = await connect(s, s.editToken, 'B');
    assert.equal(b.msgs[0].participants.length, 2);

    a.ws.send(JSON.stringify({ type: 'ops', opId: 'op-int-1', baseClassesRev: 0, ops: [{ type: 'node.upsert', node: { id: 'n3', x: 5, y: 5, name: 'C', classId: 'c1' } }] }));
    const ack = await waitFor(a, m => m.type === 'ack' && m.opId === 'op-int-1');
    const bc = await waitFor(b, m => m.type === 'ops' && m.opId === 'op-int-1');
    assert.equal(bc.revision, ack.revision);

    // duplicate opId -> identical ack, no duplicate node
    a.ws.send(JSON.stringify({ type: 'ops', opId: 'op-int-1', baseClassesRev: 0, ops: [{ type: 'node.upsert', node: { id: 'n3', x: 5, y: 5, name: 'C', classId: 'c1' } }] }));
    const ack2 = await waitFor(a, m => m.type === 'ack' && m.opId === 'op-int-1' && m !== ack);
    assert.equal(ack2.revision, ack.revision);
    const bOpsCount = b.msgs.filter(m => m.type === 'ops' && m.opId === 'op-int-1').length;
    assert.equal(bOpsCount, 1, 'no duplicate broadcast');

    // viewer is forbidden from editing
    const v = await connect(s, s.viewToken, 'V');
    assert.equal(v.msgs[0].role, 'viewer');
    v.ws.send(JSON.stringify({ type: 'ops', opId: 'op-v1', baseClassesRev: 0, ops: [{ type: 'node.delete', id: 'n1' }] }));
    const err = await waitFor(v, m => m.type === 'error');
    assert.equal(err.code, 'FORBIDDEN');

    // persistence across full reconnect
    for (const c of [a, b, v]) c.ws.close();
    await new Promise(r => setTimeout(r, 300));
    const a2 = await connect(s, s.editToken, 'A2');
    assert.equal(a2.msgs[0].graph.nodes.length, 3);
    assert.equal(a2.msgs[0].revision, ack.revision);
    a2.ws.close();
  });

  await t.test('delete wins over stale patch without resurrection', async () => {
    const s = await createSession();
    const a = await connect(s, s.editToken, 'A');
    a.ws.send(JSON.stringify({ type: 'ops', opId: 'op-del', baseClassesRev: 0, ops: [{ type: 'node.delete', id: 'n2' }] }));
    await waitFor(a, m => m.type === 'ack' && m.opId === 'op-del');
    a.ws.send(JSON.stringify({ type: 'ops', opId: 'op-stale', baseClassesRev: 0, ops: [{ type: 'node.patch', id: 'n2', patch: { name: 'ghost' } }] }));
    const err = await waitFor(a, m => m.type === 'error' && m.opId !== 'op-del' || (m.type === 'error'));
    assert.equal(err.code, 'REVISION_CONFLICT');
    const again = await connect(s, s.editToken, 'B');
    assert.equal(again.msgs[0].graph.nodes.length, 1);
    a.ws.close(); again.ws.close();
  });

  await t.test('stale classesRev is rejected', async () => {
    const s = await createSession();
    const a = await connect(s, s.editToken, 'A');
    const b = await connect(s, s.editToken, 'B');
    const classes = [...fixture().classes, { id: 'c3', key: 3, name: 'Team', shape: 'rectangle', color: '#38a99c' }];
    a.ws.send(JSON.stringify({ type: 'ops', opId: 'op-cls-1', baseClassesRev: 0, ops: [{ type: 'classes.replace', classes }] }));
    await waitFor(a, m => m.type === 'ack' && m.opId === 'op-cls-1');
    b.ws.send(JSON.stringify({ type: 'ops', opId: 'op-cls-2', baseClassesRev: 0, ops: [{ type: 'classes.replace', classes: fixture().classes }] }));
    const err = await waitFor(b, m => m.type === 'error');
    assert.equal(err.code, 'CLASS_CONFLICT');
    a.ws.close(); b.ws.close();
  });

  await t.test('reconnect acknowledges already-processed pending ops', async () => {
    const s = await createSession();
    const a = await connect(s, s.editToken, 'A');
    a.ws.send(JSON.stringify({ type: 'ops', opId: 'op-pend-1', baseClassesRev: 0, ops: [{ type: 'node.upsert', node: { id: 'n9', x: 1, y: 1, name: 'P', classId: 'c1' } }] }));
    await waitFor(a, m => m.type === 'ack' && m.opId === 'op-pend-1');
    a.ws.close();
    await new Promise(r => setTimeout(r, 300));
    // client unsure whether op-pend-1 landed: replays pendingOpIds at auth
    const a2 = await connect(s, s.editToken, 'A', { pendingOpIds: ['op-pend-1', 'op-never-sent'] });
    assert.deepEqual(a2.msgs[0].acknowledgedOpIds, ['op-pend-1']);
    // resending the acked op must not duplicate the node
    a2.ws.send(JSON.stringify({ type: 'ops', opId: 'op-pend-1', baseClassesRev: 0, ops: [{ type: 'node.upsert', node: { id: 'n9', x: 1, y: 1, name: 'P', classId: 'c1' } }] }));
    await waitFor(a2, m => m.type === 'ack' && m.opId === 'op-pend-1');
    const check = await connect(s, s.editToken, 'C');
    assert.equal(check.msgs[0].graph.nodes.filter(n => n.id === 'n9').length, 1);
    a2.ws.close(); check.ws.close();
  });

  await t.test('invalid ops leave the graph unchanged', async () => {
    const s = await createSession();
    const a = await connect(s, s.editToken, 'A');
    a.ws.send(JSON.stringify({ type: 'ops', opId: 'op-bad', baseClassesRev: 0, ops: [{ type: 'node.upsert', node: { id: 'bad', x: Infinity, y: 0, name: 'x', classId: 'c1' } }] }));
    const err = await waitFor(a, m => m.type === 'error');
    assert.equal(err.code, 'REVISION_CONFLICT');
    const b = await connect(s, s.editToken, 'B');
    assert.equal(b.msgs[0].graph.nodes.length, 2);
    assert.equal(b.msgs[0].revision, 0);
    a.ws.close(); b.ws.close();
  });

  await t.test('invalid session creation is rejected', async () => {
    const r = await fetch(BASE + '/api/sessions', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'x', graph: { classes: [], nodes: [], edges: [] } }),
    });
    assert.equal(r.status, 400);
  });

  await t.test('owner can rotate links and delete session', async () => {
    const s = await createSession();
    assert.ok(s.ownerToken, 'owner token issued');

    // non-owner cannot rotate
    const forbidden = await fetch(`${BASE}/api/sessions/${s.id}/rotate`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ownerToken: '0'.repeat(48) }),
    });
    assert.equal(forbidden.status, 403);

    // rotate -> old tokens rejected, new tokens work
    const rot = await fetch(`${BASE}/api/sessions/${s.id}/rotate`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ownerToken: s.ownerToken }),
    });
    assert.equal(rot.status, 200);
    const rotated = await rot.json();
    await assert.rejects(connect(s, s.editToken, 'OLD'), /unauthorized/);
    const fresh = await connect(s, rotated.editToken, 'NEW');
    assert.equal(fresh.msgs[0].role, 'editor');
    fresh.ws.close();

    // delete -> session gone
    const del = await fetch(`${BASE}/api/sessions/${s.id}/delete`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ownerToken: s.ownerToken }),
    });
    assert.equal(del.status, 200);
    await assert.rejects(connect(s, rotated.editToken, 'GONE'), /unauthorized|ws error/);
  });

  await t.test('bad token cannot authenticate', async () => {
    const s = await createSession();
    await assert.rejects(connect(s, '0'.repeat(48), 'X'), /unauthorized/);
  });
});
