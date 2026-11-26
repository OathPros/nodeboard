# Test and release qualification plan

Phase 0 must record existing commands, package manager, baseline failures, hardware/browser and runtime. Add unit/integration and real-browser coverage to existing suites rather than replacing proven tests without justification.

## Regression matrix

| Case | Expected result |
|---|---|
| V1 valid board | Opens; migration preserves identity, original labels, positions, styles and metadata |
| V1 conflicting class templates | v1 checker rejects; v2 migration supports both and reports ambiguities |
| Multiple relationships same source/target | Create, edit, save, reopen, collaborate, export each independently |
| Rename predicate display label | Existing assertion IDs and meaning remain unchanged |
| Change default or class | No automatic semantic rewrite; diagnostics show incompatibility |
| Inverse | Navigation derived; no duplicate stored fact |
| Typed edge properties | Required/order/validity survive storage/history and export |
| Invalid endpoints/class/domain/range | Structural rejection or semantic diagnosis by configured profile |
| Inheritance cycle / disjointness | Deterministic diagnostics |
| Draft vs publish | Missing required relation allowed in draft; strict publication blocked |
| Merge with duplicate IDs | Explicit choices; no name-only merge; cancel/rollback no mutation |
| View layout | Move entity in one view without changing others or semantic facts |
| Collaboration | Concurrent changes, undo/redo, reconnect, conflict and permissions verified in two contexts |
| Query and inference | Bounded paths and expected results; inferred not persisted as verified |
| Export | Lossless native round-trip, documented semantic export limits |
| Security | Unauthorized document/session operations denied; escaping and size bounds tested |
| UI | Keyboard, focus, quick edit, actual browser render, light/dark, narrow width, error recovery |

## Fixture and scale targets

Use supplied small synthetic fixtures for CI and a generated deterministic scale graph (e.g. 300/550, 3k/6k, stretch 10k/25k). Private Phones files may be used locally only with authorization; all names/workflows are not confirmed facts. Measure on agreed hardware; provisional goals: 300-node usable first view <2s, typical local edit p95 <100ms, search <200ms, 3k-node filtered exploration with no multi-second input blocking. Record graph size, browser, machine, cold/warm timings and bottlenecks; revise targets with evidence, not arbitrary success claims.

Test matrix includes existing Chromium tests plus agreed Firefox/WebKit compatibility; accessibility checks and manual keyboard flow; migration dry-run and backup restore. Preview tests must point at isolated environment. Record exact commands, exit status, test counts, failures/skips, screenshots and reproduction steps. No skipped critical tests at release; disclose remaining limitations. Fixture checker tests fixture shape only, not actual app behavior.

## Phase 0 synthetic fixture baseline

From the repository root, after installing the app's locked dependencies and Playwright Chromium:

```powershell
node .nodeboard-v2\scripts\audit_baseline.cjs
python .nodeboard-v2\scripts\check_fixtures.py
```

The first command exercises the actual Worker `validGraph` function and the local-file editor in isolated Chromium contexts. The valid synthetic fixture must import without changing its class/node/edge arrays; the duplicate class-pair and dangling-endpoint fixtures must be rejected without replacing the local graph. It also exports the valid synthetic graph and restores it in a fresh browser context, then reloads and compares all class, node and edge data. This establishes **v1 local behavior**, not a v2 migration, cloud restore or shared-validator test. The second command checks fixture structure only.

To run the existing local/collaboration Chromium suite without reusing a developer's server or storage, choose an unused port and a **new disposable** directory. Playwright clears the `playwright-results` subdirectory of that directory:

```powershell
$env:NODEBOARD_TEST_PORT = "18878"
$env:NODEBOARD_TEST_STATE = "C:\path\to\new-disposable-test-state"
cd nodeboard-live-starter
npx playwright test -c ..\.nodeboard-v2\scripts\playwright_isolated.config.cjs
```

The isolated config starts and stops its own local Wrangler server; it refuses to reuse an existing listener.

## Draft contract checks

The review-only Python tests require `jsonschema[format]` (tested with 4.26.0; use a virtual environment). From the repository root:

```powershell
python -m pip install "jsonschema[format]==4.26.0"
python .nodeboard-v2\scripts\test_draft_contracts.py -v
```

The tests check schema syntax, a synthetic example, malformed shapes, operation envelopes and diagnostic JSON Pointers. They explicitly demonstrate that dangling references require semantic validation; they do not exercise v2 application code. Date-time format validation requires the optional format dependency and fails explicitly when it is absent.

