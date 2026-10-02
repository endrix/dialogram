# Proposal: one editor for a whole workflow hierarchy

**Status:** implemented, all five phases: in-place navigation, the root's run and chat context, editing nested views, per-instance layout, and the hierarchy export with its cache and outline. Rows do not yet carry a run's state (see phase 5).
**Affects:** dialogram (most of it), wfpy (a hierarchy export), wfpy-ide (one
profile flag).

A diagram of a workflow whose nested workflows live in other files opens **a new
editor for every nested workflow** a person drills into. On a deep hierarchy
that is a tab per level, each with its own chat, its own Run button running
something different, and its own layout. This proposes one editor per *root*:
the file that was opened. Every nested workflow under it, in any file, is a view
inside that editor. Three things stay anchored to the root whatever is on
screen:

1. **the chat session**: the root's, for the whole hierarchy;
2. **the run**: ▶ Run, "Rerun from Here" and the stepper's ⟲ always run the
   root workflow;
3. **the layout**: every nested view's layout is the root's, stored per
   *instance* in the root file's layout.

Nested views stay **editable**, in the file that defines them.

## What happens today

Line references are to `packages/` unless written out.

| | nested workflow in the **same** file | nested workflow in **another** file |
|---|---|---|
| double-click | in place: a new `RequestModelAction` to the same client (`diagram-client/src/network-navigation-mouse-listener.ts:163-188`) | **a new editor**: `NavigateToExternalTargetAction` + `cal:openDiagram`, then `vscode.openWith` (`extension-core/src/extension/diagram/glsp-activation.ts:683`) |
| breadcrumb / "Used By" | in place | opens or focuses the other editor (`diagram-client/src/navigation-ui.ts:524-534, 835-845`) |
| chat | the editor document's (`chat-panel-integrated.ts:328-343` → `glsp-chat-transport.ts:77-92`) | the nested file's own session |
| ▶ Run | **the workflow on screen** (`__calDiagramContext`, `navigation-ui.ts:313-323`) | the nested file's workflow, standalone |
| layout | `.layout/<defining file>.layout.json`, keyed by workflow name (`diagram-server/src/server/source-model-storage.ts:443-458`) | the same: owned by the defining file, shared by every parent and instance |

No setting keeps a cross-file drill-down in place. `graphSourceNavigation` only
adds fallback args, and wfpy turns it off.

**What already works in favour of one editor:**

- **The server renders whatever file a request names.** `loadSourceModel` takes
  `options.sourceUri` with no check against the editor's document, and wfpy's
  `cli-plan` source runs `wfpy plan <that file> --workflow <name>`. A request
  from the root editor's client for `other.py` already renders `other.py`.
- **Edits already go to the file on screen.** Edit handlers write through
  `modelState.sourceUri`, which follows the last request. Each
  `ReversibleWorkspaceEditCommand` captures its own `uri`, so one undo stack
  across files undoes each edit in its own file.
- **The chat already stays on the root.** It is keyed by `diagramIdentifier.uri`,
  the editor's document, which does not change when the model does.
- **Overlays already reach a nested view through the trail.** `wf:navTrail`
  (`[{sourceUri, workflowName, workflowInstanceName?}]`) makes the overlay lookup
  accept the root run (`source-model-storage.ts:940-984, 2281`) and maps the
  active node by instance path (`sidecar-toolkit/src/server/source-analysis.ts:806-866`).

## The design: the editor is the root, and every view is a view of it

### The root and the trail

An editor's **root** is its document and the workflow first shown in it:
`trail[0]`. Every model request the editor makes carries the **full trail** from
the root to the view: drill-downs, breadcrumbs, refreshes, and the host's own
refreshes after a save or a run. The trail is what tells the server which file
to render, what tells the overlay lookup which run to show, and (below) what
keys the layout.

The host keeps the current trail **per editor**, not per shown file. Today
`uriToRefreshContext`, the pending/recent navigation maps and
`requestRunRefresh`'s client lookup are keyed by the *shown* file's URI. An
editor whose root is `top.py`, showing `child.py`, has to refresh as "`top.py`'s
editor, at this trail".

### 1. Navigating in place

A drill-down into a workflow defined elsewhere sends a `RequestModelAction` to
the **same** client, with `sourceUri` = the defining file and the trail extended
by the instance. The breadcrumb and "Used By" do the same for any crumb, in any
file. "Same file" stops being a question. `editorContext.sourceUri` (the root)
and the shown file are different things, and navigation never compares them.

**Open in Its Own Editor** stays available as a node context-menu item. It
opens the defining file as its own root, today's behaviour on request. "Used By"
navigates *up*, out of the root, so it keeps opening the caller as a new root in
its own editor. Only the views *below* the root are in place.

