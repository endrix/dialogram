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
// The container's context menu is drawn by the platform; paired with
// `./context-menu.css` for its styles (diagram-client.css @imports it).
export {
    createDiagramContainer,
    composeDiagramModules,
    type DiagramContainerOptions
} from './container';

// ── Library-owned DI modules ────────────────────────────────────────────────
export { diagramBaseModule } from './base.module';
export { workflowViewsModule } from './stock-views.module';
export { workflowFeaturesModule } from './stock-features.module';

// ── The loading indicator ───────────────────────────────────────────────────
// Raised by the stock starter and the stock feature module. A product with a
// starter and feature modules of its own installs it at start, binds the
// listener as a `TYPES.IGModelRootListener`, and imports
// `./loading-indicator.css` (diagram-client.css @imports it). The host's
// words reach it as they do the stock diagram's; `loadingProgress` is for a
// wait the webview itself starts (an action that makes the server lay the
// diagram out again), ended by the next model unless the host speaks for it.
export { installLoadingIndicator, LoadingIndicatorModelListener, loadingProgress } from './loading-indicator';

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
export { NodeOpener, type NodeOpenerContext, detachedElement, nodeOpenability, openNode, openersInOrder } from './node-opener';
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
// A product's own messages to and from its extension host (host-messages.ts),
// instead of the platform's private copy of the VS Code API.
export { postToHost, onHostMessage, isReservedMessageType } from './host-messages';
// A diagram surface: what a product draws under the SVG itself, in the
// diagram's coordinates (diagram-surface.ts; README §4).
export {
    DiagramSurface,
    type DiagramSurfaceContext,
    type SurfaceBounds,
    type SurfaceViewport,
    type SurfaceTheme,
    type SurfaceZoomLimits,
    type SurfacePoint,
    type SurfaceSelection,
    type SurfaceSection,
    type SurfaceRow,
    type SurfaceValue,
    type SurfaceValuePart,
    type SurfaceModel,
    type SurfaceImage,
    type HostMessage,
    type HostMessaging,
    type SurfaceDisposable
} from './diagram-surface';
export { renderMarkdownSafe, renderDocumentMarkdownSafe, looksLikeMarkdown } from './markdown';
export { isBlock, looksLikeDiff, parseEmbedded, formatAgentOutputs } from './agent-outputs';
// How much text the diagram draws at a zoom, and the classes a product's own
// text is tagged with to follow it (zoom-detail.ts). A product with views of
// its own draws its graph with `DetailGraphView`, which marks the svg with the
// level (`DETAIL_CLASSES`), and imports the rules that hide the rest
// (`@dialogram/diagram-client/zoom-detail.css`). The same view draws the links
// of the selection when the model carries them; their rules are in
// `selection-links.css`.
export {
    DETAIL_CLASSES,
    DETAIL_ZOOM,
    NAME_ZOOM,
    ZOOM_TEXT_CLASSES,
    detailLevel,
    withFullDetail,
    type DetailLevel
} from './zoom-detail';
export { DetailGraphView } from './detail-graph-view';
// The rendered diagram as a self-contained SVG (svg-export.ts), for a product
// that exports a node of its own: the platform's host saves what the webview
// posts as `SVG_EXTRACTED`, and says why as `SVG_EXTRACT_FAILED`. The style
// properties it carries are listed, for a product to check its own
// stylesheet against.
export {
    HTML_STYLE_PROPS,
    SVG_STYLE_PROPS,
    extractSvg,
    svgFileName,
    type ExtractOptions,
    type ExtractedSvg
} from './svg-export';
export { SVG_EXTRACTED, SVG_EXTRACT_FAILED } from './svg-export-command';
// The view options of the diagram shown (view-options.ts): a product's client
// module handles `ViewOptionsChangedAction` to redraw when the reader or the
// host turns a line, or asks `ViewOptionsService` what is checked.
export { ViewOptionsService } from './view-options';
export {
    ViewOptionsChangedAction,
    type ViewOptionChange,
    type ViewOptionGroup,
    type ViewOptionItem,
    type ViewOptionTurn
} from '@dialogram/shared';
// The palette the container binds (view-tool-palette.ts). A product's own
// palette extends it (and keeps the view options and the per-view items): an
// `@injectable()` class rebound to `ToolPalette` in one of the product's
// feature modules, which come after the base module that binds this one. It
// draws what it has of its own in `drawOwnContent`.
export { ViewToolPalette, EMPTY_PALETTE_BODY_CLASS } from './view-tool-palette';
// The mark on a product's own card over the canvas, for Fit and `reveal` to
// keep the drawing clear of it (canvas-overlays.ts).
export { CANVAS_OVERLAY_ATTRIBUTE } from './canvas-overlays';
// The outline panel (hierarchy-outline.ts), for a product with views of its
// own: bound as a singleton and an `IGModelRootListener` in one of its feature
// modules, fed by the root model's `wf:hierarchy`, its rows the producer's
// (`HierarchyOutlineEntry`) and its lazy groups the host's (`DiagramProfile.outline`).
// It shows when the product navigates in place (`clientBehavior.nestedNavigation`).
// Its styles are `hierarchy-outline.css`, its button's `floating-buttons.css`,
// and its button joins the floating stack, which such a product makes before
// the chat panel starts (`ensureFloatingButtonStack`).
export { HierarchyOutlinePanel } from './hierarchy-outline';
export { ensureFloatingButtonStack, FLOATING_BUTTON_STACK_ID } from './floating-panels';
