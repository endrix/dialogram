/**
 * The path through the selection, drawn on the diagram
 * (`clientBehavior.selectionTrace`), after mlir-viewer's trace highlighter.
 *
 * Select a node and everything that leads to it is drawn in one colour
 * (upstream), everything it leads to in another (downstream), and the rest of
 * the diagram fades. The walk follows the edges port to port, both ways, as far
 * as they go: a path is a path however many nodes it passes through.
 *
 * Nested containers. An edge that crosses a group's frame is cut there, one
 * piece per frame, the pieces meeting at boundary ports on the frames (see
 * group-edges.ts on the server). The walk passes through a boundary port
 * without counting the group as a node on the path, so a path leaves one group
 * and enters another the way the edge does, through any depth of nesting, and
 * every piece of it is drawn.
 *
 * Cycles. Reachability answers "what does this touch" where the graph is a
 * DAG. On a cycle it answers "everything": every successor of a state in a
 * state machine leads back to it, and in a handshake netlist every `ready`
 * wire runs against the data it answers, so every two neighbours form a
 * cycle and nothing past them is a path. So the walk reads the diagram the
 * way its reader does, left to right: a wire drawn back to the left (a
 * `ready`, a loop's feedback) is walked against its arrow, as if it ran from
 * the node it points at to the node it leaves. A laid-out diagram is then a
 * DAG, and upstream is what sits to the left on the path, downstream what
 * sits to the right. Where a cycle remains all the same (a model with no
 * layout yet), the trace is cut to the direct neighbours: the edges into the
 * node and out of it.
 *
 * A selected edge draws itself, every piece of it, and its two ends. A selected
 * container draws the nodes that feed it and the nodes it feeds, across its
 * frame; what it holds stays as it is, neither faded nor coloured, since
 * selecting a parent should not make every child look selected.
 *
 * The classes go on the model as GLSP feedback, as published node states do
 * (execution-states.ts): the dispatcher puts them back on every model the
 * server sends, so a relayout or an edit does not wipe the trace.
 */
import { WorkflowDiagramMetadata, WorkflowDiagramTypes } from '@dialogram/shared';
import { FeedbackCommand, IFeedbackActionDispatcher, ISelectionListener, TYPES } from '@eclipse-glsp/client';
import type { Action, CommandExecutionContext, Disposable, GModelRoot } from '@eclipse-glsp/sprotty';
import { inject, injectable, optional } from 'inversify';
import { clientBehavior } from './profile';
import { linksOfSelection } from './selection-links';

/** A model element as far as tracing goes. */
export interface TraceElement {
    id: string;
    type?: string;
    children?: readonly TraceElement[];
    sourceId?: string;
    targetId?: string;
    cssClasses?: string[];
    /** Where the element is drawn, relative to the element that holds it. */
    position?: { x: number; y: number };
    size?: { width: number; height: number };
    args?: Record<string, unknown>;
}

/** One step along an edge: the port at its other end, and the edge. */
type Hop = { port: string; edge: string };

/** The diagram as a graph of ports, which is what an edge joins. */
export interface TraceGraph {
    /** A port, or a node an edge ends on directly, to the node it belongs to. */
    ownerOf: Map<string, string>;
    /** A node to its ports, and to itself when an edge ends on it directly. */
    portsOf: Map<string, string[]>;
    /** The edges as the model has them: from source port to target port. */
    forward: Map<string, Hop[]>;
    backward: Map<string, Hop[]>;
    /**
     * The edges as the diagram reads them, left to right: an edge drawn back
     * to the left is turned around. What the walks follow.
     */
    flowForward: Map<string, Hop[]>;
    flowBackward: Map<string, Hop[]>;
    edges: Map<string, { source: string; target: string }>;
    /** Ports on a group's frame, walked through without counting the group. */
    passThrough: Set<string>;
    /** Every node, to the node that holds it (absent at the root). */
    parentOf: Map<string, string | undefined>;
    /** Nodes that hold other nodes. */
    containers: Set<string>;
}

/** What one selection draws, by element id. */
export interface Trace {
    /** The selection itself (with an edge, every piece of it). */
    focus: Set<string>;
    upstream: Set<string>;
    downstream: Set<string>;
    /** What a selected container holds: left as it is. */
    scope: Set<string>;
}

/** Tracing stops growing past this many nodes and edges, to keep a huge graph responsive. */
const MAX_TRACED = 2500;

