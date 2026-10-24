/**
 * The node states the diagram shows: the set the host's execution overlay last
 * published for it (a profile's status source answers into it), drawn with the
 * run overlay's own classes.
 *
 * ## How they are drawn, and why this way
 *
 * A node already draws a running, finished or failed state from its CSS
 * classes: `cal-node-active` (with the turning ring), `cal-node-finished`
 * (green), `cal-node-error` (red), the classes the server stamps for a live
 * run. A published state puts the same class on its node, so it looks exactly
 * like a run and no view learns anything new.
 *
 * A state names its node by the producer's id (`node:scope:root:X-001`), and
 * the diagram names a node after its label; the node keeps the producer's id
 * as `wf:graphNodeId`. A state is matched to either, so a producer can speak
 * its own graph's ids, or the diagram's.
 *
 * The classes go on as GLSP feedback, not into the model. Every model the
 * server sends replaces the client's, and the feedback dispatcher re-applies
 * the registered feedback to each one (`FeedbackAwareSetModelCommand`,
 * `FeedbackAwareUpdateModelCommand`). The matching is done by the feedback
 * command itself, against each model it is applied to, so the states outlive
 * a save and a relayout, and follow a change of view in place: a node the view
 * does not have is skipped, a node it has is painted, whatever its label.
 *
 * The states arrive outside DI (the channel route calls the stream handler
 * directly), so the set is module state, and the container's feedback
 * dispatcher is handed in once there is one ({@link setExecutionStatePainter});
 * a set that arrived before is painted then.
 */
import type { ExecutionNodeState, ExecutionNodeStatus } from '@dialogram/shared';
import { WorkflowDiagramMetadata } from '@dialogram/shared';
import { FeedbackCommand, TYPES } from '@eclipse-glsp/client';
import type { Action, CommandExecutionContext, GModelRoot } from '@eclipse-glsp/sprotty';
import { inject, injectable } from 'inversify';

/** The class a node draws each status with; `idle` draws nothing. */
export const EXECUTION_STATUS_CLASS: Readonly<Record<ExecutionNodeStatus, string | undefined>> = {
    idle: undefined,
    running: 'cal-node-active',
    succeeded: 'cal-node-finished',
    failed: 'cal-node-error'
};

/**
 * Whether `status` is one of the statuses, and its class. Asked of the map's
 * own keys: `in` also answers for what every object inherits, so a status
 * named `toString` passed and put a function where a class name goes.
 */
function isStatus(status: unknown): status is ExecutionNodeStatus {
    return typeof status === 'string' && Object.prototype.hasOwnProperty.call(EXECUTION_STATUS_CLASS, status);
}

function statusClass(status: unknown): string | undefined {
    return isStatus(status) ? EXECUTION_STATUS_CLASS[status] : undefined;
}

type ExecutionStatePainter = (states: readonly ExecutionNodeState[]) => void;

let shown: ExecutionNodeState[] = [];
let painter: ExecutionStatePainter | undefined;

/** Replace the states shown with `states`; an empty list takes them all off. */
export function showExecutionStates(states: readonly ExecutionNodeState[]): void {
    shown = states.filter(state =>
        !!state && typeof state.nodeId === 'string' && state.nodeId !== '' && isStatus(state.status)
    );
    painter?.(shown);
}

/** The states shown now. */
export function shownExecutionStates(): readonly ExecutionNodeState[] {
    return shown;
}

/** Hand in what draws the states; it is called at once with any already shown. */
export function setExecutionStatePainter(next: ExecutionStatePainter | undefined): void {
    painter = next;
    if (next && shown.length > 0) {
        next(shown);
    }
}

/** Reset module state (tests only). */
export function __resetExecutionStatesForTests(): void {
    shown = [];
    painter = undefined;
}

/** The feedback that draws a set of states (`remove`: that takes it off again). */
export interface ExecutionStatesFeedbackAction extends Action {
    kind: typeof ExecutionStatesFeedbackAction.KIND;
    states: ExecutionNodeState[];
    remove?: boolean;
}

export namespace ExecutionStatesFeedbackAction {
    export const KIND = 'dialogram.executionStatesFeedback';

    export function create(states: readonly ExecutionNodeState[], remove = false): ExecutionStatesFeedbackAction {
        return { kind: KIND, states: [...states], ...(remove ? { remove: true } : {}) };
    }
}

/** A model element as far as painting goes: its id, its producer's id, its classes, its children. */
interface PaintableElement {
    id: string;
    args?: Record<string, unknown>;
    cssClasses?: string[];
    children?: readonly PaintableElement[];
}

/** The classes the states put on each element, so taking them off leaves a run's own. */
const paintedBy = new WeakMap<object, Set<string>>();

/**
 * Put each state's class on the node it names in `root`, by the node's id or
 * its producer's id (`remove`: take it off). A class the node already had (a
 * live run marked it) is left to whoever put it there: removing the states
 * takes off only what they added. Returns the ids of the nodes it changed.
 */
export function applyExecutionStates(root: PaintableElement, states: readonly ExecutionNodeState[], remove = false): string[] {
    const classOf = new Map<string, string>();
    for (const state of states) {
        const cssClass = statusClass(state.status);
        if (cssClass) {
            classOf.set(state.nodeId, cssClass);
        }
    }
    const changed: string[] = [];
    const visit = (element: PaintableElement): void => {
        const producerId = element.args?.[WorkflowDiagramMetadata.GRAPH_NODE_ID];
        const cssClass = classOf.get(element.id) ?? (typeof producerId === 'string' ? classOf.get(producerId) : undefined);
        if (cssClass) {
            const classes = element.cssClasses ?? [];
            const painted = paintedBy.get(element) ?? new Set<string>();
            if (remove) {
                if (painted.delete(cssClass)) {
                    element.cssClasses = classes.filter(existing => existing !== cssClass);
                }
            } else if (!classes.includes(cssClass)) {
                element.cssClasses = [...classes, cssClass];
                painted.add(cssClass);
                paintedBy.set(element, painted);
            }
            changed.push(element.id);
        }
        for (const child of element.children ?? []) {
            visit(child);
        }
    };
    if (classOf.size > 0) {
        visit(root);
    }
    return changed;
}

/** Applies an {@link ExecutionStatesFeedbackAction} to the model it is given, each time. */
@injectable()
export class ExecutionStatesFeedbackCommand extends FeedbackCommand {
    static readonly KIND = ExecutionStatesFeedbackAction.KIND;

    constructor(@inject(TYPES.Action) protected readonly action: ExecutionStatesFeedbackAction) {
        super();
    }

    execute(context: CommandExecutionContext): GModelRoot {
        applyExecutionStates(context.root as unknown as PaintableElement, this.action.states, this.action.remove === true);
        return context.root;
    }
}