## Isolated v2 domain checks

From `nodeboard-live-starter`, run:

```powershell
node --test tests\v2-graph.test.mjs tests\v2-validation.test.mjs
node ..\.nodeboard-v2\scripts\v2_browser_smoke.cjs
```

The Node tests cover the in-memory graph commands and selected validator behavior. The smoke test bundles those modules with the app's esbuild dependency and exercises a batch in an isolated headless Chromium page; it does not load the editor or connect to a server. These checks do not qualify persistence, migration, authorization, collaboration or a v2 application workflow.

Latest run: 28 Node tests passed and the Chromium smoke passed. The Python contract checks passed all 6 tests; the existing v1 protocol suite passed all 14 tests. No deployed service or pre-existing local server was used.

For the standalone migration prototype, also run `node --test tests\v2-migration.test.mjs` and `node ..\.nodeboard-v2\scripts\v2_migration_browser_smoke.cjs` from `nodeboard-live-starter`. The combined graph, validator and migration suite passed 43 tests, and both isolated Chromium smoke scripts passed. The migration smoke also restores the synthetic source backup into a fresh v1 editor context and checks it after reload; it does not exercise a v2 application UI or durable v2 storage.

Run `node ..\.nodeboard-v2\scripts\v2_local_storage_smoke.cjs` from `nodeboard-live-starter` to test the separate IndexedDB prototype in a disposable Chromium context. The test passed create/reload, two-tab stale-revision rejection, invalid-batch rollback, count- and byte-bounded undo/redo with branching, corrupt-board and corrupt-history rejection, unknown-version read/write rejection, synthetic migration-preview storage and in-memory backup restore to a new board ID. This is not integrated into the editor; browser eviction, backup file UX, cloud collaboration and broader browser compatibility remain untested.

Latest combined run: `node --test tests\v2-graph.test.mjs tests\v2-validation.test.mjs tests\v2-migration.test.mjs tests\protocol.test.mjs` passed 63 tests. All three isolated Chromium scripts passed, including draft/publish required-property diagnostics; the Python contract suite passed 7 tests. Publication remains deliberately blocked and is not qualified by these tests.

After adding provenance validity checks, the same combined Node command passed 65 tests, the Python contract suite passed 7 tests and all three isolated Chromium scripts passed. Browser checks additionally cover validity ordering and provenance surviving undo/redo.

After adding cardinality checks, the combined Node suite passed 67 tests, the Python contract suite passed 8 tests and all three isolated Chromium scripts passed. The first cardinality test exposed an implementation error, which was corrected and rerun successfully.

After adding property uniqueness, the combined Node suite passed 69 tests, the Python contract suite passed 9 tests and all three isolated Chromium scripts passed. The first uniqueness run exposed an implementation error, which was corrected and rerun successfully.

After adding class disjointness, the combined Node suite passed 71 tests, the Python contract suite passed 10 tests and all three isolated Chromium scripts passed.

Validator diagnostic-limit and schema-alternative tests passed in the combined 73-test Node run; the Python contract suite passed 10 tests, typecheck passed and all three isolated Chromium scripts passed. The local storage smoke also restores and reopens a 5,000,000-byte snapshot whose backup envelope is larger than the snapshot limit, rejects an oversized snapshot without writing and rejects a board whose validation exceeded the diagnostic limit. These remain prototype checks, not integrated application tests.

After adding provisional acyclicity, `node --test tests\v2-validation.test.mjs tests\v2-graph.test.mjs tests\v2-migration.test.mjs tests\protocol.test.mjs` passed 76 tests and `npm run typecheck` passed. `test_draft_contracts.py -v` passed 11 tests. The three isolated Chromium domain, migration and storage scripts passed, including a cycle warning through local undo/redo. An initial run caught a malformed draft-schema edit; the schema was corrected before the successful rerun.

After adding allowed-target constraints, the combined Node suite passed 78 tests, the contract suite passed 12 tests, typecheck passed and all three isolated Chromium scripts passed. Tests cover inherited source and target classes, multiple applicable constraints, non-asserted links and malformed references.

`node .nodeboard-v2\scripts\v2_migration_browser_smoke.cjs` passed with a synthetic board imported through the real v1 editor, followed by local v2 preview, source-change rejection, confirmed creation, duplicate rejection and reopen. It verifies the captured SHA-256 with Node, checks that the v1 source was unchanged by migration and covers missing, unavailable and oversized sources. No real user data was used.

