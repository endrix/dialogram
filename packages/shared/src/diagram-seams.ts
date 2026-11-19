import type { LoadProgress } from './loading';
import type { ViewOptionGroup, ViewOptionsState } from './view-options';

/** Neutral, pre-normalized diagnostic a model source attaches to its GraphDocument. */
export interface GraphDiagnostic {
    /** Absolute fs path or file URI the diagnostic belongs to (defaults to the graph's source). */
    uri?: string;
    severity: 'error' | 'warning' | 'info';
    message: string;
    code?: string;
    startLine?: number;
    startColumn?: number;
    endLine?: number;
    endColumn?: number;
}

/** Identity facts about one node, for rename/navigation features. */
export interface GraphNodeIdentity {
    instanceName: string;
    definitionName?: string;
    instancePath?: string;
}

/** Relationship facts for the workflows defined in one source file. Exact shape moved
 *  verbatim from the concrete source-analysis module so storage can depend on it neutrally. */
export interface WorkflowRelationshipInfo {
    workflowNames: string[];
    entryWorkflowNames: string[];
    callersByWorkflow: Record<string, string[]>;
}

/** A discovered cross-file caller of a workflow. Exact shape moved verbatim from the concrete
 *  source-analysis module so storage can depend on it neutrally. */
export interface WorkflowCallerReference {
    sourceUri: string;
    workflowName: string;
}

/**
 * Optional language-specific source-analysis capabilities a model source may provide.
 * Method signatures mirror the concrete analysis module 1:1 (product tokens stripped from
 * names). Storage feature-detects: where `analysis` is absent, every call site degrades
 * exactly as if the underlying helper returned its empty/undefined result.
 */
export interface GraphSourceAnalysis {
    findPackageRootForFile(filePath: string): Promise<string | undefined>;
    pickDefaultWorkflowName(filePath: string, workflowNames: string[]): string | undefined;
    resolveWorkflowDefinitionRange(
        sourceText: string,
        workflowName: string
    ): { start: { line: number; character: number }; end: { line: number; character: number } } | undefined;
    analyzeWorkflowRelationships(sourceText: string): WorkflowRelationshipInfo;
    collectSourceFilesUnderRoots(scanRoots: string[], excludeFilePath: string): Promise<string[]>;
    discoverCrossFileWorkflowCallers(
        targetFilePath: string,
        targetWorkflowName: string,
        candidateFilePaths: string[]
    ): Promise<WorkflowCallerReference[]>;
    buildOverlayAstPathCandidates(args: Record<string, unknown> | undefined): string[];
    buildOverlaySignatureCandidates(entry: {
        fromEntity?: unknown;
        outPort?: unknown;
        toEntity?: unknown;
        inPort?: unknown;
    }): string[];
    buildOverlayNodeIdentityCandidates(args: Record<string, unknown> | undefined): string[];
    resolveOverlayActiveEntityName(
        active:
            | Array<{ entityInstanceName?: string; entityInstancePath?: string[] }>
            | { entityInstanceName?: string; entityInstancePath?: string[] }
            | undefined,
        workflowName: string,
        navigationTrail?: Array<{ sourceUri: string; workflowName: string; workflowInstanceName?: string }>
    ): string | undefined;
    normalizeWorkflowReferenceName(value: string | undefined): string | undefined;
}

/**
 * Neutral graph document couriered from a model source to the server's storage.
 *
 * ## A graph drawn by a surface
 *
 * A product whose webview binds a diagram surface (diagram-client
 * `diagram-surface.ts`) draws its content itself, on a canvas under the SVG,
 * and the graph need not hold it. `graph.meta.surface` is that surface's
 * data: any JSON, passed through unread to the root's `wf:surface` arg and
 * handed to the surface's `modelChanged` whenever it changes. Keep it small
 * (where to fetch what is drawn, a revision, a unit); the bulk goes over the
 * product's own messages (`DiagramProfile.onWebviewMessage` and
 * `postToWebview` on the host, `postToHost` and `onHostMessage` in the
 * webview), which carry `ArrayBuffer`s.
 *
 * Such a graph may have no nodes at all: `{ nodes: [], edges: [], meta: {
 * surface, facts } }` is a first-class view. The root still carries the
 * facts (its property panel), the hierarchy (the outline, its lazy groups
 * included), the view options (`viewOptions` below, the surface redrawing
 * as they turn) and the surface's data; Fit and Center frame the surface's
 * bounds; the palette and the chat are there as for any view. No placeholder node is needed to hold the
 * canvas open, and one that is drawn as nothing still has bounds a Fit
 * would frame.
 */
