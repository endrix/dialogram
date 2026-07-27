/**
 * @dialogram/diagram-client
 *
 * GLSP diagram client webview library. Runs in the VS Code webview (browser
 * context). Consumers assemble a diagram with {@link createDiagramContainer}
 * and drive it from their own GLSP starter — see `README.md`, section
 * "Consuming the client library", for the build-time-composition, single
 * `acquireVsCodeApi`, and DOM-anchor contracts plus the esbuild recipe.
 *
 * ## What the library owns (and re-exports here)
 *
 *  - `createDiagramContainer` / `composeDiagramModules` — the composition seam.
 *  - `DiagramWebviewChannel` (+ install/access) — the ONE host↔webview channel.
 *  - the neutral base module + the stock workflow view/feature modules.
 *  - the stock model classes and view classes (below, via `./model` / `./views`)
 *    for consumers who want to REUSE or extend the stock elements.
 *
 * It deliberately does NOT re-export GLSP/Sprotty: consumers building fully
 * custom views import `configureModelElement`, `RectangularNodeView`,
 * `PolylineEdgeView`, `IView`, `svg`, etc. from `@eclipse-glsp/client` /
 * `@eclipse-glsp/sprotty` directly — those extension points are GLSP's, and the
 * library must resolve to the SAME GLSP realm the consumer bundles.
 *
 * The stock starter (`WorkflowDiagramStarter` in `diagram-client.ts`) is NOT
 * exported: that module self-instantiates on import (it IS the shipped stock
 * webview entry), so importing it would boot the stock app. A custom-view
 * consumer brings its own `class extends GLSPStarter` and wires
 * `installDiagramWebviewChannel` + `createDiagramContainer` in it — see README.
 */

// ── Stock model + view classes (back-compat; reuse/extend the stock elements) ──
export * from './model';
export * from './views';

// ── Composition seam ─────────────────────────────────────────────────────────
export {
    createDiagramContainer,
    composeDiagramModules,
    type DiagramContainerOptions
} from './container';

// ── Library-owned DI modules ────────────────────────────────────────────────
export { diagramBaseModule } from './base.module';
export { workflowViewsModule } from './stock-views.module';
export { workflowFeaturesModule } from './stock-features.module';

// ── Stock integrated chat panel (reuse/extend the shipped chat UI) ──────────
// Paired with `./chat-panel.css` (import that stylesheet directly for the panel styles).
export { ChatPanel } from './chat-panel-integrated';

// ── Back-compat aliases for the former monolith surface ─────────────────────
export { workflowDiagramModule, createCalDiagramContainer } from './di.config';

// ── The canonical host↔webview channel ──────────────────────────────────────
export {
    DiagramWebviewChannel,
    installDiagramWebviewChannel,
    getDiagramWebviewChannel,
    type ChannelSubscription,
    type ChannelMessenger,
    type ActionKindHandler
} from './webview-channel';
