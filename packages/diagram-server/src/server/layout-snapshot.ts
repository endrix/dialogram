/**
 * The layout as the layout file stores it, read off the GModel.
 *
 * Every handler that lays nodes out or routes edges ends the same way: walk the
 * model, key each node by its AST path (or its name), key each edge the way
 * `applyPersistedEdgeRoutes` reads it back, and save both. The layout handlers
 * also keep the unselected part of the diagram where it was. These are those
 * steps, written once.
 */
import { GEdge, GModelIndex, GModelRoot, GPort, ModelState } from '@eclipse-glsp/server';
import { WorkflowDiagramMetadata, WorkflowDiagramTypes, WORKFLOW_LAYOUT_PERSISTENCE_KEY, WORKFLOW_NETWORK_MODEL_KEY } from '@dialogram/shared';
import type { WorkflowDiagramModel } from '@dialogram/shared';
import { buildEdgeSignatureCounts, edgeRouteKeyFor, type Point } from '../routing/persisted-edge-routes';
import type { LayoutPersistenceService } from '../services/layout-persistence-service';
import { layoutTargetOf } from './layout-target';
import { keptPortOrderChanges, type PortOrderChanges } from '../model/definition-port-order';

export type { Point };

/** What the model state keeps about the diagram's layout file. */
export interface LayoutPersistenceMeta {
    workflowFilePath: string;
    networkId: string;
    hasPersistedLayout: boolean;
    hasPersistedEdgeRoutes: boolean;
    didInitialLayout: boolean;
    hasClientBounds: boolean;
    allowInitialLayoutPersistence: boolean;
    unpositionedNodeCount?: number;
    sizeMeasurePassCount?: number;
    lastClientNodeSizes?: Record<string, { width: number; height: number }>;
    rerouteEdgeIds?: string[];
    /** Bus edges the saved routes did not cover on load, routed once the client has measured. */
    unroutedEdgeIds?: string[];
    /** Route `unroutedEdgeIds` without saving: the view shows its fallback's layout. */
    unroutedEdgesUnsaved?: boolean;
    /** The graph grows a step at a time (`graph.meta.incremental`): new nodes go beside their neighbours. */
    incremental?: boolean;
    /**
     * The places the load gave the nodes, by layout key, absolute: the view's
     * own layout, or its fallback's when it has none of its own. What a
     * growing graph's new nodes are placed among: the view's own file may
     * hold none of them.
     */
    appliedPositions?: ReadonlyMap<string, Point>;
    /** Those places are the fallback's: the view has no layout of its own yet. */
    layoutIsFallback?: boolean;
    [key: string]: unknown;
}

/**
 * The key the layout file stores a node's position under: its AST path, else
 * its entity name, else its port name; `undefined` for a node with none.
 */
export function nodeLayoutKeyOf(element: any): string | undefined {
    const args = element?.args as Record<string, unknown> | undefined;
    const key = (args?.[WorkflowDiagramMetadata.AST_PATH]
        ?? args?.[WorkflowDiagramMetadata.ENTITY_NAME]
        ?? args?.[WorkflowDiagramMetadata.PORT_NAME]) as unknown;
    return typeof key === 'string' && key.trim() !== '' ? key : undefined;
}

/** A node the layout may move: any `node:*` element. */
export function isMovableNode(element: any): boolean {
    const type = element?.type as string | undefined;
    return typeof type === 'string' && type.startsWith('node:');
}

/** The id of the nearest movable node at or above `elementId`. */
export function movableNodeIdFor(index: GModelIndex, elementId: string): string | undefined {
    let current: any = index.find(elementId);
    while (current) {
        if (isMovableNode(current)) {
            return String(current.id);
        }
        current = current.parent;
    }
    return undefined;
}

/**
 * The movable nodes a selection names: each selected element's node, and both
 * ends of each selected edge.
 */
export function movableNodeIdsIn(index: GModelIndex, elementIds: string[] | undefined): Set<string> {
    const result = new Set<string>();
    for (const id of Array.isArray(elementIds) ? elementIds : []) {
        const movable = movableNodeIdFor(index, id);
        if (movable) {
            result.add(movable);
        }
        const element: any = index.find(id);
        const type = element?.type as string | undefined;
        const isEdge = element instanceof GEdge || (typeof type === 'string' && type.startsWith('edge:'));
        if (isEdge) {
            for (const endId of [element.sourceId, element.targetId]) {
                const endMovable = typeof endId === 'string' ? movableNodeIdFor(index, endId) : undefined;
                if (endMovable) {
                    result.add(endMovable);
                }
            }
        }
    }
    return result;
}

function walk(root: any, visit: (element: any) => void): void {
    const step = (element: any): void => {
        if (!element) {
            return;
        }
        visit(element);
        const children = element.children as any[] | undefined;
        if (Array.isArray(children)) {
            for (const child of children) {
                step(child);
            }
        }
    };
    step(root);
}

