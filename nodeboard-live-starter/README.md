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

For the in-progress v2 local workspace, run `npm run build` and open
`public/v2.html` in the same browser origin as the classic editor. Create a
board, add classes and predicates, then add entities and relationships. Boards
are saved in this browser's separate IndexedDB database. Use **Download backup**
and **Restore backup as new board** for a portable copy. **Preview classic
board import** reads the classic local board on the same origin; confirming
creates a separate v2 board without replacing the classic source. When account services are
configured, sign in with an emailed one-time code and use **Copy board to
account** to create a separate private account copy. Owners can grant a
registered account viewer or editor access by email and send it the board link.
Shared boards cannot contain personal views. Edits use revision checks;
account history is owner-only and bounded. Shared boards do not yet provide
live synchronization or an offline change queue.
If an account copy, edit or history request has an uncertain network outcome,
reopen that board and use its retry button. The browser retains the original
request so retrying does not duplicate a committed change. If another device
has edited the board, reload and reconcile the rejected change.
Expand a class or predicate in the ontology panel to change its displayed name;
renaming a predicate does not change its identity or existing relationships.
Use **Class hierarchy** to assign parent classes or mark a class abstract;
invalid cycles and direct instances of an abstract class are rejected.
Create typed property definitions in **Properties** and assign them to classes
in **Class hierarchy**. Enum and enum-list definitions accept explicit choices.
Under **Constraints**, require a property for a class and its subclasses; the
validation panel reports missing values in the draft. Findings associated with
entities or relationships include a control to open the affected record.
**Predicate definition** edits source and target classes, inverse, symmetric
and transitive declarations without rewriting stored relationships. Transitive
inference is not yet implemented.
Select an entity to inspect its connections and open a connected entity.
Inverse and symmetric connections are labelled as derived and identify their
source assertion; they are not saved as separate relationships.
**Find entities** searches names, IDs, classes, properties and external IDs;
select a result to focus it without modifying the board.
Use **Edit relationship** to change its endpoints or predicate explicitly.
An unresolved legacy relationship stays unresolved unless a predicate is
chosen, and its original legacy details remain attached.
**Export native board** downloads the v2 snapshot; **Import native board as new
board** validates it and creates a separate local copy. This does not merge
boards. Raw import files are limited to 10 MB and snapshots to 5 MB.
The **Advanced ontology editor** accepts the ontology JSON, previews changed
definitions and validator findings, and applies a valid preview atomically.
Reload the current ontology before applying a draft based on an older board
revision. Entity and relationship property panels accept JSON objects keyed by
property-definition ID and validate the values against those definitions.
Entity and relationship property panels also allow individual values to be
added, edited or removed. List and structured values use JSON.
Use **Entity classes** to change class membership without discarding properties.
Status and provenance panels edit the explicit status and provenance array;
confidence does not automatically mark a record verified.

## Editing

- Open **Canvas appearance** from the profile menu or the blank canvas menu to
  switch light/dark mode or set a background
  colour and opacity, switch between dots, grid, and no pattern, and adjust
  pattern colour, opacity, and spacing. Changes are saved in this browser,
  apply across boards, and do not affect collaborators or exports. Reset returns
  to the current light or dark theme's defaults.
- Double-click or right-click a node, line, or blank canvas for the same options.
  Edit labels in the menu and click or tab away to save. On the canvas, choose
  **New node** or **New connected node**; alternatively, select a node and press
  Tab to add a child.
- Shift-click nodes to add or remove them from the selection. Drag a selected
  node to move the group; use Delete, class shortcuts, or the group's context
  menu to delete or reclassify them. Copy/paste duplicates the selected nodes
  and their internal connections, not connections to unselected nodes. Click
  blank canvas or press Escape to clear the selection.
- Select a source node, then Ctrl-click (Cmd-click on Mac) another node to
  connect them. The context menu's Connect action also starts a connection.
- Undo and redo with the toolbar, profile menu, Ctrl/Cmd+Z and Ctrl/Cmd+Y
  (or Ctrl/Cmd+Shift+Z). History is kept in the current tab for up to 70
  changes and is cleared on reload or switching boards. On shared boards undo
  applies only your own changes; it is blocked if a later edit conflicts, and
  waits for pending changes to sync. It affects everyone on that board.
- Choose **Save local file** (or **Save local JSON file** in the profile menu)
  to download an editable backup without signing in. **Open local JSON file**
  in the profile menu opens one as the browser's local board after confirmation;
  it does not modify a shared board. Local boards also save automatically in
  browser storage, which may be cleared, so keep file backups.
- Select a node or line and use Ctrl/Cmd+C and Ctrl/Cmd+V, or right-click and
  choose Copy/Paste. The graph clipboard is in the current tab. Pasted nodes are
  independent copies; pasted lines connect the same existing endpoints.
- Open **JSON view** (or the profile menu on smaller screens) to copy the entire
  board or paste edited Nodeboard JSON and replace it. Invalid data is rejected;
  shared-board replacement affects everyone and reconnects participants. Ask
  collaborators to pause and sync their edits before replacing a shared board.
  Replacement can be undone if no conflicting edits intervene. Export a backup first.
