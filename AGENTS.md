# Agent contract | Nodeboard v2

Apply existing repository and dev-kit instructions as well; reconcile conflicts explicitly. These instructions are for the v2 branch, not a license to change production.

Read PROJECT.md, ARCHITECTURE.md, ONTOLOGY.md, SCHEMA.md, DESIGN.md, MIGRATION.md, ROADMAP.md, BACKLOG.md, TESTING.md, STATUS.md and DECISIONS.md before modifying implementation. Treat STATUS as a claim to verify against source and tests. The lead agent owns integration and schema decisions. Specialist roles are in `.github/agents/`.

- Work on `development/v2` or an explicitly authorized equivalent. Preserve all existing board data and supported functionality. Never force-push, reset user work, merge to main, deploy production, access secrets unnecessarily or provision paid infrastructure without approval.
- Audit actual source first. Do not assume candidate stack, schema, file paths, commands or environment are confirmed. Record the commit reviewed, baseline test commands and results.
- Implement vertical slices in dependency order; each must work end to end, not merely render a UI. No placeholder controls, fake validation, silent data loss or undocumented migrations.
- Keep graph semantics independent of rendering and persistence. Never infer verification from confidence, create facts through styling, or silently rewrite assertions when a template changes.
- Shared validation is authoritative across import, local, cloud, collaboration, history and API boundaries. Validate all user inputs and enforce authorization on the server.
- Use stable IDs, explicit schema versions, reversible migration, and transaction boundaries. Preserve legacy facts that cannot be interpreted, and flag ambiguity for review.
- Keep sensitive fixtures, tokens, internal URLs and institutional records out of public Git, CI, screenshots and logs. Use synthetic public fixtures by default.
- Run the appropriate unit, integration, migration, security and real-browser tests for every slice. Do not mark a feature complete unless evidence exists. Document skipped tests and blockers.
- Update STATUS, BACKLOG and DECISIONS; record test results and changed files. Commit coherent changes when permitted; no destructive commands. Continue through ready tasks within session capacity; do not claim background work or completion without proof.
