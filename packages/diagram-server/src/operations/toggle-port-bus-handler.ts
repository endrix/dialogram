/**
 * Open or close a bus: the ports of one bundle drawn as one row.
 *
 * Whether a bundle is open is how the reader has arranged the diagram, so it
 * is saved in the layout file beside the positions and changes nothing in the
 * source; the handler is bound for read-only sessions too.
 *
 * Opening a bundle changes which ports the node has and which edges join
 * them, so the model is built again, from the document it was last built from
 * (the producer is not asked for the graph again) and with the positions and
 * routes the diagram has now (not the ones last saved, which an undone move
 * or an unwritable layout file would make different). The node is taller or
 * shorter for it, and has other ports, so the whole view is laid out again,
 * as Layout Diagram lays it out; or, where the product asks for it
 * (`StorageRuntimeOptions.toggleLayout`), the nodes stacked under it move
 * with its bottom edge (make-room.ts), and its edges and theirs are rerouted.
 */
import type { Operation } from '@eclipse-glsp/protocol';
import {
    CommandStack,
    GModelElement,
    ModelState,
    OperationHandler,
    SourceModelStorage,
    type Command,
    type MaybePromise
} from '@eclipse-glsp/server';
import { inject, injectable, optional } from 'inversify';
import {
    BoundaryPortGeometry,
    ToggleNodeOpenOperation,
    TogglePortBusOperation,
    WORKFLOW_LAYOUT_PERSISTENCE_KEY,
    WORKFLOW_NETWORK_MODEL_KEY,
    WorkflowDiagramConstants,
    WorkflowDiagramMetadata,
    WorkflowDiagramTypes
} from '@dialogram/shared';
import { LayoutPersistenceService } from '../services/layout-persistence-service';
import {
    collectEdgeRoutes,
    collectNodePositions,
    isMovableNode,
    movableNodeIdFor,
    nodeLayoutKeyOf,
    persistLayout,
    type LayoutPersistenceMeta,
    type Point
} from '../server/layout-snapshot';
import { STORAGE_RUNTIME_OPTIONS, type StorageRuntimeOptions } from '../server/storage-runtime-options';
import { WORKFLOW_LAYOUT_BOUNDARY_FLOW_OPERATION_KIND, WorkflowLayoutBoundaryFlowOperationHandler } from './layout-boundary-flow-handler';
import { makeRoom, type Box } from './make-room';
import { boundaryBusMembersOf } from '../server/boundary-bus-positions';
import { groupSizeAroundMembers } from '../server/group-geometry';
import { layoutTargetOf, type LayoutTarget } from '../server/layout-target';
import {
    WORKFLOW_REROUTE_EDGES_AVOID_OVERLAPS_OPERATION_KIND,
    WorkflowRerouteEdgesAvoidOverlapsOperationHandler
} from './reroute-edges-avoid-overlaps-handler';

/** The layout a rebuild starts from instead of the saved one. */
export interface CurrentLayout {
    positions: Map<string, Point>;
    routes: Map<string, Point[]>;
}

/** A storage that can build the model again without asking the producer. */
interface RebuildingStorage {
    rebuildFromLastDocument(layout?: CurrentLayout): Promise<boolean>;
}

function canRebuild(storage: unknown): storage is RebuildingStorage {
    return typeof (storage as Partial<RebuildingStorage> | undefined)?.rebuildFromLastDocument === 'function';
}

/** What a toggle needs to find its bundle again after the model is rebuilt. */
export interface PortBusTarget {
    layout: LayoutTarget;
    /** The node's id in the model, stable across rebuilds. */
    nodeId: string;
    /** The key the node's position and open bundles are saved under. */
    nodeKey: string;
    group: string;
}

/** Where a node was moved from and to, relative to its parent. */
export interface NodeMove {
    from: Point;
    to: Point;
}

/** The nodes a toggle moved, by id. */
export type NodeMoves = Map<string, NodeMove>;

export function inverse(moves: NodeMoves): NodeMoves {
    return new Map([...moves].map(([id, move]) => [id, { from: move.to, to: move.from }]));
}

function near(a: Point, b: Point): boolean {
    return Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5;
}

