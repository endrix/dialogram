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

/** Neutral graph document couriered from a model source to the server's storage. */
export interface GraphDocument {
    version?: string;
    graph: unknown;
    partial?: boolean;
    errors?: Array<{ message?: string; file?: string; line?: number; column?: number }>;
    /** Normalized diagnostics; storage publishes these verbatim (no product-shaped walking). */
    diagnostics?: GraphDiagnostic[];
}

export interface ModelSourceOptions {
    /** The RequestModelAction options bag, passed through verbatim. */
    requestOptions: Record<string, unknown>;
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
    publish(sourceUri: string, states: ExecutionNodeState[]): void;
    emitEvents(sourceUri: string, events: unknown[]): void;
}

export interface ExecutionOverlayActionPayload {
    kind: typeof EXECUTION_OVERLAY_ACTION_KIND;
    sourceUri: string;
    states?: ExecutionNodeState[];
    /** Opaque consumer-defined stream events (e.g. agent token stream). */
    events?: unknown[];
}
