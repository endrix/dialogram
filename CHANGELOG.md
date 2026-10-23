# Changelog

All notable changes to Dialogram are documented here. Format based on
[Keep a Changelog](https://keepachangelog.com/); versions are the Dialogram
platform API version.

## [Unreleased]

### Added

- Links in the property panel lead somewhere. A click on an anchor in any
  text the panel renders (a node's body, a producer's facts) used to do
  nothing in the webview. `#<id>` now selects that element (by its id, or by
  the producer's own, kept on every node as `wf:graphNodeId`) and brings it
  into view, or opens the file reference in the link's title when the diagram
  does not draw it, `http(s):` and `mailto:` open in the browser, and anything else is a
  file reference the host resolves and opens: an absolute path or `file:` URI;
  a path relative to the node's own file or a folder above it; else the
  workspace's files ending with that path, the closest first (a quick pick
  when several match). `#L12`, `#L12-L20` and `:12-20` select lines;
  `::Name.member` and `#name` land on the symbol's definition.
- `meta.open: { file, line? }` on a node (`wf:open`): the file the node stands
  for, such as the code a specification clause names. A double-click opens it
  at its line, ahead of a drill-down, the node's views or its definition, and
  the panel's Basic Info links it.
- Producer-editable fields in any profile. An entry of `meta.parameters`
  marked `editable: true` gets an editor in a Fields section, committed
  through `updateNodeParameter` as typed: a select when the entry lists
  `choices`, an input with a list when it offers `suggestions`, a plain input
  otherwise. Until now the panel edited parameters only for a network runtime
  (`networkPropertySections`), as source expressions.
- `clientBehavior.propertySections: { ports?, annotations?, parameters?,
  entityType? }`: `false` hides the panel's port lists, its raw definition
  annotations, the definition's parameters, or Basic Info's Type row (task,
  workflow) with its change-type button: for a product whose pins mean
  nothing, whose facts already say it all, whose nodes have no parameters but
  their own fields, or whose node kinds are its own.

- `clientBehavior.edgeCaptions`: `false` draws an edge as its line alone, with
  no carried label, queue badge, last-token button or index label on it; the
  tooltip on hover still says what it carries. Default `true`, as before.
- `SidecarProfileInput.chat.sourceContext: 'reference'`: the chat session gets
  its source by reference instead of by content. No file is attached (the note
  names its path and size), the graph goes in as a line per node with its file
  and line, and a selected node as its name, what it is and where to read it,
  with a link to the file. The default, `embed`, is unchanged. A profile's own
  `chat.graphContextProvider` now wins over the edit capability's JSON export.
- Views of a unit besides its structure. A producer lists them on a node's
  `meta.views` (`[{ id, label }]`, and on `graph.meta.views` for the unit
  shown); the platform offers each as a context-menu item on the node and on
  the canvas, and a double-click on a node with no diagram behind it opens the
  first. A view shows in place as a crumb of the trail (`top / u_add ·
  Synthesis View`), is requested with `wf:view` (the `cli-plan` acquisition
  passes `--view <id>` to the plan command, the export op gets `view`), and
  keeps a layout of its own under `<unit>@<view>`. The view items sit last in
  the context menu, under a separator.

### Fixed

- Running a workflow no longer shows a "Model loading in progress" notification
  on every firing. The live overlay's signature changes with each firing and the
  editor reloads the model to redraw the glow; that refresh is now silent, as
  the run driver's own polling refreshes already were.

### Changed

- The context menu draws a separator above a group that follows the ungrouped
  items at the top, not only above a group that follows another group.
- `clientBehavior.doubleClickOpensSource`: a double-click on a node that is not
  a network instance opens the source it references in the text editor, at its
  definition. Off by default, so every existing diagram is unchanged. For a
  product whose leaves have a body no diagram shows yet: an HDL module or
  entity of processes and assignments. Network instances drill down as before.
- `newContainer.template` on the sidecar toolkit's profile input: the whole
  text of a new source file, from its name, for a product whose file is not a
  decorated Python function (a SystemVerilog module, a VHDL entity). Absent,
  the scaffold is the import line, the decorator and an empty function, as
  before.
- `SidecarProfileInput.sourceExtensions`: a sidecar-backed product whose source
  files have more than one extension (`.sv` and `.v`, `.vhd` and `.vhdl`) names
  them all. The platform's open/rename filters, the file watcher's default
  globs, the openability probe and the raw sidecar commands accept any of them;
  the new-file scaffold takes the first. `sourceExtension` stays honoured and is
  all a Python product needs.
- `DiagramStorageOptions.platformEntityItems` (and the same on the toolkit's
  profile input): `false` leaves the palette's Entities category to the
  product's own `entityPaletteItems`, for a product whose nodes are none of the
  platform's kinds. Default `true`, so every existing palette is unchanged.
- Sidecar toolkit, for a sidecar that is not Python: `openability.decoratorName`
  is optional (with only a probe, an undecidable probe opens the file instead of
  scanning for a decorator); `navigation: 'none'` installs no Python navigation
  provider and skips the Python caller scan; `chat.sourceMimeType` names what
  the agent receives the file as.
- A producer may place a port with its bundle instead of by its direction. A
  port's `side` (`west`/`east`) and a boundary node's `meta.side` say where it
  sits; `group` names the bundle. A handshake's `ready` then sits beside the
  `valid` and `data` it answers, and the wire between two nodes is a straight
  segment with the arrow pointing back instead of a loop around both. The
  direction is untouched: a `ready` output stays an output. The side reaches
  the shared port anchor (`cal:portSide`), ELK's port sides and row ordering,
  the label pass, the client hit areas and a mirrored boundary glyph
  (`cal:boundarySide`). Absent, everything is as before. An edge whose
  `meta.role` is `bidirectional` is drawn without an arrowhead.
- `documentErrorsToProblems` on the sidecar toolkit's profile input and runtime
  config: `true` publishes a loaded document's own root-level `errors` to the
  Problems panel with their file, line and column. Default `false`: a Python
  runtime's load errors stay in the diagram's overlay, as the diagnostics
  parity tests pin.
- A location in a graph document (`source`, `referencedSource`, `authoredSource`
  on a node, `source` on a port or an edge) may leave out its `file` when it is
  the graph's own, `graph.meta.file`; the reader puts it back before anything
  navigates. A hierarchy export of a large netlist repeated one absolute path on
  every element, a third of the export. A document with every file spelled out
  reads exactly as before.

### Fixed

- ELK is told the side the producer placed a port on. It was told the side
  from the direction alone, so a bundle's `ready`, placed in the other margin,
  was routed to as if it sat on the far edge: the wire came around the outside
  of the margin and crossed the whole node, label included, to reach the glyph.
  It now arrives from the side the glyph faces, in one straight run.

### Changed

- The server's ELK layout picks its option preset by the graph's size, so large
  graphs lay out in seconds instead of minutes. The default preset, with
  network-simplex placement and model order, took 41 s on a 344-node netlist
  module, 334 s on 1528 nodes and overflowed ELK's stack on 3293 nodes. Above
  150 nodes or 400 edges the middle preset applies (model order off,
  Brandes-Koepf placement, thoroughness 3: 1.7 s on 344 nodes, 9.3 s on 1528);
  above 1000 nodes or 3000 edges the fast preset (crossing minimisation off,
  simple placement, thoroughness 1, polyline routing, since orthogonal routing
  of a simply placed graph took 2289 s on 3293 nodes against 11.5 s: 3.8 s on
  1528 nodes, 11.5 s on 3293). The
  rule reads nothing but node and edge counts, applies to the initial layout on
  open and to every Layout command alike, and wins over Untangled's own
  placement in the fast tier, where the options it replaces are the ones that
  crash. A graph of up to 150 nodes and 400 edges gets exactly the options it
  did before. Each layout logs
  `[dialogram perf] layout <network>: tier=<default|middle|fast> nodes=<n> edges=<m>`,
  and a fast-tier layout says so in the diagram's status line.

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