After adding equality-conditional requiredness, the combined Node suite passed 80 tests, the contract suite passed 13 tests and all three isolated Chromium scripts passed. These are provisional constraint checks; publication and application integration are not complete.

After adding local board discovery and strict v2 identifier matching, the combined 80-test Node run and isolated IndexedDB Chromium smoke passed. The browser test covers keyset pagination, invalid options and identifiers, getter rejection and an invalid stored key.

After adding local retry tracking, the combined Node suite passed 80 tests, 13 contract tests passed, typecheck passed and all three isolated Chromium scripts passed. The IndexedDB script checks concurrent identical submissions, retained ID reuse, retries after later edits and undo, reopen, failed writes, version-1 database upgrade, count and byte eviction, and atomic rollback when the retry index is unavailable. The synthetic 3,000-entity/6,000-relationship storage benchmark measured 632, 746 and 1,057 ms for edits and 1,189 ms for undo; it still fails the provisional 100 ms target and is not release qualification.

After adding retry-record integrity validation, the IndexedDB script passed again, including a corrupted-record rejection without changing the board. The same exploratory benchmark measured 1,013, 1,134 and 1,260 ms for edits and 1,559 ms for undo. These are isolated samples on a shared machine, not a controlled comparison.

After adding bounded glob constraints, the combined Node suite passed 82 tests, 14 contract tests passed, typecheck passed and all three isolated Chromium scripts passed. The storage test verifies pattern-work exhaustion rejects a write. An initial Node run caught an incorrectly nested validation loop; it was fixed and rerun successfully.

The local workspace is tested from `nodeboard-live-starter` with `npm run build` and `node ..\.nodeboard-v2\scripts\v2_workspace_smoke.cjs`. Both passed on Windows with Chromium 156: the isolated flow creates a board, classes, predicates and two parallel links, renames/deletes and undoes/redoes, rejects a stale tab edit, downloads/restores a backup, reloads and imports a synthetic classic board. It also checks keyboard selection, long names in selectors and editable fields, and layout at 390px in light and dark color schemes. It does not qualify cloud collaboration, full accessibility or release-scale behavior.

The same workspace smoke passed after adding class and predicate display-name editing. It checks focus after saving, class rename undo/redo, unchanged assertion IDs, and exported predicate identity and references. The 82-test graph, validation, migration and existing protocol Node suite and `npm run typecheck` passed.

A separate `wrangler dev --local` instance on `127.0.0.1:18879`, with session-local state, served `/api/health`, `/v2.html`, `/v2.js` and `/v2.css` with HTTP 200. It was stopped after the check. This does not test a deployed Worker.

The workspace smoke also passed native snapshot export/import/export across separate Chromium contexts with exact snapshot equality. It checks malformed JSON retries, semantic invalid-reference diagnostics, no board creation on invalid input and successful reload after import. File imports are capped at 10,000,000 raw bytes and the existing snapshot validator applies its own 5,000,000-byte serialized limit.

The workspace smoke passed advanced ontology preview/application of a required rule and typed properties, diagnostic display, ontology undo/redo, invalid-ontology rejection, stale-draft rejection and two-tab conflict handling. It also checks invalid typed entity-property rollback, integer entity and boolean relationship property persistence, relationship-property undo/redo, focus after save and native export contents. This is a local JSON-based editing path, not a complete visual ontology studio or release qualification.

The workspace smoke also passed class reassignment with retained typed properties, relationships and undo; incompatible values produce warnings. Entity and relationship status/provenance checks include rejecting a reversed validity range without a write, preserving explicit source and confidence without inventing verification, export and relationship status undo/redo.

With an unused port pair and a new disposable state directory, run `npx playwright test -c ..\.nodeboard-v2\scripts\playwright_v2_cloud.config.cjs` from the app directory after setting `NODEBOARD_TEST_STATE` to that directory. The isolated suite passed 3 tests with a fake authentication service: owner separation, version negotiation, concurrent stale-write rejection, atomic retry, invalid/oversized rollback, count/byte-bounded cloud history, simulated email-code UI, explicit copies, two-tab conflicts and sign-out while a write response is delayed. This does not test real SMTP, deployed Cloudflare, v2 sharing or real-time synchronization.

The same suite also passed simulated lost acknowledgements for account-board creation, edit and undo: retry after reload reused the original identity without a duplicate commit. It exercised the pending-store IndexedDB upgrade and a retry conflicting with an independent device edit. Pending requests are browser-local and one per board; this is not a full offline queue.

