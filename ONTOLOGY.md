# Semantic design and governance

Use a directed labeled property multigraph as native representation. A class defines what an entity is; a predicate defines what an assertion means; an entity is an identifiable instance; an assertion is a directed fact with a stable ID. Classes, predicates and properties each have immutable IDs, human labels, definitions and lifecycle metadata. Labels may change without altering identity. A graph may be permissive or governed.

## Rules

- Distinct predicates between the same classes or entities are legal. Canonical duplicate detection uses `(source, predicate, target, qualifier context)`; do not silently merge time-specific or sourced assertions. A predicate ID is authoritative, not its label or UI template.
- Domains/ranges may allow multiple classes and inherited membership. Define matching semantics explicitly (any vs all) and test. Inheritance is a directed acyclic hierarchy. Abstract classes cannot be directly instantiated. Disjointness and multiple membership are configurable.
- Inverse predicates are derived navigation by default, not independently duplicated stored assertions. Symmetric and transitive behavior applies only when explicitly declared; distinguish derived results from facts. No unrestricted or full OWL reasoner is assumed.
- Properties support string, integer, decimal, boolean, date, datetime, URI, enum, list and structured values with validation. Identifiers such as extensions are strings. Do not model every attribute as an entity; use entities for independent identity or relationships.
- Constraints include requiredness, cardinality in a defined direction/context, uniqueness scope, allowed target, pattern, disjointness, conditional rules and acyclic hierarchies. Separate structural validity from semantic quality. Drafts can contain incomplete facts and warnings; strict publication requires configured blockers resolved.
- Provenance supports multiple sources, source identifiers, assertion/verification times, actor, status, confidence (0..1), effective dates and lifecycle. Unknown is not false; source date is not validity date. Preserve disputed or superseded assertions where appropriate. Never claim verification based on model confidence.

## NEXUS reference examples (not hardcoded product classes)

Service -> HAS_OFFERING -> Offering -> HAS_FEATURE -> Feature; Offering -> HAS_REQUESTABLE -> Requestable -> FULFILLED_BY -> Operation -> PERFORMED_BY -> Team. Actual Request is a transaction, not a template. Request Form -> SUBMITS_REQUEST_FOR -> Requestable. Form Field is a definition, with contextual required/order properties on HAS_FIELD. Role, Person, Position, Team, Queue and Unit are distinct. Preserve existing identifiers during migration, even if the legacy names are misleading.

## Interchange

RDF/OWL semantics and closed-world validation are not equivalent. Publish a mapping profile: stable URI namespace, class/property mapping, instance typing, datatype mapping, SHACL-supported constraints and explicit representation for edge metadata (e.g. reified assertion nodes). Multiple equal triples with different contexts need assertion identity. Unsupported semantics require warnings and a native lossless export, not false claims of complete round-trip support.