export namespace TraceCss {
    export const FOCUS = 'wf-trace-focus';
    export const UPSTREAM = 'wf-trace-upstream';
    export const DOWNSTREAM = 'wf-trace-downstream';
    export const SCOPE = 'wf-trace-scope';
    /** Off the trace. */
    export const FADED = 'wf-trace-faded';
}

function startsWith(element: TraceElement, prefix: string): boolean {
    return typeof element.type === 'string' && element.type.startsWith(prefix);
}

function push<T>(map: Map<string, T[]>, key: string, value: T): void {
    const list = map.get(key);
    if (list) {
        list.push(value);
    } else {
        map.set(key, [value]);
    }
}

/** Read the ports, edges and nesting of a model. */
export function buildTraceGraph(root: TraceElement): TraceGraph {
    const graph: TraceGraph = {
        ownerOf: new Map(),
        portsOf: new Map(),
        forward: new Map(),
        backward: new Map(),
        flowForward: new Map(),
        flowBackward: new Map(),
        edges: new Map(),
        passThrough: new Set(),
        parentOf: new Map(),
        containers: new Set()
    };
    const groups = new Set<string>();
    const edges: TraceElement[] = [];
    /** The middle of each node and port across the page, for a model that is laid out. */
    const middle = new Map<string, number>();

    const visit = (element: TraceElement, node: string | undefined, originX: number): void => {
        let owner = node;
        let x = originX;
        if (element !== root && typeof element.position?.x === 'number') {
            x += element.position.x;
            if (startsWith(element, 'node') || startsWith(element, 'port')) {
                middle.set(element.id, x + (element.size?.width ?? 0) / 2);
            }
        }
        // A port on a node stands where its node does: two nodes that overlap
        // across the page (one under the other, or moved by hand) would
        // otherwise turn a wire between them by a few pixels of port offset.
        // A port on a group's frame keeps its own place; the frame is wide.
        if (startsWith(element, 'port') && node !== undefined && !groups.has(node) && middle.has(node)) {
            middle.set(element.id, middle.get(node)!);
        }
        if (startsWith(element, 'node')) {
            graph.parentOf.set(element.id, node);
            if (node !== undefined) {
                graph.containers.add(node);
            }
            if (element.type === WorkflowDiagramTypes.NODE_GROUP) {
                groups.add(element.id);
            }
            owner = element.id;
        } else if (startsWith(element, 'port')) {
            if (node !== undefined) {
                graph.ownerOf.set(element.id, node);
                push(graph.portsOf, node, element.id);
                // A port on a frame is passed through, on the way to a member.
                // Not the one where edges end at the group itself: that is
                // the group's own, and reaching it is reaching the group.
                const endsAtGroup = (element as { args?: Record<string, unknown> }).args?.[WorkflowDiagramMetadata.GROUP_END] === true;
                if ((element.type === WorkflowDiagramTypes.PORT_GROUP_BOUNDARY || groups.has(node)) && !endsAtGroup) {
                    graph.passThrough.add(element.id);
                }
            }
        } else if (startsWith(element, 'edge')
            && typeof element.sourceId === 'string'
            && typeof element.targetId === 'string') {
            edges.push(element);
        }
        for (const child of element.children ?? []) {
            visit(child, owner, x);
        }
    };
    visit(root, undefined, 0);

    for (const edge of edges) {
        const source = edge.sourceId as string;
        const target = edge.targetId as string;
        for (const end of [source, target]) {
            // An edge that ends on a node itself, not on one of its ports.
            if (!graph.ownerOf.has(end) && graph.parentOf.has(end)) {
                graph.ownerOf.set(end, end);
                push(graph.portsOf, end, end);
            }
        }
        if (!graph.ownerOf.has(source) || !graph.ownerOf.has(target)) {
            continue;
        }
        graph.edges.set(edge.id, { source, target });
        push(graph.forward, source, { port: target, edge: edge.id });
        push(graph.backward, target, { port: source, edge: edge.id });
        // Drawn back to the left: read as running the other way.
        const [sourceX, targetX] = [middle.get(source), middle.get(target)];
        const turned = sourceX !== undefined && targetX !== undefined && targetX < sourceX;
        const [from, to] = turned ? [target, source] : [source, target];
        push(graph.flowForward, from, { port: to, edge: edge.id });
        push(graph.flowBackward, to, { port: from, edge: edge.id });
    }
    return graph;
}

/** What a walk in one direction reached. */
interface Walk {
    nodes: Set<string>;
    edges: Set<string>;
    /** The boundary ports it passed through. */
    ports: Set<string>;
    /** It came back to a node it started from: the start sits on a cycle. */
    cyclic: boolean;
}

