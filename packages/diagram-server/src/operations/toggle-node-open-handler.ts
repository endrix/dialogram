/**
 * Open or close a node that holds a graph of its own (open-nodes.ts).
 *
 * As a bus toggle (toggle-port-bus-handler.ts), whose machinery this uses:
 * the choice is saved in the layout file, with the node's open bundles under
 * the name `ToggleNodeOpenOperation.OPEN`; the model is built again from the
 * document it was last built from, with the positions drawn now, and the
 * whole view is laid out again; undo and redo put back the layout it had.
 * Making room instead (`StorageRuntimeOptions.toggleLayout`): opened, the
 * frame takes the node's place and the nodes stacked under it move down for
 * its height; closed, they move back; undo and redo replay the moves.
 *
 * A run of an automaton's states, folded into one state, is opened the same
 * way (automaton-compress.ts): the state that folds it, or the first state
 * of the run unfolded, names the run (`STATE_RUN`), and the run's id is the
 * key its choice is kept under.
 */
import type { Operation } from '@eclipse-glsp/protocol';
import { type Command, type MaybePromise } from '@eclipse-glsp/server';
import { injectable } from 'inversify';
import { ToggleNodeOpenOperation, WORKFLOW_NETWORK_MODEL_KEY, WorkflowDiagramMetadata } from '@dialogram/shared';
import { collectEdgeRoutes, collectNodePositions } from '../server/layout-snapshot';
import { layoutTargetOf, type LayoutTarget } from '../server/layout-target';
import { openFrameId } from '../model/open-nodes';
import {
    inverse,
    TogglePortBusCommand,
    WorkflowTogglePortBusOperationHandler,
    type CurrentLayout,
    type NodeMoves
} from './toggle-port-bus-handler';
import { WORKFLOW_REROUTE_EDGES_AVOID_OVERLAPS_OPERATION_KIND } from './reroute-edges-avoid-overlaps-handler';

/** What a toggle needs to find its node again after the model is rebuilt. */
export interface NodeOpenTarget {
    layout: LayoutTarget;
    /** The key the node's position and open state are saved under. */
    nodeKey: string;
    /** The producer's id of the node: its frame's id is made from it. */
    producerId: string;
    /** A run of an automaton's states, drawn folded or unfolded, not a frame. */
    run?: boolean;
}

/** What opening each node moved, per diagram session: closing it moves that back. */
const roomMade = new WeakMap<object, Map<string, NodeMoves>>();

@injectable()
export class WorkflowToggleNodeOpenOperationHandler extends WorkflowTogglePortBusOperationHandler {
    override readonly operationType = ToggleNodeOpenOperation.KIND as any;

    override createCommand(operation: Operation): MaybePromise<Command | undefined> {
        if (!ToggleNodeOpenOperation.is(operation)) {
            return undefined;
        }
        const target = this.nodeTargetOf(operation.nodeId);
        if (!target) {
            return undefined;
        }
        const open = this.isOpen(target);
        return new TogglePortBusCommand((wanted, moves, restore) => this.applyOpen(target, wanted, moves, restore), !open, () => {
            const commands = (this.commandStack as unknown as { commands?: unknown[] }).commands;
            if (!Array.isArray(commands) || !commands.every(command => command instanceof TogglePortBusCommand)) {
                this.commandStack.flush();
            }
        }, () => this.layoutSnapshot());
    }

    /** The node a toggle names, closed (the node) or open (its frame). */
    nodeTargetOf(elementId: string): NodeOpenTarget | undefined {
        const element: any = this.modelState.index.find(elementId);
        const args = element?.args as Record<string, unknown> | undefined;
        const diagramModel = this.modelState.get(WORKFLOW_NETWORK_MODEL_KEY) as any;
        if (!args || !diagramModel) {
            return undefined;
        }
        const layout = layoutTargetOf(diagramModel);
        const run = args[WorkflowDiagramMetadata.STATE_RUN];
        if (typeof run === 'string' && run !== '') {
            return { layout, nodeKey: run, producerId: run, run: true };
        }
        const openKey = args[WorkflowDiagramMetadata.OPEN_NODE_KEY];
        if (typeof openKey === 'string') {
            const scopeId = String(args['wf:scopeId'] ?? '');
            return scopeId.startsWith('open:') ? { layout, nodeKey: openKey, producerId: scopeId.slice('open:'.length) } : undefined;
        }
        const producerId = args[WorkflowDiagramMetadata.GRAPH_NODE_ID];
        const nodeKey = args[WorkflowDiagramMetadata.AST_PATH];
        if (args[WorkflowDiagramMetadata.NODE_OPENABLE] === true && typeof producerId === 'string' && typeof nodeKey === 'string') {
            return { layout, nodeKey, producerId };
        }
        return undefined;
    }

    isOpen(target: NodeOpenTarget): boolean {
        if (target.run) {
            return this.runStateOf(target.nodeKey)?.args?.[WorkflowDiagramMetadata.STATE_RUN_OPEN] === true;
        }
        return this.modelState.index.find(openFrameId(target.producerId)) !== undefined;
    }

