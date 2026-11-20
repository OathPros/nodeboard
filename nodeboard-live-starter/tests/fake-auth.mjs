import { createServer } from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';

const users = {
  alice: { id: 'alice', email: 'alice@example.test', email_confirmed_at: '2026-01-01' },
  bob: { id: 'bob', email: 'bob@example.test', email_confirmed_at: '2026-01-01' },
  eve: { id: 'eve', email: 'eve@example.test', email_confirmed_at: '2026-01-01' },
};

createServer((req, res) => {
  const token = (req.headers.authorization || '').replace(/^Bearer /, '');
  const parts = token.split('.');
  let payload;
  try { payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString()); } catch {}
  const expected = createHmac('sha256', 'test-only-secret').update(parts.slice(0, 2).join('.')).digest('base64url');
  const actual = Buffer.from(parts[2] || ''), signature = Buffer.from(expected);
  const user = parts[0] === 'fixture' && actual.length === signature.length && timingSafeEqual(actual, signature) && payload?.exp > Date.now() / 1000 && users[payload.sub];
  res.writeHead(user ? 200 : 401, { 'content-type': 'application/json' });
  res.end(JSON.stringify(user || { error: 'invalid token' }));
}).listen(8899, '127.0.0.1');