function overlaps(a: Box, b: Box): boolean {
    const slack = 0.5;
    return a.x < b.x + b.width - slack && b.x < a.x + a.width - slack
        && a.y < b.y + b.height - slack && b.y < a.y + a.height - slack;
}

/**
 * Undo closes what the toggle opened, and redo opens it again: each is the
 * same write and rebuild with the other answer. What the toggle did to the
 * layout is put back exactly by undo and done again by redo, never worked
 * out anew: a toggle that lays the view out again keeps the layout before
 * and after it (`snapshot`), one that makes room the nodes it moved (what a
 * growth pushed cannot be read back off the layout). `beforeExecute` runs on
 * the first execution only.
 */
export class TogglePortBusCommand implements Command {
    private moves: NodeMoves = new Map();
    private before?: CurrentLayout;
    private after?: CurrentLayout;

    constructor(
        private readonly apply: (expanded: boolean, moves?: NodeMoves, layout?: CurrentLayout) => Promise<NodeMoves | void>,
        private readonly expanded: boolean,
        private readonly beforeExecute?: () => void,
        private readonly snapshot?: () => CurrentLayout | undefined
    ) {}

    async execute(): Promise<void> {
        this.beforeExecute?.();
        this.before = this.snapshot?.();
        const made = await this.apply(this.expanded);
        this.moves = made instanceof Map ? made : new Map();
        this.after = this.before ? this.snapshot?.() : undefined;
    }

    async undo(): Promise<void> {
        await this.apply(!this.expanded, inverse(this.moves), this.before);
    }

    async redo(): Promise<void> {
        await this.apply(this.expanded, this.moves, this.after);
    }
}

/**
 * What opening each bundle moved, by view and bundle, kept per diagram
 * session (its model state): closing it moves exactly that back, if nothing
 * has moved since. A bundle opened before (another session, the fallback's
 * choice) closes leaving the room it had.
 */
const roomMade = new WeakMap<object, Map<string, NodeMoves>>();

function bundleKey(target: PortBusTarget): string {
    return [target.layout.filePath, target.layout.networkId, target.nodeKey, target.group].join('\u0000');
}

@injectable()
export class WorkflowTogglePortBusOperationHandler extends OperationHandler {
    override readonly operationType = TogglePortBusOperation.KIND;

    @inject(ModelState)
    protected override modelState!: ModelState;

    @inject(SourceModelStorage)
    protected sourceModelStorage!: SourceModelStorage;

    @inject(LayoutPersistenceService)
    protected layoutPersistence!: LayoutPersistenceService;

    @inject(WorkflowRerouteEdgesAvoidOverlapsOperationHandler)
    protected rerouteHandler!: WorkflowRerouteEdgesAvoidOverlapsOperationHandler;

    @inject(CommandStack)
    protected commandStack!: CommandStack;

    @inject(WorkflowLayoutBoundaryFlowOperationHandler)
    @optional()
    protected layoutHandler?: WorkflowLayoutBoundaryFlowOperationHandler;

    @inject(STORAGE_RUNTIME_OPTIONS)
    @optional()
    protected storageOptions?: StorageRuntimeOptions;

    /** Whether a toggle lays the whole view out again, rather than making room (`StorageRuntimeOptions.toggleLayout`). */
    relaysOut(): boolean {
        return this.layoutHandler !== undefined && this.storageOptions?.toggleLayout !== 'make-room';
    }

    /** The positions and routes drawn now, kept by a toggle that lays the view out again. */
    layoutSnapshot(): CurrentLayout | undefined {
        return this.relaysOut()
            ? { positions: collectNodePositions(this.modelState.root), routes: collectEdgeRoutes(this.modelState.root) }
            : undefined;
    }

