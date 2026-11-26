# Migration and rollback

1. Inventory supported v1 exports, saved templates, documents, local storage, sessions and operations. Capture synthetic and authorized private fixtures. Freeze baseline tests and a backup procedure.
2. Parse without mutating; validate structure and limits; classify anomalies. Preserve all source IDs, labels, class IDs, positions, styles and unknown supported metadata. Map class keys as presentation ordering rather than identity.
3. Generate stable predicate IDs from explicit legacy definitions where unambiguous; preserve literal edge labels and directions even if missing template. Unlabeled edges or conflicting legacy templates receive explicit unresolved records and diagnostics, not invented facts. Multiple class-pair predicates must survive.
4. Handle legacy reverse edges cautiously: retain both unless there is evidence they are a generated inverse of the same assertion; report candidates, require explicit resolution. Preserve qualifiers/provenance; do not silently remove duplicates.
5. Create a default view from original positions; preserve other style data separately. Retain source snapshot/hash and a migration report with counts, mappings, ambiguities and warnings. Make migration deterministic/idempotent for a fixed input.
6. Validate output, show preview and user confirmation. Import/merge is atomic; cancel or failed validation leaves graph untouched. Conflict resolution choices: keep, update, merge by canonical identity, or create separate entity with explicit ID mapping. No name-only merge.
7. For shared docs, negotiate protocol version, snapshot and lock/coordinate writes during migration, test old client handling, ensure reconnect and undo behavior. Do not mutate production automatically at login.
8. Dry-run against representative data; compare entity/edge IDs, labels, property values and visual coordinates; record any deliberate changes. Backups must be restorable. Rollback: restore v1 backup into isolated compatible deployment, retain v2 changes in a separate export; never overwrite post-migration work silently.

Private fixtures included separately must not enter public Git or CI. Synthetic fixtures are the normal CI baseline. The enriched Phones input intentionally violates v1 template limits; v2 should migrate or import it with both predicates preserved, not discard one.

## Phase 0 v1 backup rehearsal

`node .nodeboard-v2\scripts\audit_baseline.cjs` uses only the supplied synthetic v1 fixture in fresh local-file Chromium contexts. It exports a JSON backup from one context, restores it into another, reloads, and compares classes, nodes and edges. This verifies the current local v1 path only; it is not evidence that private/cloud documents, unknown top-level fields, numeric class IDs, a v2 migration, or a production restore have been handled.

## Standalone v2 preview prototype

`src/domain/migrate-v1.js` can preview supported v1 JSON exports and unversioned local graphs without writing storage. It returns a validated draft snapshot, an untouched parsed source backup, original source text when supplied, a report and diagnostics. Numeric class references use v1 class keys or positional fallback; broken or ambiguous references fail instead of selecting another class. Original labels, definitions, positions, styles, source records and unsupported legacy property values are retained; unsupported property values remain metadata and are explicitly reported rather than silently assigned semantic types. Unmatched or ambiguous relationships remain unresolved. Entity and assertion lifecycle states are not inferred from legacy records.

The domain preview alone does not persist a backup, calculate a source hash, offer a review UI or perform a v2 import, merge, cloud migration or protocol negotiation. Its parsed backup for the valid synthetic fixture was imported into a fresh v1 editor context, reloaded and compared with the source. The local application slice below adds a separate confirmed-copy path. No production or real user data has been migrated. Full supported-v1 coverage, cloud migration and release review remain required.

## Local migration application slice

`src/application/local-migration-v2.js` prepares a non-writing preview from the current origin's `nodeboard-v1.1` browser value. A successful preview captures the exact source text, parsed backup and SHA-256 digest inside the candidate snapshot. Its explicit `commit(store, boardId)` checks that the current source still matches the preview, then atomically creates a new board through the local v2 store; an existing destination cannot be replaced. The commit uses an independent copy of the reviewed snapshot. If the larger backed-up candidate exceeds the provisional snapshot limits, preview fails rather than writing a partial board. The v1 key is never written by this module.

The source check and IndexedDB create are separate browser operations, not a cross-storage transaction. A later v1 edit cannot change the captured migration source, but can happen after the check; shared or live documents require a separate coordinated protocol. This slice is not yet exposed in the editor and does not migrate cloud documents, merge boards, or provide a review UI. Chromium exercised the actual v1 file import and local-storage path with synthetic data, confirmed a new v2 copy, hash and exact text after reopen, and checked stale-preview, invalid-source and duplicate-destination rejection.