export interface GraphDocument {
    version?: string;
    graph: unknown;
    partial?: boolean;
    errors?: Array<{ message?: string; file?: string; line?: number; column?: number }>;
    /** Normalized diagnostics; storage publishes these verbatim (no product-shaped walking). */
    diagnostics?: GraphDiagnostic[];
    /**
     * The hierarchy this graph is part of, from its root: the outline a client
     * shows to navigate it. Published on the root model as `wf:hierarchy`.
     */
    hierarchy?: HierarchyOutlineEntry;
    /**
     * What a reader may show and hide in this graph's view, as checkable
     * groups the palette draws under its tools (`view-options.ts`). The
     * profile's own groups (`DiagramProfile.viewOptions.groups`) come first.
     * Published on the root model as `wf:viewOptions`, with the reader's
     * choices for the file applied. Those of a load that was abandoned
     * (`ModelSourceOptions.signal`) are not taken as the file's.
     */
    viewOptions?: ViewOptionGroup[];
}

/**
 * What the chat is told about a diagram surface's selection: the webview's
 * `chat.selection` and `chat.sendMessage` carry it as `surfaceSelection`
 * beside `selectedNodeIds`, and the chat's turn context says it (or a
 * profile's `selectionContext.render` and `turnContextProvider`, which get it
 * as their third argument, and a slash command's `ctx.surfaceSelection`).
 *
 * Text only, capped: at most 50 ids and 40 rows, each value at most 200
 * characters. A row's links keep their text and lose their targets, which
 * mean something to the surface and nothing to an agent.
 */
export interface SurfaceSelectionSummary {
    /** The surface's own stable ids for what is selected; no graph element's. */
    ids: string[];
    /** What it is called. */
    title: string;
    /** What kind of thing it is. */
    kind?: string;
    /** The panel's rows, as text, with the section each is in. */
    rows: Array<{ section?: string; label: string; value: string }>;
}

/**
 * One instance in a workflow hierarchy, for an outline: where it is (its
 * `path` of instance names from the root, `[]` for the root), what it
 * instantiates, the file defining it, its node in the parent's graph (by the
 * producer's node id), and how big it is. No graph: an outline is light
 * enough to ride on every view.
 *
 * A producer whose units have a structure of their own says more about a
 * row: what it is called and what follows (`label`, `detail`), a node
 * family's colour (`family`), short marks (`badges`), and its `role`.
 */
export interface HierarchyOutlineEntry {
    path: string[];
    workflowName: string;
    sourceUri?: string;
    nodeId?: string;
    nodeCount?: number;
    error?: string;
    truncated?: boolean;
    children: HierarchyOutlineEntry[];
    /**
     * What the row stands for. `view` (the default): a view of its own, which
     * a double click opens. `group`: a heading over other rows (a folder, a
     * layer), which only opens and closes; it is transparent to paths, so its
     * children's paths are written as if it were not there, and its own path
     * only has to be unique. `node`: a node inside the view of the row above
     * (`nodeId`), not a view; a click finds it, a double click does what a
     * double click on that node does. `item`: something of the product's
     * that is neither a view nor a node of the graph (a file, a record): a
     * click hands its {@link id} to the product (`DiagramProfile.outline.activate`),
     * which selects and reveals it in its own way.
     */
    role?: 'view' | 'group' | 'node' | 'item';
    /** The product's id for an `item` row, handed back when it is clicked or named in a reveal; its path joined by `/` otherwise. */
    id?: string;
    /**
     * How many rows a group holds, when that is not what `children` says:
     * the size of a `lazy` group, or of a list the producer cut short
     * (`truncated`, "200 of 268"). Shown as the group's count, once.
     */
    count?: number;
    /**
     * The group's rows are the host's, a page at a time, as the group is
     * opened and scrolled (shared `outline-pages.ts`), and a filter typed in
     * the panel is answered there for them. `id` names the group to the host
     * (`DiagramProfile.outline.page`); `count` is how many rows it has;
     * `children` stays empty. Pages already shown are asked for again when
     * the outline changes: change `version` when the rows do and nothing
     * else in the outline does.
     */
    lazy?: { id: string; version?: string | number };
    /**
     * What the row's count counts, in the producer's words for one and for
     * more: a view's nodes (`nodeCount`, "1 node, 3 nodes" when unsaid), a
     * group's rows (a bare number when unsaid).
     */
    countNoun?: { one: string; other: string };
    /** What the row says, instead of its last path segment. */
    label?: string;
    /** Said after the label, dimmed: a title for an id, an id for a title. */
    detail?: string;
    /** A node family's name (its `id` or annotation): the row carries its colour. */
    family?: string;
    /** Short marks after the label, as a node header's badges. */
    badges?: Array<{ text: string; tone?: string }>;
}