    /**
     * After a rebuild: the whole view laid out again, as Layout Diagram lays
     * it out, or, given the layout it had (an undo, a redo), that one kept,
     * if it still fits the model: a node it does not place (a source edit
     * since, a filter changed) and the view is laid out instead. Saved either
     * way. The view counts as laid out, so the bounds round trip that follows
     * neither lays it out again nor parks the nodes it did not have before (a
     * bundle's boundary members, a frame's) below the rest.
     *
     * `false` when the layout failed (ELK refused, timed out): it cleared the
     * routes first, so the caller builds the view again and makes room.
     */
    async layOut(restored: boolean): Promise<boolean> {
        const meta = (): LayoutPersistenceMeta | undefined =>
            this.modelState.get(WORKFLOW_LAYOUT_PERSISTENCE_KEY) as LayoutPersistenceMeta | undefined;
        const before = meta();
        const fits = before === undefined || (before.hasPersistedLayout && (before.unpositionedNodeCount ?? 0) === 0);
        if (restored && fits) {
            await persistLayout(this.modelState, this.layoutPersistence, { layoutPerformed: true });
        } else {
            try {
                await this.layoutHandler!.runLayout({ kind: WORKFLOW_LAYOUT_BOUNDARY_FLOW_OPERATION_KIND, isOperation: true });
            } catch (error) {
                console.error('[dialogram] the layout after a toggle failed; making room instead:', error);
                return false;
            }
        }
        const after = meta();
        if (after) {
            after.didInitialLayout = true;
            this.modelState.set(WORKFLOW_LAYOUT_PERSISTENCE_KEY, after);
        }
        return true;
    }

    override createCommand(operation: Operation): MaybePromise<Command | undefined> {
        if (!TogglePortBusOperation.is(operation)) {
            return undefined;
        }
        const target = this.targetOf(operation.portId);
        if (!target) {
            return undefined;
        }
        const port: any = this.modelState.index.find(operation.portId);
        const expanded = port?.args?.[WorkflowDiagramMetadata.PORT_BUS_EXPANDED] === true;
        // The commands before this one recorded their changes as patches to
        // the model as it was; the rebuilt model has other ports and edges, and
        // a patch undone against it could land on the wrong element. They are
        // dropped, unless every one is a toggle: a toggle records no patch.
        return new TogglePortBusCommand((open, moves, restore) => this.apply(target, open, moves, restore), !expanded, () => {
            const commands = (this.commandStack as unknown as { commands?: unknown[] }).commands;
            if (!Array.isArray(commands) || !commands.every(command => command instanceof TogglePortBusCommand)) {
                this.commandStack.flush();
            }
        }, () => this.layoutSnapshot());
    }

    /** The bundle a bus port stands for, or nothing when the id names no bus. */
    targetOf(portId: string): PortBusTarget | undefined {
        const port: any = this.modelState.index.find(portId);
        const group = port?.args?.[WorkflowDiagramMetadata.PORT_BUS_GROUP];
        if (typeof group !== 'string' || group === '') {
            return undefined;
        }
        const nodeId = movableNodeIdFor(this.modelState.index, portId);
        const nodeKey = nodeId ? nodeLayoutKeyOf(this.modelState.index.find(nodeId)) : undefined;
        const diagramModel = this.modelState.get(WORKFLOW_NETWORK_MODEL_KEY) as any;
        if (!nodeId || !nodeKey || !diagramModel) {
            return undefined;
        }
        return { layout: layoutTargetOf(diagramModel), nodeId, nodeKey, group };
    }

    /**
     * The bundles open in the model as it is drawn, for every node that has
     * one, an empty set for a node whose bundles are all closed; and the
     * nodes that open in place, the open ones (drawn as their frames) listed
     * under `ToggleNodeOpenOperation.OPEN`. What the view shows may be its
     * fallback's choice; saving all of it keeps that.
     */
    openBundles(): Map<string, Set<string>> {
        const open = new Map<string, Set<string>>();
        const visit = (element: GModelElement): void => {
            const args = (element as any).args as Record<string, unknown> | undefined;
            const openKey = args?.[WorkflowDiagramMetadata.OPEN_NODE_KEY];
            if (typeof openKey === 'string') {
                // Open, and with the bundles it had open, which are not drawn now.
                const groups = open.get(openKey) ?? new Set<string>();
                groups.add(ToggleNodeOpenOperation.OPEN);
                const bundles = args?.[WorkflowDiagramMetadata.OPEN_NODE_BUNDLES];
                for (const group of Array.isArray(bundles) ? bundles : []) {
                    groups.add(String(group));
                }
                open.set(openKey, groups);
            } else if (args?.[WorkflowDiagramMetadata.NODE_OPENABLE] === true) {
                const key = nodeLayoutKeyOf(element);
                if (key && !open.has(key)) {
                    open.set(key, new Set<string>());
                }
            }
            const group = args?.[WorkflowDiagramMetadata.PORT_BUS_GROUP];
            if (typeof group === 'string') {
                const nodeId = movableNodeIdFor(this.modelState.index, element.id);
                const nodeKey = nodeId ? nodeLayoutKeyOf(this.modelState.index.find(nodeId)) : undefined;
                if (nodeKey) {
                    const groups = open.get(nodeKey) ?? new Set<string>();
                    if (args?.[WorkflowDiagramMetadata.PORT_BUS_EXPANDED] === true) {
                        groups.add(group);
                    }
                    open.set(nodeKey, groups);
                }
            }
            for (const child of element.children ?? []) {
                visit(child);
            }
        };
        visit(this.modelState.root);
        return open;
    }

