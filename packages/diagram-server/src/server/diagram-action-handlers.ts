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
    GModelElement,
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
import {
    WorkflowDiagramMetadata,
    type WorkflowDiagramModel,
    WorkflowDiagramConstants,
    WorkflowDiagramTypes,
    WORKFLOW_LAYOUT_PERSISTENCE_KEY,
    portSide
} from '@dialogram/shared';
import { LayoutPersistenceService } from '../services/layout-persistence-service';
import { placePortLabel, placePortLabels, portLabelGapOf } from './port-labels';
import { AgentStructuralEditSignal } from './agent-structural-edit-signal';
import { LoadProgressReporter, counted, isBackgroundLoad } from './load-progress';
import {
    WorkflowRerouteEdgesAvoidOverlapsOperationHandler,
    WORKFLOW_REROUTE_EDGES_AVOID_OVERLAPS_OPERATION_KIND
} from '../operations/reroute-edges-avoid-overlaps-handler';
import { clearAllEdgeRoutingPoints } from '../routing/clear-edge-routes';
import { releaseBoundaryNodeConstraints, restoreNodeLayoutOptions, runBoundaryFlowLayout } from '../operations/boundary-flow-layout';
import { perfNow } from './graph-load-perf';
import { type FreshNode, type NodeLink, type PlacedNode, placeBesideNeighbours, routeCrosses } from './incremental-placement';
import { absolutePosition, placeMembersUnder } from './group-geometry';
import {
    collectEdgeRoutes,
    isMovableNode,
    type LayoutPersistenceMeta,
    nodeLayoutKeyOf,
    persistLayout,
    restoreUnselectedLayout,
    movableNodeIdsIn,
    snapshotEdgeRoutesById,
    snapshotNodePositionsById
} from './layout-snapshot';

/**
 * Custom ModelSubmissionHandler - minimal logging version.
 */
@injectable()
export class WorkflowModelSubmissionHandler extends ModelSubmissionHandler {

    @inject(LayoutPersistenceService)
    protected layoutPersistence!: LayoutPersistenceService;

    @inject(WorkflowRerouteEdgesAvoidOverlapsOperationHandler)
    protected rerouteHandler!: WorkflowRerouteEdgesAvoidOverlapsOperationHandler;

    /**
     * Optional so the many unit tests that construct this handler directly (no DI container)
     * keep working — an absent signal simply reads as "no agent edit pending".
     */
    @inject(AgentStructuralEditSignal)
    @optional()
    protected agentEditSignal?: AgentStructuralEditSignal;

    /**
     * Where the layout says that it is running, and where the wait is said
     * to be over (see `load-progress.ts`). A first layout is the other long
     * step of a first open, after the reading, and ELK on a few hundred
     * nodes is seconds. And this handler is where a wait ends: whatever the
     * reader was waiting for, a load or the layout after an edit, its model
     * leaves from here.
     */
    @inject(LoadProgressReporter)
    @optional()
    protected loadProgress?: LoadProgressReporter;

    /** "Laying out the diagram", with how much there is of it. */
    private tellLayingOut(message: string, modelState: ModelState): void {
        if (!this.loadProgress?.telling) {
            return;
        }
        let nodes = 0;
        let edges = 0;
        const count = (element: GModelElement): void => {
            if (element instanceof GNode) {
                nodes += 1;
            } else if (element instanceof GEdge) {
                edges += 1;
            }
            element.children.forEach(count);
        };
        count(modelState.root);
        this.loadProgress.say({ message, detail: `${counted(nodes, 'node')}, ${counted(edges, 'edge')}` });
    }

    /**
     * Submit the model, and say that the wait for it is over.
     *
     * Said here because this is where the model the reader is waiting for
     * leaves, whatever came before it: said before it is sent, so that the
     * diagram keeps its indicator until the picture is there. And said when
     * the submit fails, since then no model will end it.
     */
    override async submitModelDirectly(reason?: DirtyStateChangeReason): Promise<Action[]> {
        try {
            const actions = await this.submitLaidOut(reason, false);
            this.loadProgress?.endWithModel();
            return actions;
        } catch (error) {
            this.loadProgress?.endWithoutModel();
            throw error;
        }
    }

    /**
     * Submit the model for a request nobody is waiting on: nothing is said of
     * it, and its model ends nobody's wait.
     *
     * Such a request can run alongside one the reader IS waiting on (see
     * `LoadProgressReporter`), so this is said by the caller, here, and not
     * kept as a state of the session.
     */
    async submitQuietly(reason?: DirtyStateChangeReason): Promise<Action[]> {
        return this.submitLaidOut(reason, true);
    }

    private async submitLaidOut(reason: DirtyStateChangeReason | undefined, quiet: boolean): Promise<Action[]> {
        const tellLayingOut = (message: string, state: ModelState): void => {
            if (!quiet) {
                this.tellLayingOut(message, state);
            }
        };
        const layoutEngine = (this as any).layoutEngine as LayoutEngine | undefined;
        const diagramConfiguration = (this as any).diagramConfiguration as DiagramConfiguration;
        const modelState = (this as any).modelState as ModelState;

        // 1) Optional automatic layout on first open when no persisted layout exists.
        // We do this even though layoutKind is MANUAL, but only once per session
        // and we persist the result immediately so further edits won't trigger layout.
        const layoutMeta = modelState.get(WORKFLOW_LAYOUT_PERSISTENCE_KEY) as LayoutPersistenceMeta | undefined;

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
            tellLayingOut('Laying out the diagram', modelState);
            try {
                const _elk0 = perfNow();
                // Parity with the manual auto-layout path (`dialogram.layoutBoundaryFlow`):
                // run the exact same boundary-flow routine (pin one-sided task nodes to outer
                // layers + clear stale edge routes + ELK), so the fresh-open render matches
                // what manual layout produces instead of diverging (plain ELK looked worse).
                await this.runBoundaryFlowAndPersist(modelState, layoutEngine);
                // Always-on breadcrumb: initial ELK layout is the dominant post-load server cost on a
                // fresh open, and it runs here (in the client-bounds round-trip), not in the load path.
                // eslint-disable-next-line no-console
                console.log(`[dialogram perf] layout ${layoutMeta.networkId}: elk=${Math.round(perfNow() - _elk0)}ms`);
                // A fresh-open diagram an agent just populated already got its boundary-flow layout
                // here; consume the pending flag so branch 1c does not run a second, redundant one.
                this.agentEditSignal?.consumePending();
            } catch (error) {
                console.error('[WorkflowModelSubmissionHandler] Initial layout failed:', error);
            }
        } else {
        }

