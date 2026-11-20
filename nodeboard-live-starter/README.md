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

## Editing

- Double-click an existing node or line to edit it; click or tab away to save.
  Double-click empty canvas to create a node, or select a node and press Tab to
  add a child.
- Select a node or line and use Ctrl/Cmd+C and Ctrl/Cmd+V, or right-click and
  choose Copy/Paste. The graph clipboard is in the current tab. Pasted nodes are
  independent copies; pasted lines connect the same existing endpoints.
- Open **Relationship templates** to set a title for a directed pair of classes,
  such as Service â†’ HAS_OFFERING â†’ Offering. An optional inverse title creates
  and labels the reverse line. Saving applies titles to existing matching lines
  and supplies defaults for new connections and reclassified nodes. One template
  covers each class pair; inverse titles require two different classes. Removing
  a template leaves existing lines untouched.

## Tests

```bash
npm test          # unit (protocol) + integration tests; integration self-skips if no dev server
npm run test:e2e  # Playwright: local editing regression + 2-editor/1-viewer multiplayer
npm run test:private # private documents with a local fake authentication server
npm run test:all  # typecheck + unit/integration + both E2E suites
```

`npm run test:e2e` auto-starts `wrangler dev` (or reuses one already on port 8787).

## Private accounts and documents

Accounts are optional. Private document access uses Supabase Auth and Google
sign-in; Cloudflare stores the documents and their access lists. A person must
sign in once before an owner can share with their verified account email.
Owners can grant viewer or editor access, change that access, and remove it.
Revocation closes existing connections. A viewer can see and export the board.
Existing local boards and invitation-link sessions remain separate; creating a
private copy does **not** disable existing links.

Signed-in users start at **Home** in a new tab; an active document or invitation
still opens in the editor. Use **Home** to search and manage documents, or open the profile bubble
for sign-in, saved templates, display mode, shortcuts, and JSON export. In
**Saved templates**, save the current board's classes and relationship defaults
to your account. Name a document and choose **New document** beside a template
to create an empty board with those classes; this does not change existing
boards. Templates are private to the account that saved them. Dark mode is
remembered in the current browser.

To configure accounts:

1. Create a Supabase project on the free plan. In Authentication, set the site
   URL and redirect allowlist to the deployed app URL.
2. Set up a Google OAuth **web application**, with the app origin as an authorized
   JavaScript origin and the Supabase Google provider's callback URL as its
   authorized redirect URI. Configure the consent screen for external users;
   testing mode only permits configured test users. Configure the Google client
   ID and secret in Supabase's Google provider settings. Never commit the secret.
3. Configure `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` in `wrangler.jsonc`
   using the Supabase project URL and publishable (or legacy anon) key. These
   values are public, not the service-role key. For local development without
   configured accounts, override these variables with empty values.
4. Run `npm run build`, then deploy. The `v2` Durable Object migration creates
   the document directory; do not remove or rename its binding.

Supabase's free projects may pause after inactivity. Free plan quotas apply to
Supabase and Cloudflare. The private document directory is a single Durable
Object, suitable for a small deployment but a scaling bottleneck. Exports are
the user's backups; deleting a document is permanent.

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