export interface ModelSourceOptions {
    /** The RequestModelAction options bag, passed through verbatim. */
    requestOptions: Record<string, unknown>;
    /**
     * Say what the load is doing, for the reader who is waiting on it: the
     * diagram shows the latest thing said under a turning circle, and how
     * long it has been (see `loading.ts`). Worth calling before anything that
     * can take a second: a compiler, a build, a server being started.
     *
     * Call it as often as there is something new to say; it costs a message
     * to the webview and never throws. Absent on a load nobody watches (a
     * poll in the background, an older host, a test): call it as
     * `options.progress?.(...)`.
     */
    progress?: (progress: LoadProgress) => void;
    /**
     * Aborted when nobody is waiting for this graph any more, so that the
     * product can stop the work behind it (a compiler, a worker, a request to
     * a server):
     *
     * - the diagram's editor closed;
     * - or the reader asked the same diagram for another graph (a save,
     *   another view, a refresh) while this one was being made, once the
     *   diagram shows a graph. A diagram's first load is not replaced: the
     *   reader is waiting for a picture, and is shown this one, then the
     *   newer one.
     *
     * Once it is aborted, answer as you like: `undefined`, a partial
     * document, or a throw. Nothing of the answer is drawn, and the request
     * that replaced this one draws in its place. `signal.reason` says which
     * it was (an `AbortError` whose message names it).
     *
     * The signal covers `getGraph` and nothing after it: once `getGraph` has
     * answered, the signal is never aborted, and the platform draws the
     * answer (lays it out, sends it to the webview) even when a newer request
     * arrives meanwhile, which then draws over it. A request replaced while
     * it still waited behind another never calls `getGraph`.
     *
     * A load nobody is waiting on (a run's overlay being redrawn) is not
     * aborted by a newer request, and does not abort one the reader waits
     * on; only its editor closing aborts it. Absent where nothing can cancel
     * the load (a test, an older host), so read it as
     * `options.signal?.aborted`.
     */
    signal?: AbortSignal;
    /**
     * What the reader chose of the file's view options, by group and item
     * (`view-options.ts`): an item not named is as the producer declares it.
     * For a group the producer applies itself (`reload`), which leaves
     * things out of the graph rather than hiding them in the view. Absent
     * when nothing was chosen.
     */
    viewOptions?: ViewOptionsState;
}

/** v2 seam: how a diagram gets its graph. Core ships NO implementation. */
export interface DiagramModelSource {
    getGraph(sourceUri: string, options: ModelSourceOptions): Promise<GraphDocument | undefined>;
    /** Optional: node identities for rename/nav; storage feature-detects. */
    getNodeIdentities?(sourceUri: string, options: ModelSourceOptions): Promise<GraphNodeIdentity[] | undefined>;
    /** Optional: a well-formed failure document when acquisition is impossible. */
    createFailureDocument?(sourceUri: string, message: string): GraphDocument;
    /** Optional: language-specific source-analysis capabilities (relationships, caller discovery,
     *  overlay identity/signature candidates, navigation). Storage feature-detects. */
    analysis?: GraphSourceAnalysis;
}