        // 1c) Existing diagram (layout already persisted) gained new content after load.
        const agentEditPending = this.agentEditSignal?.isPending() === true;

        // Permanent, WORKFLOW_DIAGRAM_DEBUG-gated breadcrumb: the exact state every submit sees at
        // the branch-1c decision. Pin-points, from the host log, why an agent auto-layout did or did
        // not fire on a given submit (signal reload-confirmed? persisted layout? already laid out?).
        if (process.env.WORKFLOW_DIAGRAM_DEBUG === '1') {
            // eslint-disable-next-line no-console
            console.log(
                `[agent-auto-layout] submit net=${layoutMeta?.networkId ?? '?'} ` +
                `signalPending=${agentEditPending} hasPersistedLayout=${layoutMeta?.hasPersistedLayout} ` +
                `didInitialLayout=${layoutMeta?.didInitialLayout} hasClientBounds=${layoutMeta?.hasClientBounds} ` +
                `unpositioned=${layoutMeta?.unpositionedNodeCount ?? 0} hasLayoutEngine=${!!layoutEngine}`
            );
        }

        // 1c-i) Agent structural edit (MCP create-node / create-edge): run a full boundary-flow
        // layout so nothing is left at a parked default position and new edges are routed against a
        // fresh layout — matching the manual `dialogram.layoutBoundaryFlow` result.
        //
        // Why `agentEditPending` alone is trustworthy here (the real 0.6.0 regression fix). The
        // create is dispatched as a GLSP operation, and OperationActionHandler re-submits the model
        // immediately after every operation. Under client layout that post-op submit completes via
        // a ComputedBounds round-trip and calls this handler — but on the CURRENT, not-yet-reloaded
        // model (the create rewrote the source out-of-band; the model only re-sources on the later
        // watcher reload). A naive boolean signal was consumed by that premature post-op submit,
        // against a model without the new node/edge, so the real reload found the flag lowered and
        // skipped the layout — the node landed but nothing laid out. AgentStructuralEditSignal now
        // gates on the reload generation: `isPending()` is true only once a source reload has
        // happened SINCE the edit was marked, so the post-op submit (no reload) cannot consume it
        // and only the reload carrying the edit does. See agent-structural-edit-signal.ts.
        //
        // Also deliberately NOT gated on hasClientBounds: a refresh of an already-open diagram
        // reuses the client's node sizes and may never emit a fresh ComputedBounds; the diagram is
        // already measured (persisted layout), so boundary-flow on the current sizes is correct.
        //
        // Bursts of agent ops coalesce naturally: the editor debounces source-change reloads, so a
        // run of MCP creates collapses into a single reload → a single boundary-flow pass here.
        if (
            layoutEngine &&
            agentEditPending &&
            layoutMeta &&
            layoutMeta.hasPersistedLayout &&
            !layoutMeta.didInitialLayout &&
            layoutMeta.allowInitialLayoutPersistence
        ) {
            layoutMeta.didInitialLayout = true;
            modelState.set(WORKFLOW_LAYOUT_PERSISTENCE_KEY, layoutMeta);
            this.agentEditSignal?.consumePending();
            if (process.env.WORKFLOW_DIAGRAM_DEBUG === '1') {
                // eslint-disable-next-line no-console
                console.log(`[agent-auto-layout] branch=1c-i RUN boundary-flow net=${layoutMeta.networkId}`);
            }
            console.log('[WorkflowModelSubmissionHandler] Auto-layout after agent structural edit for:', layoutMeta.networkId);
            tellLayingOut('Laying out the diagram', modelState);
            try {
                await this.runBoundaryFlowAndPersist(modelState, layoutEngine);
                console.log('[WorkflowModelSubmissionHandler] Agent auto-layout completed');
            } catch (error) {
                console.error('[WorkflowModelSubmissionHandler] Agent auto-layout failed:', error);
            }
        }
        // 1c-ii) Otherwise (palette add / hand-edited source): keep new/unpositioned nodes parked
        // below the existing graph without disturbing already-placed nodes. Unchanged: this path
        // still waits for client bounds so the park-below geometry uses measured node sizes.
        else if (
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
                const toRoute = await this.placeUnplacedNodes(layoutMeta, modelState.root);
                if (toRoute.length > 0) {
                    layoutMeta.unroutedEdgeIds = [...new Set([...(layoutMeta.unroutedEdgeIds ?? []), ...toRoute])];
                }
                modelState.set(WORKFLOW_LAYOUT_PERSISTENCE_KEY, layoutMeta);
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
            tellLayingOut('Routing the connections', modelState);
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

        // 1d) Route the bus edges a saved layout had no route for
        // (`unroutedEdgeIds`, noted on load). The bootstrap above runs only
        // when NO route was saved; with some saved, a bus edge on a layout
        // saved before buses, or one a toggle drew, would stay a straight line
        // from port to port. Those still without a route are routed, once.
        const unroutedEdgeIds = layoutMeta?.unroutedEdgeIds;
        if (layoutMeta && unroutedEdgeIds && unroutedEdgeIds.length > 0 && layoutMeta.hasPersistedLayout && layoutMeta.hasClientBounds) {
            layoutMeta.unroutedEdgeIds = undefined;
            modelState.set(WORKFLOW_LAYOUT_PERSISTENCE_KEY, layoutMeta);
            const stillUnrouted = unroutedEdgeIds.filter(id => {
                const edge: any = modelState.index.find(id);
                return edge && !(Array.isArray(edge.routingPoints) && edge.routingPoints.length >= 2);
            });
            if (stillUnrouted.length > 0) {
                try {
                    await this.rerouteHandler.runReroute({
                        kind: WORKFLOW_REROUTE_EDGES_AVOID_OVERLAPS_OPERATION_KIND,
                        isOperation: true,
                        elementIds: stillUnrouted,
                        source: 'changeBounds',
                        preview: layoutMeta.unroutedEdgesUnsaved === true
                    });
                } catch (error) {
                    console.warn('[WorkflowModelSubmissionHandler] Routing unrouted edges failed:', error);
                }
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

        // Persisted-layout reopen path typically skips ELK, which means port-label positions
        // won't be updated by the layout engine. Ensure stable, deterministic placement.
        placePortLabels(modelState.root);

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

    /**
     * Run the shared boundary-flow layout, persist the resulting node positions + edge routes,
     * and mark the layout meta as persisted. Shared by the fresh-open initial layout (branch 1)
     * and the agent-structural-edit auto-layout (branch 1c) so both produce identical geometry
     * and persistence — no divergence between them.
     */
    private async runBoundaryFlowAndPersist(modelState: ModelState, layoutEngine: LayoutEngine): Promise<void> {
        await runBoundaryFlowLayout(modelState.root, layoutEngine);
        // From now on, treat it as persisted.
        await persistLayout(modelState, this.layoutPersistence, { layoutPerformed: true });
    }

    /**
     * Gives a place to every node the load gave none, and saves the places.
     *
     * The nodes that have one are those the load placed (`appliedPositions`:
     * the view's own layout, or its fallback's when it has none of its own),
     * not those the view's own file names: a view shown on its fallback's
     * layout has no file, and every node of it would be taken for a new one
     * and moved. Three steps, each leaving alone what has a place:
     *
     * 1. a new member of a group goes under the group's members, in the
     *    group's own coordinates, and the frame grows to hold it
     *    (`placeMembersUnder`). First, so a frame has its size before it is
     *    given a place itself;
     * 2. in a graph that grows, a new node of the root goes beside the node
     *    it is wired to (`placeGrowth`);
     * 3. what is left is parked under the diagram (`placeNewNodes`).
     *
     * What is saved is where each node is drawn, from the root's corner, as
     * every layout file holds it. Returns the edges to route.
     */
    private async placeUnplacedNodes(layoutMeta: LayoutPersistenceMeta, root: GModelRoot): Promise<string[]> {
        const { workflowFilePath, networkId } = layoutMeta;
        const applied: ReadonlyMap<string, { x: number; y: number }> = layoutMeta.appliedPositions
            ?? await this.layoutPersistence.loadLayout(workflowFilePath, networkId)
            ?? new Map<string, { x: number; y: number }>();
        const present = new Set<string>();
        const collectKeys = (element: any): void => {
            if (isMovableNode(element)) {
                const key = nodeLayoutKeyOf(element);
                if (key !== undefined) {
                    present.add(key);
                }
            }
            for (const child of (element?.children ?? []) as any[]) {
                collectKeys(child);
            }
        };
        collectKeys(root);
        // A graph that grows also loses nodes (a step taken back). The place
        // of one that is gone is not kept: the next node parked would be
        // given the same one, and two places at one point make the whole
        // layout one to throw away at the next load.
        const places = new Map<string, { x: number; y: number }>(
            [...applied].filter(([key]) => !layoutMeta.incremental || present.has(key))
        );
        const hasPlace = (element: any): boolean => {
            const key = nodeLayoutKeyOf(element);
            return key !== undefined && places.has(key);
        };
        const placedNow = new Set<any>();

        const grown = this.placeNewMembers(root, hasPlace, placedNow);
        const toRoute = layoutMeta.incremental ? this.placeGrowth(root, hasPlace, placedNow, grown) : [];
        this.placeNewNodes(root, hasPlace, placedNow);
        if (placedNow.size === 0) {
            return toRoute;
        }

        for (const element of placedNow) {
            const key = nodeLayoutKeyOf(element);
            if (key !== undefined) {
                places.set(key, absolutePosition(element));
            }
        }
        // A view that was shown on its fallback's layout has one of its own
        // from here on: its old wires keep the routes they are drawn with,
        // and the routes of the new ones are saved with it.
        const wasFallback = layoutMeta.layoutIsFallback === true;
        await this.layoutPersistence.saveLayoutImmediate(
            workflowFilePath, networkId, places, wasFallback ? collectEdgeRoutes(root) : undefined
        );
        layoutMeta.appliedPositions = places;
        if (wasFallback) {
            layoutMeta.layoutIsFallback = false;
            layoutMeta.unroutedEdgesUnsaved = false;
        }
        console.log(`[WorkflowModelSubmissionHandler] Placed ${placedNow.size} new node(s); ${toRoute.length} edge(s) to route.`);
        return toRoute;
    }

    /**
     * Step 1: the nodes without a place that sit inside another node, each
     * under the members of the node it is in. Innermost first, so a frame
     * inside a frame has its size when the outer one is fitted round it.
     * Returns the groups that grew.
     */
    private placeNewMembers(root: GModelRoot, hasPlace: (element: any) => boolean, placedNow: Set<any>): any[] {
        const containers: Array<{ container: any; members: any[] }> = [];
        const visit = (element: any): void => {
            const members: any[] = [];
            for (const child of (element?.children ?? []) as any[]) {
                visit(child);
                if (element !== root && isMovableNode(child) && nodeLayoutKeyOf(child) !== undefined && !hasPlace(child)) {
                    members.push(child);
                }
            }
            if (members.length > 0) {
                containers.push({ container: element, members });
            }
        };
        visit(root);
        const grown: any[] = [];
        for (const { container, members } of containers) {
            for (const group of placeMembersUnder(container, members)) {
                if (!grown.includes(group)) {
                    grown.push(group);
                }
            }
            members.forEach(member => placedNow.add(member));
        }
        return grown;
    }

    /**
     * Step 2, in a graph that grows: puts each node of the root that has no
     * place beside the node it is wired to (incremental-placement.ts) and
     * leaves every other node where it is.
     *
     * Returns the edges to route: those of the new nodes, those whose saved
     * route a new node now sits on, and those of a group that grew, their
     * route cleared.
     */
    private placeGrowth(root: GModelRoot, hasPlace: (element: any) => boolean, placedNow: Set<any>, grown: readonly any[]): string[] {
        const placed: PlacedNode[] = [];
        const fresh: Array<FreshNode & { element: any }> = [];
        const topNodes = new Map<string, any>();
        for (const child of ((root as any).children ?? []) as any[]) {
            if (!isMovableNode(child) || nodeLayoutKeyOf(child) === undefined) {
                continue;
            }
            const id = String(child.id);
            const width = Number(child.size?.width) || 160;
            const height = Number(child.size?.height) || 60;
            topNodes.set(id, child);
            if (hasPlace(child)) {
                placed.push({ id, x: Number(child.position?.x) || 0, y: Number(child.position?.y) || 0, width, height });
            } else {
                fresh.push({ id, element: child, width, height });
            }
        }

        // Each wire between two of the root's nodes, with the height of its port inside each.
        const index = new GModelIndex();
        index.indexRoot(root);
        const endOf = (portId: unknown): { node: string; y: number; inside: any[] } | undefined => {
            let element: any = typeof portId === 'string' ? index.find(portId) : undefined;
            if (!element) {
                return undefined;
            }
            // The middle of the port, down from the top of the root's node it is on.
            let y = (Number(element.size?.height) || 0) / 2;
            const inside: any[] = [];
            while (element && !topNodes.has(String(element.id))) {
                y += Number(element.position?.y) || 0;
                inside.push(element);
                element = element.parent;
            }
            return element ? { node: String(element.id), y, inside } : undefined;
        };
        const links: NodeLink[] = [];
        const edges: any[] = [];
        const collectEdges = (element: any): void => {
            if (element instanceof GEdge || (typeof element?.type === 'string' && element.type.startsWith('edge'))) {
                edges.push(element);
            }
            for (const child of (element?.children ?? []) as any[]) {
                collectEdges(child);
            }
        };
        collectEdges(root);
        for (const edge of edges) {
            const from = endOf(edge.sourceId);
            const to = endOf(edge.targetId);
            if (from && to) {
                links.push({ from: from.node, to: to.node, fromY: from.y, toY: to.y });
            }
        }

        // With no node of the root placed there is nothing to be beside: step 3 parks them.
        const positions = fresh.length > 0 && placed.length > 0
            ? placeBesideNeighbours(placed, fresh, links)
            : new Map<string, { x: number; y: number }>();
        const freshIds = new Set<string>();
        const boxes: Array<{ x: number; y: number; width: number; height: number }> = [];
        for (const node of fresh) {
            const position = positions.get(node.id);
            if (!position) {
                continue;
            }
            node.element.position = { x: position.x, y: position.y };
            placedNow.add(node.element);
            freshIds.add(node.id);
            boxes.push({ x: position.x, y: position.y, width: node.width, height: node.height });
        }
        // A group of the root that grew round a new member covers more than it did.
        const grownGroups = new Set<any>(grown);
        const grownTops = new Set<string>();
        for (const group of grown) {
            const id = String(group.id);
            if (topNodes.has(id) && !freshIds.has(id)) {
                grownTops.add(id);
                boxes.push({
                    x: Number(group.position?.x) || 0, y: Number(group.position?.y) || 0,
                    width: Number(group.size?.width) || 0, height: Number(group.size?.height) || 0
                });
            }
        }
        if (freshIds.size === 0 && placedNow.size === 0) {
            return [];
        }

        const toRoute: string[] = [];
        for (const edge of edges) {
            const ends = [endOf(edge.sourceId), endOf(edge.targetId)];
            const points = Array.isArray(edge.routingPoints) ? edge.routingPoints as Array<{ x: number; y: number }> : [];
            // At a new node of the root, at a new member inside a group, or at
            // a port on the frame of a group that grew (the ports on its right
            // went with its edge).
            const touches = ends.some(end => end !== undefined && (
                freshIds.has(end.node)
                || end.inside.some(element => placedNow.has(element))
                || (end.inside.length > 0 ? grownGroups.has(end.inside[0].parent) : grownTops.has(end.node))
            ));
            // A wire from outside a group that grew to inside it crosses a frame that moved.
            const tops = ends.map(end => end?.node);
            const crossesFrame = tops[0] !== tops[1] && tops.some(top => top !== undefined && grownTops.has(top));
            // A wire wholly inside a group that grew lies in its box and is not under anything new for that.
            const within = tops[0] !== undefined && tops[0] === tops[1] && grownTops.has(tops[0]);
            const under = !within && points.length >= 2 && boxes.some(box => routeCrosses(points, box));
            if (touches || crossesFrame || under) {
                edge.routingPoints = [];
                toRoute.push(String(edge.id));
            }
        }
        return toRoute;
    }

    /**
     * Step 3: parks the nodes of the root still without a place in rows
     * under the diagram, without disturbing the nodes that have one.
     */
    private placeNewNodes(root: GModelRoot, hasPlace: (element: any) => boolean, placedNow: Set<any>): void {
        const DEFAULT_NODE_WIDTH = 160;
        const DEFAULT_NODE_HEIGHT = 60;
        const SPACING_X = 80;
        const SPACING_Y = 80;
        const WRAP_COLS = 4;

        // The diagram as it stands: every node of the root with a place, the ones just given one too.
        let left = Infinity;
        let foot = -Infinity;
        const newNodes: Array<{ element: any; width: number; height: number }> = [];
        for (const child of ((root as any).children ?? []) as any[]) {
            if (!isMovableNode(child) || nodeLayoutKeyOf(child) === undefined) {
                continue;
            }
            const width = Number(child.size?.width) || DEFAULT_NODE_WIDTH;
            const height = Number(child.size?.height) || DEFAULT_NODE_HEIGHT;
            if (hasPlace(child) || placedNow.has(child)) {
                left = Math.min(left, Number(child.position?.x) || 0);
                foot = Math.max(foot, (Number(child.position?.y) || 0) + height);
            } else {
                newNodes.push({ element: child, width, height });
            }
        }
        if (newNodes.length === 0) {
            return;
        }

        const startX = Number.isFinite(left) ? left : 20;
        let curX = startX;
        let curY = Number.isFinite(foot) ? foot + SPACING_Y : 20;
        let rowHeight = 0;
        let colIdx = 0;
        for (const node of newNodes) {
            // A node of the root: its position is the one saved, from the root's corner.
            node.element.position = { x: curX, y: curY };
            placedNow.add(node.element);
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
/**
 * Handed back for a request that reported no progress, so the finishing step can
 * tell "there was nothing to clear" from "clear it" by identity — a fact about
 * THIS request, unlike a field, which by then describes whichever request touched
 * it last.
 */
const SILENT_LOAD = { update: () => undefined, end: () => undefined };

@injectable()
export class WorkflowRequestModelActionHandler extends RequestModelActionHandler {
    /**
     * Whether the request being STARTED should report progress.
     *
     * Read only by `reportModelLoading`, and only in the same synchronous step that
     * set it. Suppression must not be a fact about the handler that outlives a
     * request: `reportModelLoadingFinished` runs after an await, and a flag another
     * request had flipped by then would skip ending a monitor THIS one created —
     * pinning "Model loading in progress" until the tab is closed. What is suppressed
     * is carried by the monitor instead (there simply isn't one), so finishing is
     * unconditional and cannot be talked out of it.
     */
    private startingSilently = false;

    /**
     * The host shows what a load is doing in the diagram itself (see
     * `load-progress.ts`). Where it does, "Model loading in progress" is a
     * second, vaguer notice of the same wait, in another corner of the same
     * canvas, and is not started: one indicator, which says what is
     * happening.
     */
    @inject(LoadProgressReporter)
    @optional()
    protected loadProgress?: LoadProgressReporter;

    /**
     * Load, as a request the reader is waiting on or as one they are not.
     *
     * One nobody is waiting on says nothing and ends nothing: its model can
     * arrive in the middle of a load the reader IS waiting on, whose layout
     * is still to come. One the reader is waiting on says so when it fails
     * anywhere on the way, since then no model will.
     */
    override async execute(action: RequestModelAction): Promise<Action[]> {
        try {
            return await this.load(action);
        } catch (error) {
            if (!isBackgroundLoad(action.requestId, action.options)) {
                this.loadProgress?.endWithoutModel();
            }
            throw error;
        }
    }

    private async load(action: RequestModelAction): Promise<Action[]> {
        const requestId = action.requestId ?? '';
        const isPolling = requestId.startsWith('refresh-during-run-') ||
            requestId.startsWith('refresh-live-overlay-') ||
            requestId.startsWith('refresh-queue-visibility-') ||
            requestId.startsWith('refresh-agent-ctx-') ||
            requestId.startsWith('refresh-caller-refs-');
        // One reading of the flag with `isBackgroundLoad`, which is what
        // keeps the storage silent for the load this path submits quietly.
        const isAgentCtxOnly = Boolean(action.options?.agentContextOnly);
        this.startingSilently = isPolling || this.loadProgress?.listened === true;
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
                // Quietly: this request is nobody's wait, and it can run
                // while the reader's own load is still on its way to a model.
                const submission = this.submissionHandler as ModelSubmissionHandler & {
                    submitQuietly?: () => Promise<Action[]>;
                };
                const actions = await (submission.submitQuietly
                    ? submission.submitQuietly()
                    : submission.submitModelDirectly());
                console.log(`[WorkflowRequestModelActionHandler] agent-ctx-only: submitted directly, ${actions.length} actions`);
                return actions;
            }
            return await super.execute(action);
        } finally {
            this.startingSilently = false;
        }
    }

    /**
     * Start progress reporting — unless this request is a silent one, in which case
     * nothing is dispatched and nothing is started; the caller gets
     * {@link SILENT_LOAD} to hand back when it finishes.
     */
    protected override reportModelLoading(message: string) {
        if (this.startingSilently) {
            return SILENT_LOAD;
        }
        return super.reportModelLoading(message);
    }

    /**
     * End progress reporting for whatever `reportModelLoading` returned.
     *
     * The decision is read off the MONITOR, never off handler state: only a request
     * that started silently gets {@link SILENT_LOAD} back, and every other request
     * clears unconditionally. A flag consulted here instead would be read after an
     * await — by which time it describes some other request — and skipping the clear
     * for a load that did start one pins "Model loading in progress" until the tab
     * is closed.
     */
    protected override reportModelLoadingFinished(monitor?: unknown): void {
        if (monitor === SILENT_LOAD) {
            return;
        }
        super.reportModelLoadingFinished(monitor as any);
    }

    /**
     * Always clear the "Model loading in progress" status, even when the load fails.
     *
     * The base handler starts progress reporting by dispatching a sticky `StatusAction`
     * (severity INFO) and only clears it (a second `StatusAction`, severity NONE) once the
     * load has completed. Its own `handleModelLoadingError` ends the progress monitor but
     * rethrows WITHOUT dispatching that clearing action — so a failed source load leaves the
     * notification pinned on screen forever. Routing the error through
     * `reportModelLoadingFinished` (which dispatches the clearing NONE status and ends the
     * monitor) before rethrowing guarantees the notification is disposed on every path.
     */
    protected override handleModelLoadingError(error: unknown, monitor?: unknown): void {
        this.reportModelLoadingFinished(monitor);
        throw error;
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
/**
 * Hard cap on client-bounds measurement passes before the node sizes are frozen,
 * even if consecutive measurements never converge. Bounds the worst-case number of
 * extra RequestBounds round-trips on open (font-load oscillation) while guaranteeing
 * the diagram always reaches a stable, laid-out state. Fonts normally settle within
 * one extra pass, so this cap is only hit in pathological cases.
 */
export const MAX_SIZE_MEASURE_PASSES = 4;

/**
 * Ignore sub-epsilon size deltas (selection stroke / focus ring / subpixel rounding)
 * when deciding whether two consecutive CLIENT measurements agree.
 */
export const RESIZE_EPSILON_PX = 4;

type BoundsPassNodeDecision =
    | 'accepted-grow'
    | 'accepted-shrink'
    | 'no-change'
    | 'rejected-zero'
    | 'rejected-frozen';

interface BoundsPassNodeEntry {
    id: string;
    newSize: { width: number; height: number };
    decision: BoundsPassNodeDecision;
}

/** Per-pass accumulator populated by {@link WorkflowComputedBoundsActionHandler.applyBounds}. */
interface BoundsPassResult {
    /**
     * A node's client-reported size differs from the previous pass's client report
     * (measurement still moving). Computed against the last CLIENT report, not the
     * model — a report that merely echoes the already-assigned model size does NOT
     * count as "changed", which is what breaks the echo-inflation feedback loop.
     */
    anyNodeSizeChanged: boolean;
    /** A node reported a zero/partial size — never treat such a pass as "stable". */
    sawInvalidMeasurement: boolean;
    nodes: BoundsPassNodeEntry[];
}

/**
 * Collect this pass's raw CLIENT-reported node sizes (the settling measurements),
 * keyed by element id. Zero/partial ('rejected-zero') and post-freeze
 * ('rejected-frozen') entries are excluded — only genuine measurements participate
 * in convergence.
 */
function collectNodeReports(passResult: BoundsPassResult): Record<string, { width: number; height: number }> {
    const reports: Record<string, { width: number; height: number }> = {};
    for (const entry of passResult.nodes) {
        if (entry.decision === 'accepted-grow' || entry.decision === 'accepted-shrink') {
            reports[entry.id] = { width: entry.newSize.width, height: entry.newSize.height };
        }
    }
    return reports;
}

/**
 * Two client reports "agree" when they cover the same node ids and every dimension
 * matches within {@link RESIZE_EPSILON_PX}. Used for two-consecutive-equal
 * convergence. A missing previous report never agrees (forces a second pass).
 */
function nodeReportsAgree(
    current: Record<string, { width: number; height: number }>,
    previous: Record<string, { width: number; height: number }> | undefined
): boolean {
    if (!previous) {
        return false;
    }
    const currentIds = Object.keys(current);
    const previousIds = Object.keys(previous);
    if (currentIds.length !== previousIds.length) {
        return false;
    }
    for (const id of currentIds) {
        const a = current[id];
        const b = previous[id];
        if (!b) {
            return false;
        }
        if (Math.abs(a.width - b.width) >= RESIZE_EPSILON_PX || Math.abs(a.height - b.height) >= RESIZE_EPSILON_PX) {
            return false;
        }
    }
    return true;
}

@injectable()
export class WorkflowComputedBoundsActionHandler implements ActionHandler {
    readonly actionKinds = [ComputedBoundsAction.KIND];

    @inject(ModelSubmissionHandler)
    protected submissionHandler!: ModelSubmissionHandler;

    @inject(ModelState)
    protected modelState!: ModelState;

    @inject(GModelSerializer)
    protected serializer!: GModelSerializer;

    private get enableDiagramDebug(): boolean {
        return process.env.WORKFLOW_DIAGRAM_DEBUG === '1';
    }

    /** Where a wait that ends in the sizes the diagram measured is said to be over, when applying them fails. */
    @inject(LoadProgressReporter)
    @optional()
    protected loadProgress?: LoadProgressReporter;

    async execute(action: ComputedBoundsAction): Promise<Action[]> {
        try {
            return await this.applyComputedBounds(action);
        } catch (error) {
            // The submit that follows the sizes is what ends a wait; a throw
            // before it would leave the diagram counting the seconds of a
            // load that is over.
            this.loadProgress?.endWithoutModel();
            throw error;
        }
    }

    private async applyComputedBounds(action: ComputedBoundsAction): Promise<Action[]> {
        const model = this.modelState.root;
        // `ComputedBoundsAction.revision` is optional in the GLSP protocol. Most clients include it,
        // but if it's missing we still want to apply bounds; otherwise client-side layouting may
        // never converge (no follow-up UpdateModel/SetModel round-trip).
        const hasActionRevision = action.revision !== undefined && action.revision !== null;
        const hasModelRevision = model.revision !== undefined && model.revision !== null;
        const revisionMatches = !hasActionRevision || !hasModelRevision || action.revision === model.revision;

        if (revisionMatches) {
            const passResult: BoundsPassResult = {
                anyNodeSizeChanged: false,
                sawInvalidMeasurement: false,
                nodes: []
            };
            await this.applyBounds(model, action, passResult);

            const layoutMeta = this.modelState.get(WORKFLOW_LAYOUT_PERSISTENCE_KEY) as LayoutPersistenceMeta | undefined;

            // Node sizes are SERVER-AUTHORITATIVE on every path.
            //
            // WorkflowDiagramModelSource computes each node's size deterministically from its
            // ports, port labels and header label, and places the ports centred on the border
            // (input at x=-portWidth/2, output at x=nodeWidth-portWidth/2). That estimate is what a persisted
            // reopen renders, verbatim, so it is already the geometry users see most of the time.
            // A fresh open used to instead COMMIT the client's measurement and re-anchor the ports
            // inside the committed width — which made the two paths disagree. The client's
            // measurement is getBBox() of the node's <g>, so it includes the ports AND the italic
            // type-footer drawn below and centred on the node; that footer is routinely wider than
            // the node itself, so the committed size overshot the estimate by far more than the
            // 2*portWidth the re-anchor formula assumes. Net effect: nodes visibly grew on first
            // render, and a layout saved from that render recorded port anchors that no reopen
            // could reproduce. Trusting the estimate on both paths makes fresh-open and
            // persisted-open geometry identical by construction.
            //
            // The settle loop below is retained, but purely as the font-load gate (GLSP 2.7 race):
            // it holds the initial ELK layout until two consecutive client reports agree, which is
            // when web fonts have loaded and the PORT LABEL sizes recorded by applyBounds are
            // trustworthy — ELK places labels from those. The reports themselves are never baked
            // into a node.
            //
            // Persisted-layout verbatim path: a saved layout must render byte-stable across opens,
            // and it has already been measured, so there is nothing to wait for — freeze
            // immediately and submit once, with no RequestBounds re-request. `applyBounds` (already
            // run above) only RECORDS node reports and leaves node/port positions untouched, so
            // nothing has moved at this point. Port-label late-measurement still runs there (labels
            // can measure 0 before fonts load); that is label-only and moves no node, port or edge
            // endpoint.
            if (layoutMeta && !layoutMeta.hasClientBounds && layoutMeta.hasPersistedLayout) {
                layoutMeta.hasClientBounds = true;
                this.modelState.set(WORKFLOW_LAYOUT_PERSISTENCE_KEY, layoutMeta);
                if (this.enableDiagramDebug) {
                    this.logBoundsPass(layoutMeta.networkId, layoutMeta.sizeMeasurePassCount ?? 0, { frozen: true, stabilized: true, capped: false }, passResult);
                }
                return this.submissionHandler.submitModelDirectly();
            }

            if (layoutMeta && !layoutMeta.hasClientBounds) {
                const passCount = (layoutMeta.sizeMeasurePassCount ?? 0) + 1;
                layoutMeta.sizeMeasurePassCount = passCount;

                const currentReports = collectNodeReports(passResult);
                const lastReports = layoutMeta.lastClientNodeSizes;
                // A report echoing the last CLIENT report (within epsilon) is "unchanged".
                const reportsChanged = !nodeReportsAgree(currentReports, lastReports);
                passResult.anyNodeSizeChanged = reportsChanged;
                layoutMeta.lastClientNodeSizes = currentReports;

                const haveReports = Object.keys(currentReports).length > 0;
                const stabilized = haveReports && !reportsChanged && !passResult.sawInvalidMeasurement;
                const capped = passCount >= MAX_SIZE_MEASURE_PASSES;

                if (this.enableDiagramDebug) {
                    this.logBoundsPass(layoutMeta.networkId, passCount, { frozen: false, stabilized, capped }, passResult);
                }

                if (!stabilized && !capped) {
                    // Not settled yet: re-measure. The model is never mutated with a report, so
                    // the re-served schema carries the server baseline and the client re-measures
                    // the same intrinsic geometry instead of an ever-growing echo. The original
                    // RequestModelAction stays pending (its SetModel is emitted once we call
                    // submitModelDirectly below), so no layout work happens on a partial
                    // measurement.
                    this.modelState.set(WORKFLOW_LAYOUT_PERSISTENCE_KEY, layoutMeta);
                    const rootSchema = this.serializer.createSchema(model);
                    return [RequestBoundsAction.create(rootSchema)];
                }

                // Settled (or capped): fonts have loaded, so the port-label sizes applyBounds
                // recorded are trustworthy and the initial ELK layout may run. Node sizes stay at
                // the server estimate — see the note above.
                layoutMeta.hasClientBounds = true;
                this.modelState.set(WORKFLOW_LAYOUT_PERSISTENCE_KEY, layoutMeta);
            } else if (this.enableDiagramDebug) {
                // Post-stabilization pass (sizes are frozen): still log for diagnostics.
                this.logBoundsPass(layoutMeta?.networkId, layoutMeta?.sizeMeasurePassCount ?? 0, { frozen: true, stabilized: true, capped: false }, passResult);
            }

            return this.submissionHandler.submitModelDirectly();
        }

        return [];
    }

    /** Cheap, permanent diagnostics (WORKFLOW_DIAGRAM_DEBUG=1) for the size-stabilization loop. */
    private logBoundsPass(
        networkId: string | undefined,
        passCount: number,
        state: { frozen: boolean; stabilized: boolean; capped: boolean },
        passResult: BoundsPassResult
    ): void {
        // eslint-disable-next-line no-console
        console.debug(
            `[ComputedBounds] net=${networkId ?? '?'} pass=${passCount} ${state.frozen ? 'frozen' : state.stabilized ? 'stabilized' : state.capped ? 'capped' : 'measuring'} ` +
                `changed=${passResult.anyNodeSizeChanged} invalid=${passResult.sawInvalidMeasurement} ` +
                `nodes=${JSON.stringify(passResult.nodes)}`
        );
    }

    protected async applyBounds(root: GModelRoot, action: ComputedBoundsAction, passResult?: BoundsPassResult): Promise<void> {
        const index = this.modelState.index;

        const layoutMeta = this.modelState.get(WORKFLOW_LAYOUT_PERSISTENCE_KEY) as LayoutPersistenceMeta | undefined;

        const hasPersistedLayout = layoutMeta?.hasPersistedLayout === true;

        const portLabelGapPx = portLabelGapOf(root);

        // A measured label goes back beside its port, the way every submit
        // places it (port-labels.ts); one not measured yet is left alone.
        const reanchorPortLabelToPort = (label: any): void => {
            const parentPort = label?.parent as any;
            if (!(parentPort?.size?.width > 0) || !(parentPort?.size?.height > 0)) {
                return;
            }
            if (!(label.size?.width > 0) || !(label.size?.height > 0)) {
                return;
            }
            placePortLabel(label, parentPort, portLabelGapPx);
        };

                // Only accept client-measured node size expansions during the initial bounds sync.
                // After that, client bounds can fluctuate due to selection/hover styling (stroke, focus rings),
                // and we must keep the model stable to avoid "creeping" node sizes.
                const allowClientNodeResize = !layoutMeta?.hasClientBounds;

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

                // For nodes: during the settling window (allowClientNodeResize ===
                // !hasClientBounds) we RECORD the client-measured size but never bake it into
                // the model — node sizes are server-authoritative (see the note in execute).
                // The report exists only so `execute` can compare consecutive CLIENT reports
                // and tell when web fonts have finished loading. It must not be applied: the
                // client renders the node's <rect> at its assigned size and getBBox() returns
                // that size plus the port and type-footer overhang, so applying a report both
                // inflates the node past the server estimate and, if repeated, grows it without
                // bound. Keeping the node at its fixed baseline also makes every settling pass
                // report the SAME intrinsic bbox, which is what lets convergence terminate.
                // The >0 guard preserves the documented zero-size protection: a partial/zero
                // measurement is recorded as invalid and forces another measurement pass.
                const isNode = element.type?.startsWith('node:');
                if (isNode && 'size' in element) {
                    const existingSize = (element as any).size;
                    if (existingSize && existingSize.width > 0 && existingSize.height > 0) {
                        if (allowClientNodeResize && bounds.newSize) {
                            const nw = bounds.newSize.width;
                            const nh = bounds.newSize.height;
                            if (nw > 0 && nh > 0) {
                                const nextWidth = Math.max(1, Math.ceil(nw));
                                const nextHeight = Math.max(1, Math.ceil(nh));
                                const dw = nextWidth - existingSize.width;
                                // Record the raw client report WITHOUT mutating the model.
                                // Convergence (in execute) compares this report against the
                                // previous pass's report, not against the model, so a report
                                // that merely echoes the assigned size never counts as growth.
                                passResult?.nodes.push({
                                    id: bounds.elementId,
                                    newSize: { width: nextWidth, height: nextHeight },
                                    decision: dw >= 0 ? 'accepted-grow' : 'accepted-shrink'
                                });
                            } else {
                                // Incomplete/zero measurement: never apply; force a re-measure.
                                passResult?.nodes.push({
                                    id: bounds.elementId,
                                    newSize: { width: nw, height: nh },
                                    decision: 'rejected-zero'
                                });
                                if (passResult) {
                                    passResult.sawInvalidMeasurement = true;
                                }
                            }
                        } else if (bounds.newSize) {
                            // Sizes are frozen (post-stabilization). Reject client fluctuations.
                            passResult?.nodes.push({
                                id: bounds.elementId,
                                newSize: { width: bounds.newSize.width, height: bounds.newSize.height },
                                decision: 'rejected-frozen'
                            });
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
        const selectedMovableNodeIds = movableNodeIdsIn(this.modelState.index, operation.elementIds);
        const hasSelection = selectedMovableNodeIds.size > 0;

        const preNodePositionsById = hasSelection ? snapshotNodePositionsById(this.modelState.root) : undefined;
        const preEdgeRoutesById = hasSelection ? snapshotEdgeRoutesById(this.modelState.root) : undefined;

        // When a user triggers a manual auto-layout, we want ELK to fully recompute edge routing.
        // Existing routing points (from previous ELK runs or manual routing) can otherwise
        // constrain routing and lead to stale/unstable layouts.
        clearAllEdgeRoutingPoints(this.modelState.root);

        // What makes this the COMPACT layout rather than a second boundary-flow
        // one: the network's input and output pills are released from their
        // first/last columns and placed beside whatever they connect to. On
        // the reference network that is 16% fewer crossings, 40% fewer
        // full-width edges and 15% less edge length — paid for by giving up
        // the interface being readable down the two edges of the diagram.
        //
        // The pins are restored straight afterwards: they belong to the model,
        // not to one layout run, so the boundary-flow layout still gets them.
        const previousBoundaryOptions = releaseBoundaryNodeConstraints(this.modelState.root);
        try {
            await this.layoutEngine?.layout(operation);
        } finally {
            restoreNodeLayoutOptions(this.modelState.root, previousBoundaryOptions);
        }

        if (hasSelection && preNodePositionsById && preEdgeRoutesById) {
            restoreUnselectedLayout(this.modelState.index, this.modelState.root, selectedMovableNodeIds, preNodePositionsById, preEdgeRoutesById);
        }

        await persistLayout(this.modelState, this.layoutPersistence, { layoutPerformed: true });
    }

    // clearAllEdgeRoutingPoints extracted to src/glsp/routing/clear-edge-routes.ts
}

