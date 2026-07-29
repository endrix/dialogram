/**
 * Workflow Source Model Storage
 *
 * Loads source models via the injected DiagramModelSource seam and transforms them to GModel.
 */

import 'reflect-metadata';

import {
    ActionDispatcher,
    GModelRoot,
    GNode,
    GEdge,
    ModelState,
    SourceModelStorage
} from '@eclipse-glsp/server';
import { RequestModelAction, SaveModelAction } from '@eclipse-glsp/protocol';
import { inject, injectable, optional } from 'inversify';
import { URI } from 'vscode-uri';
import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import {
    WorkflowDiagramMetadata,
    type WorkflowDiagramModel,
    WorkflowDiagramConstants,
    WORKFLOW_NETWORK_MODEL_KEY,
    WORKFLOW_LAYOUT_PERSISTENCE_KEY,
    type GraphDocument,
    type DiagramModelSource,
    type GraphDiagnostic,
    type GraphNodeIdentity,
    type WorkflowRelationshipInfo,
    type WorkflowCallerReference
} from '@dialogram/shared';
import { GraphGModelSource } from '../model/graph-gmodel-source';
import { WorkflowRequestAgentSkillsOperationHandler, type DiscoveredAgentSkill } from '../operations/request-agent-skills-handler';
import { WorkflowRequestClaudeAgentsOperationHandler, type DiscoveredClaudeAgentProfile } from '../operations/request-claude-agents-handler';
import { LayoutPersistenceService } from '../services/layout-persistence-service';
import { AgentStructuralEditSignal } from './agent-structural-edit-signal';
import { STORAGE_RUNTIME_OPTIONS, type StorageRuntimeOptions } from './storage-runtime-options';
import { convertToGModelRoot, cleanLegacyFanoutPoints } from './gmodel-convert';
import { PERF_ENABLED, perfNow, GraphLoadPerf, nextBuildCount } from './graph-load-perf';
import { getGraphDiagnosticsCollection } from './graph-diagnostics';
import {
    NAV_TRAIL_ARG,
    RUN_ID_ARG,
    RUNTIME_PROFILE_ARG,
    GRAPH_SOURCE_URI_ARG,
    ROOT_WORKFLOW_ARG,
    INSTANCE_PATH_ARG,
    parseNavigationTrailArg as sharedParseNavigationTrailArg,
    parseStringListArg,
    deriveTrailFallback as sharedDeriveTrailFallback
} from './graph-load-request-options';
import { DIAGRAM_MODEL_SOURCE } from './model-source-token';

/**
 * Exclude glob for the run-output *workspace* fallback scans (viewer run-log + live overlay). These
 * fallbacks only fire when the primary per-out-dir scan finds nothing (e.g. a CLI `--out-dir` run
 * wrote outside the resolved run-output dirs), and they run on the synchronous first-load critical
 * path. A bare `**` include with only `node_modules` pruned lets VS Code's file-search enumerate
 * build/output/VCS trees — hundreds of thousands of files in an LLVM-scale repo — which is exactly
 * the kind of synchronous workspace crawl the load path must never do. Prune the usual heavy roots
 * (build artifacts, VCS metadata) and all hidden dirs so the crawl is bounded regardless of
 * workspace size. Run-output dirs (`wf-out` and friends) are not hidden and are not named
 * `build`/`node_modules`, so a legitimate `--out-dir` target is still reachable.
 */
const RUN_OUTPUT_FALLBACK_EXCLUDE_GLOB =
    '{**/node_modules/**,**/build/**,**/dist/**,**/.git/**,**/.*/**}';

/** Result cap for the run-output workspace fallback scans (kept from the pre-hardening code). */
const RUN_OUTPUT_FALLBACK_MAX_RESULTS = 50;

/**
 * Source model storage for Workflow diagrams.
 * Acquires the graph via the injected DiagramModelSource seam and transforms it to GModel.
 */
@injectable()
export class WorkflowSourceModelStorage implements SourceModelStorage {

    private readonly agentSkillDiscoveryHelper = new WorkflowRequestAgentSkillsOperationHandler();
    private readonly claudeAgentDiscoveryHelper = new WorkflowRequestClaudeAgentsOperationHandler();
    private readonly workflowNodeIdentityCache = new Map<string, Promise<Set<string> | undefined>>();

    /** Problems-panel collection for graph diagnostics; created lazily inside a VS Code host. */
    private graphDiagnostics?: import('vscode').DiagnosticCollection;
    /** Files we published diagnostics to on the previous load, cleared before the next set. */
    private lastDiagnosedFiles: string[] = [];

    /**
     * Short-TTL cache for {@link getWorkflowCallerReferences}. That lookup walks every source
     * file under the workspace to find which workflows call the open one — expensive, and the
     * diagram reloads on a polling timer, so it was re-run several times a second for an answer
     * that virtually never changes between ticks. Cache it briefly: the polling refreshes reuse
     * one scan, and an edit to an *unrelated* file is reflected after at most TTL ms. Keyed by
     * `${resolvedFilePath}::${workflowName}`. Only feeds the `wf:parentWorkflows` breadcrumb —
     * never node/edge geometry — so staleness is cosmetic.
     */
    private readonly callerReferencesCache = new Map<string, { at: number; value: WorkflowCallerReference[] }>();
    private static readonly CALLER_REFERENCES_TTL_MS = 10_000;

    /**
     * In-flight de-duplication for {@link getWorkflowCallerReferences}. The caller-reference walk is
     * the one O(workspace) traversal on the load path (bounded per-walk by the source-analysis
     * directory ceiling, but still the heaviest overlay-adjacent I/O). It is scheduled off the
     * critical path as deferred discovery; when a diagram opens and the user immediately triggers a
     * refresh (e.g. toggling queue-trace visibility) BEFORE the first walk resolves, both loads see a
     * cold result cache and would each launch a full parallel walk. Keyed by the same
     * `${resolvedFilePath}::${workflowName}` as {@link callerReferencesCache}, this shares a single
     * in-flight walk across those overlapping builds; the entry is cleared as soon as the walk
     * settles so the TTL result cache takes over for subsequent loads.
     */
    private readonly callerReferencesInFlight = new Map<string, Promise<WorkflowCallerReference[]>>();

    /**
     * Parsed-entry cache for the append-only `run-log.jsonl` files under each run-output dir. A
     * single diagram load reads that log three times — the viewer overlay, the agent-context, and
     * the run-history scans each open it independently — and in a workspace with months of runs the
     * file grows to many MB, so re-reading and re-parsing it dominated the overlay phase (~700ms
     * cold). {@link readRunLogEntries} funnels all three readers through this cache, keyed by the
     * absolute log path and invalidated on any change to the file's size or mtime, so a cold load
     * reads+parses the log once and an unchanged repeat load skips the read entirely. The cached
     * entries are read-only to consumers (they only inspect fields), so the shared array is safe to
     * hand out without copying. Behavior is identical to the previous inline reads: the same valid
     * JSON-object entries in the same file order (invalid/blank lines are dropped, exactly as each
     * caller already did).
     */
    private readonly runLogEntryCache = new Map<string, { mtimeMs: number; size: number; entries: ReadonlyArray<Record<string, unknown>> }>();

    /**
     * Short-TTL memo for the run-output *workspace* fallback scans (see
     * {@link findRunOutputFallbackFiles}). The fallback only fires when the primary per-out-dir scan
     * misses, but when it does it must not re-crawl the workspace once per consumer or once per
     * polling reload: the diagram reloads on a timer, so an un-memoized crawl re-ran several times a
     * second. Keyed by the search glob; a single crawl is reused for TTL ms. Mirrors the
     * {@link callerReferencesCache} pattern — the only staleness is that a run-output dir created
     * mid-window is discovered after at most TTL ms, which is well within the reload cadence.
     */
    private readonly runOutputFallbackCache = new Map<string, { at: number; paths: string[] }>();
    private static readonly RUN_OUTPUT_FALLBACK_TTL_MS = 30_000;

    /**
     * Short-TTL cache for the deferred *agent-enrichment* bundle: the skill-status map (per configured
     * skill), the agent-skills picker snapshot, and the Claude-agents picker snapshot. All three scan
     * `.claude`/`.wf` skill & agent roots — directories BEYOND the run-output dirs — so on a cold
     * cache they inflate badly under host-boot contention (each of the many small readdir/readFile
     * awaits pays scheduling latency; live evidence: a restored tab during boot spent ~21s here). None
     * of the three feed first-paint geometry or the execution glow, so — mirroring the caller-reference
     * deferral — a cold load skips them and one background discovery warms this cache, then a single
     * refresh re-applies them synchronously. Keyed by the runtime root (`dirname(sourcePath)`, the base
     * every root derivation starts from). The skill-status map only holds the skills the open graph
     * referenced; {@link peekAgentEnrichment} treats a graph needing an uncached skill as a cold miss.
     */
    private readonly agentEnrichmentCache = new Map<string, {
        at: number;
        skills: DiscoveredAgentSkill[];
        agents: DiscoveredClaudeAgentProfile[];
        skillStatusByName: Map<string, string>;
    }>();
    private static readonly AGENT_ENRICHMENT_TTL_MS = 10_000;

    /**
     * In-flight de-duplication for deferred agent-enrichment discovery, keyed by runtime root. When a
     * diagram opens cold and an immediate refresh (or the caller-reference refresh reload) arrives
     * before the first discovery settles, both see a cold cache; this shares the single background
     * discovery instead of launching parallel directory crawls. Cleared when the discovery settles.
     */
    private readonly agentEnrichmentInFlight = new Map<string, Promise<void>>();

    @inject(ModelState)
    protected modelState!: ModelState;

    @inject(LayoutPersistenceService)
    protected layoutPersistence!: LayoutPersistenceService;

    /**
     * GLSP action dispatcher, used to deliver deferred caller-reference discovery through a single
     * background model refresh (see {@link scheduleDeferredCallerDiscovery}). `@optional()` because
     * unit tests construct this class directly (bypassing DI); when absent the deferral degrades to
     * a no-op refresh (the caller cache is still warmed for the next polling load).
     */
    @inject(ActionDispatcher)
    @optional()
    protected actionDispatcher?: ActionDispatcher;

    /**
     * Neutral runtime options (settings namespace + operation-prefix) supplied as plain data by
     * the consuming extension via `server-module.ts`. `@optional()` because tests may
     * construct this class directly (bypassing DI); reads degrade to empty strings when absent.
     */
    @inject(STORAGE_RUNTIME_OPTIONS)
    @optional()
    protected storageOptions?: StorageRuntimeOptions;

    /**
     * `DiagramModelSource` used to acquire graph documents and language-specific source analysis.
     * Injected the same way as `layoutPersistence` in the real DI container (see
     * `server-module.ts`), which always supplies it in production. `@optional()` because
     * tests that construct this class directly (bypassing DI) may not set one; when absent, every
     * consumer degrades gracefully (an inline "no model source configured" failure document for
     * acquisition, empty/undefined for the optional node-identity and analysis capabilities).
     * Storage depends ONLY on the neutral `DiagramModelSource` interface.
     */
    @inject(DIAGRAM_MODEL_SOURCE)
    @optional()
    protected injectedModelSource?: DiagramModelSource;

    /**
     * Per-session agent auto-layout signal. `@optional()` because it is bound only in the
     * MCP-enabled container (absent in the palette/webview flow and in unit tests). Every source
     * (re)load bumps its reload generation so a marked agent structural edit only becomes
     * consumable AFTER the reload that actually carries it — never on the premature post-operation
     * submit that runs on the not-yet-reloaded model. See {@link AgentStructuralEditSignal}.
     */
    @inject(AgentStructuralEditSignal)
    @optional()
    protected agentEditSignal?: AgentStructuralEditSignal;

    private ensureModelSource(): DiagramModelSource | undefined {
        return this.injectedModelSource;
    }

    /**
     * Inline failure document used when no `DiagramModelSource` is bound (never in production,
     * where the factory is always supplied). Mirrors the model source's graph-export failure shape
     * so the diagram degrades to a single labelled error node rather than crashing.
     */
    private buildNoModelSourceDocument(filePath: string): GraphDocument {
        const message = 'No model source configured for this diagram.';
        const fallbackGraphName = path.basename(filePath, path.extname(filePath)) || 'workflow';
        return {
            version: '1',
            partial: true,
            errors: [{ message, file: filePath }],
            graph: {
                id: `wf:${fallbackGraphName}`,
                nodes: [
                    {
                        id: '__graph_export_error__',
                        kind: 'task',
                        label: 'Graph export failed',
                        type: 'LoadError',
                        scope: '',
                        ports: [],
                        meta: { isErrored: true, errorMessage: message }
                    }
                ],
                edges: [],
                subgraphs: []
            }
        };
    }

    /**
     * Load the source model from a workflow document.
     * Only `.py` files are supported.
     */
    async loadSourceModel(action: RequestModelAction): Promise<void> {
        const sourceUri = this.getSourceUri(action);
        if (!sourceUri) {
            throw new Error('No sourceUri provided in RequestModelAction');
        }

        await this.loadSourceModelDocument(action, sourceUri);
    }

    private async loadSourceModelDocument(action: RequestModelAction, sourceUri: string): Promise<void> {
        const opts = action.options ?? {};
        const workflowFilePath = URI.parse(sourceUri).fsPath;
        const perf = new GraphLoadPerf(path.basename(workflowFilePath));
        // Acquisition (graph-acquisition strategy, model-source attempt + breadcrumb retry, CLI spawn,
        // plan-cache, static fallback) lives in the `DiagramModelSource` seam. This method
        // only runs the `finishLoadFromDoc` continuation (GModel conversion, layout persistence,
        // overlays, ModelState wiring).
        const modelSource = this.ensureModelSource();
        if (!modelSource) {
            console.warn('[WorkflowSourceModelStorage] No model source configured; rendering failure document.');
        }
        const doc = modelSource
            ? await modelSource.getGraph(sourceUri, { requestOptions: opts })
            : this.buildNoModelSourceDocument(workflowFilePath);
        perf.mark('acquire');
        if (!doc) {
            return;
        }
        // The model source pre-normalizes its diagnostics onto `doc.diagnostics` (walking its own
        // pre-transform payload). Storage publishes them verbatim -- no product-shaped walking here.
        void this.publishGraphDiagnostics(doc.diagnostics ?? [], workflowFilePath);
        // The model source may resolve different request options than the caller passed (the
        // breadcrumb-trail retry); `finishLoadFromDoc` needs those resolved options for layout/id.
        const resolvedOptions = (doc as { resolvedOptions?: Record<string, unknown> }).resolvedOptions ?? opts;
        await this.finishLoadFromDoc(doc, sourceUri, workflowFilePath, resolvedOptions, perf);
    }