/**
 * Opaque handle to a server-side operation-handler module. The concrete type is diagram-server's
 * `DiagramOperationModule`; it is kept opaque here so `shared` stays browser-safe (it must not
 * import GLSP server types). Consumers narrow a handle back to the concrete contract with
 * diagram-server's `isDiagramOperationModule` type guard before calling `configure`.
 */
export type DiagramOperationModuleHandle = { readonly __diagramOperationModule: true };

/** v2 seam: consumer-supplied edit behavior; core ships only 'read-only'. */
export type EditStrategy = 'read-only' | { operationModules: DiagramOperationModuleHandle[] };

/** A concrete editor target a navigation request resolves to. */
export interface DiagramNavigationTarget {
    uri: string;
    range?: { startLine: number; startColumn: number; endLine: number; endColumn: number };
}

/** v2 seam: resolve a cross-file navigation request to a concrete editor target. */
export interface DiagramNavigationProvider {
    /** Resolve a cross-file navigation request (element/label + current source)
     *  to a concrete editor target. Undefined = fall through to default. */
    resolveTarget(request: Record<string, unknown>): Promise<DiagramNavigationTarget | undefined>;
}

/** Optional per-profile probe: can this source file open as a diagram?
 *  undefined = unknown (caller falls through to its default), boolean = definitive.
 *  The uri is structural (`{ toString(): string }`) so `shared` stays vscode-free;
 *  the toolkit implementation round-trips it via `Uri.parse(uri.toString())`. */
export type DiagramOpenabilityCheck = (
    uri: { toString(): string },
    context: { requestedName?: string }
) => Promise<boolean | undefined>;

/**
 * Host-side seam: the webview bundle a diagram profile serves. DATA ONLY
 * (SP2c bundle-boundary lesson): every field is a URI/path STRING — never a
 * code object (no ContainerModule, class, or closure). Paths are absolute fs
 * paths or file-URI strings; the editor provider converts them via
 * `asWebviewUri` and applies a per-file `?v=<mtime>` cache-bust. When a profile
 * omits `clientAssets`, the provider serves its stock `dist/webview/*` bundle
 * unchanged.
 */
/**
 * A palette entry a product contributes to the Entities category.
 *
 * Plain data on purpose. The platform's own entries are a fixed list it cannot
 * be extended from outside, and a platform that has to learn every product's
 * vocabulary to show its nodes is not neutral. A profile describes an entry;
 * the platform builds it.
 */
/**
 * A family of nodes the product recognises, and how it should look.
 *
 * The platform draws a node it is told about; it does not know the kinds a
 * product has. `task` and `network` are its own — every dataflow graph has
 * nodes and subgraphs — but a node that is an agent, a tool or a source is
 * that product's taxonomy, and colouring it would mean the platform learning
 * one vocabulary and rendering every other product's graph plain.
 *
 * The class the platform writes is derived from `annotation`, so it names none
 * of them: `external-actor-<annotation>`.
 */
export interface NodeFamilySpec {
    /** The definition annotation that puts a node in this family. */
    annotation: string;
    /**
     * Name used to build the family's CSS classes; defaults to `annotation`.
     *
     * Needed only when one annotation splits into several families, which
     * would otherwise derive the same class and be unable to look different.
     */
    id?: string;
    /**
     * Narrow the family to nodes whose annotation carries a particular value.
     *
     * Lets one annotation split into families that look different — a tool that
     * runs an interpreter against one that runs anything else — by declaring
     * the narrow entry before the general one, since the first match wins.
     */
    match?: {
        /** Argument of the annotation to read. */
        argument: string;
        /** Values that put the node in this family, compared case-insensitively. */
        oneOf: string[];
    };
    /** Accent colour for the node's header and its body icon. */
    color: string;
    /**
     * Watermark icon drawn in the node body, scaled from its own viewBox.
     * Omit for a family that should carry no icon.
     */
    icon?: {
        viewBox: number;
        paths: string[];
    };
    /**
     * The family's own full-colour mark, drawn in the node body where an icon
     * would be — the image a palette entry shows, one per theme (`dark` is the
     * base, `light` is optional).
     */
    image?: {
        dark: string;
        light?: string;
    };
}