This changes how every product using the platform navigates, so it is a profile
choice: `nestedNavigation: 'in-place' | 'new-editor'`, default `'new-editor'`
(today's behaviour, so streamblocks-ide is unaffected). wfpy-ide sets
`'in-place'`.

### 2. The chat stays the root's

Already true. It is keyed by the editor's document. Two gaps close:

- **What is on screen.** Each turn's context gains the trail (*viewing
  `root › encoder(enc) › block(b2)`, defined in `layers/block.py`*). Selected
  node ids are then unambiguous: they belong to that instance.
- **The in-host GLSP-MCP tools** read `modelState.sourceUri`, which follows the
  view. Tools that act on the diagram keep acting on the view. Tools that answer
  "which workflow is this chat about" read the root.

### 3. The run is the root's

`__calDiagramContext` gains `rootSourceUri` and `rootWorkflowName` (trail[0])
beside the shown ones. ▶ Run, "Rerun from Here" and the stepper's ⟲ use the
root. The run driver's out directory, live-overlay watch and post-run refresh
are keyed by the editor (the root), so a run started while viewing `block`
refreshes `block`'s view in that editor.

The overlays of a nested view already come from the root run through the trail.
That keeps working once every request carries the full trail. A nested view
**without** a trail (opened in its own editor on purpose) keeps finding runs of
its own workflow, as today.

### 4. Editing a nested view

Editable, in the file that defines it, which the edit handlers already do. What
the host has to add:

- **Secondary documents never stay dirty.** The sidecar writes an edit straight
  to disk, and undo and redo save the document they change, whatever file it is
  (`ReversibleWorkspaceEditCommand.persist`). A nested file is therefore never
  left dirty by the diagram. This needed nothing new: an earlier draft of this
  section said undo left it unsaved, which was wrong.
- **The root editor refreshes when a file it shows changes.** A save, or a
  change on disk from git, a formatter or the agent, already refreshed every
  open diagram. Since phase 1 that refresh reloads the view an editor shows, at
  its trail. Only unsaved typing in a nested file's text editor previewed
  nothing, because live preview fired only for an editor's own document. It now
  also previews in every editor showing that file, with that file's text
  (`previewInViewsShowing`).
- **Concurrent editors.** The same nested file may also be open in its own
  editor ("Open in its own editor", or because someone opened it directly). Both
  refresh from disk on every save. Undo and redo refuse when the document no
  longer holds the text they left, so an edit made in one editor is not undone
  over one made in the other.

### 5. Layout per instance, owned by the root

A nested view's layout key becomes the **instance path from the root**:
`rootWorkflow/encoder/block/...`. It is stored in the **root file's** layout file
(`.layout/<root>.layout.json`). The hook exists
(`source-model-storage.ts:443-458` qualifies `networkId` with `cal:rootWorkflow`
and `cal:instancePath`) and is off for wfpy, and the layout file path still
follows the shown file. Both change for an in-place view: path from the root,
key from the trail.

Two instances of one workflow can then be arranged differently. A view with no
saved layout yet starts from the **defining file's** layout for that workflow,
which is today's key, so every layout made so far carries over. It is saved
under the instance key from then on.

### 6. Rendering a nested workflow as its instance

wfpy renders a nested view standalone (`wfpy plan child.py --workflow block`),
not as the instance it is. That mostly works, because the overlay maps the
active node by instance path. It goes wrong where the instance matters:

- **edges and queue-trace entries** are matched by endpoints, not instance
  path, so a workflow used twice can show the other instance's tokens and queue
  sizes;
- **parameters** given to the instance (a factory's arguments, `instance=` of a
  workflow instance) are not those of a standalone build.

wfpy exports the whole hierarchy instead (see the outline below), each nested
graph elaborated as the instance it is and carrying its instance path, so the
platform asks for the view at a trail rather than a workflow by name.

### 7. The hierarchy outline

Modelled on mlir-viewer's file outline (`mlir-viewer/packages/client/src/outline-panel.ts`,
`outline-tree.ts`), which solves the same problem for large `.mlir` files.

- **The tree is plain data on the root model's args**: `wf:hierarchy`, JSON.
  Nothing is laid out until a row is opened, so the panel costs nothing on a
  large hierarchy. It is computed from the **unfiltered** hierarchy, so a filter
  never hides the way out.
- **A row per instance**: its instance name, the workflow it instantiates, the
  file that defines it (dimmed when it is not the root's), and its size (nodes,
  nested instances). During and after a run a row also carries the run's state:
  running, done, failed, and fire counts, from the overlay already loaded.
- **Single click is a look**: select and center the instance's node in the view
  that contains it. **Double click commits**: navigate in place to it (a request
  at its trail). The breadcrumb and the outline are the same trail, so the
  current view's row is highlighted and its ancestors opened.