    /**
     * Publish the model source's pre-normalized {@link GraphDiagnostic}s to the VS Code Problems
     * panel with jump-to-line. Clears stale entries from the previous load. No-op outside a VS Code
     * host (tests/headless). The vscode Diagnostic construction is intentionally identical to the
     * pre-decoupling code (an entry with no `uri` defaults to the workflow file; line/column are
     * 0-indexed; the range spans to the end of the line) so published diagnostics are byte-identical.
     */
    private async publishGraphDiagnostics(
        diagnostics: GraphDiagnostic[],
        workflowFilePath: string
    ): Promise<void> {
        let vscode: typeof import('vscode');
        try {
            vscode = await import('vscode');
        } catch {
            return;
        }
        // Outside a real VS Code host (unit tests / headless) the module may be a partial mock
        // without the `languages`/`Diagnostic` APIs — degrade to a no-op rather than throwing.
        if (!vscode?.languages?.createDiagnosticCollection || typeof vscode.Diagnostic !== 'function') {
            return;
        }
        this.graphDiagnostics = getGraphDiagnosticsCollection(vscode);
        const severityOf = (s: GraphDiagnostic['severity']): import('vscode').DiagnosticSeverity =>
            s === 'warning' ? vscode.DiagnosticSeverity.Warning
                : s === 'info' ? vscode.DiagnosticSeverity.Information
                    : vscode.DiagnosticSeverity.Error;
        const byFile = new Map<string, import('vscode').Diagnostic[]>();
        for (const diagnostic of diagnostics) {
            const targetFile = typeof diagnostic.uri === 'string' && diagnostic.uri.trim() !== ''
                ? diagnostic.uri
                : workflowFilePath;
            const ln = Math.max(0, (typeof diagnostic.startLine === 'number' && Number.isFinite(diagnostic.startLine) ? diagnostic.startLine : 1) - 1);
            const hasColumn = typeof diagnostic.startColumn === 'number' && Number.isFinite(diagnostic.startColumn) && diagnostic.startColumn > 1;
            const startCol = hasColumn ? Math.max(0, diagnostic.startColumn! - 1) : 0;
            // Span to the end of the line so the squiggle is visible (a zero-width range renders as
            // an invisible caret). VS Code clamps the end character to the actual line length.
            const endCol = Number.MAX_SAFE_INTEGER;
            const diag = new vscode.Diagnostic(new vscode.Range(ln, startCol, ln, endCol), diagnostic.message, severityOf(diagnostic.severity));
            diag.source = 'workflow';
            if (typeof diagnostic.code === 'string' && diagnostic.code.trim() !== '') {
                diag.code = diagnostic.code.trim();
            }
            const list = byFile.get(targetFile) ?? [];
            list.push(diag);
            byFile.set(targetFile, list);
        }

        for (const stale of this.lastDiagnosedFiles) {
            this.graphDiagnostics.delete(vscode.Uri.file(stale));
        }
        const fresh: string[] = [];
        for (const [file, diags] of byFile) {
            this.graphDiagnostics.set(vscode.Uri.file(file), diags);
            fresh.push(file);
        }
        this.lastDiagnosedFiles = fresh;
    }

    private async finishLoadFromDoc(
        doc: any,
        sourceUri: string,
        filePath: string,
        opts: Record<string, unknown>,
        perf?: GraphLoadPerf
    ): Promise<void> {
        const workflowRelationshipInfo = await this.getWorkflowRelationshipInfo(filePath);
        perf?.mark('relInfo');
        const localWorkflowNames = workflowRelationshipInfo.workflowNames;
        const requestedWorkflowName = typeof opts.networkName === 'string' && opts.networkName.trim() !== ''
            ? opts.networkName.trim()
            : undefined;
        const defaultWorkflowName = requestedWorkflowName
            ? undefined
            : this.ensureModelSource()?.analysis?.pickDefaultWorkflowName(filePath, localWorkflowNames);
        const selectedWorkflowName = requestedWorkflowName ?? defaultWorkflowName;

        const graphTransform = new GraphGModelSource();
        const diagramModel = graphTransform.transform(doc);
        perf?.mark('transform');
        const workflowName = selectedWorkflowName
            ?? String(doc?.graph?.id ?? '').replace(/^wf:/, '');
        (diagramModel as any).workflowName = workflowName;
        (diagramModel as any).documentUri = sourceUri;

        const workflowFilePath = filePath;
        // Qualify hierarchical network IDs so each instance-path gets its own layout
        // (e.g. "qwen35_model/decoder_block/decoder_layer"). Only a hierarchical runtime ever
        // supplies the root-workflow arg, so gating on its presence (rather than the settings
        // namespace) preserves behavior while keeping storage product-neutral.
        let networkId = workflowName || String(doc?.graph?.id ?? 'workflow').replace(/^wf:/, '');
        const hierarchicalRoot = typeof opts[ROOT_WORKFLOW_ARG] === 'string' && String(opts[ROOT_WORKFLOW_ARG]).trim() !== ''
            ? String(opts[ROOT_WORKFLOW_ARG]).trim()
            : undefined;
        if (hierarchicalRoot) {
            const hierarchicalInstancePath = parseStringListArg(opts[INSTANCE_PATH_ARG]);
            const parts = [hierarchicalRoot, ...hierarchicalInstancePath, networkId];
            networkId = parts.join('/');
        }
        const loadedLayoutPositions = await this.layoutPersistence.loadLayout(workflowFilePath, networkId);
        const edgeRoutes = await this.layoutPersistence.loadEdgeRoutes(workflowFilePath, networkId);
        const hasPersistedEdgeRoutes = edgeRoutes !== undefined;
        perf?.mark('layoutIO');

        if (loadedLayoutPositions) {
            const applyLayoutPositions = (element: any): void => {
                if (!element) {
                    return;
                }
                const type = element.type as string | undefined;
                if (typeof type === 'string' && type.startsWith('node:')) {
                    const args = element.args as Record<string, unknown> | undefined;
                    const key = (args?.[WorkflowDiagramMetadata.AST_PATH] ??
                        args?.[WorkflowDiagramMetadata.ENTITY_NAME] ??
                        args?.[WorkflowDiagramMetadata.PORT_NAME]) as unknown;
                    if (typeof key === 'string' && loadedLayoutPositions.has(key)) {
                        const pos = loadedLayoutPositions.get(key);
                        if (pos) {
                            element.position = { x: pos.x, y: pos.y };
                        }
                    }
                }
                const children = element.children as any[] | undefined;
                if (Array.isArray(children)) {
                    for (const child of children) {
                        applyLayoutPositions(child);
                    }
                }
            };
            applyLayoutPositions((diagramModel as any).graph);
        }

        // Count workflow nodes with no persisted position to enable partial layout for new nodes.
        let unpositionedNodeCount = 0;
        let totalNodeCount = 0;
        if (loadedLayoutPositions !== undefined) {
            const countMissing = (element: any): void => {
                if (!element) { return; }
                const type = element.type as string | undefined;
                if (typeof type === 'string' && type.startsWith('node:')) {
                    totalNodeCount++;
                    const args = element.args as Record<string, unknown> | undefined;
                    const key = (args?.[WorkflowDiagramMetadata.AST_PATH] ??
                        args?.[WorkflowDiagramMetadata.ENTITY_NAME] ??
                        args?.[WorkflowDiagramMetadata.PORT_NAME]) as unknown;
                    if (typeof key === 'string' && !loadedLayoutPositions.has(key)) {
                        unpositionedNodeCount++;
                    }
                }
                const children = element.children as any[] | undefined;
                if (Array.isArray(children)) {
                    for (const child of children) { countMissing(child); }
                }
            };
            countMissing((diagramModel as any).graph);
        }

        // If the loaded layout has zero matches to current model nodes,
        // it was created by a different runtime (a different language mode) and
        // should be treated as a fresh layout.
        const hasPersistedLayout = loadedLayoutPositions !== undefined && unpositionedNodeCount < totalNodeCount;
        const hasPersistedEdgeRoutesEffective = hasPersistedLayout && hasPersistedEdgeRoutes;

        this.modelState.set(WORKFLOW_LAYOUT_PERSISTENCE_KEY, {
            workflowFilePath,
            networkId,
            hasPersistedLayout,
            hasPersistedEdgeRoutes: hasPersistedEdgeRoutesEffective,
            didInitialLayout: false,
            hasClientBounds: false,
            allowInitialLayoutPersistence: true,
            unpositionedNodeCount,
        });

        // Advance the agent auto-layout reload generation: a marked agent structural edit becomes
        // consumable only on a submit that follows THIS reload (the one carrying the new node/edge),
        // never on the premature post-operation submit that runs on the pre-reload model.
        this.agentEditSignal?.noteSourceReloaded();

        this.modelState.set(WORKFLOW_NETWORK_MODEL_KEY, diagramModel as any);

        const gmodelRoot = convertToGModelRoot(diagramModel as any);
        perf?.mark('convert');
        const navigationTrail = this.parseNavigationTrailArg(opts[NAV_TRAIL_ARG]);
        const sourcePathHints = this.collectSourcePathHints(workflowFilePath, opts);
        const workflowNameHints = this.collectWorkflowNameHints(workflowName || 'workflow', opts);
        const requestedRunId = typeof opts[RUN_ID_ARG] === 'string' && String(opts[RUN_ID_ARG]).trim() !== ''
            ? String(opts[RUN_ID_ARG]).trim()
            : undefined;
        (gmodelRoot as any).args = (gmodelRoot as any).args || {};
        (gmodelRoot as any).args['wf:workflowName'] = workflowName || undefined;
        (gmodelRoot as any).args['wf:selectedWorkflow'] = workflowName || undefined;
        (gmodelRoot as any).args[RUNTIME_PROFILE_ARG] = this.storageOptions?.operationPrefix ?? '';
        (gmodelRoot as any).args['cal:networkName'] = workflowName || undefined;
        (gmodelRoot as any).args['sourceUri'] = sourceUri;
        (gmodelRoot as any).args['wf:workflowFile'] = workflowFilePath;
        if (workflowName) {
            try {
                const sourceText = await (await import('fs/promises')).readFile(workflowFilePath, 'utf-8');
                const workflowDefinitionRange = this.ensureModelSource()?.analysis?.resolveWorkflowDefinitionRange(sourceText, workflowName);
                if (workflowDefinitionRange) {
                    (gmodelRoot as any).args['wf:workflowSourceUri'] = workflowFilePath;
                    (gmodelRoot as any).args['wf:workflowSourceRange'] = workflowDefinitionRange;
                }
            } catch {
                // Keep the graph-provided metadata when the source file cannot be read.
            }
        }
        perf?.mark('wfRange');
        const availableWorkflows = [...localWorkflowNames];
        if (workflowName && !availableWorkflows.includes(workflowName)) {
            availableWorkflows.push(workflowName);
        }
        if (availableWorkflows.length > 0) {
            (gmodelRoot as any).args['wf:availableWorkflows'] = availableWorkflows;
        }
        const entryWorkflowNames = workflowRelationshipInfo.entryWorkflowNames.length > 0
            ? workflowRelationshipInfo.entryWorkflowNames
            : localWorkflowNames;
        if (entryWorkflowNames.length > 0) {
            (gmodelRoot as any).args['wf:rootWorkflows'] = entryWorkflowNames;
        }
        // Caller-reference discovery ("Used By" breadcrumb parents) walks every source file under
        // the scan roots — cheap once cached, but on a COLD cache in a large tree it dominated the
        // first render (~2s). So: on a warm cache, include the references synchronously (behavior is
        // byte-identical to the old always-synchronous path). On a cold cache, defer discovery off
        // this critical path and deliver the result through one background refresh (see
        // scheduleDeferredCallerDiscovery). The consumer (diagram-client navigation-ui "Used By"
        // FAB) simply hides itself when the arg is absent and reveals on the refresh, so delayed
        // arrival degrades gracefully — no node/edge geometry depends on it.
        const callersStartedAt = perfNow();
        // `deferCallerDiscovery` is resolved here (warm vs cold) but the background discovery is
        // *scheduled after* `updateRoot` below, so its completion-time `isModelStillCurrent` check
        // observes the freshly submitted root (the intervening overlay `await`s otherwise let the
        // background continuation run before the model is current).
        let deferCallerDiscovery = false;
        if (workflowName) {
            const callerCacheKey = `${path.resolve(workflowFilePath)}::${workflowName}`;
            const warmCallerReferences = this.peekCallerReferences(callerCacheKey);
            if (warmCallerReferences !== undefined) {
                if (warmCallerReferences.length > 0) {
                    (gmodelRoot as any).args['wf:parentWorkflows'] = warmCallerReferences;
                }
                perf?.setCallers(perfNow() - callersStartedAt);
            } else {
                deferCallerDiscovery = true;
                perf?.setCallers('deferred');
            }
        } else {
            perf?.setCallers(perfNow() - callersStartedAt);
        }
        perf?.mark('callerRefs');
        if (navigationTrail.length > 0) {
            (gmodelRoot as any).args[NAV_TRAIL_ARG] = JSON.stringify(navigationTrail);
        }

        if (hasPersistedLayout && edgeRoutes && edgeRoutes.size > 0) {
            this.applyPersistedEdgeRoutes(gmodelRoot, edgeRoutes);
        }

        await this.applyViewerOverlayToEdges(
            gmodelRoot,
            workflowFilePath,
            workflowName || 'workflow',
            navigationTrail,
            workflowNameHints,
            opts.queueTraceStep as number | undefined,
            opts.queueTraceVisible as boolean | undefined,
            sourcePathHints,
            requestedRunId
        );
        perf?.mark('ov:viewer');
        await this.applyAgentContextToNodes(
            gmodelRoot,
            workflowFilePath,
            workflowName || 'workflow',
            workflowNameHints,
            sourcePathHints,
            requestedRunId
        );
        perf?.mark('ov:agentCtx');
        await this.attachWorkflowRunHistory(
            gmodelRoot,
            workflowFilePath,
            workflowName || 'workflow',
            workflowNameHints,
            sourcePathHints,
            requestedRunId
        );
        perf?.mark('ov:history');
        // Agent enrichment (skill-status on nodes + skills/agents picker snapshots on the root) is
        // warm-applied here on a warm cache and deferred off the critical path on a cold cache. The
        // three `ov:skillStatus`/`ov:skills`/`ov:agents` marks are recorded inside so the breadcrumb
        // still lists each phase (near-0 warm, 0 when deferred). Like caller discovery, the cold-path
        // scheduling is done AFTER `updateRoot` so the background completion sees the current model.
        const enrichmentPlan = await this.applyAgentEnrichment(gmodelRoot, sourceUri, perf);

        this.modelState.updateRoot(gmodelRoot);
        perf?.mark('submit');
        // Now that the model is submitted and `modelState.root` is current, kick off the deferred
        // caller-reference walk (cold-cache case). Its completion delivers the "Used By" breadcrumb
        // via a single background refresh whose warm-cache reload includes it (see the method doc).
        if (deferCallerDiscovery && workflowName) {
            this.scheduleDeferredCallerDiscovery(sourceUri, workflowFilePath, workflowName, workflowRelationshipInfo, opts);
        }
        // Cold agent-enrichment cache: schedule one background discovery + refresh. The refresh's
        // warm-cache reload re-applies the enrichment synchronously and does NOT re-defer (loop guard
        // is the warm cache), so exactly one redelivery converges. Empty results warm the cache and
        // dispatch nothing (subsequent polling loads stay synchronous and silent).
        if (enrichmentPlan?.deferred) {
            this.scheduleDeferredAgentEnrichment(sourceUri, enrichmentPlan.runtimeRoot, enrichmentPlan.neededSkillNames, opts);
        }
        const nodeCount = Array.isArray(doc?.graph?.nodes) ? doc.graph.nodes.length : 0;
        const edgeCount = Array.isArray(doc?.graph?.edges) ? doc.graph.edges.length : 0;
        perf?.done({ nodes: nodeCount, edges: edgeCount });
        // Always-on breadcrumb: one line per model build. The `#N` build counter reveals whether a
        // single open triggers more than one build (a redundant rebuild would print `#2` right after
        // `#1` for the same file). Layout/reroute cost lands on the separate `layout` line.
        perf?.emitOpenBreadcrumb(nextBuildCount(workflowFilePath), { nodes: nodeCount, edges: edgeCount });
    }