    /** The state that names a run: the one it is folded into, or its first, unfolded. */
    runStateOf(runId: string): any {
        return (this.modelState.root.children ?? []).find((child: any) => child.args?.[WorkflowDiagramMetadata.STATE_RUN] === runId);
    }

    /** The node's element in the model as it is drawn now: its frame, or itself. */
    elementOf(target: NodeOpenTarget): any {
        if (target.run) {
            return this.runStateOf(target.nodeKey);
        }
        const frame = this.modelState.index.find(openFrameId(target.producerId));
        if (frame) {
            return frame;
        }
        // Closed, the node's model id is its key; the walk is for a node keyed otherwise.
        const byKey: any = this.modelState.index.find(target.nodeKey);
        if (byKey?.args?.[WorkflowDiagramMetadata.GRAPH_NODE_ID] === target.producerId) {
            return byKey;
        }
        let found: any;
        const visit = (element: any): void => {
            if (found) {
                return;
            }
            if (element?.args?.[WorkflowDiagramMetadata.GRAPH_NODE_ID] === target.producerId
                && element?.args?.[WorkflowDiagramMetadata.NODE_OPENABLE] === true) {
                found = element;
                return;
            }
            for (const child of element?.children ?? []) {
                visit(child);
            }
        };
        visit(this.modelState.root);
        return found;
    }

    /**
     * Open or close the node, rebuild, and lay out what is around it: as a
     * bus toggle does (`apply`), with `restore` and `moves` alike. The moves
     * made.
     */
    async applyOpen(target: NodeOpenTarget, open: boolean, moves?: NodeMoves, restore?: CurrentLayout): Promise<NodeMoves> {
        const { layout, nodeKey } = target;
        const diagramModel = this.modelState.get(WORKFLOW_NETWORK_MODEL_KEY) as any;
        const shown = diagramModel ? layoutTargetOf(diagramModel) : undefined;
        if (!shown || shown.filePath !== layout.filePath || shown.networkId !== layout.networkId) {
            console.warn('[dialogram] node toggle skipped: the view it was made in is no longer shown', layout);
            return new Map();
        }
        if (this.isOpen(target) === open) {
            return new Map();
        }
        const before = this.elementOf(target);
        if (!before) {
            return new Map();
        }
        // Saved as a bus toggle saves: every node the view shows, so a view
        // showing its fallback's choice keeps it, with this one change.
        const shownOpen = this.openBundles();
        const groups = shownOpen.get(nodeKey) ?? new Set<string>();
        if (open) {
            groups.add(ToggleNodeOpenOperation.OPEN);
        } else {
            groups.delete(ToggleNodeOpenOperation.OPEN);
        }
        shownOpen.set(nodeKey, groups);
        await this.layoutPersistence.savePortBuses(layout.filePath, layout.networkId, shownOpen);

        const storage = this.sourceModelStorage as unknown as { rebuildFromLastDocument?: (layout?: CurrentLayout) => Promise<boolean> };
        if (typeof storage.rebuildFromLastDocument !== 'function') {
            return new Map();
        }
        const current: CurrentLayout = {
            positions: collectNodePositions(this.modelState.root),
            routes: collectEdgeRoutes(this.modelState.root)
        };
        const oldHeights = this.heightsUpFrom(String(before.id));
        const oldHeight = before.size?.height;
        const rooms = roomMade.get(this.modelState) ?? new Map<string, NodeMoves>();
        roomMade.set(this.modelState, rooms);
        if (restore || this.relaysOut()) {
            if (!(await storage.rebuildFromLastDocument(restore ?? current))) {
                return new Map();
            }
            if (await this.layOut(restore !== undefined)) {
                return new Map();
            }
            // The layout failed: built again, with the routes it cleared, and room made.
        }
        if (!(await storage.rebuildFromLastDocument(restore ?? current))) {
            return new Map();
        }
        const after = this.elementOf(target);
        if (!after) {
            return new Map();
        }
        const afterId = String(after.id);
        const key = [layout.filePath, layout.networkId, nodeKey].join('\u0000');
        let made: NodeMoves;
        if (moves) {
            made = this.replay(moves);
        } else if (open) {
            // The frame stands where the node stood, taller: fitted to what it
            // holds, the nodes stacked under it move down by the difference.
            const members = (after.children ?? []).filter((child: any) => String(child.type).startsWith('node:'));
            if (members.length > 0) {
                this.refitGroupsAround([String(members[0].id)]);
            }
            const heights = new Map(oldHeights);
            heights.delete(String(before.id));
            if (typeof oldHeight === 'number') {
                heights.set(afterId, oldHeight);
            }
            made = this.makeRoomUnder(afterId, heights);
        } else {
            const opened = rooms.get(key);
            made = opened ? this.replay(inverse(opened)) : new Map();
        }
        if (open) {
            rooms.set(key, made);
        } else {
            rooms.delete(key);
        }
        const moved = [afterId, ...made.keys()];
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
}