- Signed-in users can choose **Import JSON as new document** on Home. The name
  field is optional; the filename is used when it is blank. The original board
  remains unchanged. Imports and replacements are limited to 400 KB of graph
  data and use the same graph schema as the editable JSON export.
- Open **Relationship templates** to set a title for a directed pair of classes,
  such as Service â†’ HAS_OFFERING â†’ Offering. An optional inverse title creates
  and labels the reverse line. Saving applies titles to existing matching lines
  and supplies defaults for new connections and reclassified nodes. One template
  covers each class pair; inverse titles require two different classes. Removing
  a template leaves existing lines untouched.
- In **Edit classes** or **Relationship templates**, choose **Copy / paste JSON**
  to copy, edit, and replace the entire set. Keep the IDs of classes used by
  existing nodes, number `key` values consecutively from 1, and refer to class
  IDs in relationships. Valid shapes are `rounded`, `rectangle`, `pill`,
  `ellipse`, `diamond`, `hexagon`, `document`, and `circle`. A minimal example:

  ```json
  [
    {"id":"service","key":1,"name":"Service","shape":"rounded","color":"#e05a72",
     "relations":[{"to":"offering","label":"HAS_OFFERING","inverse":"IS_OFFERING"}]},
    {"id":"offering","key":2,"name":"Offering","shape":"pill","color":"#8c77cf"}
  ]
  ```

  Changed or new templates update matching existing lines and add missing
  inverse lines; removing a template leaves lines unchanged. Replacement is
  rejected if it would orphan nodes or is invalid. Export a JSON backup first
  for significant changes, especially on shared boards.

## Tests

```bash
npm test          # unit tests; live integration requires explicit opt-in
npm run test:e2e  # Playwright: local editing regression + 2-editor/1-viewer multiplayer
npm run test:private # private documents with a local fake authentication server
npm run test:all  # typecheck + unit/integration + both E2E suites
```

The live integration suite creates persistent test sessions. Run it only against
a disposable local Worker by setting `NODEBOARD_INTEGRATION_URL` to its HTTP
loopback origin. Without that variable the suite skips; if the configured
server is unavailable it fails. The standard Playwright configuration uses
port 8787; do not reuse or stop another user's service. See the repository's
`TESTING.md` for isolated browser configurations and disposable state.

## Private accounts and documents

Accounts are optional. Private document access uses Supabase Auth with a
one-time email code; Cloudflare stores the documents and their access lists. A person must
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

1. Create a **separate** Supabase project for v2. In Authentication, enable
   email sign-ups and confirmation, and set the site URL and redirect allowlist
   to the v2 app URL. Google OAuth is not needed.
2. Configure `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` in `wrangler.jsonc`
   with the new project's URL and publishable (or legacy anon) key. These
   values are public, not the service-role key. They are blank by default;
   local editing remains available without accounts.
3. Configure email delivery and templates as described below. Deploy only
   after confirming the isolated Cloudflare and Supabase settings.

For email codes, enable the Supabase Email provider and configure
[custom SMTP](https://supabase.com/docs/guides/auth/auth-smtp). The default
service is restricted to project-team email addresses and is not suitable for
general users. For example, [Resend's SMTP integration](https://resend.com/docs/send-with-supabase-smtp)
requires a verified sending domain. Enter SMTP credentials in Supabase, never
in this repository. In Supabase's **Magic Link** and **Confirm signup** email
templates, include `{{ .Token }}` so both existing and new users receive a
code, rather than only a link. Keep email confirmation enabled. Check the
provider's quotas and Supabase Auth rate limits and consider CAPTCHA before
opening sign-ups widely. Test delivery and sign-in with a real email address.

Supabase's free projects may pause after inactivity. Free plan quotas apply to
Supabase and Cloudflare. The private document directory is a single Durable
Object, suitable for a small deployment but a scaling bottleneck. Exports are
the user's backups; deleting a document is permanent.

## Deploy

The v2 configuration names the Worker `nodeboard-v2`, distinct from the
original `nodeboard-live`, and starts with no Supabase project configured.
Before deploying, verify that `nodeboard-v2` is not already in use in the
chosen Cloudflare account; choose a different Worker name if it is. Use a
separate workers.dev hostname or domain and a new Supabase project, never the
v1 project. Worker-scoped Durable Objects are created by the migrations in
this configuration; do not point v2 at v1 storage. This setup does not migrate
v1 accounts or documents. Export v1 boards and import them explicitly if needed.
Do not deploy or provision resources until approved.

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
- Shared-board undo/redo is session-local and can be blocked by conflicting
  changes, disconnection, or a request exceeding the 500 KB message limit.
- The per-IP rate limit is per Worker isolate (best-effort); put Cloudflare WAF
  rate limiting or Turnstile in front for a public deployment.
- Sessions have no automatic TTL; delete via the owner's **Delete session** control
  or the `/api/sessions/:id/delete` endpoint.
- Do not put personally identifying or confidential data on a shared board until
  your institutional data classification and retention review is complete.