    private async getWorkflowRelationshipInfo(filePath: string): Promise<WorkflowRelationshipInfo> {
        try {
            const sourceText = await fs.readFile(filePath, 'utf-8');
            return this.ensureModelSource()?.analysis?.analyzeWorkflowRelationships(sourceText)
                ?? { workflowNames: [], entryWorkflowNames: [], callersByWorkflow: {} };
        } catch {
            return {
                workflowNames: [],
                entryWorkflowNames: [],
                callersByWorkflow: {}
            };
        }
    }

    private async getWorkflowCallerReferences(
        filePath: string,
        workflowName: string,
        relationshipInfo: WorkflowRelationshipInfo
    ): Promise<WorkflowCallerReference[]> {
        const normalizedFilePath = path.resolve(filePath);
        const cacheKey = `${normalizedFilePath}::${workflowName}`;
        const cached = this.callerReferencesCache.get(cacheKey);
        if (cached && (perfNow() - cached.at) < WorkflowSourceModelStorage.CALLER_REFERENCES_TTL_MS) {
            return cached.value;
        }
        // Overlapping cold-cache builds (open + immediate refresh) share one walk rather than each
        // launching a full parallel traversal — see callerReferencesInFlight.
        const inFlight = this.callerReferencesInFlight.get(cacheKey);
        if (inFlight) {
            return inFlight;
        }
        const walk = this.computeWorkflowCallerReferences(normalizedFilePath, cacheKey, workflowName, relationshipInfo);
        this.callerReferencesInFlight.set(cacheKey, walk);
        try {
            return await walk;
        } finally {
            this.callerReferencesInFlight.delete(cacheKey);
        }
    }

    private async computeWorkflowCallerReferences(
        normalizedFilePath: string,
        cacheKey: string,
        workflowName: string,
        relationshipInfo: WorkflowRelationshipInfo
    ): Promise<WorkflowCallerReference[]> {
        const sameFileSourceUri = URI.file(normalizedFilePath).toString();
        const discovered: WorkflowCallerReference[] = [];
        const seen = new Set<string>();

        for (const callerName of relationshipInfo.callersByWorkflow[workflowName] ?? []) {
            const dedupeKey = `${sameFileSourceUri}::${callerName}`;
            if (seen.has(dedupeKey)) {
                continue;
            }
            seen.add(dedupeKey);
            discovered.push({ sourceUri: sameFileSourceUri, workflowName: callerName });
        }

        const scanRoots = await this.getWorkflowCallerScanRoots(normalizedFilePath);
        if (scanRoots.length === 0) {
            this.storeCallerReferences(cacheKey, discovered);
            return discovered;
        }
        const candidateFiles = (await this.ensureModelSource()?.analysis?.collectSourceFilesUnderRoots(scanRoots, normalizedFilePath)) ?? [];
        const crossFileCallers = (await this.ensureModelSource()?.analysis?.discoverCrossFileWorkflowCallers(normalizedFilePath, workflowName, candidateFiles)) ?? [];
        for (const caller of crossFileCallers) {
            const dedupeKey = `${caller.sourceUri}::${caller.workflowName}`;
            if (seen.has(dedupeKey)) {
                continue;
            }
            seen.add(dedupeKey);
            discovered.push(caller);
        }
        this.storeCallerReferences(cacheKey, discovered);
        return discovered;
    }

    /**
     * Non-computing peek at the caller-reference cache. Returns the cached value when it is still
     * within TTL (a "warm" cache), otherwise `undefined` (a "cold" cache — the caller should defer
     * discovery rather than block the first render). Mirrors the cache-hit read inside
     * {@link getWorkflowCallerReferences} so the warm path stays byte-identical.
     */
    private peekCallerReferences(cacheKey: string): WorkflowCallerReference[] | undefined {
        const cached = this.callerReferencesCache.get(cacheKey);
        if (cached && (perfNow() - cached.at) < WorkflowSourceModelStorage.CALLER_REFERENCES_TTL_MS) {
            return cached.value;
        }
        return undefined;
    }

    /**
     * Tracks the in-flight deferred discovery so tests can await it. Not used for correctness in
     * production (the work is fire-and-forget); the loop guard relies on the warm cache, not on this
     * handle.
     */
    private deferredCallerDiscovery?: Promise<void>;

    /**
     * Per-(file, workflow) re-entrancy guard for {@link scheduleDeferredCallerDiscovery}. The caller
     * walk is slow (it scans up to {@link MAX_SOURCE_FILES_PER_SCAN} files), so it is still cold when
     * the fast, agent-context-only redeliveries (agent enrichment, or a prior caller-refs refresh)
     * re-enter `loadSourceModel`. Each re-entry would otherwise schedule its own discovery and fire a
     * duplicate refresh. Holding the key while a discovery is pending collapses every re-entrant
     * schedule onto the first one, so exactly one redelivery ever fires per open.
     */
    private readonly pendingCallerRedelivery = new Set<string>();

    /**
     * Run caller-reference discovery off the first-load critical path (cold-cache case). On
     * completion — only if it found references AND the diagram still shows this file+workflow —
     * deliver them via a single background model refresh. That refresh re-runs `loadSourceModel`,
     * which now finds a warm cache and includes the references synchronously; the warm-cache branch
     * does NOT re-schedule discovery, so there is no refresh loop. Empty results surface nothing
     * (the cache is warmed empty, so subsequent polling loads stay synchronous and silent).
     */
    private scheduleDeferredCallerDiscovery(
        sourceUri: string,
        workflowFilePath: string,
        workflowName: string,
        relationshipInfo: WorkflowRelationshipInfo,
        opts: Record<string, unknown>
    ): void {
        // Re-entrancy guard: an agent-context-only redelivery re-enters `loadSourceModel` while this
        // walk is still cold and would schedule a second discovery + a duplicate refresh. Collapse
        // all re-entrant schedules onto the first pending one so exactly one redelivery fires.
        const redeliveryKey = `${path.resolve(workflowFilePath)}::${workflowName}`;
        if (this.pendingCallerRedelivery.has(redeliveryKey)) {
            return;
        }
        this.pendingCallerRedelivery.add(redeliveryKey);
        const run = async (): Promise<void> => {
            try {
                const references = await this.getWorkflowCallerReferences(workflowFilePath, workflowName, relationshipInfo);
                if (references.length === 0) {
                    return;
                }
                if (!this.isModelStillCurrent(sourceUri, workflowName)) {
                    return;
                }
                this.dispatchCallerReferenceRefresh(sourceUri, opts);
            } catch (err) {
                console.warn('[WorkflowSourceModelStorage] Deferred caller-reference discovery failed', err);
            } finally {
                this.pendingCallerRedelivery.delete(redeliveryKey);
            }
        };
        this.deferredCallerDiscovery = run();
        void this.deferredCallerDiscovery;
    }

    /**
     * True when the currently submitted model still corresponds to `sourceUri`+`workflowName`, so a
     * deferred caller-reference refresh would land on the right diagram (the user has not navigated
     * to a different workflow/file in the meantime).
     */
    private isModelStillCurrent(sourceUri: string, workflowName: string): boolean {
        try {
            const args = (this.modelState.root as any)?.args as Record<string, unknown> | undefined;
            if (!args) {
                return false;
            }
            const sameSource = args['sourceUri'] === sourceUri;
            const sameWorkflow = args['wf:selectedWorkflow'] === workflowName || args['wf:workflowName'] === workflowName;
            return sameSource && sameWorkflow;
        } catch {
            return false;
        }
    }

    /**
     * Dispatch one model refresh so the just-discovered caller references reach the client. Reuses
     * the existing `WorkflowRequestModelActionHandler` polling-refresh path (the `refresh-caller-refs-`
     * request-id prefix is matched there to suppress the loading notification). The re-load hits the
     * now-warm cache and includes the references synchronously. No-op when no dispatcher is bound
     * (headless/unit tests) — the cache is already warmed for the next polling load.
     */
    private dispatchCallerReferenceRefresh(sourceUri: string, opts: Record<string, unknown>): void {
        const dispatcher = this.actionDispatcher;
        if (!dispatcher) {
            return;
        }
        const refreshAction = RequestModelAction.create({
            requestId: `refresh-caller-refs-${Math.round(perfNow())}`,
            // Caller references only populate a root arg (`wf:parentWorkflows`, the "Used By"
            // breadcrumb) — no node/edge/position change — so this redelivery must run the
            // agent-context-only fast path: it re-applies the overlay off the warm plan cache and
            // skips the RequestBounds round-trip. The default full path re-submits the model mid-open,
            // which resets the model revision and invalidates the persisted-layout first render's
            // in-flight ComputedBounds — the diagram re-lays out and loses the stored layout (blank
            // spaces) until the user runs auto-layout. Without this flag the handler defaults
            // `agentContextOnly` to false and pays that full reload.
            options: { ...opts, sourceUri, agentContextOnly: true }
        });
        void Promise.resolve(dispatcher.dispatch(refreshAction)).catch(err => {
            console.warn('[WorkflowSourceModelStorage] Failed to dispatch caller-reference refresh', err);
        });
    }

    /** Record a caller-reference result with the current timestamp; bounds the cache size. */
    private storeCallerReferences(cacheKey: string, value: WorkflowCallerReference[]): void {
        this.callerReferencesCache.set(cacheKey, { at: perfNow(), value });
        // Bound memory: this map only ever holds one entry per (file, workflow) the user opens,
        // but evict the oldest if it somehow grows unbounded across a long session.
        while (this.callerReferencesCache.size > 64) {
            const oldest = this.callerReferencesCache.keys().next().value;
            if (oldest === undefined) {
                break;
            }
            this.callerReferencesCache.delete(oldest);
        }
    }

