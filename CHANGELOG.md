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
it no longer has; and a product that uses its profile's `runCli` needs a
platform that hands it one.

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

- **Images in the chat, and a picture of the diagram for any agent.** An
  image pasted into the chat's composer (or dropped on it) waits above the
  text, small, with a button to take it off; the camera button beside Send
  attaches a picture of the diagram as it is drawn. They go to the agent
  with the message as ACP `image` blocks, and show under it in the
  transcript; a restored session says how many a message had (their bytes
  are not stored). PNG, JPEG, GIF and WebP, 5 MB and ten to a message
  (`@dialogram/shared` `chat-images.ts`); an agent that does not say it
  reads images (`promptCapabilities.image`) is sent none, and the panel says
  so. The diagram's MCP server answers `diagram-png` and `diagram-svg`, for
  the chat's agent and any other client of it: GLSP's own exporters drew a
  hidden copy through a `blob:` URL the webview refuses, so every call
  failed. The client now answers with the diagram as it is drawn
  (`diagram-picture.ts`, the export's SVG, or a surface's own image): what
  is in view, at 1:1, at most 2000 px on its longer side unless the caller
  gives a size or scale; the server asks for only that size, not one worked
  out from the model, and waits up to 15 s. A window that draws nothing
  gives an error, not an empty frame. The agent's hint names the tool.

- **What a node says, in its body.** A producer's `meta.summary` (a
  clause's rule, a step's purpose) is a paragraph under the node's ports, in
  the place of its family's mark (`node-summary.ts`): the UI font, a code
  span in the editor's without its backticks, drawn close in as a node's
  lines are. The server wraps it and sizes the node by it: the paragraph asks
  for `SUMMARY_WIDTH_PX` (240) unless it is shorter, its lines are balanced,
  and after `SUMMARY_MAX_LINES` (4) the last ends in an ellipsis. Widths are
  measured per character at the regular weight, as the header's name is at
  bold. Not drawn on a state, a frame, a symbol or a list row.
- **The root laid out in ranks.** A producer ranks the root's members
  (`meta.rank` on a node, `rank` on a group scope, a whole number from zero)
  and the root is laid out in that order along the flow, rank 0 first, one
  ELK partition each (`rootRankOptions` in `group-edges.ts`): a document's
  clauses in one frame per refinement layer, L0 to L3, where the layout
  alone put a frame wherever its edges pulled it. Unlike a group's rows,
  edges between the ranks are welcome. What starts the flow stands before
  the first rank (a unit's inputs, a source no edge enters, a crossed group
  pinned left) and anything else unranked after the last. Inside a frame
  nothing changes.
- **A connection the producer flags.** An edge's `meta.tone` becomes an
  `edge-tone-<tone>` class on its line, kept apart from its role (which edits
  read); `warning` and `error` are drawn in the editor's warning and error
  colours, over a product's colour for the role, and give way to the
  selection, the hover, a run's last token and the selection trace as a
  role's colour does. A wire several edges share keeps a tone only when every
  one of them has it.
- **A product, or a producer per node, keeps names on one line.** The header
  wrap is on by default; `storageOptions.headerWrap: false` (the sidecar
  toolkit's `headerWrap`) turns it off for a product whose names are code
  that must read as written, and a node's `meta.headerWrap` (a boolean) wins
  over the product either way, so a producer can keep its code nodes on one
  line and let its prose break.
- **A node says what it is to the picture.** A node's `meta.role` becomes a
  `node-role-<role>` class, the way an edge's role does: a hook the platform
  does not style and a product's stylesheet names. ndf-ide marks the clauses
  of other documents that a document's diagram draws only so its edges have
  somewhere to go, and draws them quieter; the kind (a neighbour is a
  requirement all the same) and whether a node opens (the project's own
  documents do) could not say that.
- **A list of one node family across the hierarchy, beside the hierarchy
  outline.** A product names a family (`nodeList: { family, title, codicon }`
  on its sidecar profile, `DiagramStorageOptions.nodeList`), and the canvas
  gets a second floating panel, its button directly under the hierarchy's:
  the family's nodes wherever they are in the hierarchy, under the
  instances holding them and no others. A single click finds a node in its
  view, as the hierarchy's node rows do. A double click opens what a double
  click on that node opens, without its view being opened: each row carries
  the node as the canvas would draw it, with the edges into it and what the
  last run left on them (shared `DetachedNode`), and the product's node
  openers are given it. A node that no opener can open yet is dimmed in the
  theme's disabled ink, says why as its tooltip, and takes no click; the
  others read in the editor's ink. Openers say so through a new, optional
  `NodeOpener.canOpen`, asked only by such lists. The rows are built on the
  server from the hierarchy's export (`GraphDocument.hierarchyGraphs`, given
  by the sidecar toolkit's model source with `cliHierarchyArgs`), found by
  the family rule the canvas colours by (now one function, shared
  `resolveNodeFamily`, used by the canvas and the server too), and given
  the run's tokens by the rule the canvas's edges are given theirs by (one
  function now, `edge-tokens.ts`, so at a trace step a row opens the step's
  token as the node does). Only the graphs that name the family's
  annotation are transformed, each once per export, and the run's
  arguments are published once with the list. A row may also be made unavailable by its producer
  (`HierarchyOutlineEntry.unavailable`). The outline panel is now one kind
  of panel (`OutlinePanelConfig`) of which the hierarchy and the node list
  are two.

- **A node opened in place may start open, keep its ports on its frame and
  be titled, and is then still that node.** For a node that is a container
  of a design, such as a block of code and the registers it holds, a producer
  says three things of the graph it gives the node (`meta.inner`).

  `open: true` draws the node open to begin with; the reader's closing it is
  what the layout file then keeps (`ToggleNodeOpenOperation.CLOSED`, beside
  `OPEN`). A layout saved while such a node was drawn closed, before its
  producer said so, is laid out again once, rather than opened with each
  frame over its neighbours.

  `pins: true` keeps the node's own ports on its frame as pins, named as
  they were on the node, inputs on the left and outputs on the right. An
  edge on one of them ends there, under its own id and with its ends named
  as before, instead of being carried on to the inner pins; the wires inside
  run from and to the pin, and across the frame where an input is wired
  straight to an output. A pin no edge ends on (a clock whose net the
  diagram leaves out) is on the frame all the same, under the members,
  placed by the frame and not by the layout, so every pin is where it was
  when a saved layout is opened again. A pin of role `clock` has a clock's
  wedge at the frame, under its name, as on a register's symbol: the one
  role the platform reads here. A pin is one port: a bundle of the node's
  ports is its members, each a pin, and a port's `side` is not read.

  `title` is what the frame is titled, drawn as written where a group's name
  is set in capitals, in a frame at least as wide as it.

  A node that says `open` or `pins` is a container, and its frame is that
  node: it carries everything the node carries closed (its name, type and
  producer id, its `meta` without the graph it now shows, its place in the
  source, its fields, facts and views, an error in its source, which marks
  the frame), so it is selected, shown in the panel, edited, gone to and
  found by name as the node is, and its pins are listed as the node's ports.
  What its producer offers on it (`meta.actions`) is offered on the frame
  and on its pins, not on what the frame holds. A run state is not drawn on
  a frame, as before. A node that says neither opens as it did: its frame
  is a group's, and none of this applies to it.

- **A product's host code runs its CLI as a run does.** The profile
  `createSidecarDiagramProfile` returns has `runCli(file, args, { timeoutMs })`
  where the CLI runs a diagram (not with `cliRuns: false`). It starts the CLI
  exactly as a run of `file` starts it: the command setting scoped to the
  file, its default when blank, `-m <module>` for an interpreter, from the
  run root. At the deadline it is stopped: on POSIX it leads its own process
  group and the whole group is stopped, on Windows only the CLI itself. The
  deadline is `timeoutMs` when positive, else the graph-load deadline for
  the file. It never throws, and answers `CliRunResult`: `exitCode`,
  `stdout` and `stderr`, and a `failure` (`no-command`, `start`, `timeout`,
  or `internal` when the toolkit could not work out how to start it, a
  setting it could not read for instance) with a `message` when the CLI did
  not run to its end, and the `cwd` it was started in; an exit other than 0
  is the CLI's answer, not a failure. A product asks the CLI
  what a run would find instead of copying the rules for where and how a run
  starts, which stay the toolkit's own (`cli-invocation.ts` and
  `run-root.ts`, which the run driver now calls too). The profile's other
  CLI starts (the `cli-plan` graph export, a status source) start in the
  same folder (see Changed).
  - A run whose CLI setting and default are both blank says only that
    (`Cannot run: ... names no command`); it no longer names a workspace
    folder, `package.json` or `.git`, which cannot cause it, and no longer
    looks for the run root first.
- **A product is told when a file's diagram opens and when it has closed**
  (`DiagramProfile.onEditorOpened(uri)`, `onEditorClosed(uri)`): once when
  the file's first diagram editor opens, and once when its last closes, not
  when one of two closes. A product that keeps something per diagram (a
  layout service, a worker, a cache) lets go of it there; one watched the
  tabs itself to find out. Not called at window close. What the hook throws
  or rejects with is logged, and the editor opens and closes all the same.
