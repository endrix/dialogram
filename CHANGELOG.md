# Changelog

All notable changes to Dialogram are documented here. Format based on
[Keep a Changelog](https://keepachangelog.com/); versions are the Dialogram
platform API version.

## [Unreleased]

**Release:** this release must bump `DIALOGRAM_API_VERSION` to 0.9 and ship
with products built against it: its API removals (#127, #129), the stock
bundle's dropping the agent workflow UI (#137) and the `@viewer` opener
(#141), and the server's no longer answering agent discovery (#139), need a
product still at 0.8 to fail its version check rather than run against what
it no longer has.

### Removed

- **The two Reroute Edges entries of the context menu** ("Avoid Overlaps,
  Keep Nodes" and "Clear Routes Only", on a selection). Edges are routed by
  the layout and rerouted when a node moves or opens; the entries did
  neither well. The operations stay, for the moves and layouts that use
  them.
- **The `@viewer` double-click in the stock bundle.** Opening, diffing,
  opening with an editor or running a command on a `@viewer` task's last
  tokens, or opening the path it declares, is wfpy-ide's `NodeOpener` in its
  own bundle (endrix/wfpy-ide#29); the stock bundle binds no opener (#141).
  No other product emits `@viewer`. The double-click still opens a node's
  definition for every product, and the host still handles the
  `wf:viewer*` arguments of the actions.

- **Agent discovery and enrichment in the platform.** The server no longer
  scans `.wf/skills`, `.claude/skills`, `~/.claude/skills` and the
  `.claude/agents` directories when any product's diagram loads, no longer
  puts the skills and agent presets it found on the model's root
  (`wf:agentSkillsSnapshot`, `wf:claudeAgentsSnapshot`) or a skill status on
  `@agent` nodes, and no longer rebuilds the model a second time when that
  scan finds something. Its discovery requests and answers are gone with it
  (`dialogram.requestAgentSkills` / `requestClaudeAgents`,
  `dialogram.showAgentSkills` / `showClaudeAgents`, their handlers and the
  client's caches), as is the agent workflow UI's copy in the client
  (`agent-ui/`, `agentUiModule`, both unreleased). wfpy-ide asks its own
  host for skills and presets (endrix/wfpy-ide#26, #27). The
  `cal:agentSkillStatus` metadata key stays for now: wfpy-ide's Skill row
  still writes it.

- **The `@path` annotation editor and its wizard template.** No producer has
  a `@path` decorator: wfpy sets a workflow's tool search paths with
  `@config(path=[...])`. The property panel's editor never rendered, and the
  wizard's "external tool search paths" template wrote `@path(...)`, which the
  Python source cannot import. A `path` annotation a project defines itself
  still opens in the generic editor.
- **Agent and tool keys nothing reads**: `wf:toolSpec` on tool nodes (the
  external-actor flag stays), `cal:agentStateful` and its constant
  `WorkflowDiagramMetadata.AGENT_STATEFUL` (a removal from the shared API, for
  the next minor version), the never-called agent-metadata reset in the model
  storage, and the property panel's unused tab builder with its stylesheet
  rules, and its inline-Markdown renderer with the helper only it called.
- **Element types the model never emits**, with their client classes and
  views, server mappings, shape hints and layout branches: `node:proxy`, the
  two collapsed nodes, the if-branch, if-join, foreach-join and inline-if
  structure nodes, `edge:virtual`, `comp:ports` and `comp:port-row`; the
  metadata keys only they carried; the type guards that always answered
  false; the shared aliases, Origin helpers, sizing constants and CSS names
  nothing read.
- **Dead round-trips and aliases in the client**: the property panel's
  "Change referenced type" button and the toggle-grid action (no handler on
  either side), the pre-split back-compat module aliases, two unimported
  navigation files, a `wf:labelRole` read nothing writes, the
  `chat.sessionLoaded` case the host never sends, and 39 stylesheet selectors
  no view or template produces.
- **Unreached server code**: the serpentine layout's own edge router (its
  routes were always overwritten by the reroute that follows), the layout-key
  migration module, seven layout-persistence methods, the clipboard parser no
  paste reads, the "Stable, Experimental" reroute menu entry and its unread
  strategy flag, the ELK defaults the configurator always overrode, and the
  MCP persona option no caller set.

### Added

- **An edge can end at a group.** An edge whose end names a group's scope
  (`to: 'scope:run'`) ends on the group's frame instead of at a member: a
  transition into a state, where the state is a group of what can happen in
  it. Every edge that ends at a group arrives at one place on its frame, on
  the left, and keeps its arrowhead; an edge that starts at a group leaves
  from one place on the right. An edge between a group and something inside
  it is not drawn as a line: the group gets one loop on its frame for all of
  them, which keeps their captions and errors as its tooltip and is drawn in
  the error colour when one of them is in error. A group whose label is empty
  has no title and no header band, a group that holds nothing keeps room for
  its title (140 × 66 at least), and a scope's `label` now reaches the
  document from a sidecar's export (it was dropped, so a sidecar's groups
  were titled by their ids). The selection trace counts a group an edge ends
  at as on the path and leaves what it holds unfaded.
- **A group can be pinned to the top.** A producer pins a group with
  `pin: 'top'` on its scope: what belongs to the whole picture rather than to
  a place in its flow (a legend, the variables a state machine works on).
  Pinned groups are laid out apart and stacked in a band above the diagram,
  the first on top, their left edges on the diagram's; the rest is laid out
  as if they were not there. A pinned group that an edge crosses or ends at
  stays in the flow, since its edges need it there.
- **Links drawn only on selection.** An edge a producer marks
  `meta.onSelection` is no edge of the diagram: it takes no part in the
  layout, crosses no frame, and is not drawn until one of its ends is
  selected. Then every such link of the selected node appears over the
  diagram, the node at its other end outlined, the diagram's own edges faded
  behind. For relations too many to draw at once: the state an action reads,
  the actions that take a token from a port. Its ends name nodes (a port
  names its node, a group scope its group); `meta.role` gives it the class
  `selection-link-<role>` for a product to colour, `meta.label` a word on
  it, `meta.bidirectional` an arrowhead at both ends. A link leaves a node
  by the side facing the other end, or by the side across when a neighbour
  of the node's own frame is in the way; links sharing a side are spread
  along it so they do not cross. A node's `meta.sameAs` names what it is one
  drawing of: selecting it outlines the other nodes that draw the same.
- **A group can be marked as where the flow starts.** A producer marks a
  group with `start: true` on its scope: the initial state of a state
  machine, the first stage of a pipeline. Its title gets a filled dot before
  it, as a statechart marks its initial state (`group-start-mark`, for a
  product to colour). A group with no title has no band for it and draws
  none.
- **Lines of text in a node, read close in.** A producer puts lines of text
  in a node with `meta.lines` (`[{ text, kind? }]`, or plain strings; six at
  most, each cut at 48 characters): what a reader zooms in for and the
  property panel is too far away for, such as the condition a step waits on
  or what it takes and gives. Each line is a band across the bottom of the
  node's body, which is taller by them and as wide as the longest. The band
  is always drawn and carries `node-line-<kind>` for a product to colour, so
  which nodes have a line of a kind is seen at any zoom; its text is detail
  (`zoom-detail`), drawn only close in. A symbol takes none.
- **A group can be laid out in rows.** A producer puts the members of a
  group in rows with `meta.row` on a node, or `row` on a group nested in it
  (a whole number from zero, the first row on top): the actions of a state
  by the order they are tried in, say. The members of a row sit side by side
  in the order the producer gave them, the rows one under another; a member
  with no row comes after the last, and a member opened in place keeps its
  row. Rows are for members that relate only to what is outside their group:
  a group with an edge between two of its own members is laid out by its
  edges, as before. The pass that pins sources and sinks to the outer layers
  on opening leaves a row's members alone, and no longer pins a node that
  has no port at all (it is neither).
- **A definition the producer named is opened as it is.** A node whose
  producer resolved its type itself (`meta.referencedSource`: a sidecar that
  imported the module, a compiler that elaborated the design) carries
  `cal:referencedIsDefinition`, and "go to definition" on it (the
  double-click, **Go to Source**) opens that file and line without asking
  the host's navigation provider. With `navigation: 'python'` the provider
  asked Pylance first and took its answer over the producer's: a language
  server configured for another interpreter, or with other import roots,
  could open another declaration of the same name, with no sign that it had.
  The provider is still asked for a node whose producer gave only where it
  is written, and when the named file is gone.
- **The Python language server's import paths, from the sidecar.** A profile
  that names `pythonAnalysisPathsSettingKey` has its sidecar asked, when a
  diagram is opened, where its interpreter imports the file from (the
  `pythonEnvironment` op: the file's import roots, and the folders its
  installed packages come from). What the editor lacks is added to
  `python.analysis.extraPaths` of the file's workspace folder: the roots
  always, the installed packages only when the Python extension is known to
  have another interpreter selected. Paths are added, never removed; a folder
  whose `pyrightconfig.json` sets `extraPaths` is not written to (its author
  is told what it lacks), nor one whose `pyproject.toml` sets them; a sidecar
  that does not advertise the op is not asked. The named setting (default
  `true`, declared by the product) turns it off, as does **Stop Adding
  Paths** on the notice. The folder's effective list is what is extended, so
  entries set at user or workspace level are copied into the folder's.
- **An open reveals the editor a file already has.** A double-click on a
  node (its source, a viewer's file, a reference) opened in the diagram's
  group even when the file was open in the group beside it, as a second
  editor. An open now looks at the open tabs first
  (`extension-core/src/extension/diagram/open-in-place.ts`) and shows the
  file where it is, in the kind of editor asked for: the diagram of a file
  is not its text, and a diff is no file's editor.

- **The launcher.** Some outputs have no editor in VS Code: a chip layout
  opens in KLayout, not in a tab. A profile's new `launch` command
  (`DiagramCommandIds.launch`, named by the product: `workflow.glsp.launch`
  in wfpy-ide) starts an external program in its own window on the arguments a
  viewer gives it: the program first, then its options as they are, and
  path patterns (`{path}/results/*/*/*/6_final.gds`) replaced by the files
  they match, so a viewer's fixed arguments can name the files inside a
  folder token. A pattern that matches nothing, or a path that does not
  exist, stops the launch with a message saying which. The program starts in
  `<settingsNamespace>.launcher.workingDirectory` when set, else in its first
  file's folder; each launch's command line and output go to the profile's
  Launcher output channel. It runs only in a trusted workspace, and the
  user is shown the command line and asked before a program starts
  ("always" covers that binary, found on the PATH once, with those options,
  in that workspace folder). The
  program outlives the window that started it. A product has the launcher
  by naming the command; none is derived
  (`extension-core/src/extension/diagram/launcher.ts`).

- **A wire's bits as the producer's language writes them.** A producer can
  give the bits of a port a wire is in its own syntax beside the bits
  themselves (`fromSliceLabel`/`toSliceLabel` with `fromSlice`/`toSlice`:
  VHDL's `(7 downto 4)`, `(0 to 3)`), drawn as they are instead of `[7:4]`
  (`EDGE_FROM_INDEX_LABEL`, `EDGE_TO_INDEX_LABEL`, `indexLabelText`). Wires
  meeting one port are still ordered by their bits, and spaced by the text
  drawn. hdl-sidecar gives it for VHDL units.

- **The text comes in with the zoom.** Zoomed out below 50%, the nodes
  draw no text: their boxes, ports and wires, and a group frame its title.
  From 50% each node's name is drawn (its header, a boundary's name, a
  symbol's caption and operator), and the pills a run puts on edges (a
  queue's depth, the open button); from 80%, everything: the ports' names,
  the type under a node and a structure's condition line, its badges, what
  a wire carries and its bits. The diagram's svg carries `detail-far`,
  `detail-mid` or `detail-near` (`DetailGraphView`, `zoom-detail.ts`) and
  the stylesheet hides the rest with `display: none`, so the browser
  neither lays out nor paints it on an overview. Only the diagram on
  screen: the hidden render the client measures sizes in draws everything,
  and an SVG export lifts the class while it copies, so a file always
  carries all the text. Text a product's own views draw follows when it is
  tagged `zoom-name` or `zoom-detail` (`ZOOM_TEXT_CLASSES`, exported with
  `NAME_ZOOM`, `DETAIL_ZOOM` and `detailLevel`).

- **Any symbol can have a caption.** A producer can name what is written
  under a symbol node (`meta.caption`), as hdl-sidecar now does for an
  instance of a library cell it draws as a register or a mux (the
  instance's name: `mux_ccr_m` under its mux). A register still shows its
  label when it has no caption; a gate or a mux without one has none and
  no room for one. The symbol's box takes the caption's row, so the layout
  and the routers keep clear of it, and the body is drawn above it
  (`SymbolGeometry.size`, `bodyHeight` and `isCaptioned`). A sidecar's graph
  payload now passes a port's symbol `pins` through to the document, as the
  plan command's document already did.

- **A wire that is some bits of a port says which.** A producer can say
  that an edge is some bits of the port at one end (`meta.fromSlice`,
  `meta.toSlice`: `7:4`, `3`), as hdl-sidecar does for each operand of a
  concatenation it now wires straight to an instance's port instead of
  through a join or split node. The bits are written at that end as an
  index is (`[7:4]`), and always, whatever the product's edge captions:
  nothing else on the drawing tells those wires apart. Where several such
  wires meet one port end, their labels go one after another along the
  wire, highest bits first, as the concatenation reads.

- **A node holding a graph of its own opens in place.** A producer can give
  a node the graph it is made of (`meta.inner`: `nodes`, and `edges` between
  their pins and the node's own ports; an HDL process and the gates and
  registers it synthesises to). Such a node has a `+` at the start of its
  header; pressed, the node is drawn as a group frame titled with its name,
  holding its inner nodes, and its edges are carried on to the pins they
  reach (an edge into an input goes to each pin the input feeds, one out of
  an output comes from the pin driving it, one through it joins its ends),
  split at the frame as any group's are; the `−` in the frame's header
  closes it. Whether a node is open is saved in the layout file with its
  open bundles (the reserved name `*`, `ToggleNodeOpenOperation.OPEN`).
  Opened, the frame takes the node's place, its members are set in columns
  by depth from its inputs, and the nodes stacked under it move down;
  closed, the node takes the frame's place and they move back; undo and redo
  replay the moves (`model/open-nodes.ts`,
  `operations/toggle-node-open-handler.ts`, `node-open-toggle.ts`). Bound
  for read-only sessions too. A group's title now starts where the view puts
  it (a general text rule centred it on its x).

- **A node can be drawn as a symbol: a gate, a mux, a register, an
  operator.** A producer says what a node is (`meta.symbol`: `and`, `or`,
  `xor`, `xnor`, `not`, `mux`, `register`, `operator`, the last with its glyph
  in `meta.operator`) and which of the symbol's pins each port is
  (`port.pins`). The node is then the IEEE shape (a flat-backed AND, a curved
  OR, an XOR's second back line, a NOT's bubble), a mux's trapezoid, a
  register's box with its clock wedge and its name under it, or a small box
  with the operator: no header, no type under it. Its pins sit on short
  stubs that end on the body's back, the curve's for an OR, in the symbol's
  order: data, then controls (a mux's select below its data), then the
  result; a register's pins are named by what they are (`d`, `en`, `q`), a
  gate's are not named. Sizes and pin rows are `SymbolGeometry`
  (`shared/symbol-geometry.ts`), read by the server to place the pins and by
  the client (`symbol-views.ts`) to draw the body between them; output stubs
  meet the body's front at any height, a register widens for its pin names
  and draws a `clk` pin at its wedge, and the whole box takes the pointer. A
  symbol the platform does not know, or a node with badges (drawn in the
  header a symbol has none of), is drawn as a box. A symbol has no header
  label, so it is not renamed by editing one: meant for a read-only
  producer. hdl-sidecar sends these for a statement that synthesises to one
  cell.

- **Port bundles are drawn as buses.** The ports of one bundle (a producer's
  `port.group`: a channel's payload with its `valid` and `ready`) are drawn
  as one port named after the bundle, and every connection between two
  buses as one wider edge (4.5px against 3.5px; a product sets
  `--workflow-edge-bus-width` to draw it otherwise). A toggle in front of the name opens the bundle:
  its row stays as a header and its members are drawn under it. The edge
  stays one bus edge, drawn from the open header, until both ends are open;
  then the connections are drawn member to member as the producer sent
  them. Every bundle starts closed, and which ones are open is saved in the
  layout file beside the positions (`portBuses`, by node). Any producer that
  sends `group` gets it; today that is hdl-sidecar, so sv-ide and vhdl-ide.
  A bundle of one stays a port, and a bundle whose members sit on both sides
  becomes a bus on each. Opening or closing one is the `dialogram.togglePortBus`
  operation, bound in read-only sessions too: it saves every bundle the view
  shows open (a nested view keeps what it took from its fallback), rebuilds
  the model from the document it was last built from and the positions the
  diagram has now, without asking the producer again, and reroutes the
  node's edges. Undo closes what it opened, in the view it was made in; the
  history before a toggle is dropped unless it is all toggles (layout edits
  are recorded as patches to a model the rebuild replaces). When the layout
  file cannot be written, the choice still holds for the session. A bus edge
  a saved layout has no route for (one saved before buses, or one a toggle
  drew) is routed once the client has measured, and saved, unless the view
  is showing its fallback's layout. Opening a bundle makes its node taller:
  the nodes stacked under it move down with its bottom edge, each keeping
  its gap, and inside a group the group grows and makes the same room among
  its own siblings (`make-room.ts`). Undo, redo, and closing a bundle opened
  in the same editor session move exactly those nodes back, provided every
  one is still where the opening left it and none would land on another
  node; otherwise, and for a bundle opened before, the close leaves the
  room it had. Groups are fitted to their members again after either, and
  a toggle into the state the bundle is already in does nothing.

- **A bundle of the unit's own ports is one boundary node.** The boundary
  nodes of one bundle in one margin (`s_axis_tvalid`, `s_axis_tdata`, and
  the `s_axis_tready` placed beside them) are drawn as one, named after the
  bundle, saying how many ports it holds where a port says its type, in
  place of the first of them, and Go to Source opens that one's
  declaration; it is an input when most of its members are, and its edges
  run the way its arrow points. Its toggle sits between the arrow and the
  name and works as an instance bus's does: open, the node stays as the
  bundle's header, the members are drawn in the rows under it in its
  margin, and what was laid out under it moves down to make room, back
  again on undo or close. Its edges are merged and split by the same rule;
  a wire from one member of a closed bus to another, of the unit's or an
  instance's, is drawn once the bus is open, no longer as a loop on it. A bundle split across both margins is a bus in each; a bundle of
  one stays the port it is. The open state is saved under the bus node's
  id (`bus:wf:<margin>:<bundle>`). A layout saved before the bundle was
  drawn as one stays usable: the bus takes its topmost member's place
  rather than the whole diagram being laid out again
  (`boundary-bus-positions.ts`).

- **What a double-click on a node opens is a contribution point:
  `NodeOpener`** (exported). An opener answers before the platform's own
  definition navigation, or leaves the node to it; one per `id`, the last
  binding winning. The `@viewer` half of the double-click listener (open,
  diff, open with an editor or run a command on a task's last tokens, or a
  path it declares) became the `viewer` opener (#140) and then wfpy-ide's
  code, in its own bundle (endrix/wfpy-ide#29); the stock bundle binds no
  opener.

- **What a product's webview code needs, from the package.**
  `@dialogram/diagram-client` exports `VscodeUi` (the host's quick picks,
  input boxes and commands), `clientBehavior`, `commandId`, `offersRun`,
  `settingsNamespace`, `escapeHtml`, `shortenPath`, the markdown helpers
  (`renderMarkdownSafe`, `renderDocumentMarkdownSafe`, `looksLikeMarkdown`)
  and the agent-output helpers (`isBlock`, `looksLikeDiff`,
  `parseEmbedded`, `formatAgentOutputs`), so a product bundle's own
  contributions import names rather than the package's files by path.

- **Contribution points in the property panel and the annotation wizard, and
  the agent workflow UI as a module of its own.** `AnnotationEditor` (an
  annotation card's own controls, Save's text and merge, a quick-add button),
  `NodeSectionContribution` (Basic Info rows, a section after Annotations
  and one last, preparation before a node draws, in-place updates while the
  model changes, a one-time install) and `AnnotationTemplate` (a wizard
  entry that composes the annotation's text), all exported from
  `@dialogram/diagram-client`. A product binds them in a feature module
  passed to `startStockDiagram({ features })`; each keeps one contribution
  per name or id, the last binding winning, so a product can replace a
  stock one. wfpy's `@tool`/`@agent` editors, agent sections and
  `@tool`/`@viewer` templates moved onto them (#133–#135), then into
  wfpy-ide's own webview bundle (#136, #137, endrix/wfpy-ide#24, #27).

- **A product whose CLI has no `run` says so: `cliRuns: false`.** The
  toolkit then registers no run driver and the chat offers no resume. The
  webview learns it from a derived `clientBehavior.runDriver` (like
  `chatBackend`; `resumeAtStep` is now derived with it), and a diagram with no
  run driver behind it shows no Run, Stop or edge toggle in the palette
  header and no Agent Tools switches in the property panel, all of which
  called the driver's commands. That covers ndf once it opts out, and today
  chisel-ide and the library-mode mlir-viewer, whose Run invoked a command
  nothing registered. sv and vhdl keep theirs: `hdl run` simulates through
  it.
- **A product's own webview bundle starts the stock diagram.**
  `startStockDiagram({ features })` (`@dialogram/diagram-client/stock-starter`)
  is what the stock bundle runs, with the product's feature modules loaded
  after the stock views and feature UI; the stock entry is now that call with nothing added,
  and its bundle's stylesheet is byte-identical. A sidecar product names its
  bundle with `clientAssets` on the `createSidecarDiagramProfile` input, as a
  hand-assembled profile already could.
- **Selection trace** (`clientBehavior.selectionTrace`, opt-in): selecting a
  node draws every path through it, what leads to it in green and what it
  leads to in blue, and fades the rest; after mlir-viewer's trace highlighter.
  A path crosses group frames through their boundary ports, at any depth, every
  piece of a cut edge drawn. The walk reads the diagram left to right: a wire
  drawn back to the left, a handshake's `ready` or a loop's feedback, is
  walked against its arrow, so a netlist's ready wires do not make a cycle of
  every two neighbours and the trace follows the data as far as it goes. A
  wire is read by where its two nodes stand, not their ports, so two nodes
  that overlap across the page do not turn it. On a cycle that remains, the
  trace is cut to the node's direct neighbours, since reachability would
  light the whole diagram. A selected
  edge draws all its pieces and its two ends; a selected container, what feeds
  it and what it feeds, leaving its members as they are. Drawn as GLSP
  feedback, so it survives a relayout or an edit.

### Changed

- **A symbol's pins are drawn as wide as the wires.** The short stub from
  a gate's, operator's or register's body to each pin was a 1.5px line
  stopping at the node's edge, half a port short of where the wire ends:
  a thick wire narrowed into a thin one with a gap on the way out. The
  stubs are now as wide as a wire, with square ends: an input's from the
  border its wire's arrowhead points at, an output's out to its port's
  outer rim, where its wire begins (`SymbolPins.eastEnds`), so the wire
  goes on into the symbol unbroken. They stay the symbol's colour. A
  wire's width is one variable, `--workflow-edge-width` (3.5px), which the
  edges and the stubs both read.

- **Opening or closing a bus, or a node in place, lays the view out
  again.** The node changes size and which ports it has, and a layout made
  for the old one no longer fits: pushing the nodes under it down and
  rerouting their edges left the rest of the view crossed and crowded. The
  whole view is now laid out as Layout Diagram lays it out (with the
  product's `defaultLayout`), and scrolled so the bus or node pressed stays
  where it was on screen (`ToggleAnchor`). Undo and redo put back the layout
  the view had before and after the toggle, exactly, without laying it out
  again. A product that wants the old behaviour sets `toggleLayout:
  'make-room'` (`StorageRuntimeOptions`, the extension API and the sidecar
  profile).

- **A bus's toggle is a smaller dot.** The `+`/`−` dot of a bus port, and
  the one beside a bundle of the unit's ports, is 10px across instead of
  12px (`PORT_BUS_DOT_RADIUS_PX` 6 → 5), about the size of a port's own dot,
  so it no longer stands out from the node's other ports. Its box, and so
  where its edges end, shrinks with it.

- **Ports are dots.** A node's port is drawn as a circle on the node's
  edge, ringed in the editor's background so the edge running into it stays
  apart from it, as a group frame's dots are, instead of a rounded square
  whose stroke told input from output (the side and the edge's arrow
  already do). The geometry, anchors and the `port-shape` class products
  style are unchanged. A bus port is a larger dot with its toggle inside,
  `+` or `−`, in place of the square toggle in front of its name.

- **Ports sit centred on the node's border**, as a group frame's dots sit on
  the frame, instead of outside it; a bus port's box is its larger dot,
  centred on its row, and keeps that offset when the Free Ports layout
  reorders a side. A port's name is 3px from its dot, not 1px
  (`PORT_LABEL_GAP_PX`), on the row's whole pixel beside a bus too; nodes
  are 4px wider for it, so a saved layout packed edge to edge may touch.
  Saved routes are re-snapped to the new anchors on open. How a port's name
  is sized and placed is one shared copy (`port-label-geometry.ts` in
  shared, `port-labels.ts` on the server) for the model, every submit, the
  bounds pass and the client.

- **Breaking for a product that showed the agent workflow UI from the stock
  bundle: it no longer loads it.** The `@tool` and `@agent` annotation
  editors, the agent sections of a node's panel (Skill row, Agent Tools, live
  Agent Context), the wizard's `@tool` and `@viewer` templates and the
  handlers of the server's skill and agent-preset answers were wfpy's, yet
  every stock-bundle product showed the editors, the header's "Add @tool" and
  "Add @agent" and the templates. They are wfpy-ide's code now, in its own
  webview bundle (endrix/wfpy-ide#24, #27). sv, vhdl, ndf and
  calpy get the plain annotation card and only the wizard's "Custom
  annotation…"; none of them has `@agent` nodes, so Agent Tools, the Skill
  row and Agent Context never appeared for them. The stock bundle is 141 KB
  smaller. Ship in the 0.9 release (above).

- **Breaking for a profile that relied on the defaults: the Entities palette,
  navigation and the source MIME type are the product's.** The tool-palette
  provider no longer hard-codes wfpy's five rows (Task, Tool, Agent, Viewer,
  Workflow) or, behind `useAlternateEntityPalette`, calpy's two (Actor,
  Network): Entities are the profile's `entityPaletteItems`, in its order, and
  a profile with none shows no Entities header. `useAlternateEntityPalette`
  and `platformEntityItems` are deprecated, accepted and ignored. The Python
  navigation engine, and the Python caller scan behind "used by", run only
  for `navigation: 'python'` (the default is `'none'`), and the source goes
  to the agent as `text/plain` unless the profile names a MIME type. sv, vhdl
  and ndf set all three already; wfpy-ide (endrix/wfpy-ide#23) and
  streamblocks-ide (streamblocks/streamblocks-ide#9) declare them now. Ship
  those first; the release that ships this bumps the API to 0.9, so a
  product built for 0.8 fails the version check instead of silently losing
  its palette.
- **One declaration of the webview's behaviour flags, the command ids and
  the in-process chat tool.** `DiagramClientBehavior` (with
  `AcpConnectorInfo`), `DiagramCommandIds` and `InProcessChatTool` live in
  `@dialogram/shared`; the API re-exports them, the toolkit's
  `SidecarClientBehavior`, `SidecarProfileCommandIds` and `RegistryChatTool`
  are the shared types (the product-facing behaviour is
  `ProductClientBehavior`, the shared type minus the four fields the platform
  derives), and the webview reads them instead of its own copy. The test that
  kept two hand-written twins in step is gone with the second twin.
  `scriptInterpreterCommands` is deprecated: nothing reads it.
- **One sidecar transport.** Six places each spawned the sidecar, wrote the
  request and parsed the answer with their own wording and deadlines: the
  invoker behind every diagram edit, the chat's `invokeSidecarOp` and
  `exportWorkflowGraph`, the model source's graph export, the openability
  probe and the raw `sidecar.send` command. `sidecar-transport.ts`
  (`invokeSidecar`) is the one: every request runs from the file's Python
  package root with it on `PYTHONPATH` (before, the chat's requests did and
  the diagram's own edits did not), the answer is the whole output when it is
  one JSON document and its last line when the sidecar logs above it, and a
  process failure is reported as the child-process module describes it, with
  the op and the sidecar's stderr. `exportWorkflowGraph` is gone: the export
  is an op like the others. The graph-export op has one
  default, `exportGraph`, which every sidecar answers to (the model source
  used to pick `exportNetworkGraph` or `exportWorkflowGraph` by acquisition
  strategy and ignore the product's `exportOp`; it now sends the product's,
  and `SidecarRuntimeConfig` carries it).
- **An operation module brings the MCP tools of its operations.**
  `DiagramOperationModule.configureMcpTools` (add-only) is the seam; the
  diagram MCP module binds what the profile's modules offer instead of naming
  `create-task-type` itself, and that tool now lives in the sidecar toolkit
  beside the handler that serves it, so every sidecar product still offers it
  and a library-mode consumer without the handler no longer advertises a tool
  it cannot run. A read-only diagram offers no mutating tool at all
  (create-nodes, create-edges, modify, delete, save): nothing handles them
  there. The chat's fallback "skill", wfpy's own tool list and nouns sent to
  the agent of any product whose profile named no skill, is gone: such a
  profile gets the framing alone. The diagram-tool hint names the platform's
  tools and "whatever further diagram tools are listed", no product's.
- **One entity-node renderer.** The actor, external-actor and network views
  drew the same body (the sized rect, the run ring, the family's icon or
  image, the children, the type footer) three times over; `renderEntityNode`
  draws it once and each view names only its root classes. The three view
  classes keep their names (a product extends `ExternalActorNodeView`).
  `findNodeIdByGraphId`, the lookup of a diagram element by a producer's id,
  is one function (`producer-ids.ts`) for the outline, the property panel
  and the headless renderer, with one rule where the three differed: the
  producer id wins (a diagram id is a label, which another node's producer id
  may equal), a direct hit must be a node, the first in document order. The
  renderer's layout table is the Layout menu's own, so its Untangled now
  pins the declared port order as the editor's does.
- **One copy of each toolkit helper.** `server/source-files.ts` holds
  `fileExists`, `findPackageRootForFile`, `withPythonPackageRoot` and
  `collectPythonFilesUnderRoots` (the analysis, the create-node handler, the
  graph export and the run driver had their own); `server/python-text.ts` is
  the home of `countParenDelta`, `escapeRegExp` and
  `stripPythonCommentsAndStrings`; `normalizeWorkflowReferenceName` replaces
  the two `unqualifyName`; the run driver resolves the CLI command through
  `getCliInvocation` like the server (a blank setting now means the default,
  as it does everywhere else). `normalizeSourceUriKey` is one function, in
  `@dialogram/diagram-server/server/uri-keys`, for the host, the server and
  the toolkit; the webview keeps one copy of its own, browser-bound. The
  parity test that kept two copies aligned is gone with the second copy.
- **One layout snapshot for every handler.** The six handlers that lay nodes
  out or route edges each carried their own copy of "walk the model, key the
  nodes and the routes, save": eight `collectNodePositions`, eight
  `collectEdgeRoutes`, five signature helpers, four snapshot/restore sets,
  about 1,400 lines, drifted. `diagram-server/src/server/layout-snapshot.ts`
  holds them once (`collectNodePositions`, `collectEdgeRoutes`,
  `movableNodeIdsIn`, `snapshot*ById`, `restoreUnselectedLayout`,
  `persistLayout`), and `persisted-edge-routes.ts` exports the route-key and
  anchor helpers it always had. Every handler keys a saved route the same way
  (endpoint signature, AST path where it repeats; four keyed by path alone,
  which the loader read through its fallback). Reset Routes and the reroute,
  which noted their save under a model-state key nothing read, now leave the
  layout meta alone on purpose: lowering "has persisted edge routes" would arm
  the bootstrap reroute that redraws what was just cleared.
- **A sidecar profile names what is its own; the toolkit derives the rest.**
  `SidecarProfileInput` no longer requires the command ids, the operation
  kinds, the GLSP client identity, the CLI and sidecar setting keys, the
  eight run-driver setting keys, the undo suffix or the scope argument: each
  is derived as every product spelled it by hand (`<glspClientName>.glsp.<command>`,
  `<prefix>.sidecar.edit`, `<prefix>.createEntityPort`, `glsp.<name>`,
  `cliCommand`, `sidecarCommand`, `runOutputDir` and the agent-tool keys,
  ` (<key>)`, `workflow`), and a value the product gives wins
  (`resolveSidecarProfileInput`, `resolveSidecarCommandIds`). A product's
  profile can lose about half its lines; one that keeps them all is unchanged.
- **Three command ids and three chat fields are deprecated**, accepted and
  ignored: `createAgentToolPolicyFile`, `chatAddViewerEditor` and
  `chatAddViewerTask` (nothing registers them), `chat.name` and
  `chat.operationPrefix` (nothing reads them), and the toolkit input's
  `mcpEnabledSetting` (the rollback lever is `dialogram.chat.useGlspMcp`).
- **The chat offers no node-creation slash command the profile did not name.**
  The built-in `/create-task`, `/create-agent`, `/create-viewer` and
  `/create-workflow` fallback is gone; every sidecar product names its own
  `chat.nodeCommands` already.
- **After a drop, the routes an edge cannot keep are drawn by libavoid, with
  the edges on one port as one shared path.** The layout draws the edges into
  a port as a trunk; the built-in router gives every edge its own channel and
  drew a comb, and libavoid did the same because every edge on a port was
  started at its own staggered point. Now they start at one point and
  libavoid keeps them on one path for as long as they go the same way, a
  trunk with a junction. The half-nudge kink the stagger was for is taken
  out after routing. libavoid is the router from now on; the built-in one
  remains the fallback when libavoid is unavailable or cannot solve an edge,
  the choice for a reroute of every edge in a diagram of more than 200
  edges, and available throughout with `WORKFLOW_DIAGRAM_ROUTER=manhattan`.
- **The edges of a node being dragged are not drawn while it moves.** They
  come back as soon as a route for the node's new place is in the model, as
  a schematic editor redraws a block's nets after it is placed; before, they
  trailed the pointer on their old routes and jumped at the drop. A move by
  arrow key hides nothing, and a cancelled drag draws them again at once. A
  node held still mid-drag keeps its edges hidden: a drag with no move for 5s
  is taken as one that never finishes. A bounds pass mid-drag, which draws
  the server's model in the hidden layer with the node still at its old
  place, no longer draws the edges again for the rest of the drag. A route
  that reaches the ports is drawn the moment it arrives, inside the drag's
  settling window too, instead of a client route that is swapped out
  later. If no route arrives the edges are drawn as they were: after 1.5s,
  plus 25ms an edge hidden and 6s at most, since a dense node's routes take
  the router longer.
- The server logs one `[dialogram perf] reroute` line per reroute it
  persists: edges kept, edges routed, the router and the time taken.

- **The Java ELK server is rebuilt on ELK 0.10.0, and elkjs is pinned to
  0.10.0**, so a graph lays out the same on either engine; before, the
  server's ELK 0.8.1 put some graphs' nodes in another order than elkjs 0.9.3.
  The server's source, recovered from the shipped jar, now lives in
  `elk-server/` (Maven, `mvn package`) under the EPL-2.0 only, as before, its
  licence now inside the jar too; wire format unchanged (the gzip-framed
  socket mode included). `test/elk-server-parity.test.ts` lays two real
  documents out on both engines and requires them to match. **Products must
  rename the jar they copy and name in their profile to
  `elk-server-0.3.0-all.jar`**, and the server now needs **Java 17** (ELK 0.10
  is built for it); without it layouts stay on elkjs, as before.

### Fixed

- **A wire into a closed bus of the unit's ports runs the way it does.** A
  bundle of the unit's ports that mixes directions (a handshake's `data` and
  `valid` in, its `ready` and `space` out) is drawn as an input, and every
  edge at it ran the bus's way: closed, `ins_ready <= not Full` was drawn
  as an arrow from the bus into the inverter's output. An edge whose wires
  all run one way now runs that way, as it does once the bus is open; the
  bus's arrow still decides an edge whose wires run both ways.

- **Zoomed out, an operator symbol no longer disappears.** The rules that
  hide text by zoom named classes alone, and a node's own group carries
  classes of the same names: an operator symbol's is `symbol-operator`,
  the class of its operator's text, so the whole node was hidden below
  50%. Every rule now names the element it hides (`text`, or the `g` of a
  badge or an edge's pill), and a test keeps it so.

- **A product's node families reach the editor.** A sidecar profile's
  `nodeFamilies` went to the server, which classes the nodes, but not to
  the client, which draws a family's mark and colour from
  `clientBehavior.nodeFamilies`: sv-ide's, vhdl-ide's and ndf-ide's nodes
  had no icon and no colour in the editor, while the headless renderer,
  which feeds both, drew them. The platform now tells the client the
  families the server classes nodes with, for every profile, unless the
  product names others in `clientBehavior` (wfpy-ide does).

- **A diagram whose nodes share a label draws.** A node's id was its label,
  and an HDL producer labels an expression node with the expression: the
  same expression on two ports (`{tid, tpl}` into two RAMs,
  `mul_result[63:0]` four times) gave two nodes one id, and the client
  refused the whole model, drawing nothing (`tlu`, `sparc_exu_div` and
  `eth_miim` in sparc64soc). The first node to carry a label keeps it as its
  id, in the document's order, and later ones take the producer's id, so a
  named node's saved position survives a duplicate added later
  (`model/stable-ids.ts`). An edge's From and To show the nodes' names, not
  their ids.

- **A diagram whose node has two ports of one name draws.** A port's id was
  its node's id and its name, and a name can repeat on one node: a
  concatenation reading one net twice (`{lead0, lead0}`), an expression
  reading the net its port is named after (`.rdy(rdy != 0)`), an assignment
  reading its own target (`q = rst ? d : q`). The client refused the whole
  model; 17 of 253 sparc64soc modules drew nothing, the top level `W1`,
  `lsu`, `sparc_ifu` and `fpu_div_frac_dp` among them. Where a name repeats,
  the first output keeps it (the first input, when none is an output) and the
  others number it, `div_lead0[5:0]#1`; a name no other port on the node has
  keeps the id it had (`stablePortNames` in `model/stable-ids.ts`).

- **The selection trace follows a model rebuilt under the same selection.**
  Its classes were worked out once, on the model the selection was made on,
  and put back by id on every model after: elements a rebuild added (the
  member edges of a bus just opened) were neither traced nor faded. The
  feedback now carries the selection and works the classes out on each model
  it is put on.

- **The palette creates nodes, and the property panel adds entity ports, in
  every product's diagram.** Both handlers accepted only a `.py` source, so a
  Verilog, VHDL or NDF diagram answered a palette drop with nothing. Like every
  other handler that writes to the source, they now ask only that the model
  has one.
- **Copy then paste re-creates the copied elements.** Copy wrote the entity's
  name as `entityName` with its source text, while paste looked for `name` and
  `typeName`, so a copied node pasted as nothing; cut and duplicate already
  wrote the paste shape. One payload now lives in `@dialogram/shared`
  (`DiagramClipboardPayload`, `parseClipboardPayload`,
  `clipboardDataFromPayload`), written by copy, cut and duplicate and read by
  paste and the webview's post-paste selection. The server's
  `clipboard/py-clipboard` module is gone; its builder is
  `buildClipboardPayload` in `clipboard/clipboard`.
- **A pasted or duplicated connection joins the pasted copies**, not the
  entities it was copied from, which used to get a second wire while the copy
  stayed unwired. The pasted name follows one rule, `nextFreeName` in
  `@dialogram/shared` (`add`, then `add2`, `add3`), on the sidecar side and in
  the webview, which predicted `add1` and so never selected the pasted node.
  A paste with nothing to paste says so instead of doing nothing.
- A layout change still on its 500 ms debounce timer when the window closes
  is written out: the host flushes every diagram's pending layout saves on
  deactivation.
- **The running ring and the queue sizes no longer blink through a run.** The
  runtime writes `run.wf-viewer.live.json` at every firing and the server
  re-reads it every 400ms, so now and then it read the file halfway written,
  took that for no run at all and fell through to the previous run: the ring
  went off, the previous run's queue sizes came on, and the next read put
  things back. A run-output file that does not parse is now read as it last
  did (the queue trace too), and from the end of a run until its record is in
  `run-log.jsonl` its last live overlay stands, as finished, where the
  previous run showed for a moment.
- **The eye on the palette, off, takes the run's tokens and queue sizes off
  the edges.** It took only the step counter away: the carried colour, the
  token pills and the sizes stayed, so it looked as if it did nothing. The
  nodes keep the run's state (the ring is the live run, with its own
  setting). A queue size the trace no longer has is taken off the edge too.
- **Moving a node no longer scrambles its edges.** The layout routes the
  edges together, so edges into one port share a trunk. After a move the
  server routed the moved node's edges anew, each on its own and each in its
  own channel, so the trunk came back as a comb of parallel lines with a
  knot at the port, and the picture drifted from the layout with every
  nudge (a move counts from 4px, and an arrow key on a selected node is a
  move). Now an edge keeps its route and only its ends follow the ports, at
  any distance, not just under 5px as before; the router runs only for an
  edge whose kept route would not do: a straight edge with no bend to
  carry, a stub that would turn back through its node or shrink under 8px,
  a segment that would run through a node. An edge is rerouted for a node that moved onto
  it only when the node covers it, not when it came within the router's
  padding, and only the node that moved counts, not the one at the far end
  of its edges.

### Removed

- The `workflow.*` legacy-settings shim: the three core chat settings are read
  from `dialogram.chat` directly, the extension no longer contributes the dead
  `workflow.chat.enableMcpTools` key, and a session store written under
  `workflow.sessions` before the rename is not migrated any more (every
  release from 0.1.0 to 0.8.0 performed that migration on first open, so only
  a workspace never opened with any Dialogram build still holds one). Twelve
  SessionManager methods nothing called, the deprecated `ChatSlashCommand`
  type, the webview's port-label debug toggles and the `clientDebug.inlinePing`
  / `inlineConfig` messages no host handler answered, the `chat.setModel` and
  `chat.getStatus` message aliases the panel never sent. The sidecar toolkit's
  package index names only what products import (the profile assembler, the
  API type and the input literal's types); its unused `mcp` input and
  `clearSidecarCapabilitiesCache` are gone. `SidecarProfileInput.mcp` was
  optional and read by nothing, but a profile literal that still spells it no
  longer compiles: drop the line (the chat tools are always on).

### Tooling

- `scripts/render-svg` places port labels as every submit in the editor does
  (`placePortLabels`, now shared), so a render shows names where the editor
  does rather than where ELK left them.

- `scripts/render-svg --open <node:bundle>` draws a bundle open (repeatable;
  `<node>:*` opens all of a node's, `*` every one), so each state of a bus
  can be rendered and looked at headlessly.

- `scripts/render-svg --select <id>` selects an element (the diagram's id or
  the producer's) as a click would, so a selection trace can be rendered and
  looked at headlessly.

## [0.8.0] - 2026-10-24

What a producer of document-like diagrams needs: group containers, facts,
header badges, links and editable fields in the property panel, outline rows,
read-only views, a status overlay, edge kinds on connect, captions once per
trunk, and the Java ELK server for large graphs; plus the headless renderer
and a faithful SVG export of running nodes. (#90-#107)

Every addition is opt-in and the exported API only grows, but the minor bump
is deliberate: a product that uses any of it needs this platform, and
compatibility is exact major.minor while pre-1.0. **Consumers must raise
`EXPECTED_DIALOGRAM_API_VERSION` to `0.8.0`** in their `extension/main.ts`, or
the platform refuses to load for them.

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

### Fixed

- Export as SVG drew a running node's ring as a rainbow square over the
  node's title. In the editor the ring is HTML in a foreignObject, a turning
  gradient placed absolutely and masked down to a band, and the export copies
  neither the placement nor the mask for HTML. The export now draws the ring
  as a stroke of the same colours on the node's edge (without the glow),
  which standalone SVG renderers draw too; where the editor draws no ring (no
  band width, fewer than two colours) the export draws none. Colours are
  resolved to `rgb()` first, so `oklch()`, `color-mix()` or a stop with
  positions comes out right. The headless renderer's `--states` gets the same
  ring.
- A node state whose status is a name every object inherits (`toString`,
  `constructor`) passed the status check and put a function where a CSS
  class goes; the whole diagram then failed to draw. Only the four statuses
  pass now.
- A node family's colour now reaches every node in the family. The generated
  rules coloured external nodes and subgraphs only, so a product whose own
  nodes are plain saw its families only on nodes brought in from elsewhere,
  and every kind of its own in the task amber; a plain node in a family now
  takes the family's colour in its header, and its watermark icon too. The
  server put a plain node's family class on its header compartment only,
  where neither rule looks; it is now on the node as well, as it already was
  for external nodes and subgraphs.
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
- ELK is told the side the producer placed a port on. It was told the side
  from the direction alone, so a bundle's `ready`, placed in the other margin,
  was routed to as if it sat on the far edge: the wire came around the outside
  of the margin and crossed the whole node, label included, to reach the glyph.
  It now arrives from the side the glyph faces, in one straight run.

### Tooling

- `scripts/render-svg/render.mjs`: a graph document in (what a producer's
  plan command prints), an SVG out, through the server's layout and the real
  client in headless Chrome, extracted as "Export as SVG" extracts it. Picks a
  layout (`--layout default|untangled|free-ports`, `--all-layouts` for all
  three side by side), extra ELK options (`--elk key=value`), the product's
  node families and stylesheets, client behavior flags and a theme, and node
  states to draw (`--states`, as a status source publishes them, through the
  client's own painter). For looking at what a change does to a real diagram
  without opening VS Code.
- `scripts/render-svg/render.mjs` left its work directory in the system's
  temporary folder after a failed layout or render, or an interrupt; it is
  now removed on every exit, or kept and named with `--keep`.

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
