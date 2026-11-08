/**
 * The layout as the layout file stores it, read off the GModel.
 *
 * Every handler that lays nodes out or routes edges ends the same way: walk the
 * model, key each node by its AST path (or its name), key each edge the way
 * `applyPersistedEdgeRoutes` reads it back, and save both. The layout handlers
 * also keep the unselected part of the diagram where it was. These are those
 * steps, written once.
 */
import { GEdge, GModelIndex, GModelRoot, ModelState } from '@eclipse-glsp/server';
import { WorkflowDiagramMetadata, WORKFLOW_LAYOUT_PERSISTENCE_KEY, WORKFLOW_NETWORK_MODEL_KEY } from '@dialogram/shared';
import type { WorkflowDiagramModel } from '@dialogram/shared';
import { buildEdgeSignatureCounts, edgeRouteKeyFor } from '../routing/persisted-edge-routes';
import type { LayoutPersistenceService } from '../services/layout-persistence-service';
import { layoutTargetOf } from './layout-target';

export type Point = { x: number; y: number };

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
    [key: string]: unknown;
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
            const args = element.args as Record<string, unknown> | undefined;
            const key = (args?.[WorkflowDiagramMetadata.AST_PATH]
                ?? args?.[WorkflowDiagramMetadata.ENTITY_NAME]
                ?? args?.[WorkflowDiagramMetadata.PORT_NAME]) as unknown;
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

/**
 * Every routed edge's polyline, keyed as `applyPersistedEdgeRoutes` looks it
 * up: by endpoint signature, with the AST path added where the signature
 * repeats. A route needs two points to be one.
 */
export function collectEdgeRoutes(root: GModelRoot): Map<string, Point[]> {
    const result = new Map<string, Point[]>();
    const signatureCounts = buildEdgeSignatureCounts(root);
    walk(root, element => {
        if (element instanceof GEdge) {
            const key = edgeRouteKeyFor(element.args as Record<string, unknown> | undefined, signatureCounts);
            const routingPoints = (element as any).routingPoints as Point[] | undefined;
            if (typeof key === 'string' && Array.isArray(routingPoints) && routingPoints.length >= 2) {
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
 */
export async function persistLayout(
    modelState: ModelState,
    layoutPersistence: LayoutPersistenceService,
    options: { layoutPerformed?: boolean; keepPersistedPositions?: boolean } = {}
): Promise<void> {
    const diagramModel = modelState.get(WORKFLOW_NETWORK_MODEL_KEY) as WorkflowDiagramModel | undefined;
    if (!diagramModel) {
        return;
    }
    const { filePath: workflowFilePath, networkId } = layoutTargetOf(diagramModel as any);
    const persisted = options.keepPersistedPositions ? await layoutPersistence.loadLayout(workflowFilePath, networkId) : undefined;
    const positions = persisted ?? collectNodePositions(modelState.root);
    const routes = collectEdgeRoutes(modelState.root);
    await layoutPersistence.saveLayoutImmediate(workflowFilePath, networkId, positions, routes);

    const layoutMeta = modelState.get(WORKFLOW_LAYOUT_PERSISTENCE_KEY) as LayoutPersistenceMeta | undefined;
    if (layoutMeta) {
        if (options.layoutPerformed) {
            layoutMeta.hasPersistedLayout = true;
        }
        layoutMeta.hasPersistedEdgeRoutes = routes.size > 0;
        modelState.set(WORKFLOW_LAYOUT_PERSISTENCE_KEY, layoutMeta);
    }
}