- **A load nobody waits for any more is told so** (`ModelSourceOptions.signal`,
  an `AbortSignal` beside `progress`). It is aborted when the diagram's
  editor closes, and when a newer request for the same diagram arrives
  while `getGraph` runs (a save, another view, a refresh), once the diagram
  shows a graph: GLSP runs a session's requests one at a time, so the newer
  one would otherwise wait for the old to finish, and then draw over it.
  The reason says which (an `AbortError`). A product stops its compiler,
  worker or request; the platform draws nothing of a load whose signal was
  aborted, whatever `getGraph` returns, and does not end the loading
  indicator for it, which the newer load now speaks for.
  - The signal covers `getGraph` and nothing after it. Once `getGraph` has
    answered, nothing aborts it, and the platform draws the answer even when
    a newer request arrives during the layout; the newer one then draws
    over it.
  - A request replaced while it still waits behind another never calls
    `getGraph`: a save, then a refresh, during a slow load runs the load for
    the refresh only.
  - A diagram's first load is not replaced. Until a diagram shows a graph,
    the reader waits for a picture, any picture: the first load is drawn,
    and the newer request after it, as before. Only the editor closing
    aborts it.
  - A request nobody is waiting on (a run's overlay redrawn) neither aborts
    a load nor is aborted by one, only by the editor closing.
  - The session's dispatcher sees the newer request arrive
    (`LoadCancellingActionDispatcher`, bound by `WorkflowDiagramModule`; a
    product's own diagram module gets it by extending that one).
- **A product can say what its diagram is doing after the platform has
  drawn it** (`DiagramProfileHandle.loading.report(uri, progress)`,
  `loading.end(uri)`): a layout it streams in, a second pass. The same
  indicator the platform's load uses, on every editor of the file, centred
  while the diagram is empty and as a pill once it has a picture. A product
  reached it through an internal import of the client's
  `loading-indicator`. `loading` is optional on the handle: a Dialogram
  older than this reports the same API version and has none, so a product
  calls `handle.loading?.report(...)`.
- **A product can put its own words in place of the platform's loading
  steps, or none** (`DiagramProfile.loadPhaseWords(phase, words, facts)`,
  with `phase` one of `reading`, `drawing`, `laying-out`, `routing`).
  "Drawing the diagram, 1 node, 0 edges" is wrong for a product whose graph
  is a frame round content it streams afterwards. Handed the step, the
  platform's words and the file and counts they were made from, it returns
  other words, `false` for nothing at that step, or nothing for the
  platform's own. Threaded to the server as
  `createWorkflowGlspVscodeServer({ loadPhaseWords })`.
- **A product's "Go to source" can keep the diagram in sight**
  (`ctx.revealRange(uri, range, { beside, preserveFocus })` in
  `onWebviewMessage`). Where the file is not open in another group,
  `revealRange` shows it in the active group, the diagram's, over the
  diagram, so a product that wanted it beside opened it itself. With
  `beside`, a file open in another group is shown there and any other in
  the group beside, even where the diagram's group holds it in a tab behind;
  `preserveFocus` leaves the focus on the diagram. Without options it shows
  the file where it always did.
- **A product can say which diagrams a changed file reloads**
  (`DiagramProfile.watch.affects(changed, open)`). A change on disk to one of
  a product's sources reloads every open diagram, and a change to any other
  file its `watch.globs` name reloaded none: the watcher dropped every file
  that was not a source, so a side file a product reads (a manifest, a
  technology file) never reached its diagrams. With `affects`, every file the
  globs see is asked about, and so is each save of a source in the editor;
  the diagrams it names are reloaded, with the changed file's own. Changes
  within the quarter-second debounce are taken together. Without it, nothing
  changes. `watch.globs` may now be left out, for the globs the source
  extensions give (every file, with none declared), so that `watch` can
  carry `affects` alone; an empty list watches nothing on disk, and only a
  save in the editor reloads.
- **View options in the palette.** What a reader may show and hide is the
  producer's to declare and the platform's to draw: checkable groups under
  the palette's tools, in the palette's own markup and theme (shared
  `view-options.ts`, diagram-client `view-options-palette.ts`). A group is
  a heading that opens and closes (remembered per product), with how many
  of its lines are checked, All and None; a line has a box, an optional
  colour swatch and, on hover, Only (Alt+click does the same); Space and
  Enter work on a focused line. A line that cannot change now says why in
  its tooltip and reads as such (a dashed box, a "no" mark), not as one
  unchecked. A `one` group is radio buttons. A long group scrolls under its
  heading. The palette's filter filters the lines too.
  - Declared as data, by the profile for every diagram
    (`DiagramProfile.viewOptions.groups`) or by the model source with each
    graph (`GraphDocument.viewOptions`), which is how lines that exist only
    when the content has them come and go. They ride on the root model as
    `wf:viewOptions`, with the file's choices already applied, so the first
    drawing of a reopened file is already right.
  - The host holds the truth, per file, beside the file's layout
    (`.layout/<file>.layout.json`, `viewOptions`; every write of the layout
    keeps it): it survives a reload and a reopen, and it can be read and set
    with no diagram open. `DiagramProfileHandle.getViewOptions(uri)` and
    `setViewOptions(uri, changes)` are what a chat tool that shows or hides
    things calls; every open diagram of the file follows. Both are optional
    on the handle: a Dialogram older than them reports the same API
    version, so a product checks before calling. A file's declaration is
    every group its graphs have declared, the newest of each, with the lines
    an older declaration of it listed that the newest lacks (after the
    newest's own; the newest's label, kind, `disabled` and defaults win, and
    in a `one` group its line is the one checked by default; a group
    reloads, or is not kept, if any declaration of it says so), so two
    editors showing views that declare different groups, or one group with
    other lines, each keep theirs, save a pick equal to the newest's default
    for a line not chosen yet, which is not kept: All, None and Only turn
    every line.
  - A click is in force in the webview at once: the platform dispatches
    `ViewOptionsChangedAction` (`dialogram.viewOptionsChanged`), which a
    product's client module handles to redraw with no round trip, and asks
    `ViewOptionsService` what is checked. The host is told after, keeps it,
    tells every diagram of the file the lines that turned, and tells the
    product (`viewOptions.onDidChange`). The diagram the click came from
    hears the host's result too: a change the host made just before (a
    chat tool's) can leave another state than the click showed, and the
    diagram follows the host's. The webview hears the host from the start:
    a line the host turns while the first model is laid out is applied over
    it. A change is taken only for a file its editor shows. A group marked `reload` has the
    model asked for again, and `getGraph` is handed the choices
    (`options.viewOptions`) for a producer that leaves things out itself;
    `persist: false` keeps a choice for the session only. A load abandoned
    on the way (`options.signal` aborted) declares nothing for the file.
  - A palette with no tools no longer says "No results found." with view
    options, or with nothing at all (its empty body is not drawn); it says
    so when a filter matched neither a tool nor a line.
  - Ids are kept exactly as the producer gave them, which is what it looks
    its choices up by. In a `one` group the line declared `checked: true`
    is the one checked; a disabled line there is still let go of when the
    reader picks another, so one line stays checked.
  - A product that declares none sees no change: no root argument, no
    palette section, the same documents from its model source.
- **A diagram surface: a product draws the diagram's content itself.** A
  picture of millions of shapes is no graph of nodes; a product that draws
  one on a canvas or in WebGL kept the platform's viewport, Fit, palette,
  outline, property panel and chat only by reaching into Sprotty's DOM and
  GLSP's classes. It now binds a `DiagramSurface` in its webview module
  (`diagram-surface.ts`, exported from `@dialogram/diagram-client`), plain
  data and plain DOM with no Sprotty or GLSP type in it, and the platform
  does the rest (`diagram-surface-host.ts`):
  - The element the surface makes is put under the diagram's SVG, sized to
    the canvas, the SVG's background made transparent above it. The surface
    is told the viewport (`scrollX`, `scrollY`, `zoom`, the canvas's size and
    the device pixel ratio) at the first render and at every change after,
    each frame of an animated Fit included, and nothing when nothing moved;
    told a new size, a new theme (VS Code's four kinds) and new
    `graph.meta.surface` data from the producer; and disposed with the page.
  - Fit and Center frame its `bounds()` with the graph's, and its selection's
    bounds as they frame a selected node.
  - A click where no diagram element is, and not a pan, reaches its `click`
    in the model's coordinates. What it selects (`context.setSelection`: a
    title, a kind, a note, where it is written, sections of rows whose values
    may hold links) is drawn by the property panel with its own section
    builder, opened by the same rule as a node's (when pinned), kept through
    the platform's own model updates, and put in the chat's selection
    context. It is cleared as any selection is: by Escape, by a node selected
    (and a node's selection by it), and, for a surface that hears no clicks,
    by a click on nothing, which leaves the panel showing it, as a click that
    deselects a node does. A link in a row goes back to the surface
    (`followLink`); it carries no `href`, so the panel never reads it as a
    graph node's. A double-click there is the surface's too (`clickCount`
    2): over a surface that hears clicks, the graph's whitespace no longer
    shows the root's properties on a double-click, which replaced what the
    surface had just selected.
  - The palette's export button, and the product's export command
    (`commands.exportSvg`, which asks the webview for the same export), save
    the surface's `exportImage()` as a PNG through the export path the SVG
    uses (its dialog, beside the file); without one the export is the SVG,
    as before.
  - Its context offers `setViewport`, `reveal`, `fit`, and `freeArea()`: the
    largest part of the canvas the platform's overlays leave free, so a
    product places what it reveals there instead of keeping its own copy of
    the overlay list. `reveal` centres a rectangle at the zoom there is, as
    Center does (all of it on the canvas when it fits there, the whole
    canvas covered when it is larger), or with `fit` fits it as Fit does
    (into the whole canvas when no free area has room for the margin),
    within the zoom limits. `reveal` and `fit` are animated
    unless `animate: false`; `setViewport`, what a surface's own pan or zoom
    calls, is not unless `animate: true`.
  - The palette's header and the breadcrumb get a background over a surface,
    which they did not need over the plain canvas.
  - An empty graph with a surface is a diagram like any other: the producer
    sends `nodes: []` and `meta.surface`, and the server passes the data on
    the root's `wf:surface` (`WorkflowDiagramMetadata.SURFACE`). No scaffold
    node is needed.
- **A supported channel for a product's own webview messages.**
  `postToHost(message)` and `onHostMessage(listener)` (also a surface's
  `context.host`) replace reaching for the platform's `window.__calVscodeApi`.
  The host side is the existing `DiagramProfile.onWebviewMessage` and
  `postToWebview`. Types starting with `dialogram.` or `chat.` are the
  platform's: posting one is refused, and listeners never hear them, nor
  GLSP's own traffic.
- **The zoom range is a profile's or a surface's to set.**
  `clientBehavior.zoomLimits` (`{ min, max }`), and a surface's `zoomLimits`
  over it, replace GLSP's 0.1 to 20 for the wheel, Fit, Center and a set
  viewport. GLSP sets its range after every product module, so a product's
  rebinding of the viewer options lost; the platform now sets the one it is
  given on the built container. A floor below 0.1 widens the scroll range
  with it, or it could not be reached. A range that is not one is ignored
  with a warning. With several surfaces bound, the range is that of the
  surface used (the last one, a later binding of an `id` in an earlier
  one's place).
- **A Fit or Center the zoom range stops keeps the content in the middle,
  on the canvas.** Sprotty clamps the zoom after working out the scroll for
  the zoom wanted, and keeps that scroll: at a maximum of 5, a Fit of a
  single 100 × 50 node on an 800 × 600 canvas put its middle at (260, 195),
  and at a floor of 0.25 a Fit of a 20 000 × 10 000 diagram put it below the
  canvas, which showed nothing. The scroll is now worked out again for the
  zoom the range allows, around the content's middle, for Fit, Center, the
  first view and a surface's `reveal`, and the content is then kept on the
  canvas as Center keeps it: fitted at a floor of 0.5, a 2200 × 1000 diagram
  on a 1200 × 800 canvas stops a margin inside the left edge, where keeping
  its middle left of the palette would have cut off 92 pixels. A Fit the
  range leaves alone is not moved. It reached every product at GLSP's own
  0.1 to 20 too, for a very small diagram or a very large one.
- **A first view that fits.** `clientBehavior.initialView: 'fit'` shows a
  view never shown in the editor fitted rather than centred at zoom 1.
- **A surface's selection in the chat's hooks.** `selectionContext.render`
  and `turnContextProvider` are called with a third argument, a
  `SurfaceSelectionSummary` (ids, title, kind, rows as text, capped), when the
  surface has a selection, and only then; a slash command's context carries
  it as `surfaceSelection`. Without a `render`, the turn context says what is
  selected and its rows.

- **A diagram that is loading says so, and says what it is doing.** A large
  design takes seconds to read and seconds more to lay out, and for all of
  that the canvas was empty. It now shows a turning circle with, under it,
  what is being done, how big the job is, and from two seconds on for how
  long (`loading-indicator.ts`; the MLIR viewer had it first). In the middle
  until the first model is drawn; from then on as a pill near the top (a view
  opened from the outline, a refresh, a file that could not be drawn being
  read again), and then only when the wait passes 300 ms. It reports and
  never blocks.
  - The platform says its own steps: opening, reading the file, drawing
    ("177 nodes, 565 edges"), laying out, routing.
  - What is inside "reading the file" is the product's to say:
    `getGraph` is handed `options.progress`, to call with a `LoadProgress`
    (`message`, and an optional `detail`) before anything that can take a
    second: a compiler, a build, a server being started. Absent on a load
    nobody is waiting on, so it is called as `options.progress?.(...)`, and
    not listened to once `getGraph` has answered.
  - The words go from the server to the host (`loadProgress` on
    `createWorkflowGlspVscodeServer`) and from there to the webview as a
    message of their own (`dialogram.loading`), so that they arrive while the
    model is being asked for and not behind it.
  - The end of the wait is said the same way, by the session's
    `LoadProgressReporter`: `done` with `model` when the model the reader is
    waiting for is about to be sent, and the indicator goes at that model;
    `done` alone when the load failed or had nothing to draw, and it goes at
    once. A model by itself does not end a wait the host has spoken of: a
    refresh made behind the reader's back lands in the middle of a first
    open, whose layout is still running. Such a request says nothing, and
    submits its model quietly (`submitQuietly`).
  - Every product on the stock client has it: the stock starter raises it,
    and so does `workflowFeaturesModule`, for a product whose starter is its
    own. A client that takes neither (the MLIR viewer) is as it was.
  - Not for the loads nobody asked for: the polls that redraw a run's
    overlay, and the host's own refreshes behind the reader's back.
  - Where the host shows this, GLSP's "Model loading in progress" notice is
    not started: it was a second, vaguer word for the same wait.
  - A screen reader is told each step through a status region that is in
    the page before it is given its words, and not the seconds.
- **The outline on demand.** A group row of the outline may be `lazy`: it
  says how many rows it has (`count`), and its rows stay in the host, asked
  of the profile's `outline.page(file, { group, offset, limit, query })` a
  page at a time as the reader opens the group and scrolls it (shared
  `outline-pages.ts`, extension-core `outline-host.ts`). A filter typed in
  the panel is answered there for those rows; the rows the outline carries
  are still filtered in the webview. A lazy group stays closed until the
  reader opens it.
  - Only the rows in view are in the DOM, for every outline: rows are one
    height (22 px), so which are in view is arithmetic
    (`outline-rows.ts`), and a list of 200 000 rows scrolls as one of forty.
    A scroll asks for the pages it stops on, not every page on the way
    (`outline-pager.ts`); past what a browser scrolls, a pixel of scrolling
    stands for more rows. Each lazy group's first page carries its count,
    and is asked for once under the filter typed, however many lazy groups
    the outline has; a count still to be asked under a filter the reader
    has typed past is not asked. Coming back to a filter asks for the counts
    of it the panel has not kept.
  - A page may hold fewer rows than asked (a producer that reads in smaller
    batches): the panel asks for the rest from the first row missing. Only
    `total` ends the list; an answer with no rows short of it shows the rest
    of the page as not loaded, with why, and is not asked again. A row
    given without an `id` keeps its place and does nothing when clicked.
  - A row that is no node of the graph (a lazy row without `nodeId`, or an
    outline row with the new role `item` and its own `id`) is the
    product's: a click or a double click calls `outline.activate(file,
    { id, group?, open })`. A lazy row with `nodeId` is found in the view
    as a `node` row is.
  - The product points the outline at a row with
    `DiagramProfileHandle.revealOutlineRow(uri, { id, group?, index?, show? })`:
    the rows down to it open, the page it is on is fetched (its place asked
    of `outline.locate` when the product did not give it), it is selected
    and scrolled into view, and a filter that hides it is cleared when the
    row is there without it. Without `outline.locate`, a row whose place is
    not given is revealed only from the pages already read. `revealOutlineRow`
    is optional on the handle, as `loading` is.
- **A graph that grows keeps its picture still.** A producer may say its
  graph grows a step at a time (`graph.meta.incremental`): a schematic of a
  netlist that starts from one cell and takes in a pin's fan-in when asked.
  For such a graph a saved layout is used as long as it places some node,
  where any other graph is laid out afresh for want of one place. The nodes
  it does not place are put beside the nodes they are wired to once the
  client has measured them (`incremental-placement.ts`): a node that drives
  a placed one in the column to its left, a node a placed one drives in the
  column to its right, at the height that makes the wire straight, and where
  that place is taken at the nearest free one, along the column or a column
  further out, as many columns out as it takes: a pin that gains a thousand
  loads fills column after column, and no node is put on another. A node
  placed this way is a neighbour for the next, so a
  chain unrolls a column at a time; a pin's fan-out reads top to bottom as
  the pins do. A piece wired to nothing placed (a cell picked from a list,
  with the stubs of its pins) is started under the diagram from the node of
  it with the most wires, set in and down by the room its neighbours take,
  and grows from there as the rest does; a node wired to nothing at all is
  parked under the diagram. A new member of a group goes under the group's
  members, in the group, and the frame grows to hold it. Nothing already
  placed moves. The nodes that have a place are the ones the load gave one,
  from the view's own layout or, for a view shown on its fallback's, from
  that: such a view gets a layout of its own when it grows, with every node
  and wire where it was drawn and the new ones added. The place of a node
  that is gone is dropped with it, so a node parked later is not put on it.
  Only the wires this touches are routed: the new nodes' own, those whose
  saved route a new node now sits on, and those at the frame of a group that
  grew. A
  graph that grows with no node placed yet is laid out whole, as any graph
  is on its first open; Layout Diagram still tidies the whole picture.
- **What a producer offers on a node, carried to the product's command.** A
  node's `meta.actions`, and the graph's for the canvas, list what a reader
  can do that the platform has no word for, each an `id` of the producer's
  own and the `label` a menu shows. The context menu lists them first, in
  the producer's order, on the node and on any port or label of it, and on
  the canvas before the unit's views; an
  action marked `doubleClick: "node"` is what a double-click on the node
  does, one marked `"port"` what a double-click on one of its ports does
  (`menu: false` keeps it off the menu), in place of anything the platform
  would open. The product names the one VS Code command that carries them
  out (`clientBehavior.nodeActionCommand`), called with a
  `NodeActionRequest`: the action's id, the file and unit shown, the
  producer's id of the node, its label and meta, and the port clicked. The
  document says what is on offer and the product what runs: a graph cannot
  name a command. Without the command nothing is offered: the client leaves
  the entries out of the menu, and a double-click does what it did.
- **A refresh can name the node to go to.** The refresh command
  (`commands.refreshDiagramModel`) takes `reveal`, the label of a node: the
  diagram selects it, in place of what was selected, and centres it, keeping
  its zoom, when the model that has it arrives (`RevealNodeAction`,
  `dialogram.revealNode`). What a product's
  command added is not always where the view is: a cell picked from a list
  lands under the diagram. A name no node answers to within twenty seconds
  is forgotten, so a later load does not move the view for it.
- **NAND, NOR and buffer symbols.** `meta.symbol` takes `nand`, `nor` and
  `buf` beside the gates it had: an AND and an OR with a bubble on the
  output, and a NOT's triangle without one (`SymbolGeometry.hasBubble`,
  `hasCurvedBack`).

- **A read-only view may let its transitions be drawn and deleted.** A
  producer that says so (`graph.meta.edits: ["transition"]`, with what may
  take one in `graph.meta.transitionLabels` and each state's name in what
  the automaton is written in in its `meta.state`) gets a Transitions group
  in the palette. A transition drawn from a state to a state asks which of
  the labels takes it (an agent names one in the operation's `label`) and
  the producer writes it (`addTransition`: `from`, `to`, `label`); a
  transition deleted is taken out by its id (`removeTransition`). Both name
  the view as it was asked for (`network` and `view`, or `rootNetwork` and
  `instancePath`) and the diagram's file (`document`), the one the undo
  reverts. A refusal is shown, and nothing is drawn or deleted that the
  producer has not written; a transition refused among several deleted
  stays, and the others go. The rest of the view stays read-only: a state
  is not deleted.
- **A palette per view, with what the producer says it can make.** The
  palette of a read-only view is asked of the server for that view, again
  when the view changes, and holds what the view lets be placed or drawn:
  an Automaton group with State where the view takes states
  (`graph.meta.edits` has `state`) and Transition where it takes
  transitions, then what the producer declares it can make
  (`graph.meta.creates`: `id`, `label`, `description`, `icon`, `group`, and
  `asks`, each a `key`, a `prompt` and a default `value`), in the order
  declared, in their groups. Placing one asks its questions (an agent gives
  the answers in the operation's arguments) and the producer writes it
  (`viewCreate`: `create` and the answers), undone as a transition is. An
  ask keyed `create` is dropped, and no answer replaces the arguments that
  name the view (`network`, `view`, `document`, …). The palette is asked
  again only after a model whose view, edits or creates differ from the
  last one's (after every model where an item is dynamic, as before). A
  node the producer marks `meta.delete` (a state, a port, a row of a list
  it draws) can be deleted, and the producer takes it out (`viewDelete`:
  the node's id, `element`); a refusal is shown and that node stays.
- **A state placed before anything is written of it.** An automaton
  written as its transitions has no state that no transition names: a
  state placed with the palette's State (asked its name; an agent gives
  `name`) is held by the editor with the view's layout (`unwrittenStates`)
  and drawn dashed, its name in italics, until a transition is drawn from
  or to it. That transition names it to the producer (`addTransition`'s
  `newStates`), which writes both. Undo and redo of a placed state, and
  deleting one, change only what the editor holds. A written state the
  editor once held is let go of when the producer takes it out, and kept
  when it refuses. A delete of both kinds is one edit, on a compound
  command that changed nothing when none of its parts did and is undone
  when each part that changed something can be
  (`CompoundCommandThatMayChangeNothing`, beside `WorkflowCommandStack`);
  so is a state named but not given (a dismissed prompt), which leaves no
  entry on the undo stack.
- **An automaton.** A node of kind `state` is a state (`node:state`), a pill
  as wide as its name, the initial one marked; an edge from a state to a
  state is a transition (`edge:transition`), labelled with its label, its
  place in the order its state tries it in (`meta.order`), a mark where it
  has a guard (`meta.condition`); the tokens it takes and gives
  (`meta.tokens`, `In×384 → Out`) are in its tooltip, not on it, since
  selecting it draws its links to the ports. Most automata are laid out in
  layers from the top down, the initial state first, so they read the way
  they run; a hub (one state in two thirds of the pairs of states with a
  transition between them, next to four others at least) is placed by
  stress, round that state, up to 16 states. A transition has no route: the
  client draws it from its states' places (a curve bowed when both ways
  exist and bent round the states in its way, a loop into the widest gap,
  the labels of the whole automaton placed together), and the server lays
  out with the same arithmetic, now in `@dialogram/shared`, so what goes
  round the automaton keeps clear of its loops and labels. A large
  automaton is made small: a run of three states or more with one way in
  and one way out is one state listing its steps, the first five and how
  many more when it is long, all of them in its tooltip (`+` unfolds it, `−`
  on its first state folds it again), and the ways into a state entered from
  five or more are short arrows ending in its name. Round it, the unit's ports
  in columns close beside what is drawn, and the groups pinned to it. A link
  drawn on selection may end at a transition, anchored at its label.
- **A group can be pinned on the left, and be a list.** `pin: 'left'` puts
  a pinned group in a column on the left of the diagram, the first on top.
  `list: true` on a group's scope draws its members as the rows of a table
  instead of cards: a row each, its name then its `meta.lines` in columns
  the list's rows share, in the editor's fixed-width font, its family's
  colour down its left edge; a line's `kind` is the class
  `list-row-cell-<kind>` for a product to colour. A row is an element as a
  card is (selected, opened at its source, the end of a link, which leaves
  it by a side). Beside an automaton, a list much taller than it goes on in
  a second column.
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
  as if they were not there, and the band clears its highest route as well as
  its highest node. A pinned group that an edge crosses or ends at stays in
  the flow, since its edges need it there; a group nested in another is not
  pinned.
- **Links drawn only on selection.** An edge a producer marks
  `meta.onSelection` is no edge of the diagram: it takes no part in the
  layout, crosses no frame, and is not drawn until one of its ends is
  selected. Then every such link of the selected node appears over the
  diagram, the node at its other end outlined, and the rest of the diagram
  all but disappears (see "The rest of the diagram all but disappears
  behind a selection's links" under Changed). For relations too many to
  draw at once: the state an action reads, the actions that take a token
  from a port. Its ends name nodes (a port names its node, a group scope
  its group); `meta.role` gives it the class
  `selection-link-<role>` for a product to colour, `meta.label` a word on
  it, `meta.bidirectional` an arrowhead at both ends. A link leaves a node
  by the side facing the other end, or by the side across when a neighbour
  of the node's own frame is in the way; links sharing a side are spread
  along it in the order of the directions they lead in, so they fan out
  without crossing, and two links between the same two nodes run side by
  side. Where the platform draws a node as something else the link ends
  there: at the frame of a node opened in place, at the bus a port of the
  unit is folded into; no bus counts a link among its wires, and a link
  between a frame and what is in it is none. With the selection's trace on,
  what the links lead to is not faded, and an edge on the trace, selected
  or in error is not dimmed. The word on a link sits at the middle of its
  curve, or a little along it where another link's word is already there.
  A node's `meta.sameAs` names what it is one
  drawing of: selecting it outlines the other nodes that draw the same.
- **A group can be marked as the one the flow starts in.** A producer marks
  a group with `initial: true` on its scope: the initial state of a state
  machine, the first stage of a pipeline. Its frame gets a filled dot and a
  short arrow before its title, as a statechart marks its initial state; a
  group with no title has the mark alone, in the room it keeps for a header.
  The mark says what the group is: the layout does not move it. A product
  colours it with `.workflow-node-group .group-initial-mark { color: … }`.
  It takes 24 px of the title's room, and a frame is not made wider for its
  title: a long title in a narrow frame runs past it sooner.
- **A view can be of the instance, not of the definition.** A producer marks
  a view it offers on a node with `of: 'instance'` (`meta.views`:
  `[{ id, label, of? }]`). By name, a file answers for the definition it
  holds under that name; for a unit made per instance (by a factory, with
  the instance's parameters) that is another one. A view so marked is asked
  of the editor's root, by the path of instances that leads to the node
  (`rootNetwork` and `instancePath`, with `view`), as a drill-down into a
  nested unit already falls back to; its file is asked by name only when the
  root has no answer, and the reader is then told that what is shown is the
  definition's (a warning, with the root's reason). The mark stays on the
  view's crumb, so the trail leads back to the same view; it is acted on
  only for a trail that reaches the node through an instance at every step.
  It is said of a view a node offers, and acted on by the model source that
  asks a sidecar for its graph: a product whose graph comes from a CLI's
  plan asks by name, as before, as does any view without the mark.
- **Lines of text in a node, read close in.** A producer puts lines of text
  in a node with `meta.lines` (`[{ text, kind? }]`, or plain strings; six at
  most, each cut at 48 characters): what a reader zooms in for and the
  property panel is too far away for, such as the condition a step waits on
  or what it takes and gives. Each line is a band across the bottom of the
  node's body, which is taller by them and as wide as the longest. The band
  is always drawn and carries `node-line-<kind>` for a product to colour, so
  which nodes have a line of a kind is seen at any zoom; its text is detail
  (`zoom-detail`), drawn only close in. The cut is by character and counts a
  wide one (East Asian, an emoji) as two columns of the fixed-width font the
  lines are set in; control characters and marks that turn the direction of
  the text are taken out. A symbol takes none, nor does an `if`, a loop or a
  port of the unit. The members of a row of a group now stand on one line
  along their tops, where a node with lines beside one without would have
  been centred on it. A diagram laid out before its nodes had lines keeps
  its saved places: a node grows downward where it stands, until the next
  layout.
  as if they were not there, and the band clears its highest route as well as
  its highest node. A pinned group that an edge crosses or ends at stays in
  the flow, since its edges need it there; a group nested in another is not
  pinned.
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

- **A long name breaks onto lines in its header.** Past 200 px a node's name
  breaks between words onto up to three balanced lines, and the header grows
  taller instead of the node wider (`header-lines.ts`, `wf:headerLines` on the
  name label; the ports and the family's mark move down with it). A sentence
  for a title, as an NDF clause has, made a node three times as wide as its
  neighbours: picorv32's trap document is 30 % narrower, its pipeline 31 %. A
  name that needs more lines widens them rather than being cut; a name with
  no spaces (an identifier, a module) stays one line.
- **A header's name is sized as it is drawn.** The name was drawn at 12 px
  (`.sprotty text.sprotty-label` outranked the 11 px of `.header-label`) and
  sized at 7 px a character: a capital is nearer 9, a lowercase letter 6.5, so
  `ENABLE_REGS_DUALPORT` ran under its badges and a sentence was sized too
  wide. It is sized character by character from widths measured in Chrome
  (the widest of the fonts a webview falls back to), at the 12 px it is drawn
  at, which both rules now say. Nodes with a long lowercase name get a little
  narrower, those with a capitalised one a little wider.
- **The layouts are in a Layout submenu.** The canvas's background menu
  had five layouts in a row; it now has one "Layout" item opening Default
  Layout (what was Layout Diagram: the product's `defaultLayout`, else the
  boundary flow), Compact, Serpentine Mesh, Untangled and Free Ports. The
  items' ids and actions are unchanged. The context menu draws a menu
  item's `children` as a submenu, opened on hover, click or the right
  arrow and placed on the left when the window has no room on the right;
  it used to draw them flattened under their parent.
- **The node list's button sits under the chat's, above the hierarchy's.**
  It sat under the hierarchy's, and putting it there pushed the hierarchy's
  button and every one above up a place: a click where the hierarchy's had
  always been opened the node list. Above the hierarchy's, it moves only the
  chat's, which stays at the top of the stack. The hierarchy's button is
  placed under the node list's when there is one (`NODE_LIST_TOGGLE_ID`),
  under the chat's otherwise.
- **A run never starts above the workspace folder, and every start of a
  product's CLI starts where a run does.** The run root is the workspace
  folder that holds the file (the innermost, where folders are inside one
  another), and the file's own folder when no workspace folder holds it or
  no folder is open. It used to climb from the workspace folder to the
  nearest `.git` or `package.json` above it, up to `/`: with dotfiles kept
  in a `~/.git`, a project with no marker of its own ran in `~`, and a
  `/tmp/.git` someone planted moved a `/tmp/job` run to `/tmp`. A file
  outside every folder ran in the first workspace folder, or above it. A
  marker between the file and its workspace folder never moved a run, and
  does not now: below the workspace folder nothing changes. A file named by
  the path a symbolic link leads to is in the folder opened through that
  link, though VS Code matches it by name alone.
  - The `cli-plan` graph export (the plan, the hierarchy export, the plan
    for a child's node identities, and the chat's graph from the plan)
    started the CLI wherever the extension host was started, and a status
    source's `cli(args)` in the file's own folder. Both now start it in the
    run root, as a run and `runCli` do, so a product's CLI finds the same
    files from each. The sidecar still starts at the file's Python package
    root, which an import of the file needs.
  - A plan and a hierarchy export are kept per folder they started in: a
    workspace folder opened since moves the run root, and the file is
    planned again from there.
  - The model source's plans read the CLI setting for the file's folder, as
    a run, `runCli`, the chat's graph and a status source already did; they
    used to read the window's setting alone. The `-m <module>` form is as it was: a
    plan, the chat's graph and a status source add it for every file, a run
    and `runCli` for a Python source only.
  - A file outside every workspace folder that is itself a link to a file
    in one runs in that folder. Links are followed only where VS Code finds
    no folder for the file: a file it counts as a folder's, by the path it is
    named by, runs in that folder.
  - A CLI whose folder is gone (the file's folder removed or renamed under
    an open diagram) says so, `failed to start: the folder it starts in,
    <folder>, does not exist`, rather than Node's `spawn <command> ENOENT`,
    which reads as a command that is not installed.
- **The members of a bus opened on a register are named by the field each
  carries.** A register's pins are named by what they are (`d`, `en`, `q`),
  and a register of a bundle (chisel-ide's signal view) has a `d` and a `q`
  per field: opened, its bus was a column of `d`s that said nothing. The bus
  is named by the pin most of its members are on first (the `d`), and
  placed by it; each member is
  named as its port is, and one on another pin says which, the pin set
  apart before the name (*en* `valid`), so no name can be taken for it. A
  tie between pins goes to the one a register lists first, so the order of
  the fields does not move the bus. The members stay under their bus,
  ranked with it and then by their own pins. A bus is never at the clock's
  wedge, whatever its members are on: it and they are on the rows, in its
  rail, and a member on another pin says which (*clk* `tick`); only a port
  of the register's own on `clk` is at the wedge. The body is as wide as
  the longest names side by side, with the rail each member's name has in
  front of it. A register's names are estimated as they are drawn, the pin,
  a 4 px gap and the name (`portLabelParts`, one helper the server and the
  client share), by columns, a wide character two; every other estimate is
  as it was. Before it is measured, a register's pin name is placed by one
  estimate of its box, slot and all, on the server and in the client
  (`estimatePinLabelBox`). All of this is of a symbol's pins: every other
  port, and every bus of a node that is no symbol, is sized, named and
  placed as before.
- **The Problems panel names the product a graph diagnostic came from**: the
  profile's `displayName` ("LEF/DEF Viewer", "SystemVerilog IDE"), where it
  said `workflow` for every product. The display name because it is the one
  name every profile has that is written for a reader, and the one that
  heads the product's own output channels; `glspClientName` is a protocol
  identifier, and `chat.fullName` names the chat. Threaded to the server as
  `createWorkflowGlspVscodeServer({ diagnosticSource })`; a host that gives
  none gets `workflow`, as before. A Problems filter typed as `workflow`
  no longer matches.
- **The outline's words.** A view says "1 node", not "1 nodes", and a
  producer may name what a row counts (`countNoun`, `{ one, other }`). A
  group says its count once: a detail that only repeats it ("Parts 182 …
  182") is taken as the count and not shown again, and `count` says how
  many a group holds when it lists fewer. A list cut short says how much of
  it is listed ("200 of 268", "The first 200 of 268 are listed"), where its
  tooltip used to say it nests itself or is too deep, which is what a view
  cut short means and still says.
- **The outline sizes against the canvas.** It is at most half as wide as
  the canvas and no wider than the canvas left of its button, where it was
  half the window: with the property panel docked in a narrow editor it
  covered the canvas. Fit and Center leave room for it when it is open
  (below), and the canvas it is measured against is the one they frame and
  `freeArea()` reports: the diagram's container, less the platform's
  overlays listed once in `canvas-overlays.ts`.
- **Center keeps the zoom, for every product.** The Center command set
  zoom 1, which means nothing in particular to a product whose units are
  not the graph's pixels, and threw away the zoom a reader had chosen; every
  other centre (a link followed in the panel, a node revealed) already kept
  it. A product that mutated the `CenterAction` in flight to get this can
  stop. The first view, when it is a centre, is still at zoom 1.
- **Center puts the content in the middle of the free area**, as Fit does,
  rather than in the middle of the canvas, under the palette's edge or an
  open outline. Content that fits the canvas but not the free area stays on
  the canvas, a margin inside its edge, as near the free area's middle as
  that allows: a 1000 × 500 diagram on a 1200 × 800 canvas would otherwise
  have lost its left 42 pixels past the edge, to keep its middle left of the
  palette. Content wider than the canvas covers its whole width, and content
  taller than it its whole height, as near the free area's middle as that
  allows: a 1250 × 500 diagram on that canvas loses 50 pixels past the left
  edge and reaches the right one, where keeping its middle left of the
  palette would have cut off 167 and left 117 of the canvas empty on the
  right.
- **Fit and Center leave the chat card and an open outline clear** when the
  content fits the area they leave; content that does not stays on the
  canvas, under them if need be. Fit avoided the palette, the canvas's
  buttons, the breadcrumb and a floating property panel, but put content
  under the chat and under the outline, the platform's own included.
- **The first view is done once, when it can be right**: when the canvas has
  a size and the content has bounds (a surface's included, which may come
  after the model). It was a centre two frames after every model set,
  Sprotty's empty placeholder root included. If the reader moves the view
  first, theirs stands.

- **A wire outside the viewport is not drawn**, as a node outside it is
  not; one within a few pixels of it still is, since its arrowhead and its
  caption reach further than its route. Of a diagram's thousands of wires
  most are out of sight, and every pan and zoom draws the model again; the
  hidden render, which measures, still draws every one (`routeInView`).
  Export as SVG copies the diagram on screen, so the file holds the wires in
  sight, as it has always held the nodes in sight and no others.
- **A large source is read once while it stays as it was.** A diagram's load
  asked several things of its source's whole text, each a read of the file:
  its hash for the plan and hierarchy caches, the units it declares, what
  they are to each other, where the one shown is written. For a file of a
  megabyte or more each answer is now kept, by product, for as long as the
  file's size, modification time and inode stay the same (`file-memo.ts`);
  a smaller file is read every time, as before. What is kept is an answer:
  a read that failed is asked for again at the next load, and nothing of the
  editor that first asked is held. A 414 MB netlist's diagram
  loads in a quarter of a second after its first open, where every load
  took fifteen.

- **A feedback loop is highlighted where the drawing runs back.** The
  server put the platform's highlight on one edge per loop, the one that
  pointed backwards in an order of its own (Eades–Lin–Smyth), worked out
  apart from the layout's cycle breaking: in a CPU's core, of `cpu → mul`
  and `mul → cpu` it marked `mul → cpu`, drawn left to right, while the
  layout drew `cpu → mul` back. The server now marks every connection on a
  loop (`ON_LOOP`, the two nodes in one strongly connected part, with its
  ends in `LOOP_ENDS`), and the client highlights one that runs against the
  flow, its target left of its source (`feedback-direction.ts`): after a
  layout, exactly the edges the layout reversed; after a drag, the wires
  that run back. An end on a node stands at its node's middle, as the
  selection trace reads it (`standsWhereItsNodeDoes`, shared), so two
  nodes stacked one under the other are not told apart by their ports. A
  return wire (out of a port on the west or into one on the east, as a
  handshake's `ready`) is on no loop, so a straight handshake pipeline
  shows none. A piece cut at a group's frame goes by the whole connections
  it carries (`LOOP_ENDS` holds a pair per connection), and is feedback
  when any of them is, whichever comes first. A loop on one node, and a
  connection the producer declares (`meta.feedback`), are highlighted by
  the server whichever way they are drawn, as before. `findFeedbackEdges`
  is gone for `findLoopEdges`.
- **The state an automaton starts in has a second outline, not a dot and
  an arrow.** The mark came from where the state had the most room, and in
  a crowded automaton that was among the lines and labels. The outline is
  drawn 3px inside the state's own, with its corners, and stroked as the
  state is, selected or hovered too; it takes no room. Gone from the shared
  package with the mark: `initialMarkDirection`, `initialMarkOf`,
  `INITIAL_MARK`, `INITIAL_MARK_REACH_PX`, `AutomatonGeometry.away` and
  `automatonBounds`' third argument. A group's initial mark (the first
  stage of a pipeline) is unchanged.
- **An automaton is spread until its labels are clear.** The layout made
  room beside a line for that line's labels only, not for every line
  through the same room: a state that eleven transitions leave was drawn
  with labels on labels, on states and on the chips of its stubs. The
  server now draws the labels and chips where the client will
  (`automatonClutter`) and lays the automaton out wider, up to five times
  (`AUTOMATON_SPREADS`), until nothing lies on anything and a line runs
  through one label in ten at most (`clearEnough`), or until spreading
  further gains nothing; the least cluttered wins, a crossing weighing as a
  label lying on something. A line through a state it does not join counts
  as a crossing, and the server draws from the same inputs as the client
  (`automatonGeometryInputs`: a state that lists steps has its pill
  corners). The gap between the automaton's components is spread too, and a
  label is tried against 23 points of each curve, not 11. A stub's labels may go beside its chip or past it, not only
  beside its short stroke, where a label wider than the stroke lay back on
  its state. A diagram whose states have saved places keeps them: Auto-Layout
  lays it out anew.
- **A selected state traces one transition each way.** With
  `clientBehavior.selectionTrace`, a state of an automaton (`node:state`)
  draws the transitions into it and the states they leave from upstream,
  the transitions out of it (one that stays in it too) and the states they
  reach downstream, by the transitions' own direction; no transition is
  turned by where its states sit, for any trace. It was traced as any
  node: an automaton is all cycles, so the trace fell back to the direct
  neighbours, and read them left to right, which an automaton laid out
  from the top down is not.
- **The trace leaves what a selection's links keep in sight as it is.**
  Selecting something whose links are drawn (a variable's row) traced it
  as any node and faded the transitions and states its links lead to.
  Everything the links keep in sight is now in the trace's scope, and what
  both fade is at the links' 0.1, the stronger of the two.
- **The rest of the diagram all but disappears behind a selection's
  links.** While links drawn on selection are shown, every node and edge
  that is neither selected, at a link's end, held by one of those (a group
  a link leads to), nor an end of one of those edges (a transition's two
  states, through a group's frame to the other part of an edge cut there)
  is drawn at a tenth of its opacity (`wf-focus-faded`, put on by a vnode
  postprocessor, `SelectionFocusPostprocessor`), and comes back enough to
  read under the pointer. It was the diagram's edges only, at 0.3, and
  every state, port and row stayed as it was. A node that holds nodes
  never fades, an edge in error or on the selection's trace neither, and
  a transition kept in sight draws the line it shares with others between
  the same two states. A selection with no links (a state) fades nothing.
- **A row a selection's link leads to is tinted, not outlined.** Selecting
  a transition, or anything else with links drawn on selection, outlined
  each node at a link's other end with a box drawn 3 px outside it. The
  boxes of rows of a list (the state variables an action uses) stood on
  each other, crossed, and the link ended at the box rather than at the
  row. A row at a link's end now has its background tinted
  (`list-row-linked`, the editor's focus colour mixed into the row's
  fill), and the link meets the row's own edge; another node is outlined
  as before, and so is a row that is not drawn. The root's view works out
  what the selection brings up once a render, before the nodes are drawn
  (`noteSelection`); a row's view asks it and marks itself
  (`markLinkEnd`), and the drawing over the diagram outlines every end
  that did not.
- **The Transitions group is in the palette only of a view that takes
  transitions.** It was in every editable palette, where nothing could
  draw one, and hidden by CSS in read-only views that took none.
- **`state` is a node kind of its own.** A node of kind `state` is a state of
  an automaton (see Added): a pill with its name and nothing else, its
  `meta.lines` not drawn. A producer that sent another kind of node under
  that kind (a state variable) sends it under another (`variable`).
- **A read-only view's root panel says what the view is.** With nothing
  selected, a view the producer marked read-only (`graph.meta.readOnly`) is
  titled View and shows its facts, without the sections of what it could
  not edit (annotations, parameters, input and output ports). Every
  read-only view has it: an NDF overview and an ASL unit's view too.
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

- **A chat is the machine's, not the window's: a local window and a
  Remote-SSH window on the same folder see the same chats.** Sessions and
  their transcripts were kept in the window's `workspaceState`, which VS Code
  keeps on the client under the window's URI. A Remote-SSH window (another
  client, another URI) found none of the chats made at the desk, and the desk
  none of those made over SSH, though the agent, which runs beside the files,
  held them all. They are now kept where the agent keeps its sessions, on the
  machine the extension host runs on: a file per session in
  `$XDG_DATA_HOME/dialogram/chat/<product>/` (`~/.local/share` by default;
  `DIALOGRAM_DATA_DIR` overrides it), readable by the user alone. A window
  lists them again whenever it shows the list, and loads a session's latest
  transcript when it opens one, so a chat goes on in either. A message, a
  rename or a mode is applied to the copy kept now, under a lock the other
  window waits for, so two windows on the same chat keep each other's turns,
  and a chat deleted in one is not written back by the other. A chat that
  cannot be kept (a folder not writable) is said once and stays in the
  window. What an older
  Dialogram kept in `workspaceState` moves there on first use, from each
  client.
- **The chat's Plan and Build are what the agent runs.** A session opened
  again after a reload showed Build whatever it was in: the client dropped
  the agent's answer to `session/load` and recorded a default. It now takes
  the mode the agent says, else the one stored, and a session is in the mode
  last chosen for it: an agent that says another (opencode takes the mode of
  the session's last message) or says none is told, and one that cannot be
  keeps its own, which the panel then shows (the choice stays stored). A
  message runs in the mode it was sent in: an agent holding another is told
  before the prompt. A reply is tagged with the mode its message was
  sent in, though the mode is switched while it runs, and a restored reply
  with that of the message it answers (it had none). The mode shortcuts were
  Ctrl+Shift+P and Ctrl+Shift+B, which the webview also hands to VS Code: its
  Command Palette or build tasks opened over the chat and took what was typed
  next. Shift+Tab in the composer switches the mode now. The Plan placeholder
  says "diagram", not "workflow", and the "/" hint shows only where there are
  commands.

- **An edit drawn on the canvas shows without the file watcher.** An edit a
  product's producer writes itself (a connection, a node, a rename, a
  delete) changes the file on disk, and the editor applies nothing: the
  diagram was reloaded only when VS Code's file watcher reported the file
  changed. A watcher can report nothing (a machine out of inotify
  instances gives every new window one that does not), and the edit was
  then written and not drawn until the diagram was reopened (ndf-ide, a
  refinement drawn on the canvas). The command stack now tells the host
  which files an edit's producer wrote and what they hold
  (`createWorkflowGlspVscodeServer({ outOfBandWrites })`), and the host
  reloads the diagrams they affect, with the watcher's wait so a burst of
  edits is one reload. The watcher's report of the same write, when it
  comes, finds the text written and reloads nothing more; one that finds
  other text reloads as before. A file open with unsaved changes is left to
  the live preview, as the watcher leaves it.
- **An edit the producer wrote is undone without the file watcher.** Undo
  (and redo) first checks that the file is as the edit left it, and asked
  the editor's copy of the file. That copy catches up with a write made on
  disk only when VS Code's file watcher reports it, so with a watcher that
  reports nothing (a machine out of inotify instances) the copy still held
  the text before the edit, and every undo of an edit the producer wrote
  was refused: "Cannot undo 'Create Connection' because the document
  changed outside the diagram" (ndf-ide, a refinement drawn on the canvas).
  Where the copy holds no unsaved change and is not the file's text, undo
  and redo now ask the file on disk, put it back there, and tell the host
  to reload the diagram as of a write the producer made; elsewhere they go
  through the editor and save, as before, and so does a file in another
  encoding than UTF-8. A file changed on disk by something else, its line
  breaks included, is still refused, and so is one whose copy holds
  unsaved changes. An undo of several files that cannot write one puts
  back those it wrote and does nothing. Checked against the editor's copy,
  a file that differs from the edit's text only by a byte order mark or its
  line breaks is no longer refused, and the editor is no longer given the
  mark as text.
- **A connection drawn to a port with an arrow in it ends there.** An
  arrowhead is drawn over the port it points at, its tip on the port's
  centre, and it took the pointer's events: the click that should end a new
  connection on such a port hit the arrow, and the edge tool, finding no
  connectable element under the pointer, ignored it, so the connection
  never ended (ndf-ide, a refinement drawn to a clause already refined).
  An arrowhead now takes no pointer events; the edge is still found along
  its line. A click on an arrowhead now reaches what it points at, the port
  or the node, in every tool: an edge is selected, hovered or reconnected
  by its line.
- **A connection's role reaches its line.** The server's `edge-role-<role>`
  class landed only on the edge's outer group (`.sprotty-edge`), while the
  line is drawn in the `.workflow-edge` group inside it, beside `selected`
  and `hover`. A product stylesheet that styled lines as
  `.workflow-edge.edge-role-x` matched nothing: ndf-ide drew every edge as
  the same grey line, whether it refined, verified or blocked, and
  chisel-ide drew its channels, wires, clocks and resets alike. The edge
  views give the line group the role classes too, so both
  `.sprotty-edge.edge-role-x .workflow-edge` and `.workflow-edge.edge-role-x`
  reach it. The selection trace's colours win over a role colour that gives
  way to the selection (chisel-ide's and ac-ide's outranked them), and give
  way themselves to the pointer and to the run's last token.
- **A nested workflow instance's edges show that instance's tokens.** Two
  instances of one workflow, or two workflows that name their actors alike,
  have edges with the same ends (`p.Out --> Out`), and the overlay took the
  token of whichever run record with those ends came last: in a view of one
  instance, every such edge showed what the other carried, at the end of the
  run and at each step of the queue trace, and the node list's rows did the
  same (double-clicking a viewer there opened the other instance's file). A
  run record of a nested instance now says the instance it is in
  (`instancePath`, instance names from the run's root), and a view reads only
  its own instance's records: the canvas those of the instance the
  navigation trail leads to, the node list those of each row's instance,
  both measured from the run's root, also when that is a workflow further
  down the trail run on its own (its error is placed the same way). A run
  none of whose records says an instance shows as before.
- **The chat's button is in the floating stack whenever there is one.** The
  navigation moved it there only when it drew after the button was made;
  a button made after the last draw stayed on its own, fixed where the
  stack's lowest button is, over the debug button. It now joins a stack
  that is already there, at its top.

- **The chat card resizes as fast as the pointer moves, and by its sides
  too.** The drawer eased toward each new height over a quarter second, so
  while the top edge was dragged it trailed the pointer, by 170 px after
  25 moves; a drag now turns that transition off while it lasts. Each drag
  also started 12 px off (the drawer was measured with its padding and set
  without), and a release outside the webview, which never reaches it, left
  the drag on: the card went on resizing when the pointer came back. A
  drag now ends at the first move with the button up, or when the webview
  loses focus. The card's sides and top corners resize it too, both sides
  at once since it is centred, and its width is kept beside the drawer's
  height (`chat-resize.ts`). A closed drawer hides its top handles, so a
  drag there no longer overwrites the saved height. Dragging the floating
  property panel by its header lost a release outside the webview the same
  way, and now ends the same way.

- **Over a surface that hears clicks, the property panel opens on the
  view's own properties.** A product that draws the diagram on its own
  surface and answers its clicks (#203) opened with "Select an element to
  view properties" in the panel, and the reader had no gesture to replace
  it: the double click on the background that shows the root's properties
  elsewhere is the surface's there, so only a surface selection cleared with
  Escape brought them. The panel now shows them from the first model on,
  while nothing is selected and it shows nothing else, whether the surface
  mounts before that model or after it, and follows the models after it. A
  node or a surface selection in the panel is never replaced by them because
  a model came, a click on nothing still keeps what the panel shows, and
  nothing is reported as selected, to the chat or to a profile's selection
  hooks. Text being typed into a field of the panel is kept: the view's
  properties are drawn once the focus leaves it. A product without a
  surface, or with one that hears no clicks, sees the hint and the double
  click as before.

- **A field the producer marked editable was listed twice in the property
  panel** where a product shows instance parameters: once in the Fields
  section with its choices, once more as free text.

- **A group's ports are where they were when a saved layout is opened
  again.** A boundary port's saved route was looked up by its edge's id,
  where a route is saved under its edge's ends when the edge names them:
  such a port went level with the member it leads to, not where its route
  crossed the frame. And two ports with no saved route that lead to one
  place went on one spot: the second now goes under the first.

- **A child process's output keeps a character split between two reads.**
  `runChildProcess` added each chunk as a string, so a UTF-8 character the
  pipe delivered in two pieces became two replacement characters. Output is
  now decoded as a stream.
- **A deadline longer than about 24.8 days no longer stops a child at
  once.** Node fires a timer set beyond 2^31-1 ms after 1 ms; a longer
  deadline, given or from the graph-load setting, now waits the longest a
  timer holds.
- **Every diagram editor of a file is refreshed, and closing one leaves the
  other working.** The editor provider kept one client per file: the
  editor opened last took the entry, and the first of them to close deleted
  it. With a diagram split ("View: Split Editor Right" makes a second
  editor of the same file), the first editor stopped hearing saves as soon
  as the second opened, and closing either left the other deaf to saves,
  changes on disk, live previews and a run's overlay; the profile's
  `postToWebview` and `dispatchToWebview` reached nothing. Editors are kept one by one, each with the view it shows
  (which graph, which crumbs), and what is the file's (the overlay watch)
  goes with its last editor. A save, a change on disk, a live preview, a
  refresh, a run's overlay and a product's post reach every editor of the
  file, each refreshed to its own view; a load's words go to the editor
  whose load it is (they went to whichever had the entry). A view option
  the reader turns in one editor is shown in the other; an outline page
  goes to the editor that asked for it, and nowhere once that editor has
  closed; a row the product reveals is shown in each editor of the file,
  once (`seams-two-editors.test.ts`). What goes to one
  editor (opening a graph by name, Export as SVG, the grid, layout on
  demand, the chat's edit session) goes to the active one, or else the one
  used last. A run's replay goes to the editor that has just opened, not to
  the one that saw it live. A chat reply goes to the panel that spoke last,
  and to the other once that one's editor has closed, where it went to a
  webview that was gone.
- **The API's documentation says what crosses `activateDiagramProfile`.**
  `api.ts` said that the functions in a profile's `chat` (tools, context
  providers, slash commands) were safe only in library mode and never
  populated over the API. They are passed through as written, and called:
  every extension runs in the one extension-host realm and the profile
  object is handed over as it is. Only DI objects do not cross, and the
  boundary refuses them. A test calls each through the extension's own
  `activate()` (`chat-functions-over-api.test.ts`).
- **The READMEs give the API version as 0.8.0**, where they still said 0.4.0.
- **Fit and Center frame what is drawn.** A label a node's view leaves out
  (its name, drawn elsewhere or not at all) and a compartment of a node
  drawn as a symbol still have bounds, laid out for a box they are never
  drawn in, and Fit framed them: off-centre and zoomed out for nothing. What
  the hidden render, where GLSP measures, did not draw under a parent it
  drew is now left out, with all it holds. When that would leave nothing (a
  view that draws what it holds in its own markup, not through the render
  of each child), everything is framed, as before.
- **The first view no longer lands twice.** The centre of Sprotty's empty
  placeholder model could land after the real model's, so a diagram opened
  centred, then jumped.

- **The refresh command refreshes the view that is on screen.** Navigating in
  place, that can be a workflow in another file than the editor's document.
  The command (`commands.refreshDiagramModel`, a product's "Refresh Diagram"
  and whatever it redraws a diagram with) asked the editor's document for the
  nested view's name and trail: a view that document does not have, refused by
  a producer that reads one file at a time and drawn as a different view, under
  a different layout and one crumb deeper, by one that does not. It asks the
  file the view is of, as a save already did.
- **A refresh never changes which view an editor shows.** A caller may name
  the view it means (the diagram's own controls do). That name was sent as the
  view to show: it undid a navigation that was still on its way, and could move
  an editor to a view another editor was on. It is taken only where the editor
  has no name on record.
- **A refresh named by a file reaches the editors that show it.** A view names
  itself by the file it is of, and the command looked that file up as an
  editor's document only: the refresh of a nested view of another file (the
  diagram's own queue-trace toggle, a product's refresh of the file it has just
  worked on) reached nobody, or the editor opened on that file and not the one
  that asked. Every editor opened on the file or showing it in place is asked,
  each for the view it has.
- **A graph opened by name in a diagram that is already open is its root.**
  The open command on an open editor (the way a product moves between the
  graphs of one file) sent the name with the trail of the view that was on
  screen, and did not record what it had opened. The new view was filed under
  the old crumbs, and the next save went back to the view before. The request
  carries a trail of the view itself, which starts the crumbs over, and the
  editor remembers it as what it shows; the run on record for another graph is
  dropped, so the next save does not send it
  (`WorkflowEditorProvider.refreshFromHost`, `hostRefreshTarget`).
- **A view the host puts in an editor that exists already is on record.** A
  definition opened from another editor, into the editor its file already had,
  is asked for by the host, and the record of what an editor shows was written
  only when the diagram asked: the next save refreshed the view before it
  (`recordHostView`). Not for an editor the open has just made, which asks for
  its own first view.

- **A source too large for a text document opens as a diagram.** VS Code does
  not hand a file over 50 MB to extensions as text: `activeTextEditor` is
  absent while the file is on screen, and `openTextDocument` rejects it. The
  open commands asked both, so on such a file (a generated circuit of a
  processor with an accelerator is 64 MB) they said to open a file first, to
  someone looking at one. A command with no argument takes the active tab's
  file when no diagram or text editor is in front (`activeSourceUri`,
  `tabSourceUri`), and a file refused as text for its size, and only for
  that, is a target (`ResolveDiagramOpenTargetOptions.fileSize`). A diagram is
  drawn from the file by its producer and never needed the text document.
  Where the text is needed it is said instead of thrown: a rename answers
  that nothing was renamed, and a source with no diagram to show says it
  could not be opened as text either.
- **A double-click that opens a node's source shows the editor the file
  already has.** The opens of #165 went through the extension's own
  handler; a double-click on a node with no diagram behind it
  (`doubleClickOpensSource`: an actor's action or function, say) or on a
  node that stands for a file sends only the file and the line, which no
  branch of that handler took, so GLSP's own handler showed it in the
  diagram's group: a second text editor of a file open in the group beside.
  The handler now takes that open too, at the line, through `inPlace`
  (`plainOpenOptions`).

- **A transition no longer flickers under a pointer near its line or
  label.** The 12px stroke that catches the pointer beside a transition's
  line was narrowed to 2px while the edge was hovered, by the edges' own
  hover rule, which outranked it: a pointer a few pixels off the line was
  then off it, the hover ended, the stroke widened under the pointer again,
  and the edge flickered at the screen's rate. The reach keeps its width.
- **Two states of a layer are no longer drawn touching.** A line that
  skips a layer passes it between two of its states, and ELK kept them
  only 10px each side of it: the line and its labels lay on both. They keep
  half the room from it that they keep from each other.
- **A frame takes no forbidden cursor and no opacity.** A group, an if or
  a foreach is marked `read-only`, and `.workflow-node.read-only` gave it
  `cursor: not-allowed` and `opacity: 0.8`. Both passed to every node it
  holds: the pointer showed a forbidden sign over members that can be
  selected and edited, and they were drawn fainter. The rule is gone.
- **An edge between ports of any id can be edited.** The model read an
  edge's ends only from port ids of the `node:` and `wf:` forms, so an
  edge of a producer that names its ports otherwise (CalPy's
  `n:<node>:p:<port>`) named neither end: delete, capacity, reconnect,
  duplicate and paste all left it out, and Delete on one did nothing. An
  end the id does not name is now read from the port's owner in the
  document: the instance's label and the port's name, or the port's name
  alone on the network's own inputs and outputs. A port name with colons
  of its own stays whole, and a bus end (`bus:<node>:<bundle>`) is read
  from its node.
- **A connection the producer refuses says why.** Drawing one that the
  producer did not write ended without a word; its reason is now shown
  ("The connection was not made." when it gives none), to a person only:
  a connection an agent asks for (`headless`) fails without a word.
- **A connection moved where the producer will not make it stays where it
  was.** A reconnect takes the connection out, then makes it at its new
  end; refused there, the connection was gone, and the edit not undoable.
  The file is now written back as it was, the reason is shown ("The
  connection was not moved." when it gives none), and no edit is kept. A
  reconnect made is undone from the file the producer wrote, read on
  disk.
- **An edit refused no longer keeps Undo from the edits before it.** In
  every product, an edit of the source that wrote nothing (the producer
  refused it, a prompt was dismissed, or it wrote back the file as it was)
  still went on the undo stack: a node or a connection created, a
  rename, a reconnect, a paste, a duplicate, a property, a delete, a
  transition. It could not be undone, and on top of the stack it kept Undo
  from reaching any edit below it; it also emptied Redo and marked the
  diagram dirty. A refusal is only known once the edit has run, so the
  command stack now decides, after running it: a command that says it
  changed nothing (`changedNothing()`, which both workspace-edit commands
  answer) is not kept, and the stack is left as it was
  (`WorkflowCommandStack`, bound by `WorkflowDiagramModule`). Undo undoes
  the last edit that wrote, and Redo still redoes what was undone. An edit
  the producer writes itself is judged by the file on disk before it ran
  and after, not by the editor's document, which lags what was written
  out of band (or holds what is not saved). Several operations sent as one
  (`CompoundOperation`) make a `CompoundCommandThatMayChangeNothing`
  (`WorkflowCompoundOperationHandler`): dropped when none of them wrote,
  and undone past one that was refused; a GLSP `CompoundCommand` of parts
  that all changed nothing is dropped too. An edit applied in the editor's
  document is kept, whatever it did.
- **A delete refused partway keeps the undo of what it took out.** In a
  network view, a selection whose node, edge or port the producer refused
  to take out stopped there and threw away the snapshot of the file: what
  it had taken out before the refusal was gone from the file and could not
  be undone, and the rest of the selection stayed. A refused one is now
  kept, as a refused transition is, with the producer's reason shown (or
  "The node was not deleted.", for an edge or a port the same), and the
  rest goes; what was taken out is undone as one edit. A producer that does
  not answer (it could not start, timed out, crashed) stops the delete
  there, said once. Selected edges go first: a node taken out takes its
  edges with it, so an edge selected with its node was asked for when
  already gone, and refused. Cut takes connections out first too.
- **A cut in a read-only view takes nothing out.** Cut asked the producer
  to delete every node, edge and port of the selection that was not itself
  marked read-only, in a read-only view too, where a delete asks nothing:
  in a CalPy actor view, cutting a state variable had the sidecar rewrite
  the actor's file (with the same text) before it refused. A cut now takes
  out what a delete of the selection would (`mayRemove`, which both ask):
  in a read-only view nothing, since the transitions a delete may take out
  there are not cut. What a cut takes out is known before a command is
  made, and a cut of nothing makes none; the selection is still copied.
- **A delete of nothing that can be deleted is no command.** Delete on a
  selection of only what is kept (a read-only element, an edge with no
  ports, a line inside a group that several edges share) made a command
  that wrote nothing, and it went on the undo stack. What a selection
  deletes is now known before a command is made, and one that deletes
  nothing makes none. (A command that cannot be undone on top of the stack
  keeps every edit below it from being undone.)
- **A graph the ELK server cannot lay out stays on elkjs.** The server has
  the layered, force and mrtree algorithms; a graph that asks for another
  (an automaton placed by stress) went to it under `engine: 'elk-server'`,
  failed there and fell back to elkjs with a warning, on every layout. It
  now goes to elkjs from the start.
- **A view no longer falls back to the structure on a refresh.** The host's
  refresh (a keystroke or a save in any source file, a run) repeats the
  file, the name and the trail of what is shown, and named no view: a
  synthesis view, or any other, was replaced by the unit's structure under a
  breadcrumb that still said the view. The view is now taken from the
  trail's last crumb when the request names none and is for that crumb's
  unit.
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
