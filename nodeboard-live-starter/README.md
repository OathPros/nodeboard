# Nodeboard Live

A fast, framework-free, keyboard-first graph whiteboard with realtime multiplayer on
Cloudflare Workers + SQLite-backed Durable Objects (WebSocket Hibernation).

## Quick start

```bash
npm install
npx playwright install chromium   # one-time, for E2E tests
npm run dev                       # http://127.0.0.1:8787
```

Open the Wrangler address in two browser windows. In window A: **Collaborate ?
Create live session**, copy the **Editor link** into window B. Use the
**View-only invitation** for guests who should not edit. Opening `public/index.html`
directly from disk works as a fully-featured local editor (no server).

## Tests

```bash
npm test          # unit (protocol) + integration tests; integration self-skips if no dev server
npm run test:e2e  # Playwright: local editing regression + 2-editor/1-viewer multiplayer
npm run test:all  # typecheck + unit/integration + E2E
```

`npm run test:e2e` auto-starts `wrangler dev` (or reuses one already on port 8787).

## Deploy

```bash
npx wrangler login
npm run deploy
```

Then verify on the `*.workers.dev` origin:

- `GET /api/health` returns `{"ok":true}`.
- Create a session, open the editor link in an incognito window and on a second
  device/network; edit both ways without refresh.
- A viewer link loads read-only and cannot write (server-enforced).
- Reload / full disconnect / redeploy preserves the graph.
- Invitation tokens only ever travel in the URL fragment (`#s=...&key=...`), never
  in query strings or logs.

Optionally attach a custom domain in Cloudflare; keep the app and API on the same
origin. `wrangler.jsonc` includes the SQLite Durable Object migration
(`new_sqlite_classes`), Static Assets, and worker-first `/api/*` routing.

## How it works

- `public/index.html` — the entire client: local editor, collaboration UI, protocol
  adapter. Framework-free; also runs standalone from disk in local mode.
- `src/index.js` — Worker HTTP router + `BoardSession` Durable Object (embedded
  SQLite tables for nodes/edges/processed ops, KV for session metadata).
- Editing operations are field-level, idempotent (`opId` dedupe log), and applied in
  a single transaction; acknowledgement happens only after persistence.
- Reconnect sends `pendingOpIds`; the server answers with `acknowledgedOpIds` so
  unconfirmed edits are replayed exactly once.
- Node classes have stable UUID identities with visible `1..N` shortcuts; legacy
  numeric-class JSON is migrated on load/import.
- Presence (participants) is persisted-free; remote cursors are ephemeral relays,
  throttled at 10/sec, never stored.
- Access: 192-bit editor/viewer/owner tokens, SHA-256 hashed at rest, compared in
  constant time; Origin checked on the WebSocket handshake; viewer role enforced
  server-side on every mutation; per-IP session-creation throttle; auth-attempt
  limiting; owner can rotate invitation links or delete the session.

## Files

- `docs/BUILD_GUIDE.md` — architecture, protocol, security, acceptance matrix.
- `docs/CODEX_START_PROMPT.md` — original build brief.
- `tests/protocol.test.mjs` — graph/operation validator unit tests.
- `tests/integration.test.mjs` — live WebSocket protocol tests (needs `wrangler dev`).
- `tests/e2e/` — Playwright suites (local regression, multiplayer).

## Known limitations

- Two people editing the *same field* of the same node at the same moment is
  server-ordered last-write-wins (no CRDT). Different fields merge cleanly.
- Undo/redo is local-mode only; collaborative undo is deliberately disabled.
- The per-IP rate limit is per Worker isolate (best-effort); put Cloudflare WAF
  rate limiting or Turnstile in front for a public deployment.
- Sessions have no automatic TTL; delete via the owner's **Delete session** control
  or the `/api/sessions/:id/delete` endpoint.
- Do not put personally identifying or confidential data on a shared board until
  your institutional data classification and retention review is complete.