The expanded suite passed 5 tests, including separate viewer/editor browser contexts, shared-link email-code sign-in and sign-out, role changes, a stale shared edit, shared-edit lost-ack retry, revocation on reload, invalid grants, unauthorized shared routes and personal-view rejection. A fake-auth email-change and reassignment scenario verifies revocation targets the original member ID. Undo/redo acknowledgements and retries retain the owner role and sharing controls. It also checked the sharing link wraps without page overflow at 390px. It does not establish real-time synchronization or deployed authentication.

Classic Node integration tests create persistent sessions and now require `NODEBOARD_INTEGRATION_URL` pointing to an explicitly selected disposable HTTP loopback Worker. Without it they skip; an unavailable configured endpoint fails. An opt-in run against disposable port 18884 passed 10 tests. One earlier `npm test` unexpectedly contacted the existing service on port 8787 and created seven synthetic sessions, one of which the test deleted; six may persist. Its ownership and data location are unknown, and no cleanup was attempted.

The existing classic regression suites also passed in disposable Wrangler state: 40 local/collaboration Playwright tests on port 18878 via `playwright_isolated.config.cjs`, and 6 private-document tests on ports 18882/18883 via `playwright_private_isolated.config.cjs`. Both configs require `NODEBOARD_TEST_STATE`; neither reused an existing server. The 82-test combined Node suite and local workspace smoke passed.

After the sharing changes, those isolated classic suites passed again (40 and 6 tests), as did the 82 focused Node tests, the local workspace smoke, browser build and Worker syntax check.

The local workspace smoke now imports a synthetic graph with inverse, symmetric, unresolved and self-linked relationships, navigates between entities and confirms that revision and native export are unchanged. The shared viewer browser test also exercises read-only connection navigation. The build, 82 focused Node tests, local workspace smoke and 5 isolated account tests passed after this addition; this does not qualify a full Graph Explorer.

The local smoke also edits source/target/predicate, explicitly resolves an unresolved legacy relationship, compares preserved ID/status/properties/provenance/legacy details in exports, and undoes changes. The isolated account suite passed shared-editor relationship editing and confirmed the viewer has no relationship edit control.

Entity search passed local Chromium checks for ID, class and property matching, zero results, focus, unchanged revision, safe text rendering and long mobile result wrapping. The 5-test isolated account suite also passed viewer search. Search performance at release scale is unmeasured.

Guided hierarchy editing passed the local workspace smoke: marking a class abstract, assigning a parent, rejecting a cycle and direct abstract instance without writes, preserving graph data and undoing the assignment. The isolated account suite passed shared-editor hierarchy editing and viewer restrictions.

Guided predicate definition editing passed local Chromium checks for source/target classes, inverse, symmetry, transitive flag, derived navigation, unchanged assertions and undo. The isolated account suite passed shared-editor updates and viewer restrictions. The transitive declaration is stored but no transitive inference is implemented.

Property-definition creation passed local Chromium checks for enum and enum-list choices, accessible removal/focus, duplicate rejection without writes, class assignment, invalid typed value rejection and export. The isolated account suite passed shared-editor creation/assignment and viewer restrictions. Existing definition editing remains open.

Individual property controls passed local checks for enum selection, preservation of unrelated values, removal/undo, enum-list JSON and explicit false booleans without provenance/status changes. The isolated account suite passed an editor's integer update and owner readback. List/structured controls still use JSON; not every data type has been separately browser-tested.

Guided required-property constraints passed local Chromium checks for creation, duplicate rejection, missing-value diagnostics, unchanged assertions, undo/redo and confirmed removal. The isolated account suite passed shared-editor creation and viewer restrictions. An initial run exposed a misplaced event-handler registration; it was corrected before the successful rerun.

Finding links passed local Chromium tests for entity and relationship focus, including an entity and relationship with the same ID. The isolated shared-board suite passed editor and viewer finding navigation. Ontology-level findings do not yet have navigation controls.

Atomic connected-entity creation passed `npm run build` and `node ..\.nodeboard-v2\scripts\v2_workspace_smoke.cjs` from the app directory. The test verifies a new entity, outgoing asserted relationship and view placement, preservation of existing graph records, and undo/redo of the entire batch. The isolated shared-board browser case passed using `node .\node_modules\@playwright\test\cli.js test -c ..\.nodeboard-v2\scripts\playwright_v2_cloud.config.cjs -g 'sharing UI'` and a fresh disposable `NODEBOARD_TEST_STATE`: viewers cannot create, editors can create, and owners can read the result. An initial full-suite invocation exited with Windows status `-1073740791` before producing test results; its orphaned fake-auth child was stopped by PID, and the focused direct-CLI rerun passed. This does not qualify production infrastructure.

