# Codex starting prompt — Nodeboard Live

You are the lead engineer for **Nodeboard Live**, a lightweight multiplayer graph whiteboard. Your task is to **complete, validate, harden and deploy-ready** the starter app provided in this repository. Read `docs/BUILD_GUIDE.md`, `public/index.html`, `src/index.js`, `wrangler.jsonc`, and `package.json` before editing anything.

The existing HTML is the product and **must remain the design and workflow baseline**. Do not replace it with a generic React app, Mermaid editor, React Flow interface, or a conventional diagramming toolbar. Preserve its visual style, fast graph drawing interactions, context menus, keyboard shortcuts, unlimited node classes, colour/shape duplicate warning with explicit override, local graph persistence, JSON/SVG/PNG exports, and responsive layout.

## Primary objective

Ship a trustworthy web app that a facilitator can open, create a session, share an editor/viewer invite, and collaborate on a graph with 2–20 people in real time. Use **Cloudflare Workers Static Assets + SQLite-backed Durable Objects + WebSocket Hibernation**, same-origin deployment, and no third-party database.

The repo includes a collaboration-aware HTML interface and an initial Worker/Durable Object implementation. **Treat these as unverified starter code**: test them and repair mistakes. Do not say the collaboration works until a true two-browser end-to-end test passes against Wrangler local dev and persistence survives reconnect.

## Order of work

**1. Baseline and tests:** Run install, JS syntax checks, `wrangler dev`, and smoke-test local editor. Add automated tests for the core editor interactions and export. Record baseline so you can detect regressions.

**2. Wire up real collaboration:** Verify `POST /api/sessions`, DO initialization, WebSocket upgrade, authentication, welcome snapshot, graph operations, acknowledgement, presence, role enforcement, and persistence. Fix Worker ↔ browser protocol mismatches. Build integration tests for two concurrent editors and one viewer. Ensure initial sample graph (including legacy short IDs `n1` and `e1`) creates successfully.

**3. Concurrency correctness:** Use secure IDs for newly created nodes/edges, field-level patches (drag x/y should not overwrite a concurrent node rename), stable revisions, idempotent `opId`s, atomic related node+edge creation, and reconnect/replay without duplicate operations. Preserve server authority and reject stale class schema updates with a clear recovery flow. Serialize outgoing mutations in order; never full-graph last-writer-wins on every change.

**4. Fix class identity for multiplayer:** Upgrade classes from position-based numeric identity to stable UUID identity while retaining visible `1..N` shortcuts, and create a legacy JSON migration. Deletion must explicitly reassign nodes transactionally; concurrent deletion/reordering must not corrupt node class assignments. Preserve duplicate colour+shape warning and user override both locally and live.

**5. Presence and UX:** Show connected participants and their distinct colours, remote cursors and selected nodes (ephemeral events, max 10/sec, not stored), clear live/offline/saving/conflict states, reconnect backoff, working clipboard copy, local board restoration when leaving, accessible create/join dialogs and responsive controls.

**6. Security:** Validate every operation on server; editor/viewer role enforcement in DO; high entropy invitation tokens hashed at rest; no token leaks through query strings or logs; origin checks; size/participant/rate limits; rejection of invalid graph references; session creator permissions for token revocation and deletion (add if practicable). Prevent unauthorized access to existing session metadata and graph snapshots. Do not claim that possession-of-link is institutional-grade authentication.

**7. Tests and deployment docs:** Add representative unit, integration and browser E2E tests. Update README with exact `npm install`, `npm run dev`, `npm run deploy`, variables, domain setup, troubleshooting, limitations, and a concise operational checklist.

## Hard acceptance criteria

- Facilitator creates a session from a nonempty local graph, copies an editor invite, joins as another person, adds/renames/moves nodes/relationships from both windows, and both update without refreshing.
- Viewer link loads the graph but cannot modify it, even by hand-crafted WebSocket messages.
- Two simultaneous adds do not overwrite each other. Drag in one window + label edit in another both survive.
- Reload and full disconnect preserve the board. Reconnect after lost ACK does not duplicate a node or operation.
- Class creation and deletion are consistent across clients; 10+ classes work, and duplicate colour/shape combos warn and allow override.
- The current local HTML continues to work offline and retains every existing interaction and export format.
- Server data validates fully and remains unchanged after a malformed operation.
- Browser console free of uncaught errors; no focus jump during quick add/edit; no major visual regression on desktop/mobile.

## Engineering rules

- Make incremental commits and show exactly what changed.
- Do not hand-wave backend work or stop after writing an architecture document. Produce running code and test evidence.
- Keep the frontend framework-free unless there is a strong demonstrable need. Extract modules incrementally rather than rewriting everything.
- Do not implement CRDT/Yjs or a new database merely for novelty. Start with server-ordered per-entity/field operations and documented conflict semantics.
- Make the smallest necessary production-quality changes. Avoid unnecessary features or decorative UI.
- If Cloudflare credentials are unavailable, finish everything locally with Wrangler and give exact deploy commands; do not fabricate a successful deployment.

**Start now:** inspect the repository, run the baseline, then implement and test the first end-to-end live session. Continue through the acceptance matrix in `docs/BUILD_GUIDE.md` and report remaining limitations clearly.
