# Architecture | proposed, verify at Phase 0

## Observed v1 baseline

Source reviewed in the prior analysis: `nodeboard-live-starter/public/index.html` and `nodeboard-live-starter/src/index.js` on main, observed commit `9ee44fa448078ab08af9f6e092f94250fdeeca46`. Re-audit actual HEAD. Frontend and backend validate separately. Class relationships are embedded in classes; one unordered class pair allowed. `templateFor`, `applyTemplatesToNode`, `addConnection`, `connectNodes`, `saveRelation`, bulk class editing and graph diff/operation paths assume default labels or single connections. Templates can alter existing facts and generate reverse edges. Node coordinates and style are stored alongside entities. Frontend import caps observed: 450 KB file, 400 KB serialized graph, 1,500 classes, 3,000 nodes, 6,000 edges; server message cap 500 KB. Existing app has local board, account documents, collaboration, history, saved templates, export, and Cloudflare Durable Objects. These facts are a starting point, not a complete audit.

## Target boundaries

| Module | Responsibility | Contract |
|---|---|---|
| domain/ontology | Classes, predicates, properties, constraints, versions | Pure typed definitions, no UI |
| domain/graph | Canonical entities, assertions, stable IDs, indices | Transactional commands and reads |
| domain/validation | Structural and semantic checks | Shared diagnostics, deterministic results |
| domain/query | Traversal, filters, paths, inference | Read-only graph queries; explicit limits |
| domain/migration | v1->v2 and versioned migrations | Report, backup, lossless legacy handling |
| application | Commands, sessions, history, permissions | Atomic operation batches |
| storage adapters | Local and cloud persistence | Same graph contract; version negotiation |
| views | Layout, filtering, projection, annotations | No mutation of semantic data |
| UI | Workspaces and accessible interactions | Invokes domain commands |
| interchange | JSON, RDF, CSV, adapters | Explicit loss and feature reports |

Candidate technologies: TypeScript; React/Vite if migration reduces complexity; Cytoscape.js after interaction/performance spike; ELK.js layouts; IndexedDB; existing Workers/Durable Objects; Ajv for structural JSON Schema; custom semantic constraints with defined SHACL mapping. Vitest and Playwright are candidates: use existing tests when appropriate. Do not change stack before an ADR and small prototype.

## Collaboration and storage

Version operations and snapshots; persist canonical data and view state separately; avoid whole-board replacement for small edits. Atomic command batches, revision checks, stable op IDs, idempotency, conflict handling, permission checks, reconnect/replay, durable history and backups. Treat ontology changes as versioned migrations; keep active ontology version with each graph. Define whether a view is personal/shared, and enforce its ACL. Server is authoritative for shared state. Offline edits must surface conflicts rather than overwrite remote facts. Track UI-only edits separately from semantic audit events.

Scale: adjacency and class indices, paginated/limited traversals, viewport culling, virtualization, worker-based layout where justified. Set explicit resource budgets and transaction limits; replace v1 fixed payload assumptions only after safe protocol design. No unbounded path or inference queries.

## Phase 0 audit and architecture review | 2026-11-26

Reviewed `9ee44fa448078ab08af9f6e092f94250fdeeca46` plus the uncommitted v2 setup on `development/v2`. The old `nodeboard-live-starter/docs/BUILD_GUIDE.md` and `docs/CODEX_START_PROMPT.md` describe the earlier whiteboard milestone, including historical claims that are now stale. Preserve the existing keyboard-first UX and existing tests, but the root v2 specifications supersede the old product scope. The v2 launch prompt's explicit architecture gate supersedes the older prompt's direction to proceed directly to implementation.

### Source and data paths

| Area | Actual implementation | V2 implication |
|---|---|---|
| Editor and rendering | `public/index.html`: inline SVG renderer, graph state and interaction code; nodes carry coordinates and optional style overrides, classes carry styles and relation templates. | Extract a pure domain boundary incrementally; renderers and view positions must not define facts. |
| Browser persistence and files | `index.html:153-162,176,345-365,472`: local `nodeboard-v1.1`; v1 JSON export, numeric-class migration, local import/replacement and fallback graph. | Preserve source bytes and metadata before parsing; current startup fallback can replace invalid local data on subsequent persistence. Numeric IDs are generated randomly on migration and unknown numeric class references can fall back to the first class. |
| Validation | `index.html:161,356-360` and `src/index.js:18-23` independently validate overlapping but different rules. Local startup uses the weaker frontend check. | Introduce one authoritative, versioned structural/semantic contract; all entry points need the same diagnostics, limits and failure behavior. |
| Collaboration | `index.html:399-448`, `src/index.js:164-286`: field-level node/edge operations; `BoardSession` SQLite tables and KV metadata; `opId` deduplication, revisions, class revision and server-side validation. Pending edits live in session storage. | Define version negotiation before v2 writes. Explicitly handle idempotency expiry, concurrent schema changes, history and atomic batches; old clients must not write v2 data. |
| Accounts and private documents | `src/index.js:59-72,83-129`, `src/directory.js`, `src/browser-auth.js`: Supabase verified email identity, a directory Durable Object, per-document BoardSession and owner/editor/viewer authorization. | Retain server authorization at every data boundary; a separate v2 Supabase identity store will not automatically preserve v1 user IDs or document ACLs. |
| Build and tests | `package.json`: JavaScript, esbuild for auth, Wrangler Workers/SQLite DOs, Node test runner and Playwright. The HTML also runs from disk. | A framework change is not required for baseline functionality. Any module/bundler transition must retain offline support and existing interactions. |

