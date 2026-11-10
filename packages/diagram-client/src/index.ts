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
 * The stock start-up is NOT exported here. `startStockDiagram` lives in
 * `./stock-starter` (imported by path, `@dialogram/diagram-client/stock-starter`)
 * because it pulls in GLSP's VS Code webview integration, which only a bundle
 * needs; the shipped entry, `diagram-client.ts`, is that call with nothing
 * added and self-starts on import. A product whose bundle is the stock diagram
 * plus modules of its own calls `startStockDiagram({ features })`; one that
 * composes a diagram of its own brings a `class extends GLSPStarter` and wires
 * `installDiagramWebviewChannel` + `createDiagramContainer` in it — see README §4.
 */

// ── Stock model + view classes (reuse/extend the stock elements) ──────────────
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

// ── Property panel (reusable chrome + field toolkit) ────────────────────────
// The window-management "chrome" (show/hide/pin/resize/float) and the typed
// field/model toolkit are product-neutral and reusable. The domain-coupled
// content class (`PropertyPanel`) is intentionally NOT exported — same policy as
// `WorkflowDiagramStarter`: chrome + fields are neutral, content is domain-bound.
// Paired with `./property-panel.css` for the panel/field styles.
export {
    PropertyPanelChrome,
    DEFAULT_PROPERTY_PANEL_CHROME_CONFIG,
    type PropertyPanelChromeConfig
} from './property-panel-chrome';
export {
    ppField,
    ppNumberField,
    ppReadonlyRow,
    renderInto,
    type NumberFieldOptions
} from './property-fields';
export { AnnotationEditor, type AnnotationEditorContext } from './annotation-editor';
export {
    NodeSectionContribution,
    type NodeInfoRow,
    type NodeSectionContext,
    type NodeSectionHost,
    type PanelModelRoot
} from './node-section';
export { createPropertySection, escapeHtml, shortenPath } from './property-section';
export { NodeOpener, type NodeOpenerContext } from './node-opener';
export {
    AnnotationTemplate,
    CUSTOM_ANNOTATION_ENTRY,
    type AnnotationTemplateContext
} from './annotation-template';
export {
    type PropertyElement,
    type PropertyArgs,
    readStringArg,
    readNumberArg,
    readBoolArg
} from './property-model';

// ── The canonical host↔webview channel ──────────────────────────────────────
export {
    DiagramWebviewChannel,
    installDiagramWebviewChannel,
    getDiagramWebviewChannel,
    type ChannelSubscription,
    type ChannelMessenger,
    type ActionKindHandler
} from './webview-channel';

// ── What a product's webview code reaches the host and the profile through ──
// For a product bundle's own contributions (annotation editors, node sections,
// templates): the host's quick picks, input boxes and commands, the profile's
// client behaviour and command ids, and the text helpers the panel renders
// with. Their contracts are the modules' own docs.
export { VscodeUi, type VscodeQuickPickItem, type ViewerEditorSetting } from './vscode-ui';
export {
    clientBehavior,
    commandId,
    operationKind,
    offersRun,
    settingsNamespace,
    type DiagramCommandKey,
    type DiagramOperationKey
} from './profile';
export { renderMarkdownSafe, renderDocumentMarkdownSafe, looksLikeMarkdown } from './markdown';
export { isBlock, looksLikeDiff, parseEmbedded, formatAgentOutputs } from './agent-outputs';
// How much text the diagram draws at a zoom, and the classes a product's own
// text is tagged with to follow it (zoom-detail.ts).
export { DETAIL_ZOOM, NAME_ZOOM, ZOOM_TEXT_CLASSES, detailLevel, type DetailLevel } from './zoom-detail';
