# Changelog

All notable changes to Dialogram are documented here. Format based on
[Keep a Changelog](https://keepachangelog.com/); versions are the Dialogram
platform API version.

## [Unreleased]

## [0.7.0] - 2026-09-01

Edge routing, and boundary ports as schematic symbols. (#6-#23)

The exported API surface is unchanged, but the minor bump is deliberate: it
marks a release that changes how diagrams are routed and drawn. Compatibility is
exact major.minor while pre-1.0, so **consumers must raise their expected
version to `0.7.0`** — `EXPECTED_DIALOGRAM_API_VERSION` in each shell's
`extension/main.ts` — or the platform will refuse to load for them.

### Added

- Orthogonal edge routing through libavoid, opt-in with
  `WORKFLOW_DIAGRAM_ROUTER=libavoid`. On the reference network it cuts crossings
  285 -> 239, node overlaps 43 -> 1 and bends 166 -> 94 against the built-in
  Manhattan router. The dependency is vendored as an eval-free build so the
  webview needs `wasm-unsafe-eval` rather than `unsafe-eval`. (#17)
- Edges route live in the webview while a node is dragged, using the same router
  and the same port anchors the server uses on commit — so the committed route
  replaces the live one without a visible jump. (#18)
- Feedback edges — the connections that close a loop — are drawn and highlighted
  as such. (#10)
- A chat tool for asking which editors can open a file. (#13)
- The property-panel chrome, field toolkit and CSS are exported for library
  consumers, parameterized by config rather than hard-coded ids. (#6)
- `docs/proposals/structured-port-types.md`: what the graph schema and operation
  vocabulary need before a boundary port's type can be edited, a product or
  variant type shown, or a type's definition navigated to. (#22)

### Changed

- Boundary ports draw as schematic port symbols instead of rounded pills: an
  arrow glyph on the wire's own axis, the name on that line, the type on a
  second line below. The wire used to meet the pill at its vertical centre,
  which is the gap between the two lines, so it ran through the middle of the
  label. Rows are a little over half the height of the old boxes. (#23)
- Nodes and boundary ports paint over edges rather than under them. The same
  order decides hit-testing, so a wire passing behind a node no longer takes a
  click meant for the node. (#23)
- Property sections that are empty — annotations, parameters, port lists — open
  collapsed; the header already carries the count. A boundary port no longer
  offers "Input Ports" and "Output Ports" at all, being itself a port. (#21)
- The compact layout releases boundary ports from their first/last columns, so
  ELK can place them beside whatever they connect to. (#19)
- A creation that touches two files is one undo step. (#14)

### Fixed

- Edges no longer render detached from their ports. Persisted edge routes are re-anchored to the
  current port anchors on load; the snap existed but had never run, because ports were resolved
  through a `GModelRoot.index` property that does not exist.
- Node sizes are server-authoritative on every path. A fresh open no longer commits the client's
  measured bounds — which include the port and type-footer overhang — nor re-anchors ports inside
  the committed width, so fresh-open and persisted-reopen geometry now agree.
- Diagrams no longer twitch on reload. ELK re-centres `FIXED_POS` ports on a whole-pixel routing
  lane, returning ports of odd height half a pixel low; its port geometry is no longer written
  into the model, and edge endpoints are snapped to the server anchors instead.
- A double-click no longer nudges the node it lands on. Any pointer movement while the button was
  down counted as a drag, so the tremor in a double-click committed a real move and rerouted the
  node's edges. Mouse only — keyboard nudges of any size still commit. (#19)
- Changing a boundary port's type no longer renames the port. Every label edit was routed to a
  rename of the nearest entity, which for a type label resolved to the port itself, so the port
  was renamed to whatever type was typed. (#22)
- Edges leave a port horizontally rather than on a diagonal, and several edges sharing one port
  fan out instead of turning at the same point. (#19, #23)
- A node's height accounts for its type label, so the label no longer overlaps what sits below. (#8)
- Feedback edges are styled on the element the class actually lands on, the walk starts where data
  enters the network, and the network is ordered the way a layout engine expects. (#11, #12)
- Every child process settles, so the loading notice always clears. (#15)
- The build type-checks what consumers actually compile. (#16)
- The file attached to a chat session is bound to that session. (#9)

### Security

- Resolved npm audit findings. (#7)

## [0.6.0] - 2026-07-29

MCP cutover: one agent surface. (#5, #6)

### Added

- `create-task-type` as a reversible GLSP operation and custom MCP tool (undoable).
- `create-edges` accepts `nodeName.portName` addressing.
- Auto-layout after agent structural edits.
- Shared, parameterized property-panel chrome, field toolkit and CSS for library consumers. (#6)

### Changed

- Agents now get exactly two servers: the in-host GLSP-MCP loopback (undoable diagram editing) and the in-process registry (read tools).
- Agent-dispatched node creation is headless (no dialog), with actionable errors and port-rich confirmations.
- Chat UX: named tool chips, scroll respected during streaming, clean new-session transcript, explicit empty-state picker, unique session names, model-loading notice always clears.

### Removed

- Legacy stdio MCP server and its plumbing.

### Fixed

- MCP label-edit renames now apply (were a silent no-op).

## [0.5.0] - 2026-07-28

GLSP-MCP adoption (parallel-run). (#4)

### Added

- Loopback HTTP GLSP-MCP server per opted-in diagram profile, advertised to agents alongside the legacy stdio server.
- Agent diagram edits ride GLSP operation handlers as reversible workspace edits — user-undoable like palette edits.
- Opt-in via `profile.mcp.enabled`; per-user rollback `dialogram.chat.useGlspMcp` (legacy `workflow.chat.useGlspMcp` honored).

### Changed

- Undo/redo persists the document so the diagram reloads immediately.

### Removed

- Server-stack `undo`/`redo` MCP tools (the host owns undo).

### Fixed

- Reversible-edit snapshots read authoritative disk content (no false undo refusals).
- Undo on an empty stack no longer shows an error toast.

## [GLSP 2.7.0 + Node 22] - 2026-07-28

Toolchain upgrade, no intended behavior change. (#3)

### Changed

- Exact GLSP 2.7.0 pins on a Node 22 toolchain.

### Fixed

- Diagram no longer force-reloads on build-artifact (`.py`) changes; own-source edits still reload.
- Enrichment/queue-visibility redeliveries take an agent-context-only fast path (less drag-time work).

## [0.4.0] - 2026-07-27

One chat panel everywhere. (#2)

### Changed

- Single diagram-profile chat panel across products, with richer chat configuration.

### Removed

- Chat-only API surface.

## [0.3.0] - 2026-07-24

Chat runtime convergence. (#1)

### Changed

- Unified the two chat runtimes into one ChatRuntime with shared selection context.
