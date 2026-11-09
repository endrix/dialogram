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
 * or an unwritable layout file would make different), and the node's edges
 * are rerouted: its ports moved.
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
import { collectEdgeRoutes, collectNodePositions, movableNodeIdFor, nodeLayoutKeyOf, type Point } from '../server/layout-snapshot';
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

/**
 * Undo closes what the toggle opened, and redo opens it again: each is the
 * same write and rebuild with the other answer. `beforeExecute` runs on the
 * first execution only.
 */
export class TogglePortBusCommand implements Command {
    constructor(
        private readonly apply: (expanded: boolean) => Promise<void>,
        private readonly expanded: boolean,
        private readonly beforeExecute?: () => void
    ) {}

    execute(): Promise<void> {
        this.beforeExecute?.();
        return this.apply(this.expanded);
    }

    undo(): Promise<void> {
        return this.apply(!this.expanded);
    }

    redo(): Promise<void> {
        return this.apply(this.expanded);
    }
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
        return new TogglePortBusCommand(open => this.apply(target, open), !expanded, () => {
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

    async apply(target: PortBusTarget, expanded: boolean): Promise<void> {
        const { layout, nodeId, nodeKey, group } = target;
        // An undo or redo that arrives after the editor showed another view
        // in place: what is drawn is not the view the toggle was made in, and
        // saving its bundles would write that view's nodes into this one.
        const diagramModel = this.modelState.get(WORKFLOW_NETWORK_MODEL_KEY) as any;
        const shown = diagramModel ? layoutTargetOf(diagramModel) : undefined;
        if (!shown || shown.filePath !== layout.filePath || shown.networkId !== layout.networkId) {
            console.warn('[dialogram] bus toggle skipped: the view it was made in is no longer shown', layout);
            return;
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
            return;
        }
        const current: CurrentLayout = {
            positions: collectNodePositions(this.modelState.root),
            routes: collectEdgeRoutes(this.modelState.root)
        };
        if (!(await this.sourceModelStorage.rebuildFromLastDocument(current))) {
            return;
        }
        await this.rerouteHandler.runReroute({
            kind: WORKFLOW_REROUTE_EDGES_AVOID_OVERLAPS_OPERATION_KIND,
            isOperation: true,
            elementIds: [nodeId],
            source: 'changeBounds'
        } as any);
    }
}
