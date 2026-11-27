# @dialogram/diagram-client

The GLSP/Sprotty diagram-client library that runs inside a VS Code webview. It
ships the stock workflow diagram (bundled as `dist/webview/diagram-client.*` by
the two extension shells) AND is consumable as a library: a custom-view consumer
assembles a diagram from the neutral base + its own view modules with
`createDiagramContainer`, and serves its own bundle.

The stock consumers (wfpy / calpy) load the prebuilt stock bundle unchanged. This
document is for the OTHER path — a consumer with fully custom views (SP4 mlir).

## Consuming the client library

### 1. What the library owns

Import these from the package root (`@dialogram/diagram-client`):

| Export | Purpose |
| --- | --- |
| `createDiagramContainer(options, ...cfg)` | Compose a GLSP container: neutral base + your feature modules. |
| `composeDiagramModules(options)` | The ordered module list the factory loads (test/introspection seam). |
| `DiagramContainerOptions` | `{ clientId, features, withStockViews? }`. |
| `DiagramWebviewChannel`, `installDiagramWebviewChannel`, `getDiagramWebviewChannel` | The ONE host↔webview notification channel (see contract 2). |
| `diagramBaseModule` | The product-neutral base module (loaded first by the factory). |
| `workflowViewsModule`, `workflowFeaturesModule` | The stock model/view + feature-UI modules — reuse them or ignore them. |
| stock model / view classes (`WorkflowNode`, `ExternalActorNodeView`, …) | For consumers who want to EXTEND the stock elements. |

The library deliberately does **not** re-export GLSP/Sprotty. A custom-view
consumer imports `configureModelElement`, `RectangularNodeView`,
`PolylineEdgeView`, `IView`, `svg`, `ContainerModule`, etc. from
`@eclipse-glsp/client` / `@eclipse-glsp/sprotty` / `inversify` **directly**, and
must resolve them to the SAME GLSP 2.5.x major the library resolves to (a second
GLSP realm means divergent DI Symbols and a broken container).

There is intentionally **no exported starter class**: the stock
`WorkflowDiagramStarter` self-instantiates on import (it *is* the shipped stock
webview entry). A custom-view consumer brings its own
`class extends GLSPStarter` and wires the two library calls inside it (see §4).

### 2. Contracts (do not break these)

**Build-time composition only.** Consumer feature modules compose INSIDE the
consumer's own webview bundle, at build time. One inversify realm + one Symbol
table per bundle: a DI-decorated `ContainerModule` must never be constructed
host-side and passed across the extension API, and must never cross an esbuild
boundary. The `DiagramProfile.clientAssets` seam (§5) is therefore **data only** —
URI/path strings, never code objects.

**Single `acquireVsCodeApi()`.** A webview may acquire the VS Code API exactly
once. The host HTML acquires it in its inline bootstrap script and caches the
handle (e.g. on `window`), then overrides `acquireVsCodeApi` to return the cached
handle so libraries that call it internally do not throw. The library's channel,
the chat panel, and any custom feature all share that ONE handle — never acquire
it a second time.

**DOM-anchor contract.** The GLSP starter/webview-widget assumes the host HTML
exposes these ids, keyed on the SAME `clientId` you pass to
`createDiagramContainer`:

- `#${clientId}_container` — the Sprotty diagram host element,
- `#${clientId}_popup` — the hover/popup layer,
- `#${clientId}_hidden` — the offscreen measuring layer,
- a loading element toggled while the model builds.

A consumer serving its own webview HTML (via `clientAssets`) MUST reproduce these
ids or the loader / popup / measuring break.