/** Every movable node's relative position by element id, `undefined` where it has none. */
export function snapshotNodePositionsById(root: GModelRoot): Map<string, Point | undefined> {
    const result = new Map<string, Point | undefined>();
    walk(root, element => {
        if (isMovableNode(element)) {
            const pos = element.position as { x?: number; y?: number } | undefined;
            result.set(String(element.id), pos ? { x: pos.x ?? 0, y: pos.y ?? 0 } : undefined);
        }
    });
    return result;
}

/** Every edge's routing points by element id, `undefined` where it has none. */
export function snapshotEdgeRoutesById(root: GModelRoot): Map<string, Point[] | undefined> {
    const result = new Map<string, Point[] | undefined>();
    walk(root, element => {
        if (element instanceof GEdge) {
            const routingPoints = (element as any).routingPoints as Point[] | undefined;
            result.set(String(element.id), Array.isArray(routingPoints) ? routingPoints.map(p => ({ x: p.x, y: p.y })) : undefined);
        }
    });
    return result;
}

/**
 * Put every node outside `selectedMovableNodeIds`, and every edge with neither
 * end in it, back where the two snapshots had them: a layout of a selection
 * moves the selection alone.
 */
export function restoreUnselectedLayout(
    index: GModelIndex,
    root: GModelRoot,
    selectedMovableNodeIds: Set<string>,
    preNodePositionsById: Map<string, Point | undefined>,
    preEdgeRoutesById: Map<string, Point[] | undefined>
): void {
    walk(root, element => {
        if (isMovableNode(element)) {
            const id = String(element.id);
            if (!selectedMovableNodeIds.has(id)) {
                const prev = preNodePositionsById.get(id);
                element.position = prev ? { x: prev.x, y: prev.y } : undefined;
            }
        }
        if (element instanceof GEdge) {
            const sourceId = (element as any).sourceId as string | undefined;
            const targetId = (element as any).targetId as string | undefined;
            const sourceMovable = typeof sourceId === 'string' ? movableNodeIdFor(index, sourceId) : undefined;
            const targetMovable = typeof targetId === 'string' ? movableNodeIdFor(index, targetId) : undefined;
            const sourceSelected = sourceMovable ? selectedMovableNodeIds.has(sourceMovable) : false;
            const targetSelected = targetMovable ? selectedMovableNodeIds.has(targetMovable) : false;
            if (!sourceSelected && !targetSelected) {
                const prevRoute = preEdgeRoutesById.get(String(element.id));
                (element as any).routingPoints = prevRoute !== undefined ? prevRoute.map(p => ({ x: p.x, y: p.y })) : undefined;
            }
        }
    });
}

/**
 * Every positioned node's absolute position, keyed as the layout file keys
 * nodes: its AST path, else its entity name, else its port name.
 */
