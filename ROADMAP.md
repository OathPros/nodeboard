# Dependency-ordered release plan

| Phase | Outcome | Gate / exit evidence |
|---|---|---|
| 0 | Source audit, baseline, decisions, fixture inventory, architecture and migration spec | Architecture approval; baseline commands/results; decision on UI stack |
| 1 | Native graph engine, multigraph, typed properties, semantic identity | Parallel predicates and template safety unit tests; v2 schema round-trip |
| 2 | Persistence, collaboration, history, v1 migration | Real local and multi-client tests, migration reports, restore rehearsal |
| 3 | Ontology engine, inheritance, constraints, provenance | Valid/invalid semantic fixtures, shared validator, draft/publish tests; functional alpha |
| 4 | Application shell, design system, rendering/layout spike | Interaction prototype against real graph; design approval |
| 5 | Five complete workspaces, saved views, filtering, search, import/merge | User flows in Playwright; feature-complete beta |
| 6 | Queries, paths, impact, inference, data health, advanced layouts | Correct bounded traversal on known fixtures; actual usable workflows |
| 7 | Interchange, external adapters, APIs, documentation | Round-trip tests and explicit mapping limits |
| 8 | Performance, accessibility, security, release qualification | Release candidate report, isolated preview, deployment/rollback rehearsal |

Dependencies: Phase 1 before 2–3; Phase 4 can explore design after schema contracts stabilize but cannot implement incompatible persistence. Phase 5 uses 2–4. Phase 6/7 require stable semantics. Phase 8 is release gate, not a substitute for continuous tests. Lead coordinates concurrent work through explicit interfaces and non-overlapping files. User approval gates: architecture, design, functional alpha, beta, release candidate. No production rollout without explicit approval.
