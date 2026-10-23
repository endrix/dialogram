# Changelog

All notable changes to Dialogram are documented here. Format based on
[Keep a Changelog](https://keepachangelog.com/); versions are the Dialogram
platform API version.

## [Unreleased]

### Fixed

- A node family's colour now reaches every node in the family. The generated
  rules coloured external nodes and subgraphs only, so a product whose own
  nodes are plain saw its families only on nodes brought in from elsewhere,
  and every kind of its own in the task amber; a plain node in a family now
  takes the family's colour in its header, and its watermark icon too. The
  server put a plain node's family class on its header compartment only,
  where neither rule looks; it is now on the node as well, as it already was
  for external nodes and subgraphs.

### Added

- `DiagramProfile.clientStylesheets` (and `SidecarProfileInput.clientStylesheets`):
  a product's own stylesheets, absolute paths, served into the webview after
  the platform's own stylesheet, stock bundle or `clientAssets` alike, each
  file's directory added to the resource roots. The platform already writes
  `<kind>-node`, `edge-role-<role>` and the family classes on what it draws;
  this is where a product says what they look like, without composing a webview
  bundle of its own for one stylesheet.
- Group containers. A producer puts a scope of kind `group` in its document
  (`subgraphs: [{ id, kind: "group", label?, parent?, nodes? }]`), and the
  nodes that declare that scope, or that it lists, are drawn inside a labelled
  frame; a group whose `parent` is a group nests inside it. The members and
  the layout direction are untouched: the container only says the members
  belong together, and the layout keeps them together. The platform learns
  nothing from the grouping; what a group is (a layer, a domain, a stage) is
  the producer's business and shows only in its label.

  A group is drawn and laid out the way mlir-viewer draws a nested region: a
  tinted body, a header band carrying the label, the members below it, laid
  out on their own (`SEPARATE_CHILDREN`) so the frame stays tight around them.
  An edge that leaves or enters a group is cut where it crosses the frame, at
  a boundary port (`port:group-boundary`), one piece per level; edges reaching
  the same member through the same frame share the way in. The stretch
  between frames keeps the edge's id, arguments and caption, and deletes the
  edge; a piece several edges share lists them (`wf:edgesOf`) and is not
  deleted on its own. Every piece stays at the root of the model, so saved,
  restored and rerouted routes keep their absolute coordinates.

- A dragged member of a group stays inside its group: the bound
  `IMovementRestrictor` refuses a position outside it, and a drop there is
  not committed. A group's area is open to the right and downwards: a member
  dragged that way takes the frame with it (the server grows the group, and
  any group around it, to fit, and the ports on its right-hand side follow).
  Past the left edge or under the header is refused. Members of other
  containers (a control structure's branch) move as freely as before.

### Fixed

- Reopening a saved layout put every node inside a container outside it: the
  layout file holds absolute positions and the loader wrote them back as
  positions relative to the parent, adding the container's offset twice. A
  reopened group also lost its size and the ports on its frame, which only the
  layout run produces; they are now rebuilt from the saved positions and
  routes.
- Moving a container saved only its own position: the layout file holds
  absolute positions, so its members reopened where they had been, out of
  the frame. A move now saves the new position of everything inside the
  moved node.
- The edge rerouter that runs after a move treated a group's frame as an
  obstacle, so an edge inside a group was routed around the group it is in.
- Clicking a node inside a group grew it. The group was declared resizable,
  so GLSP took the click for the start of a resize of the group, measured the
  group and its members in the hidden model and wrote the measured sizes
  back, larger than the nodes' own. Groups are no longer resizable by hand;
  measured bounds never resize a workflow node on the client
  (`NodeSizePreservingBoundsApplicator`, the `ComputedBoundsApplicator`); and
  a move never changes a node's size on the server unless its type is
  declared resizable, whatever size the client sends.

### Tooling

- `scripts/render-svg/render.mjs`: a graph document in (what a producer's
  plan command prints), an SVG out, through the server's layout and the real
  client in headless Chrome, extracted as "Export as SVG" extracts it. Picks a
  layout (`--layout default|untangled|free-ports`, `--all-layouts` for all
  three side by side), extra ELK options (`--elk key=value`), the product's
  node families and stylesheets, client behavior flags and a theme. For
  looking at what a change does to a real diagram without opening VS Code.

- A Facts section in the property panel. A producer lists what it knows about
  a unit on a node's `meta.facts` (`[{ label, value, markdown? }]`, and on
  `graph.meta.facts` for the unit shown); the panel shows them as `Facts (n)`
  under the identity header, one read-only row per entry in the producer's
  order, label on the left and value on the right. An entry with
  `markdown: true` has its value rendered as Markdown, as a block under the
  label, through the same sanitizer the chat uses but as CommonMark (a single
  newline joins the lines, so a document's wrapped prose reads as a
  paragraph rather than breaking at every column). No label is special and
  nothing is interpreted; an entry without a string label and value is
  dropped on the way in. Carried on `wf:facts`.
- Header badges. A producer puts short marks on a node's `meta.badges`
  (`[{ text, tone? }]`, `tone` one of `neutral`, `info`, `warning`, `error`,
  `neutral` when absent or unknown); the node's header draws them as pills,
  right-aligned, in that order, and the node is sized so they never cover the
  name. The text is the producer's word and the platform reads nothing into
  it: a modality, a status, a count, whatever a reader must see without
  opening the panel. Carried on `wf:badges`.

- `SidecarProfileInput.readOnly`: a profile whose diagram is a projection of
  a file drawn by the CLI, with no sidecar and nothing to edit. The assembled
  profile's `edits` is `'read-only'` and `supportsElementCreation` is `false`;
  the toolkit spawns no sidecar (no capability or openability probe, no
  create-node type listing, no sidecar graph export when the plan fails), so
  `graphAcquisition` must be `'cli-plan'` and `sidecarCommandSettingKey`,
  `sidecarCommandDefault` and `exportOp` may be left out. The chat stays, read
  only: `get_graph` and the session's graph context come from the CLI plan
  document, there is no edit backend, and the raw sidecar commands are not
  registered. Default `false`, which changes nothing.
- `SidecarProfileInput.openability.predicate`: the product's own answer to
  "can this file be shown as a diagram?", from the file's text and path. Given,
  it decides alone -- no sidecar probe, no decorator scan -- and it is the one
  form of openability a read-only profile may have.
- `meta.instanceName` on a node: the name it navigates as when that is not
  its label. A drill-down puts it on the crumb and the hierarchy outline
  matches its row against it (`wf:entityInstanceName`); the label and the
  entity name rename and lookups use stay as they were. For a producer whose
  node stands for a unit under another name: a clause drawn at the edge of the
  document that refers to it drills into the document that holds it, and the
  crumb should say that document, not the clause.
- The kind of an edge, for a sidecar whose `connect` can make more than one.
  A sidecar lists the kinds in its capabilities (`diagnostic.edgeRoles`,
  `[{ id, label, description? }]`); the create-edge handler then asks which
  (a role given on the operation, or the only one listed, is taken without
  asking) and sends it as `args.role`, and the delete handler sends the
  edge's `cal:edgeRole` as `args.role` so the right one of several edges
  between two nodes goes. The capabilities are asked once per sidecar command
  for the session, not on every connect. An agent's `create-edges` call is
  headless: it may name the kind in `args.role`, and is never asked; without
  one the sidecar's default kind is made. A sidecar that lists none is
  treated as before, on connect and on delete.
- `StorageRuntimeOptions.defaultLayout` (and `SidecarProfileInput.defaultLayout`):
  `'untangled'` or `'free-ports'` makes that layout the one a product's
  diagrams open with and the one Layout Diagram runs. Every loaded diagram
  carries the layout's graph options; a producer's own graph options still
  win. Untangled now says the declared port order explicitly, so it stays
  itself on a graph that defaults to Free Ports. Absent, nothing changes.
- Large graphs on the Java ELK server. A profile that ships the server's jar
  (`elkServer: { jar }`; Dialogram keeps one in
  `packages/diagram-server/resources/elk-server/`) lays out every graph past
  150 nodes or 400 edges there, and the rest on elkjs as before; anything the
  server cannot do falls back to elkjs. `<settingsNamespace>.layout.engine`
  (`auto`, `elkjs`, `elk-server`), `.layout.javaPath`, `.layout.javaOpts`
  (default `-Xmx2g`) and `.layout.serverTimeoutMs` are the person's. One JVM
  per extension host, started by the first layout that needs it and stopped
  with the extension. On NDF documents: Free Ports on 2000 clauses 8.2 s on
  elkjs, 2.6 s on the server. From mlir-viewer's elk-server engine, speaking
  only the server's gzip-framed mode (its plain mode hangs on a brace in an
  id) over one connection per layout. The jar carries ELK 0.8.1, elkjs 0.9.3.
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
- `DiagramProfile.statusSource`: node states from a report the product's tool
  makes (which requirements are covered, which checks pass), shown on demand
  with the run overlay's drawing and no run driver. The profile gives a label,
  a show and a clear command, and `collect(file)` returning
  `ExecutionNodeState[]`; the platform registers the two commands (they take
  the diagram's URI, as an editor-title menu passes it, or act on the active
  diagram), offers "Show <label>" and "Clear <label>" on the canvas's context
  menu, and publishes what `collect` answers through the execution overlay a
  run driver gets as `DiagramRunHost.overlay`. A failure is reported and
  leaves the diagram as it was. `SidecarProfileInput.statusSource` is the same
  with `collect(file, cli)`, where `cli(args)` runs the configured CLI in the
  file's folder and resolves to its stdout parsed as JSON.