    /**
     * Open or close the bundle, rebuild, and lay out what is around it. With
     * `restore` (an undo or a redo of a toggle that laid the view out again),
     * the view is built with that layout; else, laying the view out again,
     * it is laid out whole (`layOut`). Making room instead: `moves` when
     * given (an undo or a redo), else, opening, the column the growth
     * pushes, and closing, what this session's opening of it moved. Moves
     * are replayed only onto a layout they still fit (see `replay`). Returns
     * the moves made.
     */
    async apply(target: PortBusTarget, expanded: boolean, moves?: NodeMoves, restore?: CurrentLayout): Promise<NodeMoves> {
        const { layout, nodeId, nodeKey, group } = target;
        // An undo or redo that arrives after the editor showed another view
        // in place: what is drawn is not the view the toggle was made in, and
        // saving its bundles would write that view's nodes into this one.
        const diagramModel = this.modelState.get(WORKFLOW_NETWORK_MODEL_KEY) as any;
        const shown = diagramModel ? layoutTargetOf(diagramModel) : undefined;
        if (!shown || shown.filePath !== layout.filePath || shown.networkId !== layout.networkId) {
            console.warn('[dialogram] bus toggle skipped: the view it was made in is no longer shown', layout);
            return new Map();
        }
        // Already as asked: an undo or redo that was skipped above, while
        // another view was shown, left the stack one step from the diagram.
        const bus = this.busPortOf(nodeId, group);
        if (!bus || ((bus as any).args?.[WorkflowDiagramMetadata.PORT_BUS_EXPANDED] === true) === expanded) {
            return new Map();
        }
        const open = this.openBundles();
        const groups = open.get(nodeKey) ?? new Set<string>();
        if (expanded) {
            groups.add(group);
        } else {
            groups.delete(group);
        }
        open.set(nodeKey, groups);
        await this.layoutPersistence.savePortBuses(layout.filePath, layout.networkId, open);

        if (!canRebuild(this.sourceModelStorage)) {
            return new Map();
        }
        const current: CurrentLayout = {
            positions: collectNodePositions(this.modelState.root),
            routes: collectEdgeRoutes(this.modelState.root)
        };
        const oldHeights = this.heightsUpFrom(nodeId);
        // A bundle of the unit's ports opens into boundary nodes of their own:
        // the rebuild puts them in the rows under the bus (boundary-bus-positions.ts),
        // and the column under it makes room for those rows. They always take
        // those rows: the rebuild starts from the positions drawn now, and a
        // closed bundle's members are not drawn.
        const boundaryMembers = boundaryBusMembersOf(this.modelState.index.find(nodeId));
        const rooms = roomMade.get(this.modelState) ?? new Map<string, NodeMoves>();
        roomMade.set(this.modelState, rooms);
        if (restore || this.relaysOut()) {
            if (!(await this.sourceModelStorage.rebuildFromLastDocument(restore ?? current))) {
                return new Map();
            }
            if (await this.layOut(restore !== undefined)) {
                return new Map();
            }
            // The layout failed: built again, with the routes it cleared, and room made.
        }
        if (!(await this.sourceModelStorage.rebuildFromLastDocument(restore ?? current))) {
            return new Map();
        }
        const key = bundleKey(target);
        let made: NodeMoves;
        if (moves) {
            made = this.replay(moves);
        } else if (expanded) {
            const rows = boundaryMembers
                ? { ids: new Set(boundaryMembers), height: boundaryMembers.length * BoundaryPortGeometry.ROW_PITCH_PX }
                : undefined;
            made = this.makeRoomUnder(nodeId, oldHeights, rows);
        } else {
            const opened = rooms.get(key);
            made = opened ? this.replay(inverse(opened)) : new Map();
        }
        if (expanded) {
            rooms.set(key, made);
        } else {
            rooms.delete(key);
        }
        // The frames around the node and what moved fit their members again,
        // smaller as well as larger, and their edges are routed again with
        // the nodes': a frame that changed size moved its ports.
        const moved = [nodeId, ...made.keys()];
        this.refitGroupsAround(moved);
        const frames = this.groupsAround(moved).map(frame => String(frame.id));
        await this.rerouteHandler.runReroute({
            kind: WORKFLOW_REROUTE_EDGES_AVOID_OVERLAPS_OPERATION_KIND,
            isOperation: true,
            elementIds: [...moved, ...frames],
            source: 'changeBounds'
        } as any);
        return made;
    }

