# Architectural decision register

| ADR | Status | Proposal / reason |
|---|---|---|
| 001 | Proposed | Dedicated v2 branch and isolated preview; avoid exposing production to incompatible changes |
| 002 | Proposed | Directed property multigraph with stable predicate and assertion IDs; resolves v1 class-pair restriction |
| 003 | Proposed | Separate ontology, graph, view and presentation; canonical entities independent of coordinates |
| 004 | Proposed | Shared validation and versioned operations; avoid frontend/backend drift |
| 005 | Proposed | Native v2 JSON lossless; migration preserves ambiguous legacy edges |
| 006 | Proposed | TypeScript/React/Vite/Cytoscape/ELK candidates pending evidence; preserve proven Cloudflare infrastructure |
| 007 | Proposed | Public synthetic fixtures only; private institutional fixtures outside Git |
| 008 | Proposed | No mandatory graph database; adapters after stable core |

ADR template: status, date, owner, context, options considered, decision, rationale, consequences, compatibility/migration, evidence, reconsideration trigger. Mark accepted only after actual review; document supersession rather than erasing history.

## Setup decision, 2026-11-26

For the local v2 branch, retain the existing Supabase email OTP implementation and remove the Google sign-in UI. Use a distinct Worker name and leave Supabase settings empty by default rather than targeting the existing project. This is setup only, not approval of the broader architecture. Accounts require a separately provisioned Supabase project and configured email delivery; existing accounts and private documents are not automatically migrated. Revisit identity and migration before inviting users or releasing.

## Phase 0 recommendation, 2026-11-26

Status: direction approved; detailed choices remain open. Preserve the current JavaScript/SVG app while establishing an independently testable domain and shared validator; retain the existing Worker/Durable Object infrastructure as the starting cloud candidate. This avoids an unproven wholesale rewrite while allowing a typed domain, versioned protocol and separate views. React and alternate renderers remain undecided until a measured spike; no package or production changes follow from this recommendation. V1 and v2 clients must not write the same migrated data until explicit version negotiation, compatibility tests and a recoverable migration are in place. See `ARCHITECTURE.md` for source evidence, alternatives, implications and open contract questions.

The 2026-11-26 structural schemas, SVG measurements and isolated Cytoscape prototype are review inputs only. Their workloads are not equivalent, and no renderer selection follows. The draft's null relationship type plus explicit legacy label/reason is a proposed representation of ambiguity, not a final migration decision. Its full-object batch operations require a conflict strategy before replacing existing field-level collaboration. Personal views require server-side projection and ACLs. See `SCHEMA.md` and `TESTING.md`; no ADR is accepted by producing the drafts.

## Architecture gate approval, 2026-11-26

The product owner stated: "I am giving architectural approval, PROCEED all the way through the end". Phase 1 implementation may begin on `development/v2`, keeping v1 and production isolated. This approves proceeding with the documented direction, not evidence that unfinished schemas, migration, renderer evaluation, testing or later release criteria have passed. Do not deploy or modify production without separate approval.

## Provisional domain input limits

The standalone v2 prototype inspects JSON-shaped input before validation or cloning, with provisional limits of 64 nesting levels, 100,000 values and 5,000,000 serialized UTF-8 bytes. Batches allow at most 100 operations, and a base revision must leave room for a safe-integer increment. Non-plain objects, accessors, sparse arrays, unsafe keys and other values that cannot round-trip as JSON are rejected. These are local safety limits, not the final network or storage budget. Revisit them with measured workloads, protocol design and application integration.

Inverse and symmetric navigation in the prototype is a read-only projection of an existing assertion. Each projected connection retains the source assertion ID and status and is marked derived; it is not an independently stored fact. A symmetric self-link does not generate an identical second projection. No transitive inference is performed by this navigation helper.

The draft represents enums as string choices and lists as values of one explicitly declared item type; an enum list uses the same explicit choices. Direct membership in an abstract class is invalid, but inheriting an abstract superclass through a concrete class is allowed. These semantics are provisional until the contract is frozen and integrated.

The standalone migration preview treats legacy properties and status as source metadata rather than inventing v2 semantic types or lifecycle. New entities are draft and relationships proposed. A predicate is mapped only when a single matching legacy definition is found; other relationships are retained unresolved. The preview does not authorize or perform a persistent migration.

An unintegrated IndexedDB prototype stores v2 boards separately from v1 and commits each snapshot, revision and local undo/redo history together. Records have a storage version and unsupported versions or unexpected fields fail closed. Stale revisions fail rather than overwriting another tab; an invalid candidate aborts the transaction. History stores full snapshots, provisionally limited to 100 entries and 10,000,000 serialized UTF-8 bytes; the oldest available entries are dropped to stay within the limit and the result exposes the drop count and truncation flag. A new edit clears redo. Its in-memory backup object contains the current snapshot, not history, and can only be restored to a new, different board ID starting at revision zero; it cannot overwrite an existing board. This is not a final offline/history design, a backup file UX, or cloud synchronization, and browser storage can be evicted.

The first constraint prototype supports inherited required-property checks using `{classId, propertyId}`. An absent key produces a draft warning and a publish error; false, zero and empty strings are present values. Unsupported constraints remain explicit, and the publish profile fails closed for every snapshot until the complete publication policy is designed and enforced.

Directional cardinality counts stored assertions of the specified predicate and direction only when their status is `asserted`; proposed, disputed, superseded and derived relationships do not satisfy the constraint. It applies through class inheritance and currently aggregates across all contexts and effective times. These provisional semantics require policy review before publication.

