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
 * shorter for it, so the nodes stacked under it move with its bottom edge
 * (make-room.ts), and its edges and theirs are rerouted.
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
import { inject, injectable } from 'inversify';
import {
    TogglePortBusOperation,
    WORKFLOW_NETWORK_MODEL_KEY,
    WorkflowDiagramMetadata
} from '@dialogram/shared';
import { LayoutPersistenceService } from '../services/layout-persistence-service';
import { collectEdgeRoutes, collectNodePositions, isMovableNode, movableNodeIdFor, nodeLayoutKeyOf, type Point } from '../server/layout-snapshot';
import { makeRoom, type Box } from './make-room';
import { growGroupsToFit } from '../server/group-geometry';
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

/** How far each node moved down (negative: up), by id. */
export type NodeMoves = Map<string, number>;

function inverse(moves: NodeMoves): NodeMoves {
    return new Map([...moves].map(([id, dy]) => [id, -dy]));
}

/**
 * Undo closes what the toggle opened, and redo opens it again: each is the
 * same write and rebuild with the other answer. The nodes the toggle moved
 * are moved back exactly by undo and again by redo, never worked out anew:
 * what a growth pushed cannot be read back off the layout. `beforeExecute`
 * runs on the first execution only.
 */
export class TogglePortBusCommand implements Command {
    private moves: NodeMoves = new Map();

    constructor(
        private readonly apply: (expanded: boolean, moves?: NodeMoves) => Promise<NodeMoves | void>,
        private readonly expanded: boolean,
        private readonly beforeExecute?: () => void
    ) {}

    async execute(): Promise<void> {
        this.beforeExecute?.();
        const made = await this.apply(this.expanded);
        this.moves = made instanceof Map ? made : new Map();
    }

    async undo(): Promise<void> {
        await this.apply(!this.expanded, inverse(this.moves));
    }

    async redo(): Promise<void> {
        await this.apply(this.expanded, this.moves);
    }
}

/**
 * What opening each bundle moved, this session, by view and bundle: closing
 * it moves exactly that back. A bundle opened before (another session, or
 * the fallback's choice) closes leaving the room it had.
 */
const roomMade = new Map<string, NodeMoves>();

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
        return new TogglePortBusCommand((open, moves) => this.apply(target, open, moves), !expanded, () => {
            const commands = (this.commandStack as unknown as { commands?: unknown[] }).commands;
            if (!Array.isArray(commands) || !commands.every(command => command instanceof TogglePortBusCommand)) {
                this.commandStack.flush();
            }
        });
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
     * one, an empty set for a node whose bundles are all closed. What the view
     * shows may be its fallback's choice; saving all of it keeps that.
     */
    openBundles(): Map<string, Set<string>> {
        const open = new Map<string, Set<string>>();
        const visit = (element: GModelElement): void => {
            const args = (element as any).args as Record<string, unknown> | undefined;
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
     * Open or close the bundle, rebuild, and move the nodes around it: `moves`
     * exactly, when given (an undo or a redo); else, opening, the column the
     * growth pushes, and closing, what this session's opening of it moved.
     * Returns the moves made.
     */
    async apply(target: PortBusTarget, expanded: boolean, moves?: NodeMoves): Promise<NodeMoves> {
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
        if (!(await this.sourceModelStorage.rebuildFromLastDocument(current))) {
            return new Map();
        }
        const key = bundleKey(target);
        let made: NodeMoves;
        if (moves) {
            made = this.moveNodes(moves);
        } else if (expanded) {
            made = this.makeRoomUnder(nodeId, oldHeights);
        } else {
            const opened = roomMade.get(key);
            made = opened ? this.moveNodes(inverse(opened)) : new Map();
        }
        if (expanded) {
            roomMade.set(key, made);
        } else {
            roomMade.delete(key);
        }
        await this.rerouteHandler.runReroute({
            kind: WORKFLOW_REROUTE_EDGES_AVOID_OVERLAPS_OPERATION_KIND,
            isOperation: true,
            elementIds: [nodeId, ...made.keys()],
            source: 'changeBounds'
        } as any);
        return made;
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

    /** Move nodes by `moves`, growing the groups they are in to hold them; the moves made. */
    moveNodes(moves: NodeMoves): NodeMoves {
        const made: NodeMoves = new Map();
        for (const [id, dy] of moves) {
            const node: any = this.modelState.index.find(id);
            if (node?.position) {
                node.position = { x: node.position.x, y: node.position.y + dy };
                made.set(id, dy);
                growGroupsToFit(node);
            }
        }
        return made;
    }

    /**
     * Move the siblings stacked under `nodeId`, which grew from its height in
     * `oldHeights`. Inside a group the group grows to hold what moved, and
     * the same room is made for the group among its own siblings, up to the
     * diagram. The moves made.
     */
    makeRoomUnder(nodeId: string, oldHeights: ReadonlyMap<string, number>): NodeMoves {
        const made: NodeMoves = new Map();
        let level: any = this.modelState.index.find(nodeId);
        while (level && isMovableNode(level)) {
            const oldHeight = oldHeights.get(String(level.id));
            const parent = level.parent;
            if (oldHeight === undefined || !parent) {
                break;
            }
            const siblings: any[] = (parent.children ?? []).filter((child: any) =>
                isMovableNode(child) && child.position && child.size);
            const boxes: Box[] = siblings.map(child => ({
                id: String(child.id),
                x: child.position.x,
                y: child.position.y,
                width: child.size.width,
                height: child.size.height
            }));
            const step = makeRoom(boxes, String(level.id), oldHeight);
            for (const [id, dy] of this.moveNodes(step)) {
                made.set(id, (made.get(id) ?? 0) + dy);
            }
            growGroupsToFit(level);
            if (!isMovableNode(parent)) {
                break;
            }
            level = parent;
        }
        return made;
    }
}
