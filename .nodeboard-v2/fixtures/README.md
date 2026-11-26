# Synthetic fixture contract

- `legacy-valid.json`: expected to pass v1 structural validation and migrate losslessly.
- `legacy-multi-predicate.json`: expected to fail the observed v1 unordered class-pair restriction. V2 import/migration must preserve both predicates, edge IDs, and source metadata (including extension leading zeros) or explicitly report unsupported data without discarding it.
- `legacy-invalid-endpoint.json`: expected to fail structural validation in all versions; report exact edge and endpoint and do not mutate destination.

These are synthetic, not institutional facts. Create additional fixtures for inheritance, constraints, inverse semantics, duplicate candidates, view independence and collaboration once the actual v2 schema is approved.