    /** The groups holding the given nodes, at any depth, innermost first. */
    groupsAround(ids: readonly string[]): any[] {
        const groups: any[] = [];
        for (const id of ids) {
            let parent: any = (this.modelState.index.find(id) as any)?.parent;
            while (parent && parent.type === WorkflowDiagramTypes.NODE_GROUP) {
                if (!groups.includes(parent)) {
                    groups.push(parent);
                }
                parent = parent.parent;
            }
        }
        const depth = (element: any): number => (element?.parent ? 1 + depth(element.parent) : 0);
        return groups.sort((a, b) => depth(b) - depth(a));
    }

    /** The bus port of `group` on the node, if the node still has one. */
    busPortOf(nodeId: string, group: string): GModelElement | undefined {
        const node: any = this.modelState.index.find(nodeId);
        return (node?.children ?? []).find((child: any) => child.args?.[WorkflowDiagramMetadata.PORT_BUS_GROUP] === group);
    }

    /**
     * Move nodes as recorded, all or none: none unless every one is still
     * where the record left it, and none if any would land on a node that is
     * not moving. A drag, a layout run, another editor, anything since the
     * record was made means the record no longer describes the diagram.
     */
    replay(moves: NodeMoves): NodeMoves {
        const nodes = new Map<string, any>();
        for (const [id, move] of moves) {
            const node: any = this.modelState.index.find(id);
            if (!node?.position || !near(node.position, move.from)) {
                return new Map();
            }
            nodes.set(id, node);
        }
        // Judged on the layout as it will be: the nodes moved, and the frames
        // around them fitted to that (a frame still holding a pushed member
        // is in the way of nothing once the member is back).
        for (const [id, move] of moves) {
            nodes.get(id).position = { ...move.to };
        }
        const frames = this.groupsAround([...moves.keys()]);
        const frameSizes = frames.map(frame => frame.size);
        for (const frame of frames) {
            const around = groupSizeAroundMembers(frame);
            frame.size = { width: Math.max(frame.size?.width ?? 0, around.width), height: around.height };
        }
        const boxOf = (element: any): Box => ({
            id: String(element.id), x: element.position.x, y: element.position.y,
            width: element.size?.width ?? 0, height: element.size?.height ?? 0
        });
        const lands = [...nodes.values()].every(node => (node.parent?.children ?? []).every((other: any) =>
            moves.has(String(other.id)) || !isMovableNode(other) || !other.position || !other.size
            || !overlaps(boxOf(node), boxOf(other))));
        frames.forEach((frame, i) => { frame.size = frameSizes[i]; });
        if (!lands) {
            for (const [id, move] of moves) {
                nodes.get(id).position = { ...move.from };
            }
            return new Map();
        }
        return new Map(moves);
    }