/**
 * Walk from the ports of `start` along `adjacency` (flowForward: downstream,
 * flowBackward: upstream). A node reached is recorded and walked on from; a
 * boundary port is passed through, unrecorded and without costing a hop, so
 * one hop still reaches the neighbour on the other side of two frames. Nodes in
 * `blocked` are not entered.
 */
function walk(
    graph: TraceGraph,
    adjacency: Map<string, Hop[]>,
    start: ReadonlySet<string>,
    maxHops = Number.POSITIVE_INFINITY,
    blocked?: ReadonlySet<string>
): Walk {
    const nodes = new Set<string>();
    const edges = new Set<string>();
    const ports = new Set<string>();
    const visited = new Set<string>();
    const queue: Array<{ port: string; hops: number }> = [];
    let cyclic = false;

    for (const node of start) {
        for (const port of graph.portsOf.get(node) ?? []) {
            if (!visited.has(port)) {
                visited.add(port);
                queue.push({ port, hops: 0 });
            }
        }
    }

    for (let head = 0; head < queue.length; head++) {
        if (nodes.size + edges.size > MAX_TRACED) {
            break;
        }
        const { port, hops } = queue[head];
        for (const next of adjacency.get(port) ?? []) {
            const owner = graph.ownerOf.get(next.port);
            if (owner !== undefined && blocked?.has(owner)) {
                continue;
            }
            edges.add(next.edge);
            // Asked before the visited check: a cycle closes on a port of the
            // start, and those were visited before the walk began.
            if (owner !== undefined && start.has(owner)) {
                cyclic = true;
            }
            if (visited.has(next.port)) {
                continue;
            }
            visited.add(next.port);
            if (graph.passThrough.has(next.port)) {
                ports.add(next.port);
                queue.push({ port: next.port, hops });
            } else if (owner !== undefined) {
                nodes.add(owner);
                if (hops + 1 < maxHops) {
                    // The port reached is walked on from too: a wire read
                    // against its arrow lands on a port that has wires of its own.
                    for (const own of graph.portsOf.get(owner) ?? []) {
                        if (own === next.port || !visited.has(own)) {
                            visited.add(own);
                            queue.push({ port: own, hops: hops + 1 });
                        }
                    }
                }
            }
        }
    }
    for (const node of start) {
        nodes.delete(node);
    }
    return { nodes, edges, ports, cyclic };
}

function union(...sets: ReadonlyArray<Iterable<string>>): Set<string> {
    const out = new Set<string>();
    for (const set of sets) {
        for (const id of set) {
            out.add(id);
        }
    }
    return out;
}

/** A node's path: every node that leads to it and every node it leads to. */
function traceNode(graph: TraceGraph, node: string): Trace {
    const start = new Set([node]);
    let up = walk(graph, graph.flowBackward, start);
    let down = walk(graph, graph.flowForward, start);
    if (up.cyclic || down.cyclic) {
        up = walk(graph, graph.flowBackward, start, 1);
        down = walk(graph, graph.flowForward, start, 1);
    }
    return {
        focus: start,
        upstream: union(up.nodes, up.edges, up.ports),
        downstream: union(down.nodes, down.edges, down.ports),
        scope: new Set()
    };
}

/** An edge, every piece of it across frames, and the nodes at its two ends. */
function traceEdge(graph: TraceGraph, edge: string): Trace {
    const { source, target } = graph.edges.get(edge)!;
    const focus = new Set([edge]);
    const follow = (from: string, adjacency: Map<string, Hop[]>, ends: Set<string>): void => {
        const stack = [from];
        const seen = new Set<string>();
        while (stack.length > 0) {
            const port = stack.pop()!;
            if (seen.has(port)) {
                continue;
            }
            seen.add(port);
            if (!graph.passThrough.has(port)) {
                const owner = graph.ownerOf.get(port);
                if (owner !== undefined) {
                    ends.add(owner);
                }
                continue;
            }
            focus.add(port);
            for (const next of adjacency.get(port) ?? []) {
                focus.add(next.edge);
                stack.push(next.port);
            }
        }
    };
    const upstream = new Set<string>();
    const downstream = new Set<string>();
    follow(source, graph.backward, upstream);
    follow(target, graph.forward, downstream);
    return { focus, upstream, downstream, scope: new Set() };
}

