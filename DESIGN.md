# Interface and interaction standards

Canvas-first professional technical workstation, not a dashboard of oversized cards. Use compact typography, restrained colour, consistent spacing and density, clear focus and selected states, responsive panels, keyboard access and accessible contrast. Preserve rapid node creation and shortcuts; do not make simple operations modal-heavy. Design tokens and reusable components should be implemented after reviewing current UI and interaction regressions.

## Workspaces

| Workspace | Main canvas/pane | Left rail | Right inspector |
|---|---|---|---|
| Graph Editor | Canonical entities in a view | Classes, views, filters | Entity/edge properties, relationships |
| Ontology Studio | Class graph or relationship matrix | Class tree, predicates, rules | Definition, domains, constraints |
| Graph Explorer | Focused neighbourhood | Search, history, path filters | Context, sources, expand controls |
| Data Explorer | Virtualized editable entity/edge table | Class/predicate filters | Record detail, validation |
| Validation Centre | Findings grouped by severity | Profiles, filters | Affected record, actionable fix |

Top bar: document, mode switch, undo/redo, search/command palette, save/sync status, account/share. Canvas toolbar: fit, zoom, layout, focus, minimap, layers. Persistent inspector collapses and resizes; quick edit for names. Status bar reports visible/total counts, selected item, validation and sync status. Mobile: prioritize inspection and basic editing, not tiny desktop panels.

## High-value flows

- Tab/add connection: choose predicate from valid candidates, then existing entity search or create. Show direction and class; permit free-form in permissive mode. Never auto-rewrite existing facts. Reuse canonical nodes; duplicate suggestions are advisory.
- Parallel edge routing: distinct labels, visible arrows, accessible selection and reverse traversal. Hide/abbreviate labels when zoomed out, inspect on focus. Self-loops and bidirectional links must remain distinguishable.
- Search by name/alias/ID/properties; jump to entity, reveal it without silently changing saved filters. Command palette for layout, view, navigation and editing actions.
- Layout: hierarchical, horizontal, radial, force-directed and swimlane; selection or visible graph only; preserve pinned nodes and undo. Independent view positions, semantic zoom, group annotations, alignment/distribution, optional snapping.
- Import: choose replace/merge/new doc/ontology only, preview additions/conflicts/warnings, resolve explicitly, then apply atomically. Precise errors with paths. Cancel without mutation.
- Validation: show severity, rationale, source and jump-to-entity; never fabricate green status. Draft and publish are distinct.

## Acceptance

Real browser screenshots at desktop and narrow widths, keyboard-only flows, reduced motion, light/dark contrast checks, empty/error/loading/sync conflict states. No dead controls or fake data in production UI. Do not substitute mockups for tested functionality.