**Parser-blocking script timing.** Load the client bundle with a **classic**
`<script nonce="…" src="…">` tag — parser-blocking on purpose. It runs (and
installs the messenger via the starter ctor) synchronously, in document order,
**before** VS Code flushes any queued `postMessage` to the webview. Do **not** add
`defer`, `async`, or `type="module"`: any of them defers execution past the
message flush, and early host notifications (the diagram identifier, an
in-progress run's overlay batch) are dropped before a handler exists.

### 3. The esbuild recipe (from the shells)

The two extension shells bundle the stock client with esbuild (see
`packages/extension/esbuild.mjs`, the `glspClientCtx` context). A custom-view
consumer uses the SAME option family for its own entry, adding `jsxFactory` for
custom SVG views:

```js
await esbuild.build({
    entryPoints: ['src/webview-app.ts'], // your entry: imports createDiagramContainer
    outdir: 'dist/webview',
    bundle: true,
    format: 'iife',                      // webviews are not module-scoped
    platform: 'browser',
    target: 'ES2017',
    jsxFactory: 'svg',                   // Sprotty JSX views (.tsx `/** @jsx svg */`)
    minify: true,
    loader: {
        '.css': 'css',                   // GLSP + your CSS inlined into one stylesheet
        '.ttf': 'dataurl',               // codicon / fonts inlined as data URIs
        '.woff': 'dataurl',
        '.woff2': 'dataurl',
        '.eot': 'dataurl',
        '.svg': 'dataurl'
    },
    define: {
        'process.env.NODE_ENV': '"production"',
        global: 'window'
    }
});
```

Notes:
- The CSS loader emits ONE sibling stylesheet next to the JS bundle; serve both.
- Fonts (codicons) are inlined as data URIs, so the CSP needs `font-src … data:`.
- The library is authored in ESM; esbuild resolves and bundles it fine even if the
  consumer's own `tsconfig` is CommonJS (the module mismatch is papered over by
  the bundler — the `tsc -b` type-check is a separate, consumer-side concern).

The consumer-path proof test (`test/consumer-build.test.ts`) runs exactly this
build headlessly against a fixture that imports `createDiagramContainer`, so this
recipe is exercised in CI.

**Path imports need an alias.** The package has no `exports` map, so a
product built against a Dialogram checkout maps `@dialogram/<pkg>[/<subpath>]`
to the package sources itself. That is what makes the path imports in §4
(`@dialogram/diagram-client/stock-starter`,
`@dialogram/diagram-client/diagram-client.css`) resolve:

```js
const { dialogramBuild } = await import(
    pathToFileURL(path.join(dialogramRoot, 'scripts/esbuild-dialogram.mjs')).href
);

await esbuild.build(dialogramBuild({
    // ...the options above, your own plugins among them
}, { packagesDir: path.join(dialogramRoot, 'packages') }));
```

Use esbuild's `alias`, not an `onResolve` plugin. esbuild applies a
`tsconfig.json` only to a path its own resolver found, so a module a plugin
resolves is compiled without the package's `experimentalDecorators`, with
standard decorators, and inversify's property `@inject` throws when the bundle
loads ("Cannot read properties of undefined (reading 'prototype')"). It shows
only once a decorated module is first imported by package name, which is why a
plugin can seem to work. `dialogramBuild` adds the alias (`dialogramAlias`)
and plugins around yours:
- before them, a check that fails the build, naming the module, when one was
  compiled with standard decorators;
- after them, the refusal of a `@dialogram/` path the alias does not map and
  `external` does not name, which esbuild would otherwise look for in
  `node_modules` (another checkout, perhaps), so a plugin of yours may serve
  such a path;
- last, the write: only when no `onEnd` failed the build, and only the files
  that changed, so a failed build leaves the last good bundle.

The wrapper writes the bundle itself (leave `write` out); `{ inMemory: true }`
leaves the outputs in `outputFiles` instead, checked all the same. A "build
succeeded" line belongs in `{ onWritten }`, which runs once the files are on
disk: a plugin's `onEnd` of yours runs before the write. The extension's own
build and the SVG renderer build this way.

A product with its own `node_modules` also pins GLSP, Sprotty and inversify to
the platform's copy, so the bundle has one inversify realm (chisel-ide's
`esbuild.mjs`, `pinPlatformRealmPlugin`). `test/stock-starter-build.test.ts`
builds a product entry through this alias and checks its stylesheet order, and
that a decorated module imported by package name keeps its legacy decorators.

### 4. Wiring your starter

**The stock diagram with your modules added.** When your bundle is the stock
diagram plus a few modules of your own (a property-panel contribution, a view,
a rebinding), do not write a starter: call the stock one. It is what the
shipped bundle runs, so you get the same channel, overlay routing, palette
header controls and SVG export. Your modules load after the stock views and
feature UI, where a `rebind` replaces what a stock feature module bound. The
VS Code integration and GLSP's grid, helper-line, hover and context-menu
modules still load after yours, and the context-menu service is rebound last,
so those you cannot replace this way. Do not pass a stock module in
`features`: the starter already loads them, and it throws rather than register
them twice.