### Single-predicate and rewrite inventory

- Both frontend `validateGraph` (`index.html:161`) and Worker `validGraph` (`src/index.js:21`) reject more than one relation template for an **unordered class pair**, including opposite directions.
- `templateFor` (`index.html:229`) selects the first class-pair template. `connectNodes` (`:234`) refuses a second directed connection for the same node endpoints and disallows self-connection; however `pasteSelection` (`:238`) can duplicate an edge and the server validator identifies edges by ID rather than enforcing endpoint uniqueness. Existing data may therefore already contain parallel edges.
- `applyTemplatesToNode` (`:230`) relabels incident edges and relabels or creates reverse edges on class changes through `chooseClass` (`:224`) and `setMenuValue` (`:246`). `addConnection` (`:231`) may relabel existing reverse edges or add one.
- `saveRelation` (`:307-312`) replaces the unordered class-pair definition, relabels matching edges and may add inverses. `applyBulkClasses` (`:324-330`) does the same for changed templates. The current UI tells users this happens; v2 must not silently retain that behavior.
- `graphOps` and `historyTarget` (`:180-190,403-413`) only patch/compare selected v1 node and edge fields. Upserts may carry extra fields, but later edits, history, class bulk replacement, template save and whole-board boundaries cannot be assumed to preserve arbitrary v2 data. `parseBoardJson` reconstructs the top-level object with only classes, nodes and edges (`:360`).

### Recommended boundary and compatibility proposal (not approved)

1. Keep the existing app operational while adding a pure, typed domain library usable by browser and Worker. Model independent class, predicate, property and constraint definitions; entities and directed assertions have opaque stable IDs. Positions and styles belong to views/presentation, not canonical facts. A predicate ID, not its label, identifies meaning.
2. Provide one deterministic validator returning structured diagnostics with stable code, severity, JSON path, optional entity ID, message and suggested action. Separate structural errors from semantic warnings and publication blockers. Validate snapshots and operations on both client and authoritative server; enforce bounded sizes, nesting and authorization independently of UI.
3. Use an explicit snapshot version and operation protocol version. Negotiate compatibility before sending snapshots or accepting mutations; reject incompatible clients without changing storage. Apply commands atomically against a revision, use stable operation IDs and an explicit replay/expiry policy, and preserve conflict reporting rather than replacing whole boards silently.
4. Migrate from a read-only captured v1 snapshot into a separate v2 document. Preserve source IDs, literal edge labels/directions, positions, style, unknown fields and a source backup. Do not equate reverse edges with generated inverses without evidence; map ambiguous or unlabeled edges to explicitly unresolved records and diagnostics. Require preview, validation and confirmation before an atomic write.
5. Keep Workers and SQLite Durable Objects as the initial cloud candidate. Compare extracting vanilla modules with TypeScript and a minimal bundler before deciding a UI framework; test SVG against candidate renderers/layout engines on representative generated graphs before selecting one. React, Cytoscape, ELK and Ajv are candidates, not installed or selected.

### Review gate and remaining Phase 0 work

`SCHEMA.md` links draft machine-readable snapshot and operation envelopes and an example. These are structural review artifacts, not a frozen contract or implemented validator; exact limits, identity and duplicate-context rules, full property/constraint semantics, view ACLs, compatibility handshake and rollback behavior remain open. The existing SVG baseline and an isolated Cytoscape prototype were measured as described in `TESTING.md`; the workloads are not equivalent, no layout prototype was performed and no performance budgets have been agreed. On 2026-11-26 the product owner approved proceeding with the architecture; the outstanding technical questions and later gates still require their stated evidence. No production deployment, data migration, infrastructure provisioning or secret changes have occurred.

## Security and rollout

Preserve account/session controls; enforce document access server-side for every read/write and collaboration message. Sanitize text/URLs, avoid raw HTML rendering, defend against oversized inputs and prototype pollution. Keep preview storage, secrets, origins and deployment configuration separate from production. Back up and dry-run migration. Roll back through an established compatible deployment/data plan; never downgrade mutated v2 data without an explicit conversion path.