    /**
     * Fit each group around the given nodes to its members again, innermost
     * first: the height to what it holds, smaller as well as larger, the
     * width never narrower (the layout leaves a layer between the members and
     * the ports on the right). The ids of the groups whose size changed.
     */
    refitGroupsAround(ids: readonly string[]): string[] {
        const groups = this.groupsAround(ids);
        const changed: string[] = [];
        for (const group of groups) {
            const before = group.size ?? { width: 0, height: 0 };
            const around = groupSizeAroundMembers(group);
            const size = { width: Math.max(before.width, around.width), height: around.height };
            if (Math.abs(size.width - before.width) < 0.5 && Math.abs(size.height - before.height) < 0.5) {
                continue;
            }
            group.size = size;
            const header = WorkflowDiagramConstants.GROUP_HEADER_HEIGHT_PX;
            for (const port of group.children ?? []) {
                if (port.type !== WorkflowDiagramTypes.PORT_GROUP_BOUNDARY) {
                    continue;
                }
                const box = port.size ?? { width: WorkflowDiagramConstants.GROUP_BOUNDARY_PORT_SIZE_PX, height: WorkflowDiagramConstants.GROUP_BOUNDARY_PORT_SIZE_PX };
                const east = port.args?.[WorkflowDiagramMetadata.PORT_SIDE] === 'EAST';
                const y = Math.min(Math.max(port.position?.y ?? header, header), Math.max(header, size.height - box.height));
                port.position = { x: east ? size.width - box.width / 2 : (port.position?.x ?? -box.width / 2), y };
            }
            changed.push(String(group.id));
        }
        return changed;
    }

    /** The heights of the node and of each group around it, by id. */
    heightsUpFrom(nodeId: string): Map<string, number> {
        const heights = new Map<string, number>();
        let element: any = this.modelState.index.find(nodeId);
        while (element && isMovableNode(element)) {
            if (typeof element.size?.height === 'number') {
                heights.set(String(element.id), element.size.height);
            }
            element = element.parent;
        }
        return heights;
    }

    /** Move each node down by its `dy`; the moves made. */
    moveBy(offsets: ReadonlyMap<string, number>): NodeMoves {
        const made: NodeMoves = new Map();
        for (const [id, dy] of offsets) {
            const node: any = this.modelState.index.find(id);
            if (node?.position) {
                const from = { x: node.position.x, y: node.position.y };
                node.position = { x: from.x, y: from.y + dy };
                made.set(id, { from, to: { ...node.position } });
            }
        }
        return made;
    }

    /**
     * Move the siblings stacked under `nodeId`, which grew from its height in
     * `oldHeights`. Inside a group the group is fitted to what it holds, and
     * the same room is made for the group among its own siblings, up to the
     * diagram. The moves made.
     */
    makeRoomUnder(
        nodeId: string,
        oldHeights: ReadonlyMap<string, number>,
        rows?: { ids: ReadonlySet<string>; height: number }
    ): NodeMoves {
        const made: NodeMoves = new Map();
        let level: any = this.modelState.index.find(nodeId);
        while (level && isMovableNode(level)) {
            const oldHeight = oldHeights.get(String(level.id));
            const parent = level.parent;
            if (oldHeight === undefined || !parent) {
                break;
            }
            // Rows put under the node (an opened boundary bus's members) count
            // as the node grown by their height, and do not move themselves.
            const siblings: any[] = (parent.children ?? []).filter((child: any) =>
                isMovableNode(child) && child.position && child.size && !rows?.ids.has(String(child.id)));
            const boxes: Box[] = siblings.map(child => ({
                id: String(child.id),
                x: child.position.x,
                y: child.position.y,
                width: child.size.width,
                height: child.size.height + (rows && String(child.id) === nodeId ? rows.height : 0)
            }));
            const step = this.moveBy(makeRoom(boxes, String(level.id), oldHeight));
            for (const [id, move] of step) {
                made.set(id, { from: made.get(id)?.from ?? move.from, to: move.to });
            }
            if (parent.type !== WorkflowDiagramTypes.NODE_GROUP) {
                break;
            }
            // The group fits what it holds now, and makes the same room among its own siblings.
            this.refitGroupsAround([String(level.id), ...step.keys()]);
            level = parent;
        }
        return made;
    }
}
