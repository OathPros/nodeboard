# Native interchange contract | draft v2

This is a proposed contract, not an existing importer format. Freeze a machine-readable JSON Schema and migration spec at architecture gate. Names can change only by recorded decision.

```json
{
  "format": "nodeboard", "version": 2,
  "ontology": {
    "id": "ont-demo", "version": "1.0.0",
    "classes": [{"id":"cls-service","name":"Service","superclassIds":[],"abstract":false,"propertyDefinitionIds":["prop-description"]}],
    "relationshipTypes": [{"id":"rel-offering","predicate":"HAS_OFFERING","label":"Has offering","domainClassIds":["cls-service"],"rangeClassIds":["cls-offering"],"inversePredicateId":null,"symmetric":false,"transitive":false}],
    "propertyDefinitions": [{"id":"prop-description","name":"description","dataType":"string"}],
    "constraints": []
  },
  "graph": {"entities": [], "relationships": []},
  "views": [],
  "presentation": {"classStyles":{},"relationshipStyles":{}},
  "metadata": {}
}
```

Example entity: `{"id":"ent-phones","classIds":["cls-service"],"name":"Phones","properties":{"prop-description":"Voice communications"},"externalIds":[],"provenance":[],"status":"active"}`.
Example assertion: `{"id":"edge-01","from":"ent-phones","to":"ent-desk","relationshipTypeId":"rel-offering","properties":{},"provenance":[],"status":"asserted"}`.
Example view: `{"id":"view-01","name":"Service map","query":{},"entityIds":["ent-phones"],"positions":{"ent-phones":{"x":0,"y":0}},"viewport":{"x":0,"y":0,"zoom":1}}`.

## Required invariants

IDs are opaque stable strings, unique per namespace; no dangling references; no invalid property keys/types; valid version and ontology reference; unique predicate ID and defined machine name within namespace; preserve edge direction and identity; no dependency on coordinates. Use explicit nullable fields or absence consistently. External IDs are namespaced and unique only under configured rules. Constrain payload size and nesting. Distinguish stored, derived, proposed and verified states; do not overload a single field to mean several dimensions. Validate dates, ranges and enum values. Unknown legacy fields are retained in designated migration metadata, not silently dropped.

## Deliverables before implementation freeze

JSON Schema for native snapshots, versioned operation schema, TypeScript types derived or checked against schema, ontology/graph validation spec, import diagnostics contract (`code`, `severity`, `path`, `entityId`, `message`, `suggestion`), view scope and sharing rules, identifier/IRI strategy, and representative valid/invalid examples. Native export must preserve semantic and presentation information across all storage pathways.

## Phase 0 structural draft | not frozen

The review artifacts are `.nodeboard-v2/contracts/snapshot.schema.json`, `.nodeboard-v2/contracts/operations.schema.json` and the synthetic `.nodeboard-v2/fixtures/v2-draft-valid.json`. They are not consumed by the application. The example contains two different predicates between the same endpoints, an unresolved legacy edge, a string identifier with leading zeroes, and two independent views.

The Phase 1 domain prototype consumes the snapshot draft in isolation; it is not wired into the application or authoritative server. It validates selected structural and semantic invariants and explicitly warns that validation is incomplete. The operation prototype applies batches atomically in memory; it does not implement authentication, durable transactions, replay handling or network negotiation.

The prototype preflights snapshots and batches as bounded JSON before cloning or validation. Its provisional limits and unsupported-schema behavior are recorded in `DECISIONS.md`; future protocol and persistence boundaries must independently enforce their final budgets and authorization. Diagnostic collection is capped at 1,000 findings; exceeding the limit produces a blocking `RESOURCE_LIMIT_EXCEEDED` diagnostic and retains the findings collected so far.

The proposed snapshot uses separate ontology, graph and views. Each relationship has a stable ID and either a relationship-type ID or a null ID with an explicit legacy label and reason. Null does not imply a verified fact or a generated inverse. Legacy fields must be retained in migration metadata or a source backup; metadata in the example is illustrative, not a complete migration format. Provenance confidence and verification time are independent.

The proposed operation envelope includes snapshot/protocol version, operation ID, base revision and an atomic batch of 1–100 commands, matching the current v1 operation count limit. Its full-object put and delete commands are a starting shape, not an implemented network protocol. Whole-object writes need conflict/rebase behavior that preserves the v1 ability to merge edits to different fields; ontology changes need safe migration, authorization and version control. Authentication, handshake, capability negotiation, acknowledgements, retry/deduplication horizon, byte/depth limits and error responses are not specified by the schema and remain open.

The schema checks structural shape only. It intentionally does **not** check identifier uniqueness across records, dangling references, inheritance, domains/ranges, duplicate assertion context, typed property values, constraint parameter semantics, permissions or publication rules. A conforming shared validator must apply those checks separately, reject unsafe property keys and enforce byte, depth, array and transaction limits before mutation. Diagnostics must include stable `code`, `severity`, JSON Pointer `path`, optional `entityId`, `message` and optional `suggestion`; a detailed registry is pending.