`@dialogram/diagram-client/stock-starter` is a path import. The package has no
`exports` map, so your bundler must resolve `@dialogram/<pkg>/<subpath>` to
`packages/<pkg>/src/<subpath>.ts`, as the alias in §3 does.

```ts
// Import the starter FIRST: its imports bring GLSP's own stylesheets, and
// esbuild writes CSS in the order it meets it, so the stock rules, then yours,
// override GLSP's.
import { startStockDiagram } from '@dialogram/diagram-client/stock-starter';
import '@eclipse-glsp/vscode-integration-webview/css/glsp-vscode.css';
import '@eclipse-glsp/client/css/grid.css';
import '@vscode/codicons/dist/codicon.css';
import '@dialogram/diagram-client/diagram-client.css';
import './my-client.css';
import { myFeaturesModule } from './my-modules';

startStockDiagram({ features: [myFeaturesModule] });
```

A sidecar product names the built bundle with `clientAssets` on its
`createSidecarDiagramProfile` input (§5).

**An annotation editor.** The property panel draws a card for every
annotation on a node's definition: Save, Remove, and a free key/value row per
argument. To give one annotation controls of its own, bind an
`AnnotationEditor` in your features module:

```ts
import { ContainerModule } from 'inversify';
import { AnnotationEditor } from '@dialogram/diagram-client';

export const myFeaturesModule = new ContainerModule(bind => {
    bind(AnnotationEditor).toConstantValue({
        annotationName: 'retry',     // edits @retry(...)
        reservedArgs: ['times'],     // the free rows skip it
        render({ args, body }) {
            const input = document.createElement('input');
            input.value = args.get('times') ?? '';
            input.addEventListener('input', () => args.set('times', input.value));
            body.appendChild(input); // Save reads `args`
        }
    });
});
```

Without `formatAnnotation`, Save writes `@name(key=value, ...)`. With
`mergeArgUpdates`, Save also sends the arguments, so the server keeps the
ones the card does not show. `guiOnlyArgs` are keys your editor keeps in
`args` for its own state; Save writes them nowhere. `quickAdd` puts an "add
from template" button in the Annotations header. There is one editor per
name: a later binding replaces an earlier one, so a module loaded later can
replace an editor an earlier one bound.

**Node sections.** To show more about a node than the panel's own sections,
bind a `NodeSectionContribution`. It needs an `id`; every hook is optional:

```ts
import { ContainerModule } from 'inversify';
import { NodeSectionContribution, createPropertySection } from '@dialogram/diagram-client';

export const myFeaturesModule = new ContainerModule(bind => {
    bind(NodeSectionContribution).toConstantValue({
        id: 'owner',
        infoRows: node => [{ label: 'Owner', value: String(node.args?.['my:owner'] ?? '') }],
        last: node => {
            const section = createPropertySection('History');
            section.querySelector('.property-section-content')!.textContent = '…';
            return section;
        }
    });
});
```

- `infoRows` are rows of Basic Info, after the node's type.
- `afterAnnotations` and `last` return a section, or nothing.
- `prepare(node, root)` runs before a selected node is drawn.
- `modelChanged(node, content)` runs on every model change while the panel
  shows the node. The panel does not redraw then: the contribution updates
  its own section in place.
- `install(host)` runs once. Its `host.redrawIfShowing(id)` draws the node
  again, for an answer that arrives later.

Contributions are asked in the order their ids were first bound. A later
binding for an id replaces the earlier one.

**Annotation templates.** The Annotations header's "Wizard…" adds an
annotation from a template, or from a name and arguments typed in. To offer a
template, bind an `AnnotationTemplate`:

```ts
import { ContainerModule } from 'inversify';
import { AnnotationTemplate } from '@dialogram/diagram-client';

export const myFeaturesModule = new ContainerModule(bind => {
    bind(AnnotationTemplate).toConstantValue({
        annotationName: 'retry',
        label: '@retry (run again on failure)',
        async compose({ existing }) {
            const times = existing?.arguments?.find(a => a.name === 'times')?.value ?? '3';
            return `@retry(times=${times})`; // or undefined: the person cancelled
        }
    });
});
```

There is one template per annotation name, and a later binding replaces an
earlier one. The wizard lists them before its own "Custom annotation…" entry
(`custom`), which a template cannot replace.