- Published node states are drawn. `overlay.publish(sourceUri, states)` held
  them and nothing sent them to the diagram; now each change goes to the
  webview as the whole set, and a node draws its state with the run overlay's
  classes (`running` the turning ring, `succeeded` green, `failed` red, `idle`
  nothing), matched by node id in whatever view is shown. They are re-applied
  to every model the server sends, and sent again when the editor reopens.
- `wf:graphNodeId` on every node: the id the producer's graph document gave
  it. The diagram names a node after its label, so this is how a state that
  names the producer's id finds its node; a state may name either.
- Richer hierarchy outlines. A producer can shape its outline rows
  (`HierarchyOutlineEntry`): `label` and `detail` (a title for an id, an id
  for a title), a node `family` (the row carries its colour), `badges`, and a
  `role`. A `group` row (a folder, a layer) only opens and closes and is
  transparent to paths: its children's paths are written as if it were not
  there. A `node` row stands for a node in the view above it, by the
  producer's `nodeId` (kept on every node as `wf:graphNodeId`): a click selects
  and centres it, opening that view first when another is shown, and a double
  click runs the canvas's own double-click on it. The filter matches labels
  and details too, and the current view's row opens with what is in it
  (with its own group rows). A labelled row drops the file chip; the panel is
  wider (up to 380 px, half the editor at most).