`scope: personal` requires `ownerId` in the draft; `shared` does not. This does not implement ACLs: server storage, snapshot projection, export and collaboration must never disclose a personal view to another user, and shared-view read/write rules require a reviewed authorization design. Personal view IDs, positions and metadata must not be blindly broadcast in a shared snapshot.

Before freeze: specify remaining property and constraint variants and qualifiers, provenance/temporal semantics, migration source retention, precise error codes, transport budgets and IRI rules; define and test cross-references, delete behavior and authorization. Derive or check TypeScript types and prepare complete valid/invalid fixtures. The product owner approved the architecture direction, not this unfinished contract. Neither JSON Schema validity nor these drafts alone authorize import or mutation.

The current property draft defines enums as a nonempty, unique list of string `enumValues`; lists require `listItemType`, including `enum` with its own `enumValues`. Nested lists are not supported. Entity and assertion property values must match the declared type. Entity properties outside the declarations of the entity's classes and their ancestors produce draft warnings without deleting values; relationship-property applicability and numeric/string restrictions remain unspecified.

The provisional `required` constraint has exactly `{classId, propertyId}` parameters. It applies to directly classified entities and descendants, and treats a property as missing only when its key is absent. Draft validation reports missing values as warnings; the explicit publish profile reports errors. Publication is always blocked with `PUBLISH_POLICY_INCOMPLETE` until the overall policy is implemented and reviewed. The current constraint kinds support only the narrow variants documented here; full constraint semantics remain incomplete.

The provisional `cardinality` constraint takes `{classId, relationshipTypeId, direction, minimum?, maximum?}`, with at least one nonnegative safe-integer bound and direction `in` or `out`. It applies to entities of the class and descendants regardless of entity status and counts only directly stored assertions with status `asserted`, not proposed, disputed, superseded or derived links. Counts are global across contexts and validity periods; context-specific cardinality remains unspecified. Inverted bounds are errors. Violations are warnings in draft and errors in the publish profile.

The provisional `uniqueness` constraint takes `{classId, propertyId}`. It compares present property values across all entities of the class and descendants within one snapshot, regardless of entity status. JSON object keys are compared independently of order; strings are compared exactly without normalization. Missing values are ignored, and duplicates are reported rather than merged. Context-, time- and cross-board uniqueness remain unspecified.

The provisional `disjointness` constraint takes `{classIds}` with at least two unique class IDs. All listed classes are pairwise disjoint; direct or inherited membership in more than one produces a draft warning and publish error.

The provisional `acyclic` constraint takes `{relationshipTypeId}` and checks directed cycles among directly stored `asserted` relationships of that predicate across the snapshot. Proposed, disputed, superseded and derived links are excluded. The diagnostics identify DFS back edges, not necessarily every edge in a cycle; draft reports warnings and the blocked publish profile reports errors. Context- or time-specific acyclicity is not specified.

The provisional `allowedTarget` constraint takes `{classId, relationshipTypeId, targetClassIds}` with a nonempty unique list of targets. For directly stored asserted outgoing relationships of the predicate, entities of the source class or its descendants must point to an entity in at least one target class or its descendants. Multiple applicable rules all apply. Violations are warnings in draft and errors in the blocked publish profile; context- and time-specific rules remain unspecified.

The provisional `conditional` constraint takes `{classId, when: {propertyId, equals}, requirePropertyIds}` with a nonempty unique list of required properties. On entities of the class and its descendants, if the condition property is present and equals the type-valid configured value, each listed property must be present. Structured values compare independently of object-key order; missing conditions do not match, and present false, zero or empty values satisfy requiredness. Violations are draft warnings and publish errors. Other conditional operators and relationship conditions remain unspecified.

The provisional `pattern` constraint takes `{classId, propertyId, syntax: "glob", pattern}` for string-valued properties of the class and descendants. It is a case-sensitive whole-value glob, not a regular expression: `*` matches zero or more Unicode code points, `?` matches one, and backslash escapes the next character. Missing properties are ignored. Patterns are limited to 256 code points and validation has a global 1,000,000-unit work budget, calculated conservatively from UTF-16 value length and token count; exhaustion is a blocking resource error. Violations are draft warnings and publish errors. Regex and other pattern syntaxes are not supported.

Provenance entries can carry independent `assertedAt`, `verifiedAt`, `validFrom` and `validUntil` timestamps. When both validity endpoints exist, the end may not precede the start; comparison uses their actual offsets and retains sub-millisecond fractional precision. Confidence does not create a verification timestamp.

## Proposed validator and diagnostic behavior

