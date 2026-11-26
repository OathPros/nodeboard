# Release backlog | initial; none implemented by this kit

Status: `[ ]` pending; `[~]` in progress; `[x]` accepted with evidence. Update each task with commit/test references. Split large tasks into independently reviewable subtasks.

| ID | Phase | Work | Acceptance evidence |
|---|---|---|---|
| NB-001 | 0 | [~] Audit source, existing devkit, deployment, tests, dependencies, data paths | Initial source map and local baselines in ARCHITECTURE.md and STATUS.md; complete review of gaps and operational inventory |
| NB-002 | 0 | [~] Decide renderer/stack after spike; freeze v2 schema and protocol | Draft structural schemas, SVG baseline and isolated Cytoscape prototype exist; equivalent interaction/layout comparison, semantic contract, protocol completion and review pending |
| NB-003 | 0 | [~] Preview isolation plan, backups, release gates | Local isolation configuration and migration proposal documented; isolated deployment and restore rehearsal pending approval |
| NB-010 | 1 | [~] Stable IDs, canonical entities/assertions, graph commands | Unit tests for parallel edges, distinct directions, identity; end-to-end integration pending |
| NB-011 | 1 | [~] Independent predicate registry, domains/ranges and inverse navigation | Guided domain/range, inverse, symmetric and transitive declarations; inspector distinguishes inverse/symmetric navigation and retains assertion IDs; transitive inference and complete semantics pending |
| NB-012 | 1 | [~] Shared structural validator and diagnostics | Isolated shared-module prototype, bounded diagnostics and unit tests exist; application/client/server integration and complete semantics pending |
| NB-013 | 1 | [~] Typed properties, schema and safe template behavior | Typed definition creation, class assignment and individual entity/relationship value editing are validated locally and in account boards; richer list/structured controls and template workflows pending |
| NB-014 | 1 | [~] Separate view/presentation model | Isolated snapshot and command tests cover independent views; storage, ACL and editor integration pending |
| NB-020 | 2 | [~] Deterministic v1 migration, legacy preservation | Synthetic preview, source backup/hash and confirmed local v2 copy tested through the workspace and actual v1 browser storage; cloud migration and complete input coverage pending |
| NB-021 | 2 | [~] Local store, backup, undo/redo and command history | IndexedDB listing, bounded history/retry, conflict handling and backup-copy restore tested through the local workspace; durability, browser coverage and release qualification pending |
| NB-022 | 2 | [~] Cloud operations, revision handling, permissions and reconnect | Owner and link-based viewer/editor ACLs, stale-write rejection, atomic retries, explicit pending-change export/discard and bounded history tested locally; live synchronization and general offline reconnect pending |
| NB-023 | 2 | [~] Protocol/version negotiation, rollback and snapshot migration | HTTP v2 version negotiation and retry ACK tested locally; cross-version migration and cloud restore rehearsal pending |
| NB-030 | 3 | [~] Class hierarchy, inheritance, membership, abstract/disjoint classes | Guided parent/abstract editing and membership are revision-checked and reject inheritance cycles or abstract instances; disjoint configuration and full studio pending |
| NB-031 | 3 | [~] Constraint profiles, cardinality, uniqueness, conditional constraints | Guided required-property creation/removal and other provisional diagnostics tested; guided configuration of other rules, regex, broader conditions and publication policy pending |
| NB-032 | 3 | [~] Provenance, verification, temporal validity and source references | Local JSON provenance/status editing validates independent source/validity times and undo/export; guided UI, complete audit and cloud persistence pending |
| NB-033 | 3 | Ontology library versioning and explicit migrations | Preview changes and compatibility; no silent fact rewrite |
| NB-040 | 4 | [~] Shell, token system, accessible controls and panels | Basic local shell exercised at narrow width and in light/dark with keyboard selectors; full accessibility and design review pending |
| NB-041 | 4 | [~] Rendering and layout prototype, parallel routing | Local workspace shows separate paths for parallel assertions; renderer decision, saved positioning and scale/interaction measurements pending |
| NB-050 | 5 | [~] Graph Editor and inspector, fast add/link existing | Workspace adds/renames entities, atomically creates a connected entity and explicitly edits relationship endpoints/predicates while preserving assertion data; complete canvas editing and keyboard workflows pending |
| NB-051 | 5 | [~] Ontology Studio, class tree, matrix, property editor | Guided class/predicate controls, property creation/assignment and advanced JSON preview exist; full class tree, matrix and property definition editing pending |
| NB-052 | 5 | [~] Graph Explorer, filters, depth, focus and minimap | Read-only entity search and one-hop inspector navigation distinguish stored and derived connections; focused explorer, bounded expansion, filters and minimap pending |
| NB-053 | 5 | Data Explorer, virtual table, batch operations | Search/sort/edit/bulk rollback, navigate to graph |
| NB-054 | 5 | [~] Validation Centre, linked findings and publish profiles | Workspace links entity and relationship findings to affected records; grouped centre, other finding targets and publish profiles pending |
| NB-055 | 5 | [~] Saved views and layouts, semantic zoom, groups, pins | Saved entity-membership views can be created, selected, edited, deleted and undone locally and in shared account boards; independent positioning, query filters, zoom, groups and pins pending |
| NB-056 | 5 | [~] Native import/merge/partial export, conflict preview | Local full snapshot export/import-as-new round-trip and invalid-input rollback tested; merge, partial export and conflict preview pending |
| NB-060 | 6 | Query/traversal engine and visual builder | Known paths, direction, limit, filters; read-only results |
| NB-061 | 6 | Impact/dependency analysis and duplicate candidates | Expected fixture results; suggestions not verified facts |
| NB-062 | 6 | Explicit bounded inference, derived results | Symmetric/transitive rules tested; provenance and distinction |
| NB-063 | 6 | Advanced layout, annotations, alignment, grouping | Non-semantic annotation and undo; pinned nodes stay fixed |
| NB-070 | 7 | CSV mapping, GraphML, native and image exports | Mapping preview, valid exports, no accidental disclosure |
| NB-071 | 7 | JSON-LD/RDF/OWL/SHACL mapping profile | Supported subset tested; qualifiers preserved or warning; no false lossless claim |
| NB-072 | 7 | Optional graph DB adapter and read API | Documented auth, paging, mapping, integration fixture |
| NB-080 | 8 | Regression, scale, accessibility, security | Full evidence report, performance budget, no critical failures |
| NB-081 | 8 | Preview release, documentation, deployment/rollback | Isolated preview verified; sign-off packet; explicit approval pending |

Setup progress (not acceptance of NB-001 or NB-003): a separate Worker name and blank authentication configuration have been prepared locally; cloud isolation and rollback remain to be verified after approval.

Prioritize NB-010–014 before any UI redesign. Scope changes and deferred requirements require an ADR and product owner review; do not quietly remove acceptance requirements.