- **Filter** keeps the ancestors of a match (`outlineMatches` in mlir-viewer),
  since the tree is the only way to reach a deep instance.
- **Chrome**: a collapsible side panel with a toggle button and a key (`O`), as
  in mlir-viewer. Its pure helpers live in a GLSP-free module, so they are unit
  tested headlessly.

**One export for the whole hierarchy, cached.** Today each drill-down starts a
`wfpy plan` process for one workflow. `wfpy plan --format graph --hierarchy`
exports the root and every nested graph once (wfpy's
`RewriteEngine.export_workflow_graph` already resolves nested workflows across
imports, with recursion guards). The server caches it per root and invalidates
it when any file in it changes. A drill-down then reads the cache. The outline
comes from the same export, and is the cheap part of it: names, files and sizes.

## Phasing

1. **In-place navigation.** *Done.* `clientBehavior.nestedNavigation`
   (`'in-place'` / `'new-editor'`, default `'new-editor'`). Drill-down and the
   breadcrumb stay in the editor for any file. "Used By" navigates in place to
   an ancestor in the trail or to a workflow of the editor's own document, and
   opens a caller in another file as a new root with no trail. The client's
   navigation stack is keyed by the editor's root. The host keys the refresh
   context by the editor (from the request's client) and remembers the shown
   file, so a save, an external change or a live preview refreshes the view
   shown. For another file it reloads from disk, since live-preview content is
   the root's text. A node menu item opens a nested workflow's file in its own
   editor.
2. **The root runs, the chat knows the view.** *Done.* The diagram context carries `rootSourceUri`, `rootWorkflowName` and
   the trail. ▶ Run, ⟲ and "Rerun from Here" use the root, and inside a nested
   view "Rerun from Here" reruns the root-level instance the view is in. The
   refresh during and after a run reloads the editor's current view (file,
   workflow, trail) rather than jumping to the root. The chat panel sends the
   view's trail with the selection and each message, and the turn context names
   the nested view and the file defining it. The diagram's GLSP-MCP tools act on
   the view's file, which is what the user sees. The turn context says so, rather
   than splitting the tools between root and view.
3. **Editing nested views.** *Done.* Undo and redo already saved any file they
   changed. A save or an on-disk change already refreshed every editor, and now
   reaches the view shown. Unsaved edits to a nested file preview in the views
   showing it.
4. **Layout per instance.** *Done.* With `nestedNavigation: 'in-place'`
   (now also in the storage options), a view at a trail of two or more crumbs
   reads its layout from the root file's store, keyed
   `root/<instance path>/<workflow>` (`layout-target.ts`). Until it has one, it
   starts from the workflow's standalone layout. The target is recorded on the
   diagram model at load (`layoutTarget`), and every handler that saves a
   layout uses it (`layoutTargetOf`): moving a node, rerouting, resetting
   routes, the layout commands, placing new nodes. Eight of them had each
   recomputed the key from the shown workflow's name, so a hierarchical
   runtime's per-instance layouts were read per instance and saved per
   workflow. A rename also moves the node in the instance's layout.
5. **The hierarchy export, the cache and the outline.** *Done.*
   - wfpy: `wfpy plan --format graph --hierarchy` (huawei-csl/wfpy#45) exports
     the root and every nested instance, each elaborated as its parent built
     it.
   - The cache: a product gives `cliHierarchyArgs`, and `CliGraphModelSource`
     reads every view, root or nested, from one export per root
     (`hierarchy-cache.ts`). The export is kept while every file it came from is
     unchanged on disk. An instance that did not elaborate, or unsaved text
     being previewed, still gets a plan of its own.
   - The outline: the tree without graphs reaches the root model as
     `wf:hierarchy`. The panel (`hierarchy-outline.ts`, helpers in
     `hierarchy-outline-tree.ts`) has a toggle and the O key, a filter that
     keeps ancestors, a single click that selects and centers the instance in
     the view containing it, a double click that opens its view, and the
     current row highlighted.
   - Not yet: a run's state (running / done / failed, fire counts) on the rows.

Each phase is usable on its own. 1 and 2 together are what removes the
editor-per-level problem.

## Decided

- **Nested views are editable**, in their own files (section 4).
- **Layout is per instance**, in the root's layout file (section 5).
- **"Open in its own editor" opens the nested file as its own root.** It gets
  its own chat, its own runs and its standalone layout: today's behaviour, made
  explicit. A second editor on the same root is not offered.
- **"Used By" opens the caller as a new root**, in its own editor. This editor
  keeps its root, chat and run: navigating up never re-anchors it.

## Open questions

- **How large is the cached hierarchy** for the biggest real workflows, and
  does the outline need the node budget mlir-viewer's has (`truncated`)?