Pending-edit recovery passed the isolated five-test cloud suite with a fresh disposable state, `npm run build`, `npm run typecheck`, and the local workspace smoke. The shared-browser flow checks an already-committed lost acknowledgement after a downgrade to viewer, export of account/owner/board identity and payload, cancellation, failed fresh read retaining the retry, confirmed discard, and an unsent change being discarded without changing the board. It also verifies a subsequent edit after restoring editor access. Early runs exposed asynchronous test-dialog races; the test now waits for each dialog and operation completion before continuing. The exported JSON can contain board data and is not an import or automatic reconciliation mechanism.

Saved entity-membership views passed `npm run build`, the local workspace smoke and all five isolated account tests. Local checks cover creation, membership changes without changing facts or other views, undo/redo, navigation outside the view, deletion/undo, and connected creation in the selected view. The shared-account flow covers editor creation, owner readback and viewer access without editing controls. Existing positions, viewport and query data remain intact but are not rendered or evaluated; layout and query behavior are not qualified.

Run `node .nodeboard-v2\scripts\v2_validator_benchmark.mjs` from the repository root for three local Node measurements of `validateSnapshot` on a generated 3,000-entity/6,000-assertion snapshot (1,227,226 JSON bytes, no views). These measurements are not browser interactions, a p95 benchmark or release qualification; full-snapshot validation may exceed the proposed local edit budget at this size.

On the machine described below with Node 24.15.0, the three trials took 220, 206 and 227 ms, each with the expected incomplete-validation warning and no errors.

Run `node .nodeboard-v2\scripts\v2_storage_benchmark.cjs` from the repository root for a disposable headless Chromium test of three edits and one undo on a 3,000-entity/6,000-assertion graph. On the machine/browser described below, edits took 564, 741 and 978 ms, and undo took 1,142 ms. These are exploratory sequential samples, not p95 measurements. Full-snapshot validation and history do not meet the provisional 100 ms edit target in these trials; optimize and remeasure before release.

## Existing SVG renderer measurement

Run `node .nodeboard-v2\scripts\renderer_baseline.cjs` from the repository root with the app's locked npm dependencies and Playwright Chromium installed. It generates graphs locally, loads the real editor through `file://` in a fresh isolated context for each trial, checks rendered SVG node/edge counts and uncaught errors, and reports elapsed navigation through two animation frames. It does not access the user's local board, a server or private fixtures.

On 2026-11-26, Windows 11 Pro 64-bit, Intel Core i7-11700F (16 logical processors), approximately 16 GB RAM, Node 24.15.0, Chromium 156.0.8078.4, 1280x800 viewport:

| Synthetic graph | Three elapsed trials |
|---|---|
| 300 nodes / 550 edges | 337, 200, 195 ms |
| 3,000 nodes / 6,000 edges | 1,351, 1,312, 1,304 ms |

These are local headless measurements on one machine, including generated graph initialization and startup; the browser process is reused while each context is fresh. They do not measure interaction latency, memory, accessibility, layouts, filtered exploration, network/cloud performance or competing renderers. They are not release qualification or a renderer selection.

## Isolated Cytoscape prototype

The candidate was installed outside the repository in session storage with `npm install --prefix <isolated-directory> cytoscape@3.35.0`; no app dependency was changed. Set `NODEBOARD_CYTOSCAPE_JS` to that installation's `node_modules\cytoscape\dist\cytoscape.min.js`, then run `node .nodeboard-v2\scripts\renderer_candidate.cjs` from the repository root.

On the same machine and browser, the standalone prototype produced:

| Synthetic graph | Three elapsed trials |
|---|---|
| 300 nodes / 550 edges | 808, 556, 413 ms |
| 3,000 nodes / 6,000 edges | 3,627, 2,742, 3,783 ms |

It verifies element counts, that a parallel endpoint pair is retained, and pointer selection of a node. It uses Cytoscape preset positions and a simplified style; unlike the SVG baseline, timing starts after the candidate library has been loaded and includes passing generated elements into the page. The two measurements are **not equivalent workloads** and cannot establish a performance winner. This is not integrated into Nodeboard and does not test edge routing visibility, keyboard behavior, layouts, editing, export, accessibility or collaboration. More equivalent interaction and layout experiments are required before a renderer decision.