The stock bundle binds no editors, sections or templates. wfpy-ide's own
bundle is an example of all three: its `src/webview/agent-ui/` holds the
`@tool` and `@agent` editors, the agent sections (Basic Info's Skill row,
Agent Tools, the live Agent Context) and the `@tool` and `@viewer` templates.

**Node openers.** A double-click on a node opens its definition, unless the
network navigation opens something for it. To open something else for some
of your nodes, bind a `NodeOpener` with an `id`: its `open(node, { sourceUri })`
returns the actions to run, or `undefined` to leave the node to the platform.
Openers are asked in the order their ids were first bound, and the first
that answers wins; a later binding for an id replaces the earlier one. The
stock bundle binds none; wfpy-ide's binds its `@viewer` opener.

**A view's own facts.** The facts a producer states for the view itself
(`graph.meta.facts`, `[{ label, value, markdown? }]`, on the root as
`wf:facts`) are drawn in the panel with the view's name: after a double
click on the background, and by themselves over a surface that hears clicks
(below). A product whose readers look at them before selecting anything sets
`clientBehavior.viewFactsWhileNothingSelected: true`: for a view with facts
the panel then shows them while nothing is selected, with or without a
surface: from the first model on, in place of the "Select an element" hint,
and again when a click on nothing clears a node's selection or a surface's.
Not over a surface's selection the reader has just made, nor over a field of
the panel that has the focus or holds text typed and not committed: the
panel is left as it is then. What is typed counts as committed after an
Enter the field takes (it prevents the key's default, as each of the panel's
fields whose Enter commits does; Ctrl+Enter in a field of lines) or the
change of a field marked `data-commits-on="change"`; in a field committed
only by its button it counts as not committed until the panel is drawn anew.
The producer's fields carry that mark; a product's own field in the panel
that commits on its change must carry it too, or its text is held as not
committed. A search field holds nothing. A selection that goes because the
model no longer has the element (an edit renamed it) gives way to its node,
or to the view, as it always did. The pin keeps the panel visible, as its
button says, and keeps no content. Escape clears a surface's selection and
shows the view's properties, as it does without the option; no key clears a
node's selection. Without the option, and for a view with no facts, the
panel opens on the hint and keeps what it shows on a deselection.

**A diagram surface.** To draw the diagram's content yourself (a canvas, a
WebGL context) while the platform keeps the viewport, Fit and Center, the
palette, the outline, the property panel and the chat, bind a
`DiagramSurface` (`diagram-surface.ts`). It never sees a Sprotty or GLSP
type; coordinates are the model's, and a model point `(x, y)` is drawn at
CSS pixel `((x - scrollX) * zoom, (y - scrollY) * zoom)` of your element.

```ts
import { ContainerModule } from 'inversify';
import { DiagramSurface, type DiagramSurfaceContext } from '@dialogram/diagram-client';
import { startStockDiagram } from '@dialogram/diagram-client/stock-starter';

let context: DiagramSurfaceContext;
const canvas = document.createElement('canvas');
const surface: DiagramSurface = {
    id: 'my-surface',
    zoomLimits: { min: 0.01, max: 5000 },          // over clientBehavior.zoomLimits, over GLSP's 0.1–20
    mount(c) { context = c; return canvas; },        // put under the SVG, sized to the canvas
    render(viewport) { draw(canvas, viewport); },    // every viewport change, the first included
    bounds: () => dataBounds,                        // Fit and Center frame it with the graph
    modelChanged({ data }) { load(data); context.boundsChanged(); context.requestRender(); },
    click(point) { context.setSelection(pick(point.x, point.y)); },   // a click on no diagram element
    followLink(link) { context.setSelection(selectionFor(link)); },   // a link in the panel's rows
    exportImage: () => new Promise(resolve => canvas.toBlob(resolve, 'image/png'))
};
startStockDiagram({ features: [new ContainerModule(bind => { bind(DiagramSurface).toConstantValue(surface); })] });
```

- The producer sends the surface's data on the graph: `meta.surface` reaches
  `modelChanged` (plain, small JSON, once per change). An empty graph
  (`nodes: []`) with a surface is a diagram like any other; no scaffold node.
  Larger data goes over the product's own channel: `postToHost(message)` and
  `onHostMessage(listener)` (also `context.host`), heard on the host by
  `DiagramProfile.onWebviewMessage` and answered with `postToWebview`. Types
  starting with `dialogram.` or `chat.` are the platform's and are refused.
  Do not reach for `window.__calVscodeApi`.
