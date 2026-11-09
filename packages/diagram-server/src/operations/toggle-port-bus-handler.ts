/**
 * Open or close a bus: the ports of one bundle drawn as one row.
 *
 * Whether a bundle is open is how the reader has arranged the diagram, so it
 * is saved in the layout file beside the positions and changes nothing in the
 * source; the handler is bound for read-only sessions too.
 *
 * Opening a bundle changes which ports the node has and which edges join
 * them, so the model is built again, from the document it was last built from
 * (the producer is not asked for the graph again), and the node's edges are
 * rerouted: its ports moved, and the routes saved for them no longer start
 * where they are.
 */
import {
    ModelState,
    OperationHandler,
    SourceModelStorage,
    type Command,
    type MaybePromise
} from '@eclipse-glsp/server';
import type { Operation } from '@eclipse-glsp/protocol';
import { inject, injectable } from 'inversify';
import {
    TogglePortBusOperation,
    WORKFLOW_NETWORK_MODEL_KEY,
    WorkflowDiagramMetadata
} from '@dialogram/shared';
import { LayoutPersistenceService } from '../services/layout-persistence-service';
import { movableNodeIdFor, nodeLayoutKeyOf } from '../server/layout-snapshot';
import { layoutTargetOf, type LayoutTarget } from '../server/layout-target';
import {
    WORKFLOW_REROUTE_EDGES_AVOID_OVERLAPS_OPERATION_KIND,
    WorkflowRerouteEdgesAvoidOverlapsOperationHandler
} from './reroute-edges-avoid-overlaps-handler';

/** A storage that can build the model again without asking the producer. */
interface RebuildingStorage {
    rebuildFromLastDocument(): Promise<boolean>;
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
 * same write and rebuild with the other answer.
 */
export class TogglePortBusCommand implements Command {
    constructor(
        private readonly apply: (expanded: boolean) => Promise<void>,
        private readonly expanded: boolean
    ) {}

    execute(): Promise<void> {
        return this.apply(this.expanded);
    }

    undo(): Promise<void> {
        return this.apply(!this.expanded);
    }

    redo(): Promise<void> {
        return this.execute();
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
        return new TogglePortBusCommand(open => this.apply(target, open), !expanded);
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

    async apply(target: PortBusTarget, expanded: boolean): Promise<void> {
        const { layout, nodeId, nodeKey, group } = target;
        await this.layoutPersistence.setPortBusExpanded(layout.filePath, layout.networkId, nodeKey, group, expanded);
        if (!canRebuild(this.sourceModelStorage) || !(await this.sourceModelStorage.rebuildFromLastDocument())) {
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