/** A container: what feeds it and what it feeds, across its frame; what it holds, as it is. */
function traceContainer(graph: TraceGraph, container: string): Trace {
    const held = new Set<string>();
    for (const node of graph.parentOf.keys()) {
        for (let parent = graph.parentOf.get(node); parent !== undefined; parent = graph.parentOf.get(parent)) {
            if (parent === container) {
                held.add(node);
                break;
            }
        }
    }
    const start = new Set([container]);
    const up = walk(graph, graph.flowBackward, start, 1, held);
    const down = walk(graph, graph.flowForward, start, 1, held);
    const inside = union(held, start);
    const scope = new Set(held);
    for (const [id, { source, target }] of graph.edges) {
        if (inside.has(graph.ownerOf.get(source)!) && inside.has(graph.ownerOf.get(target)!)) {
            scope.add(id);
        }
    }
    return {
        focus: start,
        upstream: union(up.nodes, up.edges, up.ports),
        downstream: union(down.nodes, down.edges, down.ports),
        scope
    };
}

/**
 * The trace of the first selected element that has one: a node, a port (its
 * node), an edge or a container. `undefined` when nothing selected is any of
 * these.
 */
export function computeTrace(graph: TraceGraph, selected: readonly string[]): Trace | undefined {
    for (const id of selected) {
        if (graph.edges.has(id)) {
            return withHeld(graph, traceEdge(graph, id));
        }
        const node = graph.parentOf.has(id) ? id : graph.ownerOf.get(id);
        if (node !== undefined && graph.parentOf.has(node)) {
            return withHeld(graph, graph.containers.has(node) ? traceContainer(graph, node) : traceNode(graph, node));
        }
    }
    return undefined;
}

/**
 * A container on a trace (an edge ends at it, or starts from it) is reached
 * whole: what it holds is left as it is, not faded as nodes off the trace are.
 */
function withHeld(graph: TraceGraph, trace: Trace): Trace {
    const reached = [...trace.upstream, ...trace.downstream].filter(id => graph.containers.has(id));
    if (reached.length === 0) {
        return trace;
    }
    const on = new Set(reached);
    const scope = new Set(trace.scope);
    for (const node of graph.parentOf.keys()) {
        for (let parent = graph.parentOf.get(node); parent !== undefined; parent = graph.parentOf.get(parent)) {
            if (on.has(parent)) {
                scope.add(node);
                break;
            }
        }
    }
    return { ...trace, scope };
}

/**
 * What the selection's links lead to, and the other drawings of what is
 * selected (selection-links.ts), are read with the selection: they are left
 * as they are, not faded as nodes off the trace are.
 */
export function withLinked(root: TraceElement, selected: readonly string[], trace: Trace): Trace {
    const { ends, same } = linksOfSelection(root, new Set(selected));
    if (ends.size === 0 && same.size === 0) {
        return trace;
    }
    return { ...trace, scope: new Set([...trace.scope, ...ends, ...same]) };
}

/** The trace of `selected` on `root`, with what its links lead to. */
function traceOf(root: TraceElement, graph: TraceGraph, selected: readonly string[]): Trace | undefined {
    const trace = computeTrace(graph, selected);
    return trace && withLinked(root, selected, trace);
}

/**
 * The classes a trace puts on each element. Every leaf node and edge off the
 * trace fades. A container never does: its opacity would multiply into every
 * node it holds, traced or not.
 */
export function traceClasses(graph: TraceGraph, trace: Trace): Record<string, string[]> {
    const classes: Record<string, string[]> = {};
    const add = (id: string, cssClass: string): void => {
        (classes[id] ??= []).push(cssClass);
    };
    for (const id of trace.scope) add(id, TraceCss.SCOPE);
    for (const id of trace.upstream) add(id, TraceCss.UPSTREAM);
    for (const id of trace.downstream) add(id, TraceCss.DOWNSTREAM);
    for (const id of trace.focus) add(id, TraceCss.FOCUS);
    const fade = (id: string): void => {
        if (!(id in classes)) {
            add(id, TraceCss.FADED);
        }
    };
    for (const node of graph.parentOf.keys()) {
        if (!graph.containers.has(node)) {
            fade(node);
        }
    }
    for (const edge of graph.edges.keys()) {
        fade(edge);
    }
    return classes;
}

/**
 * Puts a trace's classes on the model, or (`remove`) takes them off.
 * `selected`: what the trace is of. Given, the classes are worked out again
 * from each model the feedback is put on, so a model rebuilt under the same
 * selection (a bus opened, its member edges new) is traced as it now is, and
 * `classes` (those of the model the selection was made on) are not read. A
 * `remove` takes off whatever the trace put on, whatever `classes` says.
 */
export interface SelectionTraceFeedbackAction extends Action {
    kind: typeof SelectionTraceFeedbackAction.KIND;
    classes: Record<string, string[]>;
    selected?: string[];
    remove?: boolean;
}