export function collectNodePositions(root: GModelRoot): Map<string, Point> {
    const result = new Map<string, Point>();
    const visit = (element: any, parentAbsX: number, parentAbsY: number): void => {
        if (!element) {
            return;
        }
        const absX = parentAbsX + (element.position?.x ?? 0);
        const absY = parentAbsY + (element.position?.y ?? 0);
        if (isMovableNode(element)) {
            const key = nodeLayoutKeyOf(element);
            if (key !== undefined && element.position) {
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

/**
 * Every routed edge's polyline, keyed as `applyPersistedEdgeRoutes` looks it
 * up: by endpoint signature, with the AST path added where the signature
 * repeats. Any routing points count: the loader rebuilds a lone bend into a
 * full polyline between the ports.
 */
export function collectEdgeRoutes(root: GModelRoot): Map<string, Point[]> {
    const result = new Map<string, Point[]>();
    const signatureCounts = buildEdgeSignatureCounts(root);
    walk(root, element => {
        // A transition of an automaton has no route of its own to keep.
        if (element instanceof GEdge && element.type !== WorkflowDiagramTypes.EDGE_TRANSITION) {
            const key = edgeRouteKeyFor(element.args as Record<string, unknown> | undefined, signatureCounts);
            const routingPoints = (element as any).routingPoints as Point[] | undefined;
            if (typeof key === 'string' && Array.isArray(routingPoints) && routingPoints.length > 0) {
                result.set(key, routingPoints);
            }
        }
    });
    return result;
}

/**
 * Save the model's layout to the diagram's layout file and note it in the
 * model state. `layoutPerformed`: the whole layout is now persisted, not only
 * the routes. `keepPersistedPositions`: a route-only change, so the positions
 * already on disk, under their stable keys, stand where there are any.
 * `noteInMeta: false`: save without touching the model state's layout meta.
 * Reset Routes and the reroute save that way: lowering "has persisted edge
 * routes" would arm the bootstrap reroute that redraws what was just cleared.
 */
export async function persistLayout(
    modelState: ModelState,
    layoutPersistence: LayoutPersistenceService,
    options: { layoutPerformed?: boolean; keepPersistedPositions?: boolean; noteInMeta?: boolean } = {}
): Promise<void> {
    const diagramModel = modelState.get(WORKFLOW_NETWORK_MODEL_KEY) as WorkflowDiagramModel | undefined;
    if (!diagramModel) {
        return;
    }
    const { filePath: workflowFilePath, networkId } = layoutTargetOf(diagramModel as any);
    const persisted = options.keepPersistedPositions ? await layoutPersistence.loadLayout(workflowFilePath, networkId) : undefined;
    const positions = persisted ?? collectNodePositions(modelState.root);
    const routes = collectEdgeRoutes(modelState.root);
    // The routes end on the ports' rows: the order the definitions are drawn
    // in is saved with them (definition-port-order.ts).
    await layoutPersistence.saveLayoutImmediate(workflowFilePath, networkId, positions, routes, keptPortOrderChanges(modelState.root));

    if (options.noteInMeta === false) {
        return;
    }
    const layoutMeta = modelState.get(WORKFLOW_LAYOUT_PERSISTENCE_KEY) as LayoutPersistenceMeta | undefined;
    if (layoutMeta) {
        if (options.layoutPerformed) {
            layoutMeta.hasPersistedLayout = true;
        }
        layoutMeta.hasPersistedEdgeRoutes = routes.size > 0;
        modelState.set(WORKFLOW_LAYOUT_PERSISTENCE_KEY, layoutMeta);
    }
}

/**
 * A drawing of the diagram, kept to be shown again or saved: where each node
 * and port is (relative to what holds it), each node's size, each edge's
 * route; and the same as the layout file keys it. A layout tried and not kept
 * (the chat's untangle tries) is drawn without being saved, and the drawing
 * the diagram had before is kept beside it, so either can come back.
 */
export interface LayoutGeometry {
    nodes: Map<string, { position?: Point; size?: { width: number; height: number } }>;
    /** Every other element with a place or a size: ports, labels, compartments. */
    parts: Map<string, { position?: Point; size?: { width: number; height: number } }>;
    edges: Map<string, Point[] | undefined>;
    /** As `persistLayout` would save it. */
    saved: { positions: Map<string, Point>; routes: Map<string, Point[]>; portOrders: PortOrderChanges };
}

/** The diagram as it is drawn now (see {@link LayoutGeometry}). */
export function layoutGeometryOf(root: GModelRoot): LayoutGeometry {
    const nodes: LayoutGeometry['nodes'] = new Map();
    const parts: LayoutGeometry['parts'] = new Map();
    walk(root, element => {
        if (element === root || element instanceof GEdge) {
            return;
        }
        const position = (element as any).position as Point | undefined;
        const size = (element as any).size as { width: number; height: number } | undefined;
        const bounds = {
            ...(position ? { position: { x: position.x, y: position.y } } : {}),
            ...(size ? { size: { width: size.width, height: size.height } } : {})
        };
        if (isMovableNode(element)) {
            nodes.set(String(element.id), bounds);
        } else if (position || size || element instanceof GPort) {
            parts.set(String(element.id), bounds);
        }
    });
    return {
        nodes,
        parts,
        edges: snapshotEdgeRoutesById(root),
        saved: { positions: collectNodePositions(root), routes: collectEdgeRoutes(root), portOrders: keptPortOrderChanges(root) }
    };
}

/** Draw `geometry` again on `root`: what it holds by id; an element it does not know is left as it is. */
export function applyLayoutGeometry(root: GModelRoot, geometry: LayoutGeometry): void {
    walk(root, element => {
        const id = String(element.id);
        const bounds = isMovableNode(element) ? geometry.nodes.get(id) : geometry.parts.get(id);
        if (bounds) {
            (element as any).position = bounds.position ? { ...bounds.position } : undefined;
            if (bounds.size) {
                (element as any).size = { ...bounds.size };
            }
        } else if (element instanceof GEdge && geometry.edges.has(id)) {
            const route = geometry.edges.get(id);
            (element as any).routingPoints = route ? route.map(p => ({ x: p.x, y: p.y })) : undefined;
        }
    });
}

/** Save `geometry` as the diagram's layout, whatever is drawn now. */
export async function saveLayoutGeometry(
    modelState: ModelState,
    layoutPersistence: LayoutPersistenceService,
    geometry: LayoutGeometry
): Promise<void> {
    const diagramModel = modelState.get(WORKFLOW_NETWORK_MODEL_KEY) as WorkflowDiagramModel | undefined;
    if (!diagramModel) {
        return;
    }
    const { filePath: workflowFilePath, networkId } = layoutTargetOf(diagramModel as any);
    await layoutPersistence.saveLayoutImmediate(workflowFilePath, networkId, geometry.saved.positions, geometry.saved.routes, geometry.saved.portOrders);
}