Property uniqueness is provisional and scoped to one class and its descendants within a snapshot, including every entity status. It ignores absent values, compares JSON objects independently of key order and compares strings exactly. It reports duplicates without merging them; cross-board, time-sensitive and normalized matching are not implied.

The provisional class-disjointness rule treats its list of classes as pairwise disjoint and detects both direct multiple membership and membership inherited through one or more subclasses. Violations are warnings in draft and errors in the blocked publish profile.

The provisional acyclic constraint is predicate-wide and checks only directed, stored asserted links across all contexts and times. Iterative traversal identifies cycle-closing back edges without generating inverse links or rewriting assertions. Draft warnings become errors in the blocked publish profile.

The provisional allowed-target constraint applies to asserted outgoing links for a configured source class and predicate. Source and target subclasses match their ancestors, allowed targets are an any-of list, and all applicable constraints are independently enforced. It does not impose rules on proposed links or derived inverses.

The initial conditional constraint supports a type-checked property-equals test that requires configured entity properties when it matches, including inherited class membership. It is not a general expression language. Canonical JSON equality ignores object-key order, and missing condition values do not match.

The initial pattern constraint explicitly uses whole-value, case-sensitive glob syntax, not arbitrary regular expressions. A bounded dynamic-programming matcher enforces a global work budget and fails closed on exhaustion; regex semantics require a separate safe implementation and contract review.

The provisional validator limits collected structural and semantic diagnostics to 1,000, returning a `RESOURCE_LIMIT_EXCEEDED` error when more would be produced. Preflight uses the same limit for unsafe-key findings. Previously collected findings are retained; truncated validation is not a successful draft validation. Alternative-schema probes stop at the first mismatch rather than exhausting the diagnostic budget.

Local backup envelopes are checked separately from their snapshots. The 5,000,000-byte JSON limit applies independently to the snapshot, not to the snapshot plus its backup metadata; unsafe or oversized snapshots still fail before a restore writes a board.

Local v1 migration creates a new v2 board only after explicit confirmation of a preview and a best-effort source-change check. The candidate embeds the parsed source, exact original text and SHA-256 digest, and is revalidated with that backup included. LocalStorage and IndexedDB cannot be updated in one transaction; the confirmed source is captured rather than overwritten, and shared-document migration remains separate.

The local store lists board IDs with bounded keyset pagination rather than loading every snapshot. Listing checks key shape; record and snapshot validity are checked on individual reads. Pages are separate read transactions and do not represent a fixed cross-page snapshot under concurrent changes.

The local IndexedDB prototype upgrades its database from version 1 to 2 with a separate retry log, leaving board record version 1 unchanged. An atomic transaction records the canonical batch together with board state and history. Reusing a retained operation ID with another payload fails; an identical retry returns `replayed: true`, its `committedRevision`, and the current board revision and snapshot, not an old snapshot. Retention is bounded to 100 operations and 10,000,000 UTF-8 bytes of canonical batch payload per board; `retryHistoryTruncated` reports eviction on a new commit. Old retries outside the horizon encounter a revision conflict and require reconciliation; operation-ID reuse after eviction cannot be detected, so clients must generate fresh IDs. This is not the final network ACK/replay contract, and backups do not include local history or retry records.

The provenance prototype treats assertion, verification and effective-validity timestamps as independent. If both validity endpoints are supplied, the end must not precede the start, including when offsets or sub-millisecond fractions differ. Confidence never implies verification.

The provisional owner-only cloud store uses a dedicated Durable Object namespace keyed by authenticated user ID, separate from classic documents. Every request authenticates through the configured Supabase project and requires explicit v2 protocol and snapshot headers. A transaction writes the validated snapshot, revision, bounded full-snapshot history and an operation-ID/SHA-256 record together. Replay returns the original committed revision and the current snapshot; ID reuse with a different endpoint or canonical payload fails. To avoid silently accepting expired retries, the prototype retains up to 10,000 operation IDs per board and then rejects further writes; it does not yet have a compaction/reconciliation policy. The 100-entry/10 MB history limit can discard older history with an explicit result flag. No sharing, personal-view projection or real-time broadcast is implemented; an owner-only namespace must not be reused for shared boards without a reviewed ACL and projection design. These decisions are provisional and not release approval.

For ambiguous account copy/write/history outcomes, the browser persists one pending request per account and board before sending it. Creation retains a stable destination ID and the server atomically records its snapshot hash, so replay can return the existing board without another copy. Edits and history replay their original operation IDs. A definitive 400/409/413/426 rejection removes the pending request; a network or server failure retains it for explicit retry after reopen. Pending data is stored locally without tokens, remains subject to browser eviction and is not a multi-operation offline queue.

The provisional sharing slice supersedes the earlier owner-only restriction: the owner grants a registered account viewer or editor access, and recipients open an explicit owner/board link. The owner's Durable Object enforces roles on each request and rechecks edit permissions inside the transaction. Revocation uses the stable member ID returned in the owner-only member list, rather than re-resolving a potentially changed or reassigned email; the displayed email is the one recorded when access was granted. To prevent personal-view disclosure without a projection model, a board with personal views cannot be shared, and adding or restoring one is rejected while any members exist. History is owner-only. Revocation takes effect on the next request, not by live notification. Sharing and private-view projection require further review before release.

Classic Node integration tests create persistent sessions, so they now require an explicit disposable HTTP loopback origin in `NODEBOARD_INTEGRATION_URL`; absence skips the suite and an unreachable configured origin fails. This follows the documented accidental contact with an existing port 8787 service and does not establish that the service was disposable.
