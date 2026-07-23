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
| stock model / view classes (`WorkflowNode`, `WorkflowNodeView`, …) | For consumers who want to EXTEND the stock elements. |

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

### 4. Wiring your starter

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