export namespace SelectionTraceFeedbackAction {
    export const KIND = 'dialogramSelectionTraceFeedback';

    export function create(classes: Record<string, string[]>, remove = false, selected?: readonly string[]): SelectionTraceFeedbackAction {
        return { kind: KIND, classes, ...(selected ? { selected: [...selected] } : {}), ...(remove ? { remove: true } : {}) };
    }
}

/** The classes the trace of `selected` puts on `root` as it is now; empty when nothing selected is there. */
export function traceClassesOf(root: TraceElement, selected: readonly string[]): Record<string, string[]> {
    const graph = buildTraceGraph(root);
    const trace = traceOf(root, graph, selected);
    return trace ? traceClasses(graph, trace) : {};
}

/** Take off every class a trace put on `root`, whichever trace it was. */
export function removeTraceClasses(root: TraceElement): void {
    const visit = (element: TraceElement): void => {
        const added = tracedBy.get(element);
        if (added && added.size > 0) {
            element.cssClasses = (element.cssClasses ?? []).filter(cssClass => !added.has(cssClass));
            tracedBy.delete(element);
        }
        for (const child of element.children ?? []) {
            visit(child);
        }
    };
    visit(root);
}

/** The classes the trace put on each element, so taking them off leaves everyone else's. */
const tracedBy = new WeakMap<object, Set<string>>();

/** Put `classes` on the elements of `root` they name (`remove`: take them off). */
export function applyTraceClasses(root: TraceElement, classes: Record<string, string[]>, remove = false): void {
    const visit = (element: TraceElement): void => {
        const wanted = classes[element.id];
        if (wanted) {
            const own = element.cssClasses ?? [];
            const added = tracedBy.get(element) ?? new Set<string>();
            if (remove) {
                const taken = new Set(wanted.filter(cssClass => added.delete(cssClass)));
                if (taken.size > 0) {
                    element.cssClasses = own.filter(cssClass => !taken.has(cssClass));
                }
            } else {
                const fresh = wanted.filter(cssClass => !own.includes(cssClass));
                if (fresh.length > 0) {
                    element.cssClasses = [...own, ...fresh];
                    fresh.forEach(cssClass => added.add(cssClass));
                    tracedBy.set(element, added);
                }
            }
        }
        for (const child of element.children ?? []) {
            visit(child);
        }
    };
    visit(root);
}

/** Applies a {@link SelectionTraceFeedbackAction} to the model it is given, each time. */
@injectable()
export class SelectionTraceFeedbackCommand extends FeedbackCommand {
    static readonly KIND = SelectionTraceFeedbackAction.KIND;

    constructor(@inject(TYPES.Action) protected readonly action: SelectionTraceFeedbackAction) {
        super();
    }

    execute(context: CommandExecutionContext): GModelRoot {
        const root = context.root as unknown as TraceElement;
        if (this.action.remove === true) {
            removeTraceClasses(root);
        } else if (this.action.selected) {
            applyTraceClasses(root, traceClassesOf(root, this.action.selected));
        } else {
            applyTraceClasses(root, this.action.classes);
        }
        return context.root;
    }
}

/**
 * Draws the trace of each new selection, when the product asks for it. A new
 * trace withdraws the last one first; a selection that traces the same as the
 * last one changes nothing.
 */
@injectable()
export class SelectionTraceListener implements ISelectionListener {
    @inject(TYPES.IFeedbackActionDispatcher)
    @optional()
    protected readonly feedbackDispatcher?: IFeedbackActionDispatcher;

    private feedback?: Disposable;
    private shown = '';

    selectionChanged(root: Readonly<GModelRoot>, selectedElements: string[]): void {
        let classes: Record<string, string[]> | undefined;
        if (clientBehavior().selectionTrace === true && selectedElements.length > 0) {
            const graph = buildTraceGraph(root as unknown as TraceElement);
            const trace = traceOf(root as unknown as TraceElement, graph, selectedElements);
            classes = trace ? traceClasses(graph, trace) : undefined;
        }
        const key = classes ? JSON.stringify(classes) : '';
        if (key === this.shown) {
            return;
        }
        this.shown = key;
        this.feedback?.dispose();
        this.feedback = undefined;
        if (classes && this.feedbackDispatcher) {
            this.feedback = this.feedbackDispatcher.registerFeedback(
                this,
                [SelectionTraceFeedbackAction.create(classes, false, selectedElements)],
                [SelectionTraceFeedbackAction.create(classes, true)]
            );
        }
    }
}