export interface EntityPaletteItemSpec {
    /** The element type to create — one of the platform's node type ids. */
    elementTypeId: string;
    label: string;
    description: string;
    /** A codicon id, or one of the platform's own icon names. */
    icon?: string;
    /** Passed through to the create operation, e.g. to select a variant. */
    args?: Record<string, string | number | boolean>;
}

export interface DiagramClientAssets {
    /** Absolute fs path (or file-URI string) of the consumer's client script bundle. */
    scriptPath: string;
    /** Optional absolute fs path (or file-URI string) of the consumer's stylesheet. */
    stylePath?: string;
    /** Absolute fs paths (or file-URI strings) added to the webview's `localResourceRoots`,
     *  extending — never replacing — the stock roots so the consumer's assets are loadable. */
    localResourceRoots?: string[];
}

export type ExecutionNodeStatus = 'idle' | 'running' | 'succeeded' | 'failed';
export interface ExecutionNodeState {
    /** The node's id in the graph document the producer emitted (kept on
     *  the diagram's node as `wf:graphNodeId`), or the diagram's own id for
     *  it, which is its label. */
    nodeId: string;
    status: ExecutionNodeStatus;
    detail?: string;
}

/**
 * Neutral client action kind published from the execution-overlay seam into the
 * diagram webview. Run drivers emit through the {@link ExecutionOverlayRegistry};
 * a host bridge forwards the batch to the owning webview under this kind.
 */
export const EXECUTION_OVERLAY_ACTION_KIND = 'dialogram.executionOverlay';

/** Write side of the execution overlay, as consumed by run drivers.
 *  Contract: events are fire-and-forget; delivery to a webview that is not
 *  yet connected is DROPPED — consumers relying on completeness must replay
 *  history on connect (the SSE run stream does). */
export interface ExecutionOverlaySink {
    /**
     * The node states the diagram of `sourceUri` shows, replacing the ones it
     * showed: an empty list takes them all off. Unlike the events, the states
     * are kept and shown again on a diagram opened after they were published.
     * A node draws its state with the run overlay's classes (`running` the
     * turning ring, `succeeded` green, `failed` red, `idle` nothing), matched
     * by node id in whatever view the diagram shows.
     */
    publish(sourceUri: string, states: ExecutionNodeState[]): void;
    emitEvents(sourceUri: string, events: unknown[]): void;
}

export interface ExecutionOverlayActionPayload {
    kind: typeof EXECUTION_OVERLAY_ACTION_KIND;
    sourceUri: string;
    /** Present, the whole set of node states the diagram shows from now on. */
    states?: ExecutionNodeState[];
    /** Opaque consumer-defined stream events (e.g. agent token stream). */
    events?: unknown[];
}

/**
 * A link between two nodes that is drawn only while one of them is selected:
 * what a node uses, when there is too much of it to draw all at once (the
 * state an action reads, the ports it takes tokens from). A producer marks an
 * edge `meta.onSelection`; such an edge takes no part in the layout and is no
 * element of the model. `from` and `to` are the ids of the model's nodes.
 */
export interface SelectionLink {
    id: string;
    from: string;
    to: string;
    /** What kind of link, for the product's stylesheet: `selection-link-<role>`. */
    role?: string;
    /** A word or two drawn on the link. */
    label?: string;
    /** Both ways at once (read and written): an arrowhead at each end. */
    bidirectional?: boolean;
}

/**
 * A line of text in a node, under its header and ports: what a reader zooms
 * in for (a condition, what goes in and out). Each line is a band across the
 * node; the band is always drawn, the text only close in, so a kind of line
 * a product colours is seen from afar and read from near.
 */
export interface NodeLine {
    text: string;
    /** What kind of line, for the product's stylesheet: `node-line-<kind>`. */
    kind?: string;
}

/**
 * What the row of a member of a list shows: its name, then its lines (a
 * declaration's type and value, a function's parameters and kind), each in a
 * column the list's rows share, at the place the list gives that column, so
 * that a list reads as a table. All in one fixed-width font; the places are
 * from the row's left.
 */
export interface ListRow {
    /** Where the name starts. */
    nameX: number;
    cells: ListRowCell[];
}

/** One of a row's lines, in its column. */
export interface ListRowCell {
    text: string;
    x: number;
    /** What kind of line, for the product's stylesheet: `list-row-cell-<kind>`. */
    kind?: string;
}