- A selection (`setSelection({ ids, title, kind?, note?, source?, sections?, bounds? })`)
  is drawn by the property panel as a node's is, put in the chat's context,
  framed by Fit and Center by its `bounds`, and cleared by Escape or a node
  selected (`selectionCleared` tells you); without a `click`, by a click on
  no diagram element too, which leaves the panel as it is, or shows the
  view's facts where the product asks for them (below). A row's `link`, or
  a value's parts with links, come back to `followLink`.
- A double-click on no diagram element reaches `click` with `clickCount: 2`
  (after the first click's `1`) and is yours alone: with a `click`, the
  platform does not show the root's properties there, so what you select
  stays in the panel. The panel shows the root's properties by itself
  instead while nothing is selected: from the first model on, in place of
  its "Select an element" hint, and again once a selection is cleared by
  Escape or by you. A node or a selection of yours in the panel is never
  replaced by them because a model came, and a click on nothing that you
  leave unanswered leaves the panel as it is.
- `context.reveal(bounds)` centres a rectangle in the free area at the zoom
  there is, as Center does: a rectangle that fits the canvas but not the
  free area stays on the canvas, a margin inside its edge, and one wider or
  taller than the canvas covers its whole width or height, as near the free
  area's middle as that allows. `{ fit: true }` fits it as Fit does, into
  the whole canvas when no free area has room for the margin; a zoom the
  limits stop keeps it in the middle, and on the canvas by the same rule.
  `context.freeArea()` is that area, the canvas less the platform's overlays.
  `reveal` and `fit` are animated unless `{ animate: false }`; `setViewport`,
  for your own pan and zoom, is not unless `{ animate: true }`.
- The zoom limits are those of the surface used: with several bound, the
  last, a later binding of an `id` taking an earlier one's place.
- The host and the server are the installed Dialogram's, not your bundle's.
  Until the release that bumps the API to 0.9, nothing at run time tells a
  Dialogram that understands `meta.surface` from one that does not: an older
  server leaves `modelChanged`'s `data` undefined, as a producer that sends
  none does. Require 0.9 once it is out.
- The profile's `clientBehavior.initialView: 'fit'` makes the first view a
  fit, done once the canvas has a size and `bounds()` answers: data that
  comes later over `context.host` is waited for, as long as `boundsChanged()`
  is called when it is in. Until the reader moves the view, it is done again
  when the canvas takes another size (a model drawn before VS Code sized the
  webview's frame). `clientBehavior.fitMaxZoom` caps how far that
  fit, Fit and `reveal` with `fit` zoom in (`1`: a small diagram opens at its
  drawn size, not magnified); `reveal`'s own `maxZoom` wins over it, and the
  zoom limits over both.
- The rest of the diagram works with a surface as without one. What the
  reader shows and hides reaches it as it reaches any module (§6: handle
  `ViewOptionsChangedAction`, then `requestRender()`); the outline, its lazy
  groups too, sits beside it, and Fit and `freeArea()` keep clear of it. A
  selection the outline should show as well goes to the host, which calls
  `DiagramProfileHandle.revealOutlineRow`; a click on a product's row in the
  outline reaches the host's `outline.activate`, which can tell the surface
  with `postToWebview`. Each editor of a file has its own surface; a
  `postToWebview` reaches all of them, `ctx.postToWebview` only the asker.

**A card of your own over the canvas.** Fit, Center and a surface's
`reveal` keep the drawing clear of the platform's overlays (the palette, the
outline, the chat card) and of any element marked `data-canvas-overlay`
(`CANVAS_OVERLAY_ATTRIBUTE`). Mark the one element that holds your card, and
put it on the page before the first view, empty if its content comes later:
the mark is read when a fit runs. A card that is `hidden`, not visible, or
marked `"false"` is not counted.

**A view your server names.** A model set again (a `SetModelAction`, such as
the answer to a `RequestModelAction` after the source changed) keeps the
viewport when it is the same view, and gets the first view
(`clientBehavior.initialView`) when it is a view never shown. The platform
tells views apart by the root's `sourceUri`, workflow and shown view
(`wf:view`), and the instance path of a nested workflow. A root without a
source or a workflow is named by its server instead, with
`VIEWPORT_KEY_ARG` (`'wf:viewportKey'`, from `@dialogram/shared`): a
non-empty string or a number, one stable key per view, such as the file's
URI. Without either, every model set is a view never shown, so a refresh is
centred or fitted again.

**A diagram of your own.** When you compose the container yourself:

```ts
import 'reflect-metadata';
import { GLSPStarter } from '@eclipse-glsp/vscode-integration-webview';
import { createDiagramContainer, installDiagramWebviewChannel } from '@dialogram/diagram-client';
import { myViewsModule, myFeaturesModule } from './my-modules';

class MyDiagramStarter extends GLSPStarter {
    constructor() {
        super();
        // Publish the ONE canonical channel over GLSP's messenger BEFORE the
        // stock GLSP handlers register — first-class handler composition means
        // your custom action-kind routes and GLSP's late `actionMessage` handler
        // coexist regardless of registration order.
        installDiagramWebviewChannel(this.messenger as never);
    }

    createContainer(...cfg: unknown[]): unknown {
        const id = (globalThis as { diagramIdentifier?: { clientId?: string } }).diagramIdentifier;
        const clientId = typeof id?.clientId === 'string' ? id.clientId : '';
        // Your modules compose AFTER the neutral base, in array order.
        return createDiagramContainer({ clientId, features: [myViewsModule, myFeaturesModule] }, ...cfg);
    }
}

new MyDiagramStarter();
```

**`withStockViews` caveat.** `withStockViews: true` prepends
`workflowViewsModule` ahead of `features`. Do **not** also pass
`workflowViewsModule` inside `features` — the stock model/view set would be
registered twice and GLSP throws on the duplicate `configureModelElement`
binding. Use the flag as a convenience OR list the module explicitly, never both.

### 5. Serving your bundle via `DiagramProfile.clientAssets`

The neutral editor provider builds the webview HTML from your profile's
`clientAssets` (data only — the SP2c bundle-boundary lesson):

```ts
const MY_PROFILE: DiagramProfile = {
    // …the rest of the profile…
    clientAssets: {
        scriptPath: '/abs/path/to/lib/webview/webview-app.js', // your esbuild output
        stylePath: '/abs/path/to/lib/webview/webview-app.css',  // the sibling stylesheet
        localResourceRoots: ['/abs/path/to/lib/webview', '/abs/path/to/lib/codicons']
    }
};
```

- Paths are absolute fs paths (or `file:` URI strings); the provider converts them
  via `webview.asWebviewUri` and appends a per-file `?v=<mtime>` cache-bust token
  (the webview otherwise serves a stale bundle across rebuilds).
- `localResourceRoots` EXTENDS — never replaces — the stock roots, so both your
  assets and the platform's codicons remain loadable under the CSP.
- Omit `clientAssets` entirely and the provider falls back to the stock
  `dist/webview/diagram-client.*` paths, byte-identically to today.

### 6. Following the view options in your modules

What a reader may show and hide is declared by the profile or the model
source (`DiagramProfile.viewOptions`, `GraphDocument.viewOptions`) and drawn
by the platform under the palette's tools. A renderer of your own follows it
in the webview, with no round trip, by handling the action the platform
dispatches each time what is checked changes (the first model that has the
groups, a reader's click, a change the host made):

```ts
import { ContainerModule } from 'inversify';
import { configureActionHandler } from '@eclipse-glsp/client';
import { ViewOptionsChangedAction, ViewOptionsService } from '@dialogram/diagram-client';

export const myFeaturesModule = new ContainerModule((bind, unbind, isBound, rebind) => {
    bind(MyRenderer).toSelf().inSingletonScope();
    configureActionHandler({ bind, isBound }, ViewOptionsChangedAction.KIND, MyRenderer);
});

@injectable()
class MyRenderer {
    @inject(ViewOptionsService) private readonly options!: ViewOptionsService;
    handle(action: ViewOptionsChangedAction.Action): void {
        // `action.changed` is the lines that turned, `action.groups` all of them.
        this.redraw(this.options.isChecked('kinds', 'a') !== false);
    }
}
```

The platform binds `ViewOptionsService` and a handler of its own for the
action, so the action is known whether or not you handle it. The state is the
host's, per file, kept beside the layout; do not keep a copy of it in the
webview's storage.
