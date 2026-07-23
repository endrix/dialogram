/**
 * Workflow Diagram Action Handlers
 *
 * Model submission, request-model, computed-bounds, and layout-operation handlers
 * for Workflow network diagrams.
 */

import 'reflect-metadata';

import {
    ActionHandler,
    CommandStack,
    DiagramConfiguration,
    GEdge,
    GLabel,
    GModelIndex,
    GModelRecordingCommand,
    GModelRoot,
    GModelSerializer,
    GNode,
    GPort,
    LayoutEngine,
    ModelState,
    ModelSubmissionHandler,
    ModelValidator,
    OperationHandler,
    RequestModelActionHandler,
    ServerLayoutKind,
    applyAlignment,
    applyElementAndBounds
} from '@eclipse-glsp/server';
import {
    Action,
    ComputedBoundsAction,
    DirtyStateChangeReason,
    LayoutOperation,
    RequestBoundsAction,
    RequestModelAction,
    SetDirtyStateAction,
    SetModelAction,
    UpdateModelAction
} from '@eclipse-glsp/protocol';
import { inject, injectable, optional } from 'inversify';
import { URI } from 'vscode-uri';
import {
    WorkflowDiagramMetadata,
    type WorkflowDiagramModel,
    WorkflowDiagramConstants,
    WorkflowDiagramTypes,
    WORKFLOW_NETWORK_MODEL_KEY,
    WORKFLOW_LAYOUT_PERSISTENCE_KEY
} from '@dialogram/shared';
import { LayoutPersistenceService } from '../services/layout-persistence-service';
import {
    WorkflowRerouteEdgesAvoidOverlapsOperationHandler,
    WORKFLOW_REROUTE_EDGES_AVOID_OVERLAPS_OPERATION_KIND
} from '../operations/reroute-edges-avoid-overlaps-handler';
import { clearAllEdgeRoutingPoints } from '../routing/clear-edge-routes';
import { perfNow } from './graph-load-perf';

/**
 * Custom ModelSubmissionHandler - minimal logging version.
 */
@injectable()
export class WorkflowModelSubmissionHandler extends ModelSubmissionHandler {

    @inject(LayoutPersistenceService)
    protected layoutPersistence!: LayoutPersistenceService;

    @inject(WorkflowRerouteEdgesAvoidOverlapsOperationHandler)
    protected rerouteHandler!: WorkflowRerouteEdgesAvoidOverlapsOperationHandler;
    
    override async submitModelDirectly(reason?: DirtyStateChangeReason): Promise<Action[]> {
        const layoutEngine = (this as any).layoutEngine as LayoutEngine | undefined;
        const diagramConfiguration = (this as any).diagramConfiguration as DiagramConfiguration;
        const modelState = (this as any).modelState as ModelState;

        // 1) Optional automatic layout on first open when no persisted layout exists.
        // We do this even though layoutKind is MANUAL, but only once per session
        // and we persist the result immediately so further edits won't trigger layout.
        const layoutMeta = modelState.get(WORKFLOW_LAYOUT_PERSISTENCE_KEY) as
            | {
                  workflowFilePath: string;
                  networkId: string;
                  hasPersistedLayout: boolean;
                                    hasPersistedEdgeRoutes: boolean;
                  didInitialLayout: boolean;
                                    hasClientBounds: boolean;
                  allowInitialLayoutPersistence: boolean;
                  unpositionedNodeCount?: number;
              }
            | undefined;

        if (
            layoutEngine &&
            diagramConfiguration.layoutKind === ServerLayoutKind.MANUAL &&
            layoutMeta &&
            !layoutMeta.hasPersistedLayout &&
            !layoutMeta.didInitialLayout &&
            layoutMeta.hasClientBounds &&
            layoutMeta.allowInitialLayoutPersistence
        ) {
            // Mark first to avoid re-entrancy (submitModelDirectly can be called multiple times).
            layoutMeta.didInitialLayout = true;
            modelState.set(WORKFLOW_LAYOUT_PERSISTENCE_KEY, layoutMeta);

            console.log('[WorkflowModelSubmissionHandler] Running initial ELK layout for:', layoutMeta.networkId);
            try {
                const _elk0 = perfNow();
                await layoutEngine.layout();
                // Always-on breadcrumb: initial ELK layout is the dominant post-load server cost on a
                // fresh open, and it runs here (in the client-bounds round-trip), not in the load path.
                // eslint-disable-next-line no-console
                console.log(`[dialogram perf] layout ${layoutMeta.networkId}: elk=${Math.round(perfNow() - _elk0)}ms`);
                const positions = this.collectNodePositions(modelState.root);
                const routes = this.collectEdgeRoutes(modelState.root);
                await this.layoutPersistence.saveLayoutImmediate(layoutMeta.workflowFilePath, layoutMeta.networkId, positions, routes);
                // From now on, treat it as persisted.
                layoutMeta.hasPersistedLayout = true;
                layoutMeta.hasPersistedEdgeRoutes = routes.size > 0;
                modelState.set(WORKFLOW_LAYOUT_PERSISTENCE_KEY, layoutMeta);
            } catch (error) {
                console.error('[WorkflowModelSubmissionHandler] Initial layout failed:', error);
            }
        } else {
        }

        // 1c) Partial layout for newly added nodes when a layout file already exists.
        // Places new/unpositioned nodes below the existing graph without disturbing
        // the positions of already-placed nodes.
        if (
            layoutMeta &&
            layoutMeta.hasPersistedLayout &&
            !layoutMeta.didInitialLayout &&
            layoutMeta.hasClientBounds &&
            layoutMeta.allowInitialLayoutPersistence &&
            (layoutMeta.unpositionedNodeCount ?? 0) > 0
        ) {
            layoutMeta.didInitialLayout = true;
            modelState.set(WORKFLOW_LAYOUT_PERSISTENCE_KEY, layoutMeta);
            console.log(`[WorkflowModelSubmissionHandler] Placing ${layoutMeta.unpositionedNodeCount} newly added node(s)...`);
            try {
                await this.placeNewNodes(layoutMeta.workflowFilePath, layoutMeta.networkId, modelState.root);
                console.log('[WorkflowModelSubmissionHandler] New node placement completed');
            } catch (error) {
                console.error('[WorkflowModelSubmissionHandler] New node placement failed:', error);
            }
        }

        // 1b) Bootstrap canonical edge reroute when we have persisted node layout
        // but no persisted edge routes for the current model. With hierarchical
        // layout keys, routes from a different language mode are no longer loaded, so
        // hasPersistedEdgeRoutes is only true for routes saved by the user in this mode.
        const didBootstrapReroute = modelState.get('workflow.didBootstrapReroute') === true;
        if (
            layoutMeta &&
            layoutMeta.hasPersistedLayout &&
            !layoutMeta.hasPersistedEdgeRoutes &&
            layoutMeta.hasClientBounds &&
            !didBootstrapReroute
        ) {
            console.log('[WorkflowModelSubmissionHandler] Running bootstrap edge reroute for:', layoutMeta.networkId);
            try {
                const _reroute0 = perfNow();
                await this.rerouteHandler.runReroute({
                    kind: WORKFLOW_REROUTE_EDGES_AVOID_OVERLAPS_OPERATION_KIND,
                    isOperation: true,
                    source: 'changeBounds',
                });
                // Always-on breadcrumb: bootstrap edge reroute is the other post-load layout cost.
                // eslint-disable-next-line no-console
                console.log(`[dialogram perf] layout ${layoutMeta.networkId}: reroute=${Math.round(perfNow() - _reroute0)}ms`);
                modelState.set('workflow.didBootstrapReroute', true);
                console.log('[WorkflowModelSubmissionHandler] Bootstrap edge reroute completed');
            } catch (error) {
                console.warn('[WorkflowModelSubmissionHandler] Bootstrap edge reroute failed:', error);
            }
        }

        // 2) Legacy automatic mode (kept for completeness; currently layoutKind is MANUAL).
        if (diagramConfiguration.layoutKind === ServerLayoutKind.AUTOMATIC && layoutEngine) {
            try {
                await layoutEngine.layout();
            } catch (error) {
                console.error('[WorkflowModelSubmissionHandler] Layout failed:', error);
            }
        }

        // Call the parent's implementation to do the rest
        const serializer = (this as any).serializer as GModelSerializer;
        const commandStack = (this as any).commandStack as CommandStack;
        const validator = (this as any).validator as ModelValidator | undefined;
        const requestModelAction = (this as any).requestModelAction;

        // Debug: Check if virtual edges have routing points before serialization
        // Compare ROOT tree edges vs INDEX edges to verify they're the same objects
        const virtualEdgesFromRoot: any[] = [];
        const checkEdgesForRouting = (element: any): void => {
            if (!element) return;
            if (element.type?.startsWith('edge:virtual') || element.id?.startsWith('V:')) {
                virtualEdgesFromRoot.push(element);
                // Also check if the index has the same object
                const indexEdge = modelState.index.get(element.id);
                const isSameObject = indexEdge === element;
                console.log('[WorkflowModelSubmissionHandler] Virtual edge ROOT vs INDEX:', {
                    id: element.id,
                    rootRoutingPoints: element.routingPoints?.length ?? 0,
                    indexRoutingPoints: (indexEdge as any)?.routingPoints?.length ?? 0,
                    isSameObject,
                    indexEdgeExists: !!indexEdge
                });
            }
            if (Array.isArray(element.children)) {
                for (const child of element.children) {
                    checkEdgesForRouting(child);
                }
            }
        };
        checkEdgesForRouting(modelState.root);

        // Persisted-layout reopen path typically skips ELK, which means port-label positions
        // won't be updated by the layout engine. Ensure stable, deterministic placement.
        this.applyDeterministicPortLabelPositions(modelState.root);

        const root = serializer.createSchema(modelState.root);

        const result: Action[] = [];
        result.push(
            requestModelAction
                ? SetModelAction.create(root, { responseId: requestModelAction.requestId ?? '' })
                : UpdateModelAction.create(root, { animate: diagramConfiguration.animatedUpdate })
        );
        
        if (requestModelAction) {
            (this as any).requestModelAction = undefined;
        }
        
        if (!diagramConfiguration.needsClientLayout) {
            result.push(SetDirtyStateAction.create(commandStack.isDirty, { reason }));
        }
        if (validator) {
            const validationActions = await (this as any).validateModel(validator);
            result.push(...validationActions);
        }
        return result;
    }