    private async getWorkflowCallerScanRoots(filePath: string): Promise<string[]> {
        const roots = new Set<string>();
        const packageRoot = await this.ensureModelSource()?.analysis?.findPackageRootForFile(filePath);
        if (packageRoot) {
            roots.add(packageRoot);
        }
        roots.add(path.dirname(filePath));
        try {
            const vscode = await import('vscode');
            const wsFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(filePath));
            const workspaceRoot = wsFolder?.uri?.fsPath;
            if (workspaceRoot) {
                roots.add(workspaceRoot);
            }
        } catch {
            // Ignore workspace resolution failures in tests or non-extension contexts.
        }
        return [...roots];
    }

    /**
     * Thin wrapper delegating to the shared `parseNavigationTrailArg` (see
     * `graph-load-request-options.ts`). Kept on the storage because existing tests call it
     * directly (see `cross-file-navigation-overlay.test.ts`), and because `finishLoadFromDoc`,
     * `collectSourcePathHints`, and `collectWorkflowNameHints` below still call it as `this.*`.
     */
    private parseNavigationTrailArg(raw: unknown): Array<{ sourceUri: string; workflowName: string; workflowInstanceName?: string }> {
        return sharedParseNavigationTrailArg(raw);
    }

    /**
     * Thin wrapper delegating to the shared `deriveTrailFallback` (see
     * `graph-load-request-options.ts`). Kept on the storage because existing tests call it
     * directly (see `cross-file-navigation-overlay.test.ts`).
     */
    private deriveTrailFallback(
        sourceUri: string,
        opts: Record<string, unknown>
    ): { graphSourceUri: string; rootWorkflowName: string; instancePath: string[] } | undefined {
        return sharedDeriveTrailFallback(sourceUri, opts);
    }

    private collectSourcePathHints(workflowFilePath: string, opts: Record<string, unknown>): string[] {
        const hints = new Set<string>();

        const addFilePath = (candidate: string | undefined): void => {
            if (!candidate || candidate.trim() === '') {
                return;
            }
            try {
                const parsed = URI.parse(candidate);
                if (parsed.scheme === 'file' && parsed.fsPath.trim() !== '') {
                    hints.add(parsed.fsPath);
                    return;
                }
            } catch {
                // Fall through to plain path handling.
            }
            hints.add(candidate);
        };

        addFilePath(workflowFilePath);
        addFilePath(typeof opts[GRAPH_SOURCE_URI_ARG] === 'string' ? String(opts[GRAPH_SOURCE_URI_ARG]) : undefined);
        for (const entry of this.parseNavigationTrailArg(opts[NAV_TRAIL_ARG])) {
            addFilePath(entry.sourceUri);
        }

        return [...hints];
    }

    private collectWorkflowNameHints(workflowName: string, opts: Record<string, unknown>): string[] {
        const hints = new Set<string>();

        const addWorkflowName = (candidate: string | undefined): void => {
            if (!candidate || candidate.trim() === '') {
                return;
            }
            hints.add(candidate.trim());
        };

        addWorkflowName(workflowName);
        for (const entry of this.parseNavigationTrailArg(opts[NAV_TRAIL_ARG])) {
            addWorkflowName(entry.workflowName);
        }

        return [...hints];
    }

    private async applyViewerOverlayToEdges(
        root: GModelRoot,
        workflowFilePath: string,
        workflowName: string,
        navigationTrail: Array<{ sourceUri: string; workflowName: string; workflowInstanceName?: string }>,
        workflowNameHints: string[],
        queueTraceStep?: number,
        queueTraceVisible?: boolean,
        sourcePathHints?: string[],
        preferredRunId?: string
    ): Promise<void> {
        const _perfT0 = PERF_ENABLED ? perfNow() : 0;
        try {
            const overlay = await this.tryLoadLatestViewerOverlay(workflowFilePath, workflowName, sourcePathHints, workflowNameHints, preferredRunId);
            const _perfTLoad = PERF_ENABLED ? perfNow() : 0;
            if (!overlay) {
                console.log(`[WorkflowSourceModelStorage] applyViewerOverlay: no overlay found for workflowFile=${workflowFilePath} workflow=${workflowName}`);
                // Clear any stale glow state left from a previous cycle.
                this.clearExecutionGlowState(root);
                return;
            }
            const activeNamesLog = overlay.active
                ? overlay.active.map(a => a?.entityInstanceName ?? 'none').join(',')
                : 'none';
            console.log(`[WorkflowSourceModelStorage] applyViewerOverlay: found overlay runId=${overlay.runId} active=${activeNamesLog} edges=${Object.keys(overlay.edges).length}`);

            const liveGlowEnabled = await this.isLiveExecutionGlowEnabled(workflowFilePath);

            // Stash a tiny bit of info on the root for debugging/inspection.
            (root as any).args = (root as any).args || {};
            (root as any).args['wf:viewerOverlayRunId'] = overlay.runId;
            (root as any).args['wf:viewerOverlayOutDir'] = overlay.outDir;

            const queueTrace = queueTraceVisible === false
                ? undefined
                : await this.tryLoadQueueTraceAtStep(overlay.outDir, queueTraceStep);
            if (queueTrace) {
                (root as any).args['wf:queueTraceStep'] = queueTrace.selectedStep;
                (root as any).args['wf:queueTraceStepCount'] = queueTrace.stepCount;
                if (queueTrace.actorInstanceName) {
                    (root as any).args['wf:queueTraceActor'] = queueTrace.actorInstanceName;
                }
            } else {
                delete (root as any).args['wf:queueTraceStep'];
                delete (root as any).args['wf:queueTraceStepCount'];
                delete (root as any).args['wf:queueTraceActor'];
            }

            const analysis = this.ensureModelSource()?.analysis;
            const signatureCandidatesForOverlay = (entry: { fromEntity?: string; outPort?: string; toEntity?: string; inPort?: string }): string[] => {
                return analysis?.buildOverlaySignatureCandidates(entry) ?? [];
            };

            const signatureCandidatesForEdge = (args: Record<string, unknown> | undefined): string[] => {
                if (!args) {
                    return [];
                }
                return analysis?.buildOverlaySignatureCandidates({
                    fromEntity: args['wf:from'],
                    outPort: args['wf:outPort'],
                    toEntity: args['wf:to'],
                    inPort: args['wf:inPort']
                }) ?? [];
            };

            const astPathCandidatesForEdge = (args: Record<string, unknown> | undefined): string[] => {
                return analysis?.buildOverlayAstPathCandidates(args) ?? [];
            };

            const overlayBySignature = new Map<string, unknown>();
            for (const entry of Object.values(overlay.edges)) {
                for (const signature of signatureCandidatesForOverlay(entry as any)) {
                    if (Object.prototype.hasOwnProperty.call(entry, 'lastToken')) {
                        overlayBySignature.set(signature, (entry as any).lastToken);
                    }
                }
            }

            const queueByAstPath = new Map<string, number>();
            const queueBySignature = new Map<string, number>();
            const queueTokenByAstPath = new Map<string, unknown>();
            const queueTokenBySignature = new Map<string, unknown>();
            if (queueTrace) {
                for (const q of queueTrace.queues) {
                    if (typeof q.astPath === 'string' && q.astPath.trim() !== '') {
                        queueByAstPath.set(q.astPath, q.size);
                        if (Object.prototype.hasOwnProperty.call(q, 'lastToken')) {
                            queueTokenByAstPath.set(q.astPath, (q as any).lastToken);
                        }
                        continue;
                    }
                    for (const signature of signatureCandidatesForOverlay(q as any)) {
                        queueBySignature.set(signature, q.size);
                        if (Object.prototype.hasOwnProperty.call(q, 'lastToken')) {
                            queueTokenBySignature.set(signature, (q as any).lastToken);
                        }
                    }
                }
            }

            const activeNames = overlay.active && Array.isArray(overlay.active)
                ? overlay.active
                    .map(entry => analysis?.resolveOverlayActiveEntityName(entry, workflowName, navigationTrail))
                    .filter((name): name is string => typeof name === 'string')
                : (() => {
                    const single = analysis?.resolveOverlayActiveEntityName(overlay.active, workflowName, navigationTrail);
                    return single ? [single] : [];
                })();
            const activeNameSet = new Set(activeNames);
            const matchedActiveNames = new Set<string>();

            // Decide which CSS class to apply for the active entity:
            // - Running + liveGlowEnabled → cal-node-active (animated green glow)
            // - Not running → no active glow (state clears when run terminates)
            // - liveGlowEnabled disabled + running → skip glow entirely
            const activeGlowClass = activeNames.length > 0
                ? (overlay.running
                    ? (liveGlowEnabled ? 'cal-node-active' : undefined)
                    : undefined)
                : undefined;
            const activeMetadataKey = activeGlowClass === 'cal-node-active'
                ? WorkflowDiagramMetadata.IS_EXECUTING
                : (activeGlowClass === 'cal-node-finished' ? WorkflowDiagramMetadata.IS_FINISHED : undefined);

            const errorEntityName = typeof overlay.error?.entityInstanceName === 'string'
                ? overlay.error.entityInstanceName.trim()
                : undefined;

            // ── Pre-pass: clear stale execution-glow state synchronously ─────
            // This MUST happen immediately before the visitor that re-applies
            // the glow. All async I/O (overlay read, queue trace read) is done
            // above so the clear ↔ reapply window is fully synchronous.
            this.clearExecutionGlowState(root);

            const visit = (element: any): void => {
                if (!element) {
                    return;
                }
                if (element instanceof GEdge) {
                    const args = element.args as Record<string, unknown> | undefined;
                    let queueSizeForEdge: number | undefined;
                    let queueTokenForEdge: unknown;
                    const astPathCandidates = astPathCandidatesForEdge(args);
                    for (const astPath of astPathCandidates) {
                        const entry = overlay.edges[astPath];
                        if (entry && Object.prototype.hasOwnProperty.call(entry, 'lastToken')) {
                            element.args = element.args || {};
                            (element.args as any)[WorkflowDiagramMetadata.VIEWER_LAST_TOKEN] = (entry as any).lastToken;
                            break;
                        }
                        const qSize = queueByAstPath.get(astPath);
                        if (queueSizeForEdge === undefined && typeof qSize === 'number') {
                            queueSizeForEdge = qSize;
                        }
                        if (queueTokenForEdge === undefined && queueTokenByAstPath.has(astPath)) {
                            queueTokenForEdge = queueTokenByAstPath.get(astPath);
                        }
                    }

                    const signature = signatureCandidatesForEdge(args)
                        .find(candidate => overlayBySignature.has(candidate));
                    if (signature) {
                        element.args = element.args || {};
                        (element.args as any)[WorkflowDiagramMetadata.VIEWER_LAST_TOKEN] = overlayBySignature.get(signature);
                    }
                    if (queueSizeForEdge === undefined && signature) {
                        const qSize = queueBySignature.get(signature);
                        if (typeof qSize === 'number') {
                            queueSizeForEdge = qSize;
                        }
                    }
                    if (queueTokenForEdge === undefined && signature && queueTokenBySignature.has(signature)) {
                        queueTokenForEdge = queueTokenBySignature.get(signature);
                    }
                    if (queueSizeForEdge !== undefined) {
                        element.args = element.args || {};
                        (element.args as any)[WorkflowDiagramMetadata.QUEUE_SIZE] = queueSizeForEdge;
                    }
                    if (queueTokenForEdge !== undefined) {
                        element.args = element.args || {};
                        (element.args as any)[WorkflowDiagramMetadata.VIEWER_LAST_TOKEN] = queueTokenForEdge;
                    }
                }
                if (element instanceof GNode) {
                    const args = element.args as Record<string, unknown> | undefined;
                    const nodeIdentityCandidates = analysis?.buildOverlayNodeIdentityCandidates(args) ?? [];
                    const matchesActive = activeNames.length > 0
                        && !!activeGlowClass
                        && !!activeMetadataKey
                        && nodeIdentityCandidates.some(candidate => activeNameSet.has(candidate));
                    const matchesError = !!errorEntityName
                        && nodeIdentityCandidates.includes(errorEntityName);

                    if (matchesActive && activeGlowClass && activeMetadataKey) {
                        element.args = element.args || {};
                        (element.args as any)[activeMetadataKey] = true;
                        const cssClasses = Array.isArray(element.cssClasses) ? element.cssClasses : [];
                        if (!cssClasses.includes(activeGlowClass)) {
                            element.cssClasses = [...cssClasses, activeGlowClass];
                        }
                        const matchedName = nodeIdentityCandidates.find(candidate => activeNameSet.has(candidate)) ?? '';
                        if (matchedName) {
                            matchedActiveNames.add(matchedName);
                        }
                        console.log(`[WorkflowSourceModelStorage] glow applied: active=${matchedName} candidates=${JSON.stringify(nodeIdentityCandidates)} class=${activeGlowClass} cssClasses=${JSON.stringify(element.cssClasses)}`);
                    }
                    if (matchesError && errorEntityName) {
                        element.args = element.args || {};
                        (element.args as any)[WorkflowDiagramMetadata.IS_ERRORED] = true;
                        const cssClasses = Array.isArray(element.cssClasses) ? element.cssClasses : [];
                        if (!cssClasses.includes('cal-node-error')) {
                            element.cssClasses = [...cssClasses, 'cal-node-error'];
                        }
                        console.log(`[WorkflowSourceModelStorage] error applied: error=${errorEntityName} candidates=${JSON.stringify(nodeIdentityCandidates)} cssClasses=${JSON.stringify(element.cssClasses)}`);
                    }
                }
                const children = element.children as any[] | undefined;
                if (Array.isArray(children)) {
                    for (const child of children) {
                        visit(child);
                    }
                }
            };
            const _perfTPrep = PERF_ENABLED ? perfNow() : 0;
            visit(root);
            if (PERF_ENABLED) {
                const _perfTVisit = perfNow();
                // eslint-disable-next-line no-console
                console.log(`[perf]   viewer: load=${Math.round(_perfTLoad - _perfT0)} prep=${Math.round(_perfTPrep - _perfTLoad)} visit=${Math.round(_perfTVisit - _perfTPrep)} (overlayEdges=${Object.keys(overlay.edges).length})`);
            }

            if (activeNames.length > 0 && activeGlowClass && activeMetadataKey) {
                for (const name of activeNames) {
                    if (matchedActiveNames.has(name)) {
                        continue;
                    }
                    const ancestorWorkflowNode = await this.findUniqueAncestorWorkflowNodeForActiveInstance(root, name);
                    if (ancestorWorkflowNode) {
                        ancestorWorkflowNode.args = ancestorWorkflowNode.args || {};
                        (ancestorWorkflowNode.args as any)[activeMetadataKey] = true;
                        const cssClasses = Array.isArray(ancestorWorkflowNode.cssClasses) ? ancestorWorkflowNode.cssClasses : [];
                        if (!cssClasses.includes(activeGlowClass)) {
                            ancestorWorkflowNode.cssClasses = [...cssClasses, activeGlowClass];
                        }
                        console.log(`[WorkflowSourceModelStorage] ancestor glow applied: active=${name} workflowNode=${ancestorWorkflowNode.id}`);
                    }
                }
            }
        } catch (err) {
            console.warn('[WorkflowSourceModelStorage] Failed to apply viewer overlay', err);
        }
    }

    private async findUniqueAncestorWorkflowNodeForActiveInstance(root: GModelRoot, activeName: string): Promise<GNode | undefined> {
        const networkNodes: GNode[] = [];

        const visit = (element: any): void => {
            if (element instanceof GNode) {
                const args = element.args as Record<string, unknown> | undefined;
                if (args?.[WorkflowDiagramMetadata.IS_NETWORK_INSTANCE] === true) {
                    networkNodes.push(element);
                }
            }
            const children = element?.children as any[] | undefined;
            if (Array.isArray(children)) {
                for (const child of children) {
                    visit(child);
                }
            }
        };
        visit(root);

        if (networkNodes.length === 0) {
            return undefined;
        }

        const matches = await Promise.all(networkNodes.map(async node => {
            const args = node.args as Record<string, unknown> | undefined;
            const referencedUri = typeof args?.[WorkflowDiagramMetadata.REFERENCED_URI] === 'string'
                ? String(args[WorkflowDiagramMetadata.REFERENCED_URI]).trim()
                : undefined;
            const workflowName = this.ensureModelSource()?.analysis?.normalizeWorkflowReferenceName(
                typeof args?.[WorkflowDiagramMetadata.REFERENCED_ENTITY_NAME] === 'string'
                    ? String(args[WorkflowDiagramMetadata.REFERENCED_ENTITY_NAME])
                    : typeof args?.[WorkflowDiagramMetadata.ENTITY_TYPE] === 'string'
                        ? String(args[WorkflowDiagramMetadata.ENTITY_TYPE])
                        : undefined
            );

            if (!referencedUri || !workflowName) {
                return undefined;
            }

            let filePath: string;
            try {
                filePath = URI.parse(referencedUri).fsPath;
            } catch {
                return undefined;
            }

            const identities = await this.getWorkflowNodeIdentities(filePath, workflowName);
            if (!identities?.has(activeName)) {
                return undefined;
            }
            return node;
        }));

        const resolved = matches.filter((node): node is GNode => !!node);
        return resolved.length === 1 ? resolved[0] : undefined;
    }

    private async getWorkflowNodeIdentities(filePath: string, workflowName: string): Promise<Set<string> | undefined> {
        const cacheKey = `${filePath}::${workflowName}`;
        const cached = this.workflowNodeIdentityCache.get(cacheKey);
        if (cached) {
            return cached;
        }

        const pending = (async (): Promise<Set<string> | undefined> => {
            // Node-identity acquisition lives behind the `DiagramModelSource` seam; storage flattens
            // the neutral `GraphNodeIdentity[]` into the instance/definition-name set callers need.
            const identities: GraphNodeIdentity[] | undefined = await this.ensureModelSource()?.getNodeIdentities?.(
                URI.file(filePath).toString(),
                { requestOptions: { networkName: workflowName } }
            );
            if (!identities) {
                return undefined;
            }
            const names = new Set<string>();
            for (const identity of identities) {
                if (typeof identity.instanceName === 'string' && identity.instanceName.trim() !== '') {
                    names.add(identity.instanceName.trim());
                }
                if (typeof identity.definitionName === 'string' && identity.definitionName.trim() !== '') {
                    names.add(identity.definitionName.trim());
                }
            }
            return names;
        })();

        this.workflowNodeIdentityCache.set(cacheKey, pending);
        return pending;
    }

    /**
     * Synchronously remove execution-glow state (`IS_EXECUTING` arg and
     * `cal-node-active` CSS class) from every GNode in the tree.
     *
     * Called from `applyViewerOverlayToEdges()` AFTER all async I/O so the
     * clear ↔ reapply window is synchronous and no other handler can observe
     * the model without the active-glow styling.
     */
    private clearExecutionGlowState(root: GModelRoot): void {
        const visit = (element: any): void => {
            if (element instanceof GNode) {
                const args = element.args as Record<string, unknown> | undefined;
                if (args) {
                    delete args[WorkflowDiagramMetadata.IS_EXECUTING];
                    delete args[WorkflowDiagramMetadata.IS_FINISHED];
                    delete args[WorkflowDiagramMetadata.IS_ERRORED];
                }
                if (Array.isArray(element.cssClasses)) {
                    element.cssClasses = element.cssClasses.filter(
                        (c: string) => c !== 'cal-node-active' && c !== 'cal-node-finished' && c !== 'cal-node-error'
                    );
                }
            }
            const children = element.children as any[] | undefined;
            if (Array.isArray(children)) {
                for (const child of children) {
                    visit(child);
                }
            }
        };
        visit(root);
    }

    /**
     * Remove all agent context metadata from GNodes so it can be cleanly re-applied
     * without leftover data from a previous cycle.
     *
     * Note: execution-glow state (`IS_EXECUTING`, `cal-node-active` CSS) is NOT cleared
     * here.  It is cleared synchronously inside `applyViewerOverlayToEdges()` right before
     * the new overlay is applied.  This avoids a race condition where a stale
     * `ComputedBoundsAction` arriving between the `await` gap (clear ↔ overlay read)
     * could submit the model without the active-glow CSS class, causing the glow to
     * flicker/disappear.
     */
    private clearAgentContextMetadata(root: GModelRoot): void {
        const agentKeys: string[] = [
            WorkflowDiagramMetadata.AGENT_CHAT_HISTORY,
            WorkflowDiagramMetadata.AGENT_FIRE_COUNT,
            WorkflowDiagramMetadata.AGENT_CONTEXT_BUDGET,
            WorkflowDiagramMetadata.AGENT_TRUNCATION_STRATEGY,
            WorkflowDiagramMetadata.AGENT_MODEL,
            WorkflowDiagramMetadata.AGENT_STATEFUL,
            WorkflowDiagramMetadata.AGENT_SKILL_STATUS,
        ];
        const visit = (element: any): void => {
            if (element instanceof GNode) {
                const args = element.args as Record<string, unknown> | undefined;
                if (args) {
                    for (const key of agentKeys) {
                        delete args[key];
                    }
                }
            }
            const children = element.children as any[] | undefined;
            if (Array.isArray(children)) {
                for (const child of children) {
                    visit(child);
                }
            }
        };
        visit(root);
    }

    /**
     * Tracks the in-flight deferred agent-enrichment discovery so tests can await it. Not used for
     * correctness in production (fire-and-forget); convergence relies on the warm cache, not this
     * handle. Mirrors {@link deferredCallerDiscovery}.
     */
    private deferredAgentEnrichment?: Promise<void>;

    /**
     * Warm-or-defer the three agent-enrichment overlays as one unit (skill status on nodes plus the
     * skills and Claude-agents picker snapshots on the root). All three scan `.claude`/`.wf` roots —
     * directories BEYOND the run-output dirs — and none of them feed first-paint geometry or the
     * execution glow, so mirror the caller-reference deferral:
     *  - WARM cache (all needed data present + within TTL): apply all three synchronously from the
     *    cached bundle. Byte-identical to the old always-synchronous path.
     *  - COLD cache: skip them for first paint (the client degrades gracefully — it recomputes skill
     *    status on demand and re-primes the picker caches through the on-demand request handlers) and
     *    return a plan so the caller can schedule one background discovery + refresh after updateRoot.
     * Records the `ov:skillStatus`/`ov:skills`/`ov:agents` marks and the `enrichment=` breadcrumb
     * outcome. Returns the cold plan, or `undefined` on the warm path (nothing to schedule).
     */
    private async applyAgentEnrichment(
        root: GModelRoot,
        sourceUri: string,
        perf?: GraphLoadPerf
    ): Promise<{ deferred: boolean; runtimeRoot: string; neededSkillNames: string[] } | undefined> {
        const runtimeRoot = path.dirname(URI.parse(sourceUri).fsPath);
        const neededSkillNames = this.collectAgentSkillNames(root);
        const startedAt = perfNow();
        const warm = this.peekAgentEnrichment(runtimeRoot, neededSkillNames);
        if (warm) {
            this.applyAgentSkillStatusFromCache(root, warm.skillStatusByName);
            perf?.mark('ov:skillStatus');
            this.applyAgentSkillsSnapshotToRoot(root, warm.skills);
            perf?.mark('ov:skills');
            this.applyClaudeAgentsSnapshotToRoot(root, warm.agents);
            perf?.mark('ov:agents');
            perf?.setEnrichment(perfNow() - startedAt);
            return undefined;
        }
        // Cold: leave the enrichment args unset for first paint. Record zero-cost marks so the
        // breadcrumb still lists the phases, and flag the outcome as deferred.
        perf?.mark('ov:skillStatus');
        perf?.mark('ov:skills');
        perf?.mark('ov:agents');
        perf?.setEnrichment('deferred');
        return { deferred: true, runtimeRoot, neededSkillNames };
    }

    /** Collect the distinct configured skill names referenced by agent nodes in the current graph. */
    private collectAgentSkillNames(root: GModelRoot): string[] {
        const names = new Set<string>();
        const visit = (element: any): void => {
            if (element instanceof GNode) {
                const args = element.args as Record<string, unknown> | undefined;
                const skillName = this.getSkillNameFromAgentSpec(args?.['wf:agentSpec'] as Record<string, unknown> | undefined);
                if (skillName) {
                    names.add(skillName);
                }
            }
            const children = element?.children as any[] | undefined;
            if (Array.isArray(children)) {
                for (const child of children) {
                    visit(child);
                }
            }
        };
        visit(root);
        return [...names];
    }

    /**
     * Non-computing peek at the agent-enrichment cache. Returns the cached bundle only when it is
     * within TTL AND every skill the current graph needs already has a computed status (a cold miss
     * otherwise, so a graph that references a not-yet-discovered skill re-defers rather than showing a
     * stale/absent status). Mirrors {@link peekCallerReferences}.
     */
    private peekAgentEnrichment(runtimeRoot: string, neededSkillNames: string[]): {
        skills: DiscoveredAgentSkill[];
        agents: DiscoveredClaudeAgentProfile[];
        skillStatusByName: Map<string, string>;
    } | undefined {
        const cached = this.agentEnrichmentCache.get(runtimeRoot);
        if (!cached || (perfNow() - cached.at) >= WorkflowSourceModelStorage.AGENT_ENRICHMENT_TTL_MS) {
            return undefined;
        }
        for (const name of neededSkillNames) {
            if (!cached.skillStatusByName.has(name)) {
                return undefined;
            }
        }
        return cached;
    }

    /**
     * Synchronous warm-apply of per-node skill status from the cached status map. Sets
     * `AGENT_SKILL_STATUS` on agent nodes with a configured skill and clears it on the rest —
     * byte-identical to the old {@link describeAgentSkillStatus}-driven walk (the map IS that walk's
     * per-skill result). The peek guarantees every needed skill is present in the map.
     */
    private applyAgentSkillStatusFromCache(root: GModelRoot, skillStatusByName: Map<string, string>): void {
        const visit = (element: any): void => {
            if (element instanceof GNode) {
                const args = element.args as Record<string, unknown> | undefined;
                if (args) {
                    const skillName = this.getSkillNameFromAgentSpec(args['wf:agentSpec'] as Record<string, unknown> | undefined);
                    if (!skillName) {
                        delete args[WorkflowDiagramMetadata.AGENT_SKILL_STATUS];
                    } else {
                        args[WorkflowDiagramMetadata.AGENT_SKILL_STATUS] = skillStatusByName.get(skillName);
                    }
                }
            }
            const children = element.children as any[] | undefined;
            if (Array.isArray(children)) {
                for (const child of children) {
                    visit(child);
                }
            }
        };
        visit(root);
    }

    private agentSkillRoots(runtimeRoot: string): string[] {
        return this.agentSkillDiscoveryHelper['skillRoots'](runtimeRoot, 'all');
    }

    private getSkillNameFromAgentSpec(spec: Record<string, unknown> | undefined): string {
        const raw = spec?.skill;
        if (typeof raw !== 'string') {
            return '';
        }
        return raw.trim();
    }

    private async describeAgentSkillStatus(skillName: string, roots: string[]): Promise<string> {
        const skill = skillName.trim();
        if (!skill) {
            return 'No skill selected.';
        }
        for (const root of roots) {
            const skillDir = path.join(root, skill);
            const skillMdPath = path.join(skillDir, 'SKILL.md');
            let hasSkillMd = false;
            try {
                hasSkillMd = (await fs.stat(skillMdPath)).isFile();
            } catch {
                hasSkillMd = false;
            }
            if (!hasSkillMd) {
                continue;
            }

            const warnings: string[] = [];
            let declared: { pre?: string; post?: string } | undefined;
            let description: string | undefined;
            try {
                const raw = await fs.readFile(skillMdPath, 'utf-8');
                declared = this.agentSkillDiscoveryHelper['parseDeclaredHooks'](raw);
                description = this.agentSkillDiscoveryHelper['extractSkillDescription'](raw);
            } catch (err) {
                warnings.push(`Failed to parse SKILL.md: ${String(err)}`);
            }

            const hooks = await this.agentSkillDiscoveryHelper['discoverHooks'](path.join(skillDir, 'scripts'));
            const missing: string[] = [];
            if (declared?.pre && !hooks.includes(declared.pre)) {
                missing.push(declared.pre);
            }
            if (declared?.post && !hooks.includes(declared.post)) {
                missing.push(declared.post);
            }

            const missingText = missing.length > 0 ? `missing scripts: ${missing.join(', ')}` : 'missing scripts: none';
            const warningText = warnings.length > 0 ? `warnings: ${warnings.join(' | ')}` : '';
            return [
                description && description.trim() !== '' ? description : `Skill '${skill}'`,
                warningText,
                missing.length > 0 ? missingText : '',
            ].filter(Boolean).join('; ');
        }

        return `Skill '${skill}' not discovered in configured roots.`;
    }

    /**
     * Synchronous warm-apply of the agent-skills picker snapshot onto the root args. Copies before
     * sorting so the cached array is never mutated. Byte-identical output to the old
     * `attachAgentSkillsSnapshot` (same sort, same `JSON.stringify`).
     */
    private applyAgentSkillsSnapshotToRoot(root: GModelRoot, skills: DiscoveredAgentSkill[]): void {
        const rootArgs = ((root as any).args ?? {}) as Record<string, unknown>;
        rootArgs['wf:agentSkillsSnapshot'] = JSON.stringify([...skills].sort((a, b) => a.name.localeCompare(b.name)));
        (root as any).args = rootArgs;
    }

    private async discoverAgentSkillsSnapshot(sourceUri: string): Promise<DiscoveredAgentSkill[]> {
        const sourcePath = URI.parse(sourceUri).fsPath;
        const runtimeRoot = path.dirname(sourcePath);
        const roots = this.agentSkillDiscoveryHelper['skillRoots'](runtimeRoot, 'all');
        const rows = await this.agentSkillDiscoveryHelper['discoverSkills'](roots);
        return rows as DiscoveredAgentSkill[];
    }

    /**
     * Synchronous warm-apply of the Claude-agents picker snapshot onto the root args. Copies before
     * sorting so the cached array is never mutated. Byte-identical output to the old
     * `attachClaudeAgentsSnapshot`.
     */
    private applyClaudeAgentsSnapshotToRoot(root: GModelRoot, agents: DiscoveredClaudeAgentProfile[]): void {
        const rootArgs = ((root as any).args ?? {}) as Record<string, unknown>;
        rootArgs['wf:claudeAgentsSnapshot'] = JSON.stringify([...agents].sort((a, b) => a.name.localeCompare(b.name)));
        (root as any).args = rootArgs;
    }

    private async discoverClaudeAgentsSnapshot(sourceUri: string): Promise<DiscoveredClaudeAgentProfile[]> {
        const sourcePath = URI.parse(sourceUri).fsPath;
        const runtimeRoot = path.dirname(sourcePath);
        const roots = this.claudeAgentDiscoveryHelper['agentRoots'](runtimeRoot);
        const rows = await this.claudeAgentDiscoveryHelper['discoverClaudeAgents'](roots);
        return rows as DiscoveredClaudeAgentProfile[];
    }

    /** Compute the skill-status string for each requested skill name (the deferred I/O). */
    private async discoverSkillStatuses(runtimeRoot: string, skillNames: string[]): Promise<Map<string, string>> {
        const roots = this.agentSkillRoots(runtimeRoot);
        const statuses = new Map<string, string>();
        for (const skillName of skillNames) {
            if (statuses.has(skillName)) {
                continue;
            }
            statuses.set(skillName, await this.describeAgentSkillStatus(skillName, roots));
        }
        return statuses;
    }

    /** Run all three enrichment discoveries (skills snapshot, agents snapshot, per-skill status). */
    private async computeAgentEnrichment(
        runtimeRoot: string,
        sourceUri: string,
        neededSkillNames: string[]
    ): Promise<{
        skills: DiscoveredAgentSkill[];
        agents: DiscoveredClaudeAgentProfile[];
        skillStatusByName: Map<string, string>;
    }> {
        const skills = await this.discoverAgentSkillsSnapshot(sourceUri);
        const agents = await this.discoverClaudeAgentsSnapshot(sourceUri);
        const skillStatusByName = await this.discoverSkillStatuses(runtimeRoot, neededSkillNames);
        return { skills, agents, skillStatusByName };
    }

    /** Record an agent-enrichment bundle with the current timestamp; bounds the cache size. */
    private storeAgentEnrichment(
        runtimeRoot: string,
        bundle: { skills: DiscoveredAgentSkill[]; agents: DiscoveredClaudeAgentProfile[]; skillStatusByName: Map<string, string> }
    ): void {
        this.agentEnrichmentCache.set(runtimeRoot, { at: perfNow(), ...bundle });
        while (this.agentEnrichmentCache.size > 64) {
            const oldest = this.agentEnrichmentCache.keys().next().value;
            if (oldest === undefined) {
                break;
            }
            this.agentEnrichmentCache.delete(oldest);
        }
    }

    /**
     * Run agent-enrichment discovery off the first-load critical path (cold-cache case), warm the
     * cache, and — only if it found something AND the diagram still shows this source — deliver it via
     * a single background model refresh. The refresh re-runs `loadSourceModel`, which now finds a warm
     * cache and applies the enrichment synchronously; the warm branch does NOT re-schedule discovery,
     * so there is no refresh loop. Empty results warm the cache and dispatch nothing. De-duplicated
     * per runtime root via {@link agentEnrichmentInFlight} so an overlapping refresh reload shares the
     * single discovery instead of launching a parallel directory crawl. Mirrors
     * {@link scheduleDeferredCallerDiscovery}.
     */
    private scheduleDeferredAgentEnrichment(
        sourceUri: string,
        runtimeRoot: string,
        neededSkillNames: string[],
        opts: Record<string, unknown>
    ): void {
        if (this.agentEnrichmentInFlight.has(runtimeRoot)) {
            return;
        }
        const run = async (): Promise<void> => {
            try {
                const bundle = await this.computeAgentEnrichment(runtimeRoot, sourceUri, neededSkillNames);
                this.storeAgentEnrichment(runtimeRoot, bundle);
                const hasData = bundle.skills.length > 0 || bundle.agents.length > 0 || bundle.skillStatusByName.size > 0;
                if (!hasData) {
                    return;
                }
                if (!this.isModelStillCurrentForSource(sourceUri)) {
                    return;
                }
                this.dispatchAgentEnrichmentRefresh(sourceUri, opts);
            } catch (err) {
                console.warn('[WorkflowSourceModelStorage] Deferred agent-enrichment discovery failed', err);
            } finally {
                this.agentEnrichmentInFlight.delete(runtimeRoot);
            }
        };
        const promise = run();
        this.agentEnrichmentInFlight.set(runtimeRoot, promise);
        this.deferredAgentEnrichment = promise;
    }

    /**
     * True when the currently submitted model still corresponds to `sourceUri`, so a deferred
     * agent-enrichment refresh would land on the right diagram. Enrichment is source-scoped (the
     * picker snapshots are workflow-independent; per-node skill status re-derives on the warm reload),
     * so — unlike caller references — only the source needs to match.
     */
    private isModelStillCurrentForSource(sourceUri: string): boolean {
        try {
            const args = (this.modelState.root as any)?.args as Record<string, unknown> | undefined;
            return !!args && args['sourceUri'] === sourceUri;
        } catch {
            return false;
        }
    }

    /**
     * Dispatch one model refresh so the just-discovered agent enrichment reaches the client. Reuses
     * the polling-refresh path (the `refresh-agent-enrichment-` request-id prefix is matched in
     * {@link WorkflowRequestModelActionHandler} to suppress the loading notification). No-op when no
     * dispatcher is bound (headless/unit tests) — the cache is already warmed for the next load.
     */
    private dispatchAgentEnrichmentRefresh(sourceUri: string, opts: Record<string, unknown>): void {
        const dispatcher = this.actionDispatcher;
        if (!dispatcher) {
            return;
        }
        const refreshAction = RequestModelAction.create({
            requestId: `refresh-agent-enrichment-${Math.round(perfNow())}`,
            // Agent enrichment only rewrites node/root args (skill status + skills/agents picker
            // snapshots) — no node/edge/position change — so this redelivery must run the
            // agent-context-only fast path: it re-applies the overlay off the warm plan cache and
            // skips the RequestBounds round-trip (and its full model re-submit / CLI re-acquire) that
            // the default full path would otherwise pay on every diagram open. Without this flag the
            // handler defaults `agentContextOnly` to false and reloads the whole model.
            options: { ...opts, sourceUri, agentContextOnly: true }
        });
        void Promise.resolve(dispatcher.dispatch(refreshAction)).catch(err => {
            console.warn('[WorkflowSourceModelStorage] Failed to dispatch agent-enrichment refresh', err);
        });
    }

    /**
     * Load the agent context overlay (live or final) and attach chat history
     * metadata to matching agent GNodes so the property panel can display them.
     */
    private async applyAgentContextToNodes(
        root: GModelRoot,
        workflowFilePath: string,
        workflowName: string,
        workflowNameHints: string[] = [],
        sourcePathHints: string[] = [],
        preferredRunId?: string
    ): Promise<void> {
        try {
            const agentCtx = await this.tryLoadAgentContext(workflowFilePath, workflowName, workflowNameHints, sourcePathHints, preferredRunId);
            if (!agentCtx || agentCtx.agents.length === 0) {
                return;
            }

            // Build lookups by both instance and entity names.
            // Instance name should be the primary key for runtime overlays.
            const byInstanceName = new Map<string, {
                fireCount: number;
                model?: string;
                stateful: boolean;
                contextBudget: number;
                truncationStrategy: string;
                chatHistory: Array<{ role: string; content: string }>;
            }>();
            const byEntityName = new Map<string, {
                fireCount: number;
                model?: string;
                stateful: boolean;
                contextBudget: number;
                truncationStrategy: string;
                chatHistory: Array<{ role: string; content: string }>;
            }>();
            for (const entry of agentCtx.agents) {
                if (entry.instanceName) {
                    byInstanceName.set(entry.instanceName, entry);
                }
                if (entry.entityName) {
                    byEntityName.set(entry.entityName, entry);
                }
            }

            // Walk the GModel tree and attach agent metadata to matching nodes.
            const visit = (element: any): void => {
                if (element instanceof GNode) {
                    const args = element.args as Record<string, unknown> | undefined;
                    const entityName = typeof args?.[WorkflowDiagramMetadata.ENTITY_NAME] === 'string'
                        ? String(args[WorkflowDiagramMetadata.ENTITY_NAME]).trim()
                        : undefined;
                    const instanceName = typeof args?.['wf:entityInstanceName'] === 'string'
                        ? String(args['wf:entityInstanceName']).trim()
                        : entityName;
                    const entityType = typeof args?.[WorkflowDiagramMetadata.ENTITY_TYPE] === 'string'
                        ? String(args[WorkflowDiagramMetadata.ENTITY_TYPE]).trim()
                        : undefined;

                    const entry =
                        (instanceName ? byInstanceName.get(instanceName) : undefined)
                        ?? (entityType ? byEntityName.get(entityType) : undefined)
                        ?? (entityName ? byEntityName.get(entityName) : undefined);

                    if (entry) {
                        element.args = element.args || {};
                        (element.args as any)[WorkflowDiagramMetadata.AGENT_CHAT_HISTORY] = JSON.stringify(entry.chatHistory);
                        (element.args as any)[WorkflowDiagramMetadata.AGENT_FIRE_COUNT] = entry.fireCount;
                        (element.args as any)[WorkflowDiagramMetadata.AGENT_CONTEXT_BUDGET] = entry.contextBudget;
                        (element.args as any)[WorkflowDiagramMetadata.AGENT_TRUNCATION_STRATEGY] = entry.truncationStrategy;
                        if (entry.model) {
                            (element.args as any)[WorkflowDiagramMetadata.AGENT_MODEL] = entry.model;
                        }
                        (element.args as any)[WorkflowDiagramMetadata.AGENT_STATEFUL] = entry.stateful;
                    }
                }
                const children = element.children as any[] | undefined;
                if (Array.isArray(children)) {
                    for (const child of children) {
                        visit(child);
                    }
                }
            };
            visit(root);
        } catch (err) {
            console.warn('[WorkflowSourceModelStorage] Failed to apply agent context', err);
        }
    }

    /**
     * Try to load the agent context overlay — preferring the live file during
     * execution, falling back to the persisted final file from the latest run.
     */
    private async tryLoadAgentContext(
        workflowFilePath: string,
        workflowName: string,
        workflowNameHints: string[] = [],
        sourcePathHints: string[] = [],
        preferredRunId?: string
    ): Promise<{
        agents: Array<{
            instanceName: string;
            entityName: string;
            fireCount: number;
            model?: string;
            stateful: boolean;
            contextBudget: number;
            truncationStrategy: string;
            chatHistory: Array<{ role: string; content: string }>;
        }>;
    } | undefined> {
        const fsModule = await import('fs/promises');
        const pathModule = await import('path');

        const wantSourcePaths = new Set(
            sourcePathHints.map(p => pathModule.resolve(p)).filter(p => p !== '')
        );
        const wantWorkflowNames = new Set(
            workflowNameHints.map(name => name.trim()).filter(name => name !== '')
        );
        if (wantSourcePaths.size === 0) {
            wantSourcePaths.add(pathModule.resolve(workflowFilePath));
        }
        if (wantWorkflowNames.size === 0) {
            wantWorkflowNames.add(workflowName);
        }

        const tryReadFile = async (filePath: string): Promise<{
            agents: Array<{
                instanceName: string;
                entityName: string;
                fireCount: number;
                model?: string;
                stateful: boolean;
                contextBudget: number;
                truncationStrategy: string;
                chatHistory: Array<{ role: string; content: string }>;
            }>;
        } | undefined> => {
            try {
                const raw = await fsModule.readFile(filePath, 'utf-8');
                const parsed = JSON.parse(raw);
                if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.agents)) {
                    console.log(`[WorkflowSourceModelStorage] agent context rejected: version=${parsed?.version} agents=${Array.isArray(parsed?.agents)} at ${filePath}`);
                    return undefined;
                }
                if (preferredRunId && parsed.runId !== preferredRunId) {
                    return undefined;
                }
                if (typeof parsed.workflowName !== 'string' || !wantWorkflowNames.has(parsed.workflowName.trim())) {
                    console.log(`[WorkflowSourceModelStorage] agent context rejected: wfName=${parsed.workflowName} (wantAny=${[...wantWorkflowNames].join(',')}) at ${filePath}`);
                    return undefined;
                }
                if (typeof parsed.sourcePath === 'string' && !wantSourcePaths.has(pathModule.resolve(parsed.sourcePath))) {
                    console.log(`[WorkflowSourceModelStorage] agent context rejected: srcPath=${parsed.sourcePath} not in wanted=[${[...wantSourcePaths].join(', ')}] at ${filePath}`);
                    return undefined;
                }
                return { agents: parsed.agents };
            } catch {
                return undefined;
            }
        };

        // 1. Try the live file (in baseOutDir).
        // Resolve baseOutDir the same way as the run command — relative to the source file directory.
        const vscode = await import('vscode');
        const baseOutDirs = await this.resolveRunOutputDirs(workflowFilePath, sourcePathHints, vscode);
        console.log(`[WorkflowSourceModelStorage] tryLoadAgentContext: baseOutDirs=${baseOutDirs.join(',')} workflow=${workflowName} hints=${[...wantWorkflowNames].join(',')}`);
        for (const baseOutDir of baseOutDirs) {
            // Try live file first.
            const livePath = pathModule.join(baseOutDir, 'run.wf-agent-context.live.json');
            const liveResult = await tryReadFile(livePath);
            console.log(`[WorkflowSourceModelStorage] agent-context live file: ${livePath} found=${!!liveResult} agents=${liveResult?.agents?.length ?? 0}`);
            if (liveResult) {
                return liveResult;
            }

            // Try the latest run's final agent context file.
            const logPath = pathModule.join(baseOutDir, 'run-log.jsonl');
            const logEntries = await this.readRunLogEntries(logPath);
            // Scan from latest to oldest.
            for (let i = logEntries.length - 1; i >= 0; i--) {
                const entry = logEntries[i] as any;
                if (preferredRunId && entry.runId !== preferredRunId) {
                    continue;
                }
                if (typeof entry.workflowName !== 'string' || !wantWorkflowNames.has(entry.workflowName.trim())) {
                    continue;
                }
                if (typeof entry.sourcePath === 'string' && !wantSourcePaths.has(pathModule.resolve(entry.sourcePath))) {
                    continue;
                }
                if (typeof entry.outDir === 'string') {
                    const finalResult = await tryReadFile(pathModule.join(entry.outDir, 'run.wf-agent-context.json'));
                    if (finalResult) {
                        return finalResult;
                    }
                }
            }
        }

        return undefined;
    }

    private async attachWorkflowRunHistory(
        root: GModelRoot,
        workflowFilePath: string,
        workflowName: string,
        workflowNameHints: string[] = [],
        sourcePathHints: string[] = [],
        preferredRunId?: string
    ): Promise<void> {
        const runs = await this.discoverWorkflowRunHistory(workflowFilePath, workflowName, workflowNameHints, sourcePathHints);
        const rootArgs = ((root as any).args ?? {}) as Record<string, unknown>;
        if (runs.length > 0) {
            rootArgs['wf:availableRuns'] = JSON.stringify(runs);
        } else {
            delete rootArgs['wf:availableRuns'];
        }
        const loadedRunId = typeof rootArgs['wf:viewerOverlayRunId'] === 'string'
            ? String(rootArgs['wf:viewerOverlayRunId']).trim()
            : undefined;
        const selectedRunId = preferredRunId || loadedRunId || runs[0]?.runId;
        if (selectedRunId) {
            rootArgs['wf:selectedRunId'] = selectedRunId;
        } else {
            delete rootArgs['wf:selectedRunId'];
        }
        (root as any).args = rootArgs;
    }

    private async discoverWorkflowRunHistory(
        workflowFilePath: string,
        workflowName: string,
        workflowNameHints: string[] = [],
        sourcePathHints: string[] = []
    ): Promise<Array<{ runId: string; label: string; running?: boolean }>> {
        const vscode = await import('vscode');
        const fs = await import('fs/promises');
        const path = await import('path');

        const wantSourcePaths = new Set(sourcePathHints.map(p => path.resolve(p)).filter(p => p !== ''));
        const wantWorkflowNames = new Set(workflowNameHints.map(name => name.trim()).filter(name => name !== ''));
        if (wantSourcePaths.size === 0) {
            wantSourcePaths.add(path.resolve(workflowFilePath));
        }
        if (wantWorkflowNames.size === 0) {
            wantWorkflowNames.add(workflowName);
        }

        const matchesSourcePath = (candidate: unknown): boolean => {
            if (typeof candidate !== 'string' || candidate.trim() === '') {
                return false;
            }
            return wantSourcePaths.has(path.resolve(candidate));
        };

        const matchesWorkflowName = (candidate: unknown): boolean => {
            return typeof candidate === 'string' && wantWorkflowNames.has(candidate.trim());
        };

        const formatLabel = (entry: { runId: string; running?: boolean; startedAt?: string; finishedAt?: string; errorMessage?: string }): string => {
            const status = entry.running ? 'Live' : entry.errorMessage ? 'Failed' : 'Done';
            const when = entry.running ? entry.startedAt : (entry.finishedAt ?? entry.startedAt);
            const timestamp = typeof when === 'string' ? when.replace('T', ' ').replace(/\.\d+Z$/, 'Z') : '';
            return [status, entry.runId, timestamp].filter(Boolean).join(' · ');
        };

        const seen = new Set<string>();
        const runs: Array<{ runId: string; label: string; running?: boolean }> = [];
        const addRun = (entry: { runId?: unknown; running?: boolean; startedAt?: unknown; finishedAt?: unknown; errorMessage?: unknown }): void => {
            if (typeof entry.runId !== 'string' || entry.runId.trim() === '' || seen.has(entry.runId)) {
                return;
            }
            seen.add(entry.runId);
            runs.push({
                runId: entry.runId,
                label: formatLabel({
                    runId: entry.runId,
                    running: entry.running === true,
                    startedAt: typeof entry.startedAt === 'string' ? entry.startedAt : undefined,
                    finishedAt: typeof entry.finishedAt === 'string' ? entry.finishedAt : undefined,
                    errorMessage: typeof entry.errorMessage === 'string' ? entry.errorMessage : undefined,
                }),
                ...(entry.running === true ? { running: true } : {})
            });
        };

        const baseOutDirs = await this.resolveRunOutputDirs(workflowFilePath, sourcePathHints, vscode);
        if (baseOutDirs.length === 0) {
            return runs;
        }

        for (const baseOutDir of baseOutDirs) {
            try {
                const liveOverlayPath = path.join(baseOutDir, 'run.wf-viewer.live.json');
                const parsed = JSON.parse(await fs.readFile(liveOverlayPath, 'utf-8'));
                if (parsed && parsed.version === 1 && parsed.running === true && matchesWorkflowName(parsed.workflowName) && matchesSourcePath(parsed.sourcePath)) {
                    addRun({ runId: parsed.runId, running: true, startedAt: parsed.startedAt });
                }
            } catch {
                // ignore
            }

            const historyEntries = await this.readRunLogEntries(path.join(baseOutDir, 'run-log.jsonl'));
            for (let i = historyEntries.length - 1; i >= 0; i--) {
                const entry = historyEntries[i] as any;
                if (!matchesWorkflowName(entry.workflowName) || !matchesSourcePath(entry.sourcePath)) {
                    continue;
                }
                addRun({
                    runId: entry.runId,
                    startedAt: entry.startedAt,
                    finishedAt: entry.finishedAt,
                    errorMessage: typeof entry?.error?.message === 'string' ? entry.error.message : undefined,
                });
            }
        }

        return runs;
    }

    private async tryLoadQueueTraceAtStep(
        outDir: string,
        requestedStep?: number
    ): Promise<{
        selectedStep: number;
        stepCount: number;
        actorInstanceName?: string;
        queues: Array<{
            astPath?: string;
            fromEntity?: string;
            outPort?: string;
            toEntity?: string;
            inPort?: string;
            size: number;
            lastToken?: unknown;
        }>;
    } | undefined> {
        const fs = await import('fs/promises');
        const path = await import('path');

        const queueTracePath = path.join(outDir, 'run.wf-queues.json');
        let text: string;
        try {
            text = await fs.readFile(queueTracePath, 'utf-8');
        } catch {
            return undefined;
        }

        let trace: any;
        try {
            trace = JSON.parse(text);
        } catch {
            return undefined;
        }

        if (!trace || typeof trace !== 'object' || trace.version !== 1 || !Array.isArray(trace.steps) || trace.steps.length === 0) {
            return undefined;
        }

        const stepCount = trace.steps.length;
        const normalizedRequested = typeof requestedStep === 'number' && Number.isFinite(requestedStep)
            ? Math.trunc(requestedStep)
            : (stepCount - 1);
        const selectedStep = Math.max(0, Math.min(stepCount - 1, normalizedRequested));
        const step = trace.steps[selectedStep];
        if (!step || typeof step !== 'object' || !Array.isArray(step.queueSizes)) {
            return undefined;
        }

        const queues = step.queueSizes
            .map((entry: any) => {
                const size = typeof entry?.size === 'number' && Number.isFinite(entry.size)
                    ? Math.max(0, Math.trunc(entry.size))
                    : undefined;
                if (size === undefined) {
                    return undefined;
                }
                const overlayAstPath = typeof entry?.overlayAstPath === 'string' && entry.overlayAstPath.trim() !== ''
                    ? entry.overlayAstPath
                    : undefined;
                const astPath = typeof entry?.astPath === 'string' ? entry.astPath : undefined;
                return {
                    astPath: overlayAstPath ?? astPath,
                    fromEntity: typeof entry?.fromEntity === 'string' ? entry.fromEntity : undefined,
                    outPort: typeof entry?.outPort === 'string' ? entry.outPort : undefined,
                    toEntity: typeof entry?.toEntity === 'string' ? entry.toEntity : undefined,
                    inPort: typeof entry?.inPort === 'string' ? entry.inPort : undefined,
                    size,
                    ...(Object.prototype.hasOwnProperty.call(entry ?? {}, 'lastToken') ? { lastToken: entry.lastToken } : {})
                };
            })
            .filter((v: any): v is {
                astPath?: string;
                fromEntity?: string;
                outPort?: string;
                toEntity?: string;
                inPort?: string;
                size: number;
                lastToken?: unknown;
            } => !!v);

        const actorInstanceName = typeof step.actorInstanceName === 'string' && step.actorInstanceName.trim() !== ''
            ? step.actorInstanceName
            : undefined;

        return {
            selectedStep,
            stepCount,
            actorInstanceName,
            queues
        };
    }

    private async tryLoadLatestViewerOverlay(
        workflowFilePath: string,
        workflowName: string,
        sourcePathHints: string[] = [workflowFilePath],
        workflowNameHints: string[] = [workflowName],
        preferredRunId?: string
    ): Promise<{
        runId: string;
        outDir: string;
        running: boolean;
        edges: Record<string, { lastToken?: unknown }>;
        active?: Array<{ entityInstanceName?: string; entityInstancePath?: string[] }>;
        error?: { entityInstanceName?: string; message?: string };
    } | undefined> {
        const vscode = await import('vscode');
        const fs = await import('fs/promises');
        const path = await import('path');
        const liveGlowEnabled = await this.isLiveExecutionGlowEnabled(workflowFilePath, vscode);

        const wantSourcePaths = new Set(
            sourcePathHints
                .map(p => path.resolve(p))
                .filter(p => p !== '')
        );
        const wantWorkflowNames = new Set(
            workflowNameHints
                .map(name => name.trim())
                .filter(name => name !== '')
        );
        if (wantSourcePaths.size === 0) {
            wantSourcePaths.add(path.resolve(workflowFilePath));
        }
        if (wantWorkflowNames.size === 0) {
            wantWorkflowNames.add(workflowName);
        }

        const matchesSourcePath = (candidate: unknown): boolean => {
            if (typeof candidate !== 'string' || candidate.trim() === '') {
                return false;
            }
            const resolved = path.resolve(candidate);
            return wantSourcePaths.has(resolved);
        };

        const matchesWorkflowName = (candidate: unknown): boolean => {
            return typeof candidate === 'string' && wantWorkflowNames.has(candidate.trim());
        };

        const readOverlayFromPath = async (
            overlayPath: string,
            requireRunning = false
        ): Promise<{
            runId: string;
            outDir: string;
            running: boolean;
            edges: Record<string, { lastToken?: unknown }>;
            active?: Array<{ entityInstanceName?: string; entityInstancePath?: string[] }>;
            error?: { entityInstanceName?: string; message?: string };
        } | undefined> => {
            let overlayText: string;
            try {
                overlayText = await fs.readFile(overlayPath, 'utf-8');
            } catch {
                return undefined;
            }

            let overlay: any;
            try {
                overlay = JSON.parse(overlayText);
            } catch {
                return undefined;
            }
            if (!overlay || typeof overlay !== 'object') {
                return undefined;
            }
            if (overlay.version !== 1) {
                return undefined;
            }
            if (typeof overlay.runId !== 'string' || typeof overlay.outDir !== 'string' || typeof overlay.edges !== 'object') {
                return undefined;
            }
            if (preferredRunId && overlay.runId !== preferredRunId) {
                return undefined;
            }
            if (requireRunning && overlay.running !== true) {
                console.log(`[WorkflowSourceModelStorage] viewer overlay rejected: running=${overlay.running} (required=true) at ${overlayPath}`);
                return undefined;
            }
            if (!matchesWorkflowName(overlay.workflowName) || !matchesSourcePath(overlay.sourcePath)) {
                console.log(`[WorkflowSourceModelStorage] viewer overlay rejected: wfName=${overlay.workflowName} (wantAny=${[...wantWorkflowNames].join(',')}) srcMatch=${matchesSourcePath(overlay.sourcePath)} src=${overlay.sourcePath} at ${overlayPath}`);
                return undefined;
            }

            const activeRaw = overlay.active;
            const activeEntries: Array<{ entityInstanceName?: string; entityInstancePath?: string[] }> = [];
            const normalizeEntry = (entry: any): void => {
                if (!entry || typeof entry !== 'object') {
                    return;
                }
                activeEntries.push({
                    entityInstanceName: typeof entry.entityInstanceName === 'string' ? entry.entityInstanceName : undefined,
                    entityInstancePath: Array.isArray(entry.entityInstancePath)
                        ? entry.entityInstancePath.filter((part: unknown): part is string => typeof part === 'string' && part.trim() !== '')
                        : undefined
                });
            };
            if (Array.isArray(activeRaw)) {
                for (const entry of activeRaw) {
                    normalizeEntry(entry);
                }
            } else {
                normalizeEntry(activeRaw);
            }
            const active = activeEntries.length > 0 ? activeEntries : undefined;

            const errorRaw = overlay.error;
            const error = errorRaw && typeof errorRaw === 'object'
                ? {
                    entityInstanceName: typeof errorRaw.entityInstanceName === 'string' ? errorRaw.entityInstanceName : undefined,
                    message: typeof errorRaw.message === 'string' ? errorRaw.message : undefined
                }
                : undefined;

            return {
                runId: overlay.runId,
                outDir: overlay.outDir,
                running: overlay.running === true,
                edges: overlay.edges as Record<string, { lastToken?: unknown }>,
                active,
                ...(error ? { error } : {})
            };
        };

        const readOverlay = async (entry: { workflowName?: string; sourcePath?: string; outDir?: string; runId?: string }): Promise<{
            runId: string;
            outDir: string;
            running: boolean;
            edges: Record<string, { lastToken?: unknown }>;
            active?: Array<{ entityInstanceName?: string; entityInstancePath?: string[] }>;
            error?: { entityInstanceName?: string; message?: string };
        } | undefined> => {
            if (preferredRunId && entry.runId !== preferredRunId) {
                return undefined;
            }
            if (!matchesWorkflowName(entry.workflowName)) {
                return undefined;
            }
            if (!matchesSourcePath(entry.sourcePath)) {
                return undefined;
            }
            if (typeof entry.outDir !== 'string' || typeof entry.runId !== 'string') {
                return undefined;
            }

            const overlayPath = path.join(entry.outDir, 'run.wf-viewer.json');
            return readOverlayFromPath(overlayPath);
        };

        const pickLatestEntry = (entries: any[]): any | undefined => {
            const byTime = (value: any): number => {
                const raw = value?.finishedAt ?? value?.startedAt;
                const ts = typeof raw === 'string' ? Date.parse(raw) : NaN;
                return Number.isFinite(ts) ? ts : 0;
            };
            return entries.sort((a, b) => byTime(b) - byTime(a))[0];
        };

        const baseOutDirs = await this.resolveRunOutputDirs(workflowFilePath, sourcePathHints, vscode);
        console.log(`[WorkflowSourceModelStorage] tryLoadLatestViewerOverlay: baseOutDirs=${baseOutDirs.join(',')} workflow=${workflowName} liveGlow=${liveGlowEnabled}`);
        for (const baseOutDir of baseOutDirs) {
            if (liveGlowEnabled) {
                const liveOverlayPath = path.join(baseOutDir, 'run.wf-viewer.live.json');
                const liveOverlay = await readOverlayFromPath(liveOverlayPath, true);
                console.log(`[WorkflowSourceModelStorage] viewer live overlay: ${liveOverlayPath} found=${!!liveOverlay}`);
                if (liveOverlay) {
                    return liveOverlay;
                }
            }
            const runLogPath = path.join(baseOutDir, 'run-log.jsonl');
            const entries = await this.readRunLogEntries(runLogPath);
            // Scan from the end (latest run wins).
            for (let i = entries.length - 1; i >= 0; i--) {
                const overlay = await readOverlay(entries[i] as any);
                if (overlay) {
                    return overlay;
                }
            }
        }

        // Fallback: scan the workspace for run-log.jsonl (useful when the CLI wrote to a `--out-dir`
        // outside the resolved run-output dirs). Exclude-hardened, capped and memoized so this never
        // becomes a synchronous full-workspace crawl on the load path (see findRunOutputFallbackFiles).
        try {
            const candidatePaths = await this.findRunOutputFallbackFiles('**/run-log.jsonl', vscode);
            const entries: any[] = [];
            for (const candidatePath of candidatePaths) {
                for (const entry of await this.readRunLogEntries(candidatePath)) {
                    const e = entry as any;
                    if (!matchesWorkflowName(e.workflowName) || !matchesSourcePath(e.sourcePath)) {
                        continue;
                    }
                    entries.push(e);
                }
            }

            const latest = pickLatestEntry(entries);
            if (latest) {
                const overlay = await readOverlay(latest);
                if (overlay) {
                    return overlay;
                }
            }
        } catch {
            // ignore
        }

        // Fallback: scan the workspace for live overlays (useful when the CLI wrote to a `--out-dir`).
        // Same exclude-hardened / capped / memoized crawl as the run-log fallback above.
        if (liveGlowEnabled) {
            try {
                const candidatePaths = await this.findRunOutputFallbackFiles('**/run.wf-viewer.live.json', vscode);
                const overlays: Array<{
                    runId: string;
                    outDir: string;
                    running: boolean;
                    edges: Record<string, { lastToken?: unknown }>;
                    active?: Array<{ entityInstanceName?: string; entityInstancePath?: string[] }>;
                    startedAt?: string;
                    finishedAt?: string;
                }> = [];
                for (const candidatePath of candidatePaths) {
                    const overlay = await readOverlayFromPath(candidatePath, true);
                    if (!overlay) {
                        continue;
                    }
                    overlays.push(overlay as any);
                }
                if (overlays.length > 0) {
                    const byTime = (value: any): number => {
                        const raw = value?.startedAt ?? value?.finishedAt;
                        const ts = typeof raw === 'string' ? Date.parse(raw) : NaN;
                        return Number.isFinite(ts) ? ts : 0;
                    };
                    overlays.sort((a, b) => byTime(b) - byTime(a));
                    return overlays[0];
                }
            } catch {
                // ignore
            }
        }

        return undefined;
    }

    private async isLiveExecutionGlowEnabled(
        workflowFilePath: string,
        vscodeModule?: typeof import('vscode')
    ): Promise<boolean> {
        const vscode = vscodeModule ?? await import('vscode');
        return vscode.workspace
            .getConfiguration(this.storageOptions?.settingsNamespace ?? '', vscode.Uri.file(workflowFilePath))
            .get<boolean>('liveExecutionGlow', true);
    }

    private async resolveRunOutputDir(workflowFilePath: string, vscode: typeof import('vscode')): Promise<string | undefined> {
        const config = vscode.workspace.getConfiguration(this.storageOptions?.settingsNamespace ?? '', vscode.Uri.file(workflowFilePath));
        const configured = (config.get('runOutputDir') as string | undefined) ?? 'wf-out';

        // Use dynamic import to avoid pulling in node builtins at module load time.
        const path = await import('path');

        if (path.isAbsolute(configured)) {
            return configured;
        }

        // Prefer resolving relative to the source file path (matches run command behavior).
        const fileDir = path.dirname(workflowFilePath);
        if (fileDir) {
            return path.join(fileDir, configured);
        }

        // Fallback: resolve relative to the workspace folder that contains the source file.
        const wsFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(workflowFilePath));
        const base = wsFolder?.uri?.fsPath;
        if (!base) {
            return undefined;
        }

        return path.join(base, configured);
    }

    private async resolveRunOutputDirs(
        workflowFilePath: string,
        sourcePathHints: string[],
        vscode: typeof import('vscode')
    ): Promise<string[]> {
        const path = await import('path');
        const candidateFiles = new Set<string>([path.resolve(workflowFilePath)]);
        for (const hint of sourcePathHints) {
            if (typeof hint === 'string' && hint.trim() !== '') {
                candidateFiles.add(path.resolve(hint));
            }
        }

        const outDirs = new Set<string>();
        for (const candidateFile of candidateFiles) {
            const outDir = await this.resolveRunOutputDir(candidateFile, vscode);
            if (typeof outDir === 'string' && outDir.trim() !== '') {
                outDirs.add(outDir);
            }
        }

        return [...outDirs];
    }

    /**
     * Read and parse a run-output `run-log.jsonl`, memoized per absolute path and invalidated on any
     * change to the file's `size`/`mtimeMs`. Returns the valid JSON-object entries in file order
     * (blank and unparseable lines dropped), matching what the viewer-overlay, agent-context and
     * run-history scans each used to compute inline. Missing/unreadable logs resolve to an empty
     * array. Callers must treat the returned array as read-only — it is shared across the three
     * consumers and across loads.
     */
    private async readRunLogEntries(runLogPath: string): Promise<ReadonlyArray<Record<string, unknown>>> {
        const fsModule = await import('fs/promises');
        let stat: import('fs').Stats;
        try {
            stat = await fsModule.stat(runLogPath);
        } catch {
            this.runLogEntryCache.delete(runLogPath);
            return [];
        }
        const cached = this.runLogEntryCache.get(runLogPath);
        if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
            return cached.entries;
        }
        let text: string;
        try {
            text = await fsModule.readFile(runLogPath, 'utf-8');
        } catch {
            this.runLogEntryCache.delete(runLogPath);
            return [];
        }
        const entries: Array<Record<string, unknown>> = [];
        for (const line of text.split(/\r?\n/)) {
            if (line.trim() === '') {
                continue;
            }
            let entry: unknown;
            try {
                entry = JSON.parse(line);
            } catch {
                continue;
            }
            if (entry && typeof entry === 'object') {
                entries.push(entry as Record<string, unknown>);
            }
        }
        this.runLogEntryCache.set(runLogPath, { mtimeMs: stat.mtimeMs, size: stat.size, entries });
        return entries;
    }

    /**
     * Run one of the run-output *workspace* fallback file searches, exclude-hardened, capped and
     * memoized per glob for a short TTL. Returns absolute `fsPath`s of the matches (empty on any
     * error). This is the single choke point through which every workspace-wide run-output scan
     * flows: it guarantees the search is bounded ({@link RUN_OUTPUT_FALLBACK_EXCLUDE_GLOB} prunes
     * build/output/VCS/hidden trees, {@link RUN_OUTPUT_FALLBACK_MAX_RESULTS} caps the result set)
     * and that it runs at most once per TTL window ({@link runOutputFallbackCache}) — so a burst of
     * polling reloads, or the viewer + live-overlay fallbacks within one load, share a single crawl
     * instead of re-enumerating the workspace each time.
     */
    private async findRunOutputFallbackFiles(glob: string, vscode: typeof import('vscode')): Promise<string[]> {
        const now = perfNow();
        const cached = this.runOutputFallbackCache.get(glob);
        if (cached && now - cached.at < WorkflowSourceModelStorage.RUN_OUTPUT_FALLBACK_TTL_MS) {
            return cached.paths;
        }
        let paths: string[] = [];
        try {
            const found = await vscode.workspace.findFiles(
                glob,
                RUN_OUTPUT_FALLBACK_EXCLUDE_GLOB,
                RUN_OUTPUT_FALLBACK_MAX_RESULTS
            );
            paths = (found ?? []).map(uri => uri.fsPath);
        } catch {
            paths = [];
        }
        this.runOutputFallbackCache.set(glob, { at: now, paths });
        return paths;
    }

    private pointDistance(a: { x: number; y: number }, b: { x: number; y: number }): number {
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        return Math.sqrt(dx * dx + dy * dy);
    }

    private absolutePosition(element: any): { x: number; y: number } {
        let x = 0;
        let y = 0;
        let cur: any = element;
        while (cur) {
            const p = cur.position as { x?: number; y?: number } | undefined;
            if (p) {
                x += p.x ?? 0;
                y += p.y ?? 0;
            }
            cur = cur.parent;
        }
        return { x, y };
    }

    private portAnchorAbsolute(root: GModelRoot, portId: string): { x: number; y: number } | undefined {
        const idx = (root as any).index as any;
        const port = idx?.get?.(portId) as any;
        if (!port) {
            return undefined;
        }
        let node: any = port;
        while (node && !(node instanceof GNode)) {
            node = node.parent;
        }
        if (!node) {
            return undefined;
        }

        const nodeAbs = this.absolutePosition(node);
        const portRel = (port.position as { x?: number; y?: number } | undefined) ?? { x: 0, y: 0 };
        const fallbackPortWidth = WorkflowDiagramConstants.PORT_WIDTH_PX;
        const fallbackPortHeight = WorkflowDiagramConstants.PORT_HEIGHT_PX;
        const w = (port.size?.width && port.size.width > 0) ? port.size.width : fallbackPortWidth;
        const h = (port.size?.height && port.size.height > 0) ? port.size.height : fallbackPortHeight;

        const direction = (port as any).args?.['cal:portDirection'] as string | undefined;
        const side = direction === 'output' ? 'EAST'
            : direction === 'input' ? 'WEST'
            : (port.type as string | undefined)?.includes('output') ? 'EAST'
            : (port.type as string | undefined)?.includes('input') ? 'WEST'
            : 'WEST';

        const absPortX = nodeAbs.x + (portRel.x ?? 0);
        const absPortY = nodeAbs.y + (portRel.y ?? 0);
        const cx = absPortX + w / 2;
        const cy = absPortY + h / 2;

        switch (side) {
            case 'WEST':
                return { x: absPortX, y: cy };
            case 'EAST':
                return { x: absPortX + w, y: cy };
            default:
                return { x: cx, y: cy };
        }
    }

    
    private edgeSignatureFromArgs(args: Record<string, unknown> | undefined): string | undefined {
        if (!args) {
            return undefined;
        }

        const normalizeEndpoint = (value: unknown): string => {
            if (typeof value === 'string' && value.trim() !== '') {
                return value.trim();
            }
            return 'boundary';
        };

        const fromEntity = normalizeEndpoint(args['wf:from']);
        const toEntity = normalizeEndpoint(args['wf:to']);
        const outPort = typeof args['wf:outPort'] === 'string' ? (args['wf:outPort'] as string) : undefined;
        const inPort = typeof args['wf:inPort'] === 'string' ? (args['wf:inPort'] as string) : undefined;

        if (!outPort || !inPort) {
            return undefined;
        }

        return `${fromEntity}|${outPort}|${toEntity}|${inPort}`;
    }

    private buildEdgeSignatureCounts(root: GModelRoot): Map<string, number> {
        const counts = new Map<string, number>();
        const visit = (element: any): void => {
            if (!element) {
                return;
            }
            if (element instanceof GEdge) {
                const signature = this.edgeSignatureFromArgs(element.args as Record<string, unknown> | undefined);
                if (signature) {
                    counts.set(signature, (counts.get(signature) ?? 0) + 1);
                }
            }
            const children = element.children as any[] | undefined;
            if (Array.isArray(children)) {
                for (const child of children) {
                    visit(child);
                }
            }
        };
        visit(root);
        return counts;
    }

    private edgeRouteKeyFor(
        args: Record<string, unknown> | undefined,
        signatureCounts: Map<string, number>
    ): string | undefined {
        const signature = this.edgeSignatureFromArgs(args);
        const astPath = args?.[WorkflowDiagramMetadata.AST_PATH];

        if (signature) {
            const count = signatureCounts.get(signature) ?? 0;
            if (count > 1) {
                if (typeof astPath === 'string' && astPath.trim() !== '') {
                    return `${signature}|${astPath}`;
                }
                return undefined;
            }
            return signature;
        }

        if (typeof astPath === 'string' && astPath.trim() !== '') {
            return astPath;
        }

        return undefined;
    }

    private normalizePersistedRouteToFullPolyline(root: GModelRoot, edge: GEdge, persisted: { x: number; y: number }[]): { x: number; y: number }[] {
        const src = typeof (edge as any).sourceId === 'string' ? this.portAnchorAbsolute(root, (edge as any).sourceId) : undefined;
        const tgt = typeof (edge as any).targetId === 'string' ? this.portAnchorAbsolute(root, (edge as any).targetId) : undefined;
        if (!src || !tgt) {
            return persisted;
        }

        if (persisted.length >= 2) {
            const snapped = persisted.map(p => ({ x: p.x, y: p.y }));
            snapped[0] = src;
            snapped[snapped.length - 1] = tgt;
            return snapped;
        }

        return [src, ...persisted, tgt];
    }

    private applyPersistedEdgeRoutes(root: GModelRoot, edgeRoutes: Map<string, { x: number; y: number }[]>): void {
        const signatureCounts = this.buildEdgeSignatureCounts(root);
        const visit = (element: any): void => {
            if (!element) {
                return;
            }
            if (element instanceof GEdge) {
                const args = element.args as Record<string, unknown> | undefined;
                const key = this.edgeRouteKeyFor(args, signatureCounts);
                if (!key) {
                    return;
                }
                const astPath = args?.[WorkflowDiagramMetadata.AST_PATH];
                const points = edgeRoutes.get(key)
                    ?? (typeof astPath === 'string' && astPath.trim() !== '' ? edgeRoutes.get(astPath) : undefined);
                if (points) {
                    const full = this.normalizePersistedRouteToFullPolyline(root, element, points);
                    const cleaned = cleanLegacyFanoutPoints(full);
                    (element as any).routingPoints = cleaned.length >= 2 ? cleaned : undefined;
                }
            }
            const children = element.children as any[] | undefined;
            if (Array.isArray(children)) {
                for (const child of children) {
                    visit(child);
                }
            }
        };
        visit(root);
    }

    /**
     * Save the source model back to the Workflow document.
     * This updates the AST and triggers document save.
     */
    async saveSourceModel(action: SaveModelAction): Promise<void> {
        const sourceUri = this.modelState.sourceUri ?? this.getSourceUri(action as any);
        if (!sourceUri) {
            return;
        }

        try {
            const vscode = await import('vscode');
            const textDoc = await vscode.workspace.openTextDocument(vscode.Uri.parse(sourceUri));
            await textDoc.save();
        } catch (err) {
            console.warn('[WorkflowSourceModelStorage] Failed to save document for SaveModelAction', err);
        }
    }

    /**
     * Extract sourceUri from RequestModelAction
     */
    private getSourceUri(action: RequestModelAction): string | undefined {
        return action.options?.sourceUri as string | undefined;
    }

}