The structural diagnostic shape is `.nodeboard-v2/contracts/diagnostics.schema.json`. `path` is an RFC 6901 JSON Pointer into the submitted snapshot or operation batch; escape `~` as `~0` and `/` as `~1`. Use the empty string for the document root. `entityId` identifies the affected entity or assertion when known, not necessarily the object addressed by the pointer. Output is deterministic: sort by path, code and entity ID, and do not echo sensitive input values in messages. Messages are explanatory, never evidence of verification.

| Code | Proposed condition | Default severity |
|---|---|---|
| `INVALID_STRUCTURE` | Missing/invalid field or unsupported snapshot version | error |
| `RESOURCE_LIMIT_EXCEEDED` | Input exceeds a configured byte, depth, count or operation budget | error |
| `DUPLICATE_ID` | An ID occurs twice in its namespace | error |
| `REFERENCE_NOT_FOUND` | Required entity, class, predicate, property, view or ontology reference is absent | error |
| `UNSAFE_PROPERTY_KEY` | A property key is unsafe or not a permitted definition ID | error |
| `INHERITANCE_CYCLE` | Class hierarchy contains a cycle | error |
| `ABSTRACT_CLASS_INSTANTIATION` | Entity directly declares an abstract class | error |
| `INVALID_PROPERTY_VALUE` | A value does not match its property definition | error |
| `PROPERTY_NOT_APPLICABLE` | Entity property is not declared on a class or ancestor | warning in draft |
| `INVALID_TEMPORAL_RANGE` | Provenance validity end precedes its start | error |
| `UNRESOLVED_LEGACY_RELATIONSHIP` | A migrated edge has no defensible predicate mapping | warning in draft; publication blocker |
| `DOMAIN_RANGE_MISMATCH` | Resolved assertion endpoints do not meet the predicate's allowed classes | warning in draft; publication blocker |
| `CONSTRAINT_VIOLATION` | A configured semantic constraint is not satisfied | profile-dependent |
| `INVALID_CONSTRAINT` | Configured cardinality minimum exceeds its maximum | error |
| `POSSIBLE_DUPLICATE_ASSERTION` | Same source, predicate, target and qualifier context may represent a duplicate | warning; never silently merge |

Structural errors, missing references and unsafe payloads must block both draft and publish writes. Semantic warnings can remain in draft only if the selected profile permits them; publishing requires an explicit profile and blocks its configured findings. The server must decide whether to accept a batch; clients use the same domain rules but do not grant authorization. Graph and ontology references, scoped ID uniqueness, property definitions and type checks apply to the complete candidate result, not intermediate commands inside an atomic batch. Views refer to existing entities; no view change may create or alter a fact.

Matching proposal for review: an entity matches a domain or range if any of its declared classes is the listed class or a descendant; an empty domain/range means no class restriction. Predicate identity is its ID, not its name or a class-pair template. Class/predicate display renames never rewrite assertion IDs or labels retained for migration. Derived inverse navigation does not materialize a second assertion. Duplicate candidates must account for qualifiers and provenance rather than replacing independently sourced facts. The qualifier identity and precise treatment of temporal ranges still need an approved specification.

## Proposed protocol and isolation behavior

Each connection must negotiate supported snapshot and protocol versions before receiving private state or sending changes. The server authenticates independently and refuses incompatible writers without altering data. A version 1 client must not receive a version 2 board in a form that it can save back as v1; compatibility requires an explicitly read-only, loss-reported projection or a separate v1 backup, not silent conversion.

For an authorized editor, submit an atomic batch with a stable operation ID and base revision. Check the version and limits, current authorization and idempotency record, then validate the candidate graph and commit state, revision and deduplication record together. ACK only after commit. A retry of the same ID and payload must return its committed result; reuse of an ID with different content must fail. A stale base revision must not silently overwrite another participant's changes. Rebase or field-level preconditions need to preserve independent edits and surface conflicting edits; the current full-object draft operations do not yet meet that requirement. A client outside the retained deduplication horizon must reconcile explicitly instead of blindly replaying old changes.

The local-only IndexedDB prototype now has a bounded retry log; see `DECISIONS.md` for its different replay response and eviction behavior. It does not implement this proposed network ACK, authentication or server authority.

The owner-only account-board prototype now validates with the same v2 domain module in its Durable Object and requires `X-Nodeboard-Protocol: 2` and `X-Nodeboard-Snapshot: 2`. Its operations and history requests have stable IDs, revision checks and atomic retry records; replay reports the committed revision alongside the current snapshot. It retains IDs until a hard per-board limit rather than silently evicting them. This is not the final collaboration protocol: sharing, private-view projections, multi-user access, reconnect and compaction remain unspecified and unimplemented.

Private views are stored and projected by authorized principal; document members must not receive another user's personal views in snapshots, operation broadcasts, exports or history. Shared views follow document ACLs. A viewer cannot mutate either a graph or a shared view; an authorized user may edit their own personal view only under the final reviewed policy. Tokens and access checks are not part of graph data. Protocol error envelopes, ACK/retry semantics and exact transaction limits remain to be machine-specified and tested against real clients.