    private applyDeterministicPortLabelPositions(root: GModelRoot): void {
        const portLabelGapPx = (() => {
            const raw = (root as any)?.args?.['cal:portLabelGapPx'];
            const n = typeof raw === 'number' ? raw : Number(raw);
            return Number.isFinite(n) ? n : WorkflowDiagramConstants.PORT_LABEL_GAP_PX;
        })();

        const estimateLabelSizeFallback = (text: string): { width: number; height: number } => {
            // Keep aligned with WorkflowDiagramModelSource sizing.
            const fontSizePx = WorkflowDiagramConstants.PORT_LABEL_FONT_SIZE_PX;
            const avgCharWidth = fontSizePx * 0.7;
            const padding = 3;
            return {
                width: Math.max(1, Math.ceil(text.length * avgCharWidth + padding * 2)),
                height: Math.max(1, Math.ceil(fontSizePx * 1.25)),
            };
        };

        const visit = (element: any): void => {
            if (!element) return;

            if (element instanceof GPort) {
                const portW = element.size?.width ?? WorkflowDiagramConstants.PORT_WIDTH_PX;
                const portH = element.size?.height ?? WorkflowDiagramConstants.PORT_HEIGHT_PX;
                const direction = (element.args?.[WorkflowDiagramMetadata.PORT_DIRECTION] as string | undefined)
                    ?? (element.type === WorkflowDiagramTypes.PORT_OUTPUT ? 'output' : 'input');

                const children = (element.children as any[] | undefined) ?? [];
                for (const child of children) {
                    if (!(child instanceof GLabel)) continue;
                    if (child.type !== WorkflowDiagramTypes.LABEL_PORT) continue;

                    const text = child.text ?? '';
                    const fallback = estimateLabelSizeFallback(text);
                    const labelW = child.size?.width ?? fallback.width;
                    const labelH = child.size?.height ?? fallback.height;

                    const y = Math.round((portH - labelH) / 2);
                    // Port labels are positioned relative to the port. For output labels, the label box
                    // sits to the *left* of the port marker with a fixed gap. Client-side alignment
                    // transforms for port labels are intentionally disabled (see ComputedBounds handling),
                    // so we use the label's top-left origin here.
                    const x = direction === 'output'
                        ? -portLabelGapPx - labelW
                        : portW + portLabelGapPx;

                    child.position = { x, y };

                    // Ensure port-label rendering is driven purely by position/size.
                    // Any previously stored alignment (e.g., from an older computed-bounds
                    // cycle) can introduce an additional client-side translate().
                    (child as any).alignment = undefined;
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
     * Places newly added nodes (those with no entry in the persisted layout file)
     * below the existing graph bounding box, without disturbing the positions of
     * already-placed nodes. Merges the new positions into the layout file.
     */
    private async placeNewNodes(
        workflowFilePath: string,
        networkId: string,
        root: GModelRoot
    ): Promise<void> {
        // Load source-of-truth positions from disk.
        const existingPositions = await this.layoutPersistence.loadLayout(workflowFilePath, networkId)
            ?? new Map<string, { x: number; y: number }>();

        // Compute bounding box from the persisted positions.
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const { x, y } of existingPositions.values()) {
            if (x < minX) { minX = x; }
            if (y < minY) { minY = y; }
            if (x > maxX) { maxX = x; }
            if (y > maxY) { maxY = y; }
        }
        const hasExisting = existingPositions.size > 0;

        const DEFAULT_NODE_WIDTH = 160;
        const DEFAULT_NODE_HEIGHT = 60;
        const SPACING_X = 80;
        const SPACING_Y = 80;
        const WRAP_COLS = 4;

        // Collect GNodes that have no entry in the persisted layout file.
        const newNodes: Array<{ key: string; element: any; width: number; height: number }> = [];
        const collect = (element: any): void => {
            if (!element) { return; }
            const type = element.type as string | undefined;
            if (typeof type === 'string' && type.startsWith('node:')) {
                const args = element.args as Record<string, unknown> | undefined;
                const key = (args?.[WorkflowDiagramMetadata.AST_PATH] ??
                    args?.[WorkflowDiagramMetadata.ENTITY_NAME] ??
                    args?.[WorkflowDiagramMetadata.PORT_NAME]) as unknown;
                if (typeof key === 'string' && key.trim() !== '' && !existingPositions.has(key)) {
                    const size = (element as any).size as { width: number; height: number } | undefined;
                    newNodes.push({
                        key,
                        element,
                        width: size?.width ?? DEFAULT_NODE_WIDTH,
                        height: size?.height ?? DEFAULT_NODE_HEIGHT,
                    });
                }
            }
            const children = element.children as any[] | undefined;
            if (Array.isArray(children)) {
                for (const child of children) { collect(child); }
            }
        };
        collect(root);

        if (newNodes.length === 0) {
            return;
        }

        // Place new nodes below the existing bounding box in a row-wrapping grid.
        const startX = hasExisting ? minX : 20;
        const startY = hasExisting ? (maxY + DEFAULT_NODE_HEIGHT + SPACING_Y) : 20;
        let curX = startX;
        let curY = startY;
        let rowHeight = 0;
        let colIdx = 0;

        const merged = new Map<string, { x: number; y: number }>(existingPositions);

        for (const node of newNodes) {
            merged.set(node.key, { x: curX, y: curY });
            // Apply position directly to the live GNode so the client sees it immediately.
            (node.element as any).position = { x: curX, y: curY };

            rowHeight = Math.max(rowHeight, node.height);
            curX += node.width + SPACING_X;
            colIdx++;
            if (colIdx >= WRAP_COLS) {
                curX = startX;
                curY += rowHeight + SPACING_Y;
                rowHeight = 0;
                colIdx = 0;
            }
        }

        // Persist merged positions (edge routes are preserved automatically by saveLayoutImmediate).
        await this.layoutPersistence.saveLayoutImmediate(workflowFilePath, networkId, merged, undefined);
        console.log(`[WorkflowModelSubmissionHandler] Placed ${newNodes.length} new node(s) below existing graph at y=${startY}.`);
    }

    private collectNodePositions(root: GModelRoot): Map<string, { x: number; y: number }> {
        const result = new Map<string, { x: number; y: number }>();
        // Accumulate absolute positions by tracking parent offsets
        const visit = (element: any, parentAbsX: number, parentAbsY: number): void => {
            if (!element) {
                return;
            }
            // Compute this element's absolute position
            const relX = element.position?.x ?? 0;
            const relY = element.position?.y ?? 0;
            const absX = parentAbsX + relX;
            const absY = parentAbsY + relY;

            const type = element.type as string | undefined;
            if (typeof type === 'string' && type.startsWith('node:')) {
                const args = element.args as Record<string, unknown> | undefined;
                const key = (args?.[WorkflowDiagramMetadata.AST_PATH] ??
                    args?.[WorkflowDiagramMetadata.ENTITY_NAME] ??
                    args?.[WorkflowDiagramMetadata.PORT_NAME]) as unknown;
                if (typeof key === 'string' && key.trim() !== '' && element.position) {
                    result.set(key, { x: absX, y: absY });
                }
            }
            const children = element.children as any[] | undefined;
            if (Array.isArray(children)) {
                for (const child of children) {
                    visit(child, absX, absY);
                }
            }
        };
        visit(root, 0, 0);
        return result;
    }

    private collectEdgeRoutes(root: GModelRoot): Map<string, { x: number; y: number }[]> {
        const result = new Map<string, { x: number; y: number }[]>();
        const signatureCounts = this.buildEdgeSignatureCounts(root);
        const visit = (element: any): void => {
            if (!element) {
                return;
            }
            if (element instanceof GEdge) {
                const args = element.args as Record<string, unknown> | undefined;
                const key = this.edgeRouteKeyFor(args, signatureCounts);
                const routingPoints = (element as any).routingPoints as { x: number; y: number }[] | undefined;
                if (typeof key === 'string' && Array.isArray(routingPoints) && routingPoints.length > 0) {
                    result.set(key, routingPoints);
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
        return result;
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
}

/**
 * Custom RequestModelActionHandler that suppresses the "Model loading in progress"
 * notification for polling/refresh requests during workflow execution.
 *
 * The base GLSP handler dispatches a StatusAction and starts a ProgressMonitor
 * on every RequestModelAction. During streaming agent execution the diagram is
 * refreshed every second (signature-based dedup), which causes the notification
 * to flash repeatedly. This subclass detects polling requests by their requestId
 * prefix and silently skips the progress reporting for those.
 */
@injectable()
export class WorkflowRequestModelActionHandler extends RequestModelActionHandler {
    /** When true, reportModelLoading / reportModelLoadingFinished are no-ops. */
    private suppressNotifications = false;

    override async execute(action: RequestModelAction): Promise<Action[]> {
        const requestId = action.requestId ?? '';
        const isPolling = requestId.startsWith('refresh-during-run-') ||
            requestId.startsWith('refresh-queue-visibility-') ||
            requestId.startsWith('refresh-agent-ctx-') ||
            requestId.startsWith('refresh-caller-refs-') ||
            requestId.startsWith('refresh-agent-enrichment-');
        const isAgentCtxOnly = Boolean(action.options?.agentContextOnly);
        this.suppressNotifications = isPolling;
        if (isPolling) {
            console.log(`[WorkflowRequestModelActionHandler] polling refresh: ${requestId.slice(0, 40)} agentOnly=${isAgentCtxOnly}`);
        }
        try {
            if (isAgentCtxOnly) {
                // Fast path: skip the bounds round-trip for agent-context-only
                // refreshes.  Layout hasn't changed (same nodes/edges/positions),
                // only metadata and CSS classes changed.  Going through
                // submitInitialModel() would trigger a RequestBoundsAction →
                // ComputedBoundsAction round-trip that is unnecessary and harmful:
                // submitModel() resets the model revision, which invalidates any
                // in-flight ComputedBoundsAction from a concurrent full refresh,
                // causing perpetual model invalidation (the diagram never updates).
                await this.sourceModelStorage.loadSourceModel(action);
                const actions = await this.submissionHandler.submitModelDirectly();
                console.log(`[WorkflowRequestModelActionHandler] agent-ctx-only: submitted directly, ${actions.length} actions`);
                return actions;
            }
            return await super.execute(action);
        } finally {
            this.suppressNotifications = false;
        }
    }

    protected override reportModelLoading(message: string) {
        if (this.suppressNotifications) {
            return undefined;
        }
        return super.reportModelLoading(message);
    }

    protected override reportModelLoadingFinished(monitor?: unknown): void {
        if (this.suppressNotifications) {
            return;
        }
        super.reportModelLoadingFinished(monitor as any);
    }
}

/**
 * Custom ComputedBoundsActionHandler that handles invalid routes gracefully.
 * 
 * The default GLSP ComputedBoundsActionHandler throws "Invalid Route!" when
 * a route has fewer than 2 points. This can happen during live updates when
 * the diagram is being refreshed while the user is typing, and the layout
 * produces incomplete routing information.
 * 
 * This handler skips invalid routes instead of throwing, allowing the diagram
 * to remain functional during live editing.
 */
@injectable()
export class WorkflowComputedBoundsActionHandler implements ActionHandler {
    readonly actionKinds = [ComputedBoundsAction.KIND];
    
    @inject(ModelSubmissionHandler)
    protected submissionHandler!: ModelSubmissionHandler;
    
    @inject(ModelState)
    protected modelState!: ModelState;

    private get enableDiagramDebug(): boolean {
        return process.env.WORKFLOW_DIAGRAM_DEBUG === '1';
    }
    
    async execute(action: ComputedBoundsAction): Promise<Action[]> {
        const model = this.modelState.root;
        // `ComputedBoundsAction.revision` is optional in the GLSP protocol. Most clients include it,
        // but if it's missing we still want to apply bounds; otherwise client-side layouting may
        // never converge (no follow-up UpdateModel/SetModel round-trip).
        const hasActionRevision = action.revision !== undefined && action.revision !== null;
        const hasModelRevision = model.revision !== undefined && model.revision !== null;
        const revisionMatches = !hasActionRevision || !hasModelRevision || action.revision === model.revision;

        if (revisionMatches) {
            await this.applyBounds(model, action);

            // Mark that we have a first, consistent client-bounds snapshot.
            const layoutMeta = this.modelState.get(WORKFLOW_LAYOUT_PERSISTENCE_KEY) as
                | {
                      workflowFilePath: string;
                      networkId: string;
                      hasPersistedLayout: boolean;
                      hasPersistedEdgeRoutes: boolean;
                      didInitialLayout: boolean;
                      hasClientBounds: boolean;
                      allowInitialLayoutPersistence: boolean;
                      unpositionedNodeCount?: number;
                  }
                | undefined;
            if (layoutMeta && !layoutMeta.hasClientBounds) {
                layoutMeta.hasClientBounds = true;
                this.modelState.set(WORKFLOW_LAYOUT_PERSISTENCE_KEY, layoutMeta);
            }
            return this.submissionHandler.submitModelDirectly();
        }

        return [];
    }
    
    protected async applyBounds(root: GModelRoot, action: ComputedBoundsAction): Promise<void> {
        const index = this.modelState.index;

        const layoutMeta = this.modelState.get(WORKFLOW_LAYOUT_PERSISTENCE_KEY) as
            | {
                  workflowFilePath?: string;
                  networkId?: string;
                  hasPersistedLayout?: boolean;
                  hasClientBounds?: boolean;
                  hasPersistedEdgeRoutes: boolean;
                  rerouteEdgeIds?: string[];
              }
            | undefined;

        const hasPersistedLayout = layoutMeta?.hasPersistedLayout === true;

        const portLabelGapPx = (() => {
            const raw = (root as any)?.args?.['cal:portLabelGapPx'];
            const n = typeof raw === 'number' ? raw : Number(raw);
            return Number.isFinite(n) ? n : WorkflowDiagramConstants.PORT_LABEL_GAP_PX;
        })();

        const reanchorPortLabelToPort = (label: any): void => {
            const parentPort = label?.parent as any;
            if (!parentPort) {
                return;
            }
            const portType = parentPort.type as string | undefined;
            const portW = parentPort.size?.width ?? 0;
            const portH = parentPort.size?.height ?? 0;
            if (!(portW > 0) || !(portH > 0)) {
                return;
            }

            const labelW = label.size?.width ?? 0;
            const labelH = label.size?.height ?? 0;
            if (!(labelW > 0) || !(labelH > 0)) {
                return;
            }

            const direction = (parentPort.args?.[WorkflowDiagramMetadata.PORT_DIRECTION] as string | undefined)
                ?? (portType === WorkflowDiagramTypes.PORT_OUTPUT ? 'output' : 'input');

            const y = Math.round((portH - labelH) / 2);
            const x = direction === 'output'
                ? -portLabelGapPx - labelW
                : portW + portLabelGapPx;

            label.position = { x, y };
        };

        const reanchorPortsToNodeSize = (node: any): void => {
            const nodeSize = node?.size as { width: number; height: number } | undefined;
            const children = node?.children as any[] | undefined;
            if (!nodeSize || !Array.isArray(children)) {
                return;
            }
            const nodeWidth = nodeSize.width ?? 0;
            const nodeHeight = nodeSize.height ?? 0;
            if (!(nodeWidth > 0) || !(nodeHeight > 0)) {
                return;
            }

            // Ports are often nested in compartments; ensure we re-anchor ALL descendant ports.
            const absPos = (element: any): { x: number; y: number } => {
                let x = 0;
                let y = 0;
                let current = element;
                while (current) {
                    if (current.position) {
                        x += current.position.x ?? 0;
                        y += current.position.y ?? 0;
                    }
                    current = current.parent;
                }
                return { x, y };
            };

            const nodeAbs = absPos(node);
            const visit = (el: any): void => {
                if (!el) {
                    return;
                }
                const elType = (el as any)?.type as string | undefined;
                if (typeof elType === 'string' && elType.startsWith('port:')) {
                    const port = el as any;
                    const portSize = port.size as { width: number; height: number } | undefined;
                    const portDirection = port.args?.[WorkflowDiagramMetadata.PORT_DIRECTION] as string | undefined;
                    if (!portSize || !(portSize.width > 0) || !(portSize.height > 0) || !port.position) {
                        return;
                    }

                    // Desired absolute X at the node border.
                    const desiredAbsX = hasPersistedLayout
                        ? (portDirection === 'output' ? nodeAbs.x + nodeWidth : nodeAbs.x - portSize.width)
                        : (portDirection === 'output' ? nodeAbs.x + Math.max(0, nodeWidth - portSize.width) : nodeAbs.x);

                    const parentAbs = absPos(port.parent);
                    const anchoredX = desiredAbsX - parentAbs.x;

                    // Keep Y stable (avoid reshuffling port ordering).
                    port.position = { x: anchoredX, y: port.position.y ?? 0 };
                    return;
                }

                const elChildren = el.children as any[] | undefined;
                if (Array.isArray(elChildren)) {
                    for (const c of elChildren) {
                        visit(c);
                    }
                }
            };

            for (const child of children) {
                visit(child);
            }
        };

                // Only accept client-measured node size expansions during the initial bounds sync.
                // After that, client bounds can fluctuate due to selection/hover styling (stroke, focus rings),
                // and we must keep the model stable to avoid "creeping" node sizes.
                const allowClientNodeResize = !layoutMeta?.hasClientBounds;

                // Ignore tiny deltas that are typically selection stroke or subpixel rounding.
                const RESIZE_EPSILON_PX = 4;

        let didExpandNodeSize = false;
        
        // Apply element bounds - but preserve server-calculated node sizes
        action.bounds.forEach(bounds => {
            const element = index.get(bounds.elementId);
            if (element) {
                // Ports and port labels are positioned explicitly on the server for ELK.
                // Do NOT overwrite their position/size with client-computed bounds.
                const elementType = (element as any).type as string | undefined;
                const isPort = typeof elementType === 'string' && elementType.startsWith('port:');
                const isPortLabel = elementType === WorkflowDiagramTypes.LABEL_PORT;

                // Ports are placed by the server + ELK and must not be moved by client bounds.
                if (isPort) {
                    return;
                }

                // Port labels: accept client-measured SIZE only during the initial bounds sync.
                // Unlike nodes, we DO allow shrinking here: server-side text estimation can be
                // intentionally conservative, and an overestimated label width directly affects
                // label placement (e.g. output labels placed at -gap-labelWidth).
                // Do not accept position from the client; ELK/deterministic placement owns it.
                if (isPortLabel) {
                    // NOTE: Port labels are a special case: on persisted-layout reopen, the first
                    // ComputedBoundsAction can arrive before text measurement is complete, leaving
                    // label sizes at 0. If we lock hasClientBounds too early, output labels (which
                    // depend on width for anchoring) will never converge until a manual layout.
                    //
                    // Therefore we accept non-zero port-label size updates even after the initial
                    // bounds sync when persisted layout is active.
                    const allowPortLabelResize = allowClientNodeResize || hasPersistedLayout;

                    if (allowPortLabelResize && bounds.newSize) {
                        const anyEl = element as any;
                        const nextWidth = bounds.newSize.width;
                        const nextHeight = bounds.newSize.height;

                        if (nextWidth > 0 && nextHeight > 0) {
                            const prevW = anyEl.size?.width ?? 0;
                            const prevH = anyEl.size?.height ?? 0;
                            const nextW = Math.max(1, Math.ceil(nextWidth));
                            const nextH = Math.max(1, Math.ceil(nextHeight));

                            // Avoid churn from tiny fluctuations.
                            const changed = prevW <= 0 || prevH <= 0 || Math.abs(nextW - prevW) >= 2 || Math.abs(nextH - prevH) >= 2;
                            if (changed) {
                                anyEl.size = { width: nextW, height: nextH };

                                // Keep label position consistent with its (possibly updated) size.
                                // This is especially important when persisted layout skips ELK.
                                if (hasPersistedLayout) {
                                    reanchorPortLabelToPort(anyEl);
                                }
                            }

                        }
                    }

                    return;
                }

                // For nodes: allow a one-time expansion to client-measured size (never shrink).
                // This keeps the model consistent with real text measurement, but prevents size creep.
                const isNode = element.type?.startsWith('node:');
                if (isNode && 'size' in element) {
                    const existingSize = (element as any).size;
                    if (existingSize && existingSize.width > 0 && existingSize.height > 0) {
                        if (allowClientNodeResize && bounds.newSize) {
                            const dw = bounds.newSize.width - existingSize.width;
                            const dh = bounds.newSize.height - existingSize.height;
                            const shouldExpand = dw >= RESIZE_EPSILON_PX || dh >= RESIZE_EPSILON_PX;
                            if (shouldExpand) {
                                const expandedWidth = Math.max(existingSize.width, bounds.newSize.width);
                                const expandedHeight = Math.max(existingSize.height, bounds.newSize.height);
                                if (expandedWidth !== existingSize.width || expandedHeight !== existingSize.height) {
                                    didExpandNodeSize = true;
                                    (element as any).size = { width: expandedWidth, height: expandedHeight };
                                    reanchorPortsToNodeSize(element as any);
                                }
                            }
                        }

                        // Apply position only when there is NO persisted layout.
                        // With a persisted layout, node positions are server-authoritative.
                        // Applying client-reported positions can shift nodes by a few
                        // pixels (CSS rounding, SVG transforms) while edge routing
                        // points stay at the old coordinates, producing diagonal/stale
                        // edge artifacts immediately after diagram open.
                        if (!hasPersistedLayout && 'position' in element && bounds.newPosition) {
                            (element as any).position = bounds.newPosition;
                        }
                        return;
                    }
                }
                
                // For ALL elements with existing valid sizes, preserve server-calculated size
                // This prevents client-side stroke/CSS changes from affecting model sizes
                if ('size' in element) {
                    const existingSize = (element as any).size;
                    if (existingSize && existingSize.width > 0 && existingSize.height > 0) {
                        // Only apply position when no persisted layout (same reason as above).
                        if (!hasPersistedLayout && 'position' in element && bounds.newPosition) {
                            (element as any).position = bounds.newPosition;
                        }
                        return; // Skip size update
                    }
                }
                
                // For other elements without existing sizes, apply normally
                applyElementAndBounds(bounds, index);
            }
        });
        
        // Apply alignments.
        //
        // IMPORTANT: Do NOT apply client-computed alignment offsets for port labels.
        // Port labels are placed by ELK (or by our deterministic port-label positioning
        // when ELK is skipped on persisted reopen). Applying alignment for these labels
        // introduces an additional translate() in the client SVG that shifts the text
        // into/through the port bar.
        (action.alignments ?? []).forEach(alignment => {
            const el = index.get(alignment.elementId);
            if (el && (el as any).type === WorkflowDiagramTypes.LABEL_PORT) {
                return;
            }
            applyAlignment(alignment, index);
        });
        
        // Apply routes - with graceful handling of invalid routes.
        // Keep routes stable by default: if we have server/persisted routes, ignore client routes.
        // After a node move, the client may send temporary straight-line routes; we must NOT
        // persist those. Instead, reroute affected edges on the server.
        const rerouteSet = this.computeRerouteSet(action, index, root);

        // Build a map of the client-provided routing points (full polyline, incl. endpoints).
        // We also keep the previous map around to stabilize "mouse-up" where the last
        // ComputedBoundsAction may contain recomputed routes for many edges.
        const prevClientRoutingPointsByEdgeId = (layoutMeta as any)?.lastClientRoutingPointsByEdgeId as
            | Map<string, { x: number; y: number }[]>
            | undefined;
        const currentClientRoutingPointsByEdgeId = new Map<string, { x: number; y: number }[]>();
        for (const route of action.routes ?? []) {
            const routingPoints = route.newRoutingPoints ?? [];
            if (routingPoints.length < 2) {
                continue;
            }
            currentClientRoutingPointsByEdgeId.set(route.elementId, routingPoints);
        }
        if (layoutMeta) {
            (layoutMeta as any).lastClientRoutingPointsByEdgeId = currentClientRoutingPointsByEdgeId;
            this.modelState.set(WORKFLOW_LAYOUT_PERSISTENCE_KEY, layoutMeta);
        }

        // NOTE: We intentionally do NOT run a second ELK layout pass here.
        // Edge rerouting after node moves is handled by WorkflowChangeBoundsOperationHandler
        // (which calls the reroute handler) and by the client drag router's
        // flushPendingReroute. Running ELK in ComputedBoundsActionHandler was
        // destructive: ELK's layered algorithm ignores position pins (those are
        // for the 'fixed' algorithm only), so the second pass computed routes for
        // ELK-determined positions rather than the actual positions, then
        // restoreNodePositions put nodes back, leaving position/route mismatches
        // (diagonal "stale segment" artifacts).

        // IMPORTANT: Never apply client routes from ComputedBoundsAction by default.
        // Those routes are preview routes from the client router and can overwrite valid
        // server-routed polylines during reopen/initial render (especially when no
        // persisted layout file exists yet), producing diagonal/stale artifacts.
        //
        // Genuine rerouting is handled server-side by dedicated operation handlers.
        // A debug opt-in exists for troubleshooting only.
        const shouldApplyClientRoutes = process.env.WORKFLOW_DIAGRAM_APPLY_CLIENT_ROUTES === '1'
            && !layoutMeta?.hasPersistedEdgeRoutes;
        if (!shouldApplyClientRoutes) {
            return;
        }

        let didApplyAnyRoute = false;
        (action.routes ?? []).forEach(route => {
            if (rerouteSet.size > 0 && !rerouteSet.has(route.elementId)) {
                return;
            }
            const routingPoints = route.newRoutingPoints ?? [];
            if (routingPoints.length < 2) {
                // Skip invalid routes instead of throwing
                console.warn(`[WorkflowComputedBoundsActionHandler] Skipping invalid route for edge ${route.elementId}: ${routingPoints.length} points (need >= 2)`);
                return;
            }
            
            // Apply the route manually since we can't import applyRoute (it throws)
            const edge = index.get(route.elementId);
            if (edge && 'routingPoints' in edge) {
                // Full polyline (incl. source/target endpoints)
                (edge as GEdge).routingPoints = routingPoints;
                didApplyAnyRoute = true;
            }
        });

        // IMPORTANT: Do NOT persist edge routes coming from the client's ComputedBoundsAction.
        // During interactive edits (especially drag), the client may report transient/preview
        // routes. Persisting those makes the layout file unstable and breaks determinism.
        // Persist routes only from explicit routing-point edits or server-side reroute actions.

        if (layoutMeta && rerouteSet.size > 0) {
            // One-shot: after we rerouted the affected edges, clear the flag so
            // later computed-bounds updates don't keep re-routing everything.
            layoutMeta.rerouteEdgeIds = undefined;
            this.modelState.set(WORKFLOW_LAYOUT_PERSISTENCE_KEY, layoutMeta);
        }
    }

    private computeRerouteSet(action: ComputedBoundsAction, index: GModelIndex, root: GModelRoot): Set<string> {
        const movedPortIds = new Set<string>();

        const collectPortIds = (element: any): void => {
            if (!element) {
                return;
            }
            if (element instanceof GPort) {
                movedPortIds.add(element.id);
            }
            const children = element.children as any[] | undefined;
            if (Array.isArray(children)) {
                for (const child of children) {
                    collectPortIds(child);
                }
            }
        };

        for (const bound of action.bounds) {
            const element = index.get(bound.elementId);
            collectPortIds(element);
        }

        const rerouteSet = new Set<string>();
        if (movedPortIds.size > 0) {
            const visit = (element: any): void => {
                if (!element) {
                    return;
                }
                if (element instanceof GEdge) {
                    const sourceMoved = movedPortIds.has(element.sourceId);
                    const targetMoved = movedPortIds.has(element.targetId);
                    // Reroute any edge incident to moved node(s)/ports.
                    if (sourceMoved || targetMoved) {
                        rerouteSet.add(element.id);
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
        return rerouteSet;
    }

    private snapshotNodePositionsById(root: any): Map<string, { x: number; y: number } | undefined> {
        const result = new Map<string, { x: number; y: number } | undefined>();
        const visit = (element: any): void => {
            if (!element) {
                return;
            }
            const type = element?.type as string | undefined;
            const isNode = typeof type === 'string' && type.startsWith('node:');
            if (isNode) {
                const id = String((element as any).id);
                const pos = (element as any).position as { x?: number; y?: number } | undefined;
                result.set(id, pos ? { x: pos.x ?? 0, y: pos.y ?? 0 } : undefined);
            }
            const children = element.children as any[] | undefined;
            if (Array.isArray(children)) {
                for (const child of children) {
                    visit(child);
                }
            }
        };
        visit(root);
        return result;
    }

    private snapshotEdgeRoutesById(root: any): Map<string, { x: number; y: number }[] | undefined> {
        const result = new Map<string, { x: number; y: number }[] | undefined>();
        const visit = (element: any): void => {
            if (!element) {
                return;
            }
            if (element instanceof GEdge) {
                const id = String((element as any).id);
                const routingPoints = (element as any).routingPoints as { x: number; y: number }[] | undefined;
                if (Array.isArray(routingPoints)) {
                    result.set(
                        id,
                        routingPoints.map(p => ({ x: p.x, y: p.y }))
                    );
                } else {
                    result.set(id, undefined);
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
        return result;
    }

    private applyInteractiveRoutingOptions(root: any): { restore: () => void } {
        const prevRootLayoutOptions = (root as any).layoutOptions ? { ...(root as any).layoutOptions } : undefined;
        (root as any).layoutOptions = {
            ...(prevRootLayoutOptions ?? {}),
            'elk.edgeRouting': 'ORTHOGONAL',
            'org.eclipse.elk.edgeRouting': 'ORTHOGONAL',
            // Recompute routes from scratch for targeted edges instead of preserving
            // prior bends from interactive history.
            'org.eclipse.elk.interactiveLayout': 'false',
            'elk.layered.crossingMinimization.semiInteractive': 'false'
        };

        const prevNodeLayoutOptionsById = new Map<string, any>();
        const visit = (element: any): void => {
            if (!element) {
                return;
            }
            if (element instanceof GNode && element.position) {
                const id = String((element as any).id);
                prevNodeLayoutOptionsById.set(id, (element as any).layoutOptions ? { ...(element as any).layoutOptions } : undefined);

                (element as any).layoutOptions = {
                    ...((element as any).layoutOptions ?? {}),
                    'org.eclipse.elk.position': { x: element.position.x, y: element.position.y }
                };
            }
            const children = element.children as any[] | undefined;
            if (Array.isArray(children)) {
                for (const child of children) {
                    visit(child);
                }
            }
        };
        visit(root);

        return {
            restore: () => {
                (root as any).layoutOptions = prevRootLayoutOptions;
                const restoreNodes = (element: any): void => {
                    if (!element) {
                        return;
                    }
                    if (element instanceof GNode) {
                        const id = String((element as any).id);
                        if (prevNodeLayoutOptionsById.has(id)) {
                            (element as any).layoutOptions = prevNodeLayoutOptionsById.get(id);
                        }
                    }
                    const children = element.children as any[] | undefined;
                    if (Array.isArray(children)) {
                        for (const child of children) {
                            restoreNodes(child);
                        }
                    }
                };
                restoreNodes(root);
            }
        };
    }

    private restoreNodePositions(root: any, preNodePositionsById: Map<string, { x: number; y: number } | undefined>): void {
        const visit = (element: any): void => {
            if (!element) {
                return;
            }
            const type = element?.type as string | undefined;
            const isNode = typeof type === 'string' && type.startsWith('node:');
            if (isNode) {
                const id = String((element as any).id);
                const prev = preNodePositionsById.get(id);
                (element as any).position = prev ? { x: prev.x, y: prev.y } : undefined;
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

    private restoreUntargetedEdgeRoutes(
        root: any,
        rerouteSet: Set<string>,
        preEdgeRoutesById: Map<string, { x: number; y: number }[] | undefined>,
        clientRoutingPointsByEdgeId?: Map<string, { x: number; y: number }[]>
    ): void {
        const visit = (element: any): void => {
            if (!element) {
                return;
            }
            if (element instanceof GEdge) {
                const id = String((element as any).id);
                if (!rerouteSet.has(id)) {
                    // Prefer restoring from the client's route for visual stability during drag.
                    // If not available, fall back to the previous server route snapshot.
                    const clientRoute = clientRoutingPointsByEdgeId?.get(id);
                    if (clientRoute !== undefined) {
                        (element as any).routingPoints = clientRoute.map(p => ({ x: p.x, y: p.y }));
                    } else {
                        const prevRoute = preEdgeRoutesById.get(id);
                        // IMPORTANT: preserve empty arrays. `[]` means "explicitly no bendpoints".
                        // Using a truthy check would convert `[]` to `undefined`, letting the client
                        // router recompute and causing unrelated edges to jump.
                        (element as any).routingPoints = prevRoute !== undefined ? prevRoute.map(p => ({ x: p.x, y: p.y })) : undefined;
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

    private clearRoutingPointsForEdges(root: any, edgeIds: Set<string>): void {
        const visit = (element: any): void => {
            if (!element) {
                return;
            }
            if (element instanceof GEdge) {
                const id = String((element as any).id);
                if (edgeIds.has(id)) {
                    // Clear routing points to force ELK to re-route freely.
                    delete (element as any).routingPoints;
                    
                    // Also clear manual route flag if present, to allow auto-routing to take over
                    // consistent with the node move.
                    if ((element as any).args) {
                        delete (element as any).args['cal:manualRoute'];
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

    private collectNodePositions(root: GModelRoot): Map<string, { x: number; y: number }> {
        const result = new Map<string, { x: number; y: number }>();
        const visit = (element: any, parentAbsX: number, parentAbsY: number): void => {
            if (!element) {
                return;
            }
            const relX = element.position?.x ?? 0;
            const relY = element.position?.y ?? 0;
            const absX = parentAbsX + relX;
            const absY = parentAbsY + relY;

            const type = element.type as string | undefined;
            if (typeof type === 'string' && type.startsWith('node:')) {
                const args = element.args as Record<string, unknown> | undefined;
                const key = (args?.[WorkflowDiagramMetadata.AST_PATH] ??
                    args?.[WorkflowDiagramMetadata.ENTITY_NAME] ??
                    args?.[WorkflowDiagramMetadata.PORT_NAME]) as unknown;
                if (typeof key === 'string' && key.trim() !== '' && element.position) {
                    result.set(key, { x: absX, y: absY });
                }
            }

            const children = element.children as any[] | undefined;
            if (Array.isArray(children)) {
                for (const child of children) {
                    visit(child, absX, absY);
                }
            }
        };
        visit(root, 0, 0);
        return result;
    }

    private collectEdgeRoutes(root: GModelRoot, allowedEdgeIds?: Set<string>): Map<string, { x: number; y: number }[]> {
        const result = new Map<string, { x: number; y: number }[]>();
        const signatureCounts = this.buildEdgeSignatureCounts(root);
        const visit = (element: any): void => {
            if (!element) {
                return;
            }
            if (element instanceof GEdge) {
                // Optionally filter by edge ids (e.g., only persist rerouted edges).
                const id = String((element as any).id);
                if (!allowedEdgeIds || allowedEdgeIds.has(id)) {
                    const args = element.args as Record<string, unknown> | undefined;
                    const key = this.edgeRouteKeyFor(args, signatureCounts);
                    const routingPoints = (element as any).routingPoints as { x: number; y: number }[] | undefined;
                    if (typeof key === 'string' && Array.isArray(routingPoints) && routingPoints.length > 0) {
                        result.set(key, routingPoints);
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
        return result;
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
}

/**
 * Custom LayoutOperationHandler that always executes layout regardless of layoutKind.
 * 
 * The default GLSP LayoutOperationHandler only works when layoutKind === MANUAL.
 * In AUTOMATIC mode, layout happens automatically after model changes, but users
 * still want a manual re-layout button. This handler allows manual layout requests
 * even in AUTOMATIC mode.
 */
@injectable()
export class WorkflowLayoutOperationHandler extends OperationHandler {
    override readonly operationType = LayoutOperation.KIND;
    
    @inject(LayoutEngine)
    @optional()
    protected layoutEngine?: LayoutEngine;
    
    @inject(ModelState)
    protected override modelState!: ModelState;
    
    @inject(GModelSerializer)
    protected serializer!: GModelSerializer;

    @inject(LayoutPersistenceService)
    protected layoutPersistence!: LayoutPersistenceService;
    
    override createCommand(operation: LayoutOperation): GModelRecordingCommand | undefined {
        if (!this.layoutEngine) {
            console.warn('[WorkflowLayoutOperationHandler] Could not execute layout operation. No LayoutEngine is bound!');
            return undefined;
        }
        return new GModelRecordingCommand(this.modelState, this.serializer, () => this.executeOperation(operation));
    }
    
    protected async executeOperation(operation: LayoutOperation): Promise<void> {
        // GLSP's ELK layout engine currently computes layout for the full diagram.
        // For selection-only layout, we snapshot the current positions/routes, run
        // layout, then restore everything that was not selected.
        const selectedMovableNodeIds = this.getSelectedMovableNodeIds(operation);
        const hasSelection = selectedMovableNodeIds.size > 0;

        const preNodePositionsById = hasSelection ? this.snapshotNodePositionsById(this.modelState.root) : undefined;
        const preEdgeRoutesById = hasSelection ? this.snapshotEdgeRoutesById(this.modelState.root) : undefined;

        // When a user triggers a manual auto-layout, we want ELK to fully recompute edge routing.
        // Existing routing points (from previous ELK runs or manual routing) can otherwise
        // constrain routing and lead to stale/unstable layouts.
        clearAllEdgeRoutingPoints(this.modelState.root);

        await this.layoutEngine?.layout(operation);

        if (hasSelection && preNodePositionsById && preEdgeRoutesById) {
            this.restoreUnselectedLayout(this.modelState.root, selectedMovableNodeIds, preNodePositionsById, preEdgeRoutesById);
        }

        const diagramModel = this.modelState.get(WORKFLOW_NETWORK_MODEL_KEY) as WorkflowDiagramModel | undefined;
        if (!diagramModel) {
            return;
        }

        const workflowFilePath = URI.parse(diagramModel.documentUri).fsPath;
        const explicitName = (diagramModel as any)?.workflowName as string | undefined;
        const networkId = explicitName && explicitName.trim() !== ''
            ? explicitName.trim()
            : 'unknown';
        const positions = this.collectNodePositions(this.modelState.root);
        const routes = this.collectEdgeRoutes(this.modelState.root);
        await this.layoutPersistence.saveLayoutImmediate(workflowFilePath, networkId, positions, routes);

        const layoutMeta = this.modelState.get(WORKFLOW_LAYOUT_PERSISTENCE_KEY) as
            | {
                  workflowFilePath: string;
                  networkId: string;
                  hasPersistedLayout: boolean;
                  hasPersistedEdgeRoutes: boolean;
                  didInitialLayout: boolean;
                  hasClientBounds: boolean;
                  allowInitialLayoutPersistence: boolean;
                  unpositionedNodeCount?: number;
              }
            | undefined;
        if (layoutMeta) {
            layoutMeta.hasPersistedLayout = true;
            layoutMeta.hasPersistedEdgeRoutes = routes.size > 0;
            this.modelState.set(WORKFLOW_LAYOUT_PERSISTENCE_KEY, layoutMeta);
        }
    }

    // clearAllEdgeRoutingPoints extracted to src/glsp/routing/clear-edge-routes.ts

    private isMovableNode(element: any): boolean {
        const type = element?.type as string | undefined;
        return typeof type === 'string' && type.startsWith('node:');
    }

    private getMovableNodeIdForElementId(elementId: string): string | undefined {
        let current: any = this.modelState.index.find(elementId);
        while (current) {
            if (this.isMovableNode(current)) {
                return String((current as any).id);
            }
            current = (current as any).parent;
        }
        return undefined;
    }

    private getSelectedMovableNodeIds(operation: LayoutOperation): Set<string> {
        const result = new Set<string>();
        const elementIds = Array.isArray(operation.elementIds) ? operation.elementIds : [];

        for (const id of elementIds) {
            const movable = this.getMovableNodeIdForElementId(id);
            if (movable) {
                result.add(movable);
            }

            const element: any = this.modelState.index.find(id);
            const type = element?.type as string | undefined;
            const isEdge = element instanceof GEdge || (typeof type === 'string' && type.startsWith('edge:'));
            if (isEdge) {
                const sourceId = (element as any).sourceId as string | undefined;
                const targetId = (element as any).targetId as string | undefined;
                if (typeof sourceId === 'string') {
                    const sourceMovable = this.getMovableNodeIdForElementId(sourceId);
                    if (sourceMovable) {
                        result.add(sourceMovable);
                    }
                }
                if (typeof targetId === 'string') {
                    const targetMovable = this.getMovableNodeIdForElementId(targetId);
                    if (targetMovable) {
                        result.add(targetMovable);
                    }
                }
            }
        }

        return result;
    }

    private snapshotNodePositionsById(root: any): Map<string, { x: number; y: number } | undefined> {
        const result = new Map<string, { x: number; y: number } | undefined>();
        const visit = (element: any): void => {
            if (!element) {
                return;
            }
            if (this.isMovableNode(element)) {
                const id = String((element as any).id);
                const pos = (element as any).position as { x?: number; y?: number } | undefined;
                if (pos) {
                    result.set(id, { x: pos.x ?? 0, y: pos.y ?? 0 });
                } else {
                    result.set(id, undefined);
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
        return result;
    }

    private snapshotEdgeRoutesById(root: any): Map<string, { x: number; y: number }[] | undefined> {
        const result = new Map<string, { x: number; y: number }[] | undefined>();
        const visit = (element: any): void => {
            if (!element) {
                return;
            }
            if (element instanceof GEdge) {
                const id = String((element as any).id);
                const routingPoints = (element as any).routingPoints as { x: number; y: number }[] | undefined;
                if (Array.isArray(routingPoints)) {
                    result.set(
                        id,
                        routingPoints.map(p => ({ x: p.x, y: p.y }))
                    );
                } else {
                    result.set(id, undefined);
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
        return result;
    }

    private restoreUnselectedLayout(
        root: any,
        selectedMovableNodeIds: Set<string>,
        preNodePositionsById: Map<string, { x: number; y: number } | undefined>,
        preEdgeRoutesById: Map<string, { x: number; y: number }[] | undefined>
    ): void {
        const visit = (element: any): void => {
            if (!element) {
                return;
            }

            if (this.isMovableNode(element)) {
                const id = String((element as any).id);
                if (!selectedMovableNodeIds.has(id)) {
                    const prev = preNodePositionsById.get(id);
                    (element as any).position = prev ? { x: prev.x, y: prev.y } : undefined;
                }
            }

            if (element instanceof GEdge) {
                const id = String((element as any).id);
                const sourceId = (element as any).sourceId as string | undefined;
                const targetId = (element as any).targetId as string | undefined;

                const sourceMovable = typeof sourceId === 'string' ? this.getMovableNodeIdForElementId(sourceId) : undefined;
                const targetMovable = typeof targetId === 'string' ? this.getMovableNodeIdForElementId(targetId) : undefined;

                const sourceSelected = sourceMovable ? selectedMovableNodeIds.has(sourceMovable) : false;
                const targetSelected = targetMovable ? selectedMovableNodeIds.has(targetMovable) : false;

                // Keep new routes for edges incident to moved (selected) nodes.
                // Restore routes for edges that only connect non-selected nodes.
                if (!sourceSelected && !targetSelected) {
                    const prevRoute = preEdgeRoutesById.get(id);
                    // Preserve empty arrays; see restoreUntargetedEdgeRoutes().
                    (element as any).routingPoints = prevRoute !== undefined ? prevRoute.map(p => ({ x: p.x, y: p.y })) : undefined;
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

    private collectNodePositions(root: GModelRoot): Map<string, { x: number; y: number }> {
        const result = new Map<string, { x: number; y: number }>();
        // Accumulate absolute positions by tracking parent offsets
        const visit = (element: any, parentAbsX: number, parentAbsY: number): void => {
            if (!element) {
                return;
            }
            // Compute this element's absolute position
            const relX = element.position?.x ?? 0;
            const relY = element.position?.y ?? 0;
            const absX = parentAbsX + relX;
            const absY = parentAbsY + relY;

            const type = element.type as string | undefined;
            if (typeof type === 'string' && type.startsWith('node:')) {
                const args = element.args as Record<string, unknown> | undefined;
                const key = (args?.[WorkflowDiagramMetadata.AST_PATH] ??
                    args?.[WorkflowDiagramMetadata.ENTITY_NAME] ??
                    args?.[WorkflowDiagramMetadata.PORT_NAME]) as unknown;
                if (typeof key === 'string' && key.trim() !== '' && element.position) {
                    result.set(key, { x: absX, y: absY });
                }
            }
            const children = element.children as any[] | undefined;
            if (Array.isArray(children)) {
                for (const child of children) {
                    visit(child, absX, absY);
                }
            }
        };
        visit(root, 0, 0);
        return result;
    }

    private collectEdgeRoutes(root: GModelRoot): Map<string, { x: number; y: number }[]> {
        const result = new Map<string, { x: number; y: number }[]>();
        const signatureCounts = this.buildEdgeSignatureCounts(root);
        const visit = (element: any): void => {
            if (!element) {
                return;
            }
            if (element instanceof GEdge) {
                const args = element.args as Record<string, unknown> | undefined;
                const key = this.edgeRouteKeyFor(args, signatureCounts);
                const routingPoints = (element as any).routingPoints as { x: number; y: number }[] | undefined;
                if (typeof key === 'string' && Array.isArray(routingPoints) && routingPoints.length > 0) {
                    result.set(key, routingPoints);
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
        return result;
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
}

