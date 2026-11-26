# Product definition

Nodeboard is a general-purpose visual ontology engineering, knowledge graph modeling, exploration and structured data management environment. It must remain as fast and approachable as a keyboard-driven graph editor while supporting governed, interoperable semantic models. NEXUS is a reference use case, not the product's domain boundary.

## Users and jobs

| User | Job | Success |
|---|---|---|
| Casual modeler | Map an idea quickly | Create nodes and labeled connections without schema friction |
| Ontology architect | Specify reusable concepts and rules | Define classes, predicates, constraints, properties and versions |
| Knowledge steward | Maintain canonical facts | Edit, merge, verify and trace provenance without duplication |
| Analyst | Explore a large graph | Discover paths and dependencies with saved filters |
| Collaborator | Work safely on shared boards | Changes synchronize, permissions hold, history is reliable |

## Scope and guardrails

V2 includes semantic multigraph, safe migration, ontology authoring, graph editor/explorer, data explorer, validation, view separation, graph queries, interoperability, and preserved offline/cloud features. Optional external graph database connectors must not be a requirement for normal operation. AI generation, autonomous institutional verification, enterprise-wide authorization over individual records and full OWL reasoning are not implied by this release: scope and fidelity must be documented. No fake feature surfaces.

## Success measures (proposed release targets)

- Preserve all supported v1 entities/edges/styles and original labels through migration and native round-trip; report ambiguities.
- Demonstrate multiple predicates for identical endpoints and no implicit rewriting of facts.
- Import, merge, search, filter, layout, inspect, query and export the Phones-scale graph.
- Existing editing, accounts, private documents, collaboration, permissions, offline and undo/redo regression tests pass.
- Agree hardware/browser and benchmark budgets in Phase 0; initial targets in TESTING.md.

Product owner approves architecture, design, alpha, beta and release candidate. Production deployment requires explicit approval.