- `clientBehavior.outlineTitle`: what the hierarchy outline panel is called,
  its title and its button's tooltip ("Hierarchy" by default). The filter's
  placeholder now just says "Filter…".
- Read-only views: a producer marks one view read-only with
  `graph.meta.readOnly: true` (a projection of a file it reads but does not
  write, a project overview). The root carries `wf:readOnlyView`; the
  palette's tools are hidden while that view is shown (its header stays, and
  the tools come back on the next editable view), and the context menu
  leaves out Rename Entity, Duplicate, Edit Parameters and the boundary-port
  edits. Moving and laying out stay. Per view, so one editor passes between
  editable and read-only views in place; `supportsElementCreation: false`
  still empties the palette of a whole profile. A keyboard delete or label
  edit still reaches the producer's sidecar, which is expected to refuse it.
- `clientBehavior.edgeCaptions: 'once'`: of the edges that leave one port, or
  reach one port, with the same carried label, only the first in model order
  writes it; the router bundles them on one trunk, where their captions used
  to stack (twenty `depends-on` on one line). An edge whose caption is left
  out, or not written because captions are off, says what it carries in its
  hover tooltip. `true` (the default) and `false` are unchanged.

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

- A double-click opens one thing. On a node that is not a network instance,
  the network navigation listener opens its first view (or, with
  `doubleClickOpensSource`, its definition), and the viewer listener opened
  its definition as a preview as well: a specification clause opened its
  refinement trace and its heading at once. The viewer listener now stands
  back whenever the other opens something.

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
