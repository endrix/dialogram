/**
 * The selection's path (`clientBehavior.selectionTrace`), after mlir-viewer's
 * trace highlighter.
 *
 * Pinned here:
 *
 *  - a node traces every path through it: all it leads from upstream, all it
 *    leads to downstream, the rest faded;
 *  - on a cycle the walk comes back to the start and would light everything,
 *    so the trace is cut to the direct neighbours;
 *  - nested groups: the models are split by the server's own
 *    `splitEdgesAtGroups`, so the pieces and boundary ports are the ones the
 *    client is sent. A path crosses frames, at any depth, with every piece
 *    and boundary port on it drawn, and no group counted as a node on it;
 *  - a selected edge draws all its pieces and its two ends; a selected
 *    container draws what feeds it and what it feeds, and leaves what it
 *    holds as it is;
 *  - a container is never faded, since its opacity would fade its members;
 *  - the classes go on as feedback, only when the product asks, are withdrawn
 *    on the next selection, and take off only what they put on.
 */
import 'reflect-metadata';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkflowDiagramTypes } from '@dialogram/shared';
import { splitEdgesAtGroups } from '../../diagram-server/src/model/group-edges';
import {
    applyTraceClasses,
    buildTraceGraph,
    computeTrace,
    SelectionTraceFeedbackAction,
    SelectionTraceListener,
    traceClasses,
    TraceCss,
    type TraceElement
} from '../src/selection-trace';

type El = TraceElement & { children?: El[] };

function node(name: string): El {
    return {
        id: name,
        type: WorkflowDiagramTypes.NODE_ACTOR,
        children: [
            { id: `${name}.in`, type: WorkflowDiagramTypes.PORT_INPUT },
            { id: `${name}.out`, type: WorkflowDiagramTypes.PORT_OUTPUT }
        ]
    };
}

function group(name: string, ...members: El[]): El {
    return { id: name, type: WorkflowDiagramTypes.NODE_GROUP, children: members };
}

function edge(from: string, to: string): El {
    return { id: `${from}->${to}`, type: WorkflowDiagramTypes.EDGE_CONNECTION, sourceId: `${from}.out`, targetId: `${to}.in` };
}

/** A graph root holding `children`, its group-crossing edges split as the server splits them. */
function model(...children: El[]): El {
    splitEdgesAtGroups(children as any);
    return { id: 'root', type: WorkflowDiagramTypes.GRAPH, children };
}

function trace(root: El, ...selected: string[]) {
    const graph = buildTraceGraph(root);
    const result = computeTrace(graph, selected);
    return { graph, result: result!, classes: result ? traceClasses(graph, result) : {} };
}

const sorted = (set: Iterable<string>) => [...set].sort();

describe('a selected node', () => {
    it('traces every path through it, both ways, and fades the rest', () => {
        const root = model(node('a'), node('b'), node('c'), node('d'), node('x'),
            edge('a', 'b'), edge('b', 'c'), edge('c', 'd'), edge('x', 'd'));
        const { result, classes } = trace(root, 'b');
        expect(sorted(result.upstream)).toEqual(['a', 'a->b']);
        expect(sorted(result.downstream)).toEqual(['b->c', 'c', 'c->d', 'd']);
        expect(classes.x).toEqual([TraceCss.FADED]);
        expect(classes['x->d']).toEqual([TraceCss.FADED]);
        expect(classes.b).toEqual([TraceCss.FOCUS]);
    });

    it('is traced from a port of it too', () => {
        const root = model(node('a'), node('b'), edge('a', 'b'));
        expect(sorted(trace(root, 'b.in').result.upstream)).toEqual(['a', 'a->b']);
    });

    it('follows an edge that ends on a node itself, not on a port', () => {
        const root = model(node('a'), node('b'),
            { id: 'a=>b', type: WorkflowDiagramTypes.EDGE_CONNECTION, sourceId: 'a', targetId: 'b' });
        expect(sorted(trace(root, 'a').result.downstream)).toEqual(['a=>b', 'b']);
    });

    it('on a cycle, shows only the edges into it and out of it', () => {
        // s1 -> s2 -> s3 -> s1, and s3 -> s4: reachability would mark all four both ways.
        const root = model(node('s1'), node('s2'), node('s3'), node('s4'),
            edge('s1', 's2'), edge('s2', 's3'), edge('s3', 's1'), edge('s3', 's4'));
        const { result } = trace(root, 's1');
        expect(sorted(result.upstream)).toEqual(['s3', 's3->s1']);
        expect(sorted(result.downstream)).toEqual(['s1->s2', 's2']);
    });

    it('leaves a virtual edge out of the path', () => {
        const root = model(node('a'), node('b'),
            { ...edge('a', 'b'), type: WorkflowDiagramTypes.EDGE_VIRTUAL });
        expect(trace(root, 'a').result.downstream.size).toBe(0);
    });
});

describe('nested groups', () => {
    it('follows a path out of one group and into another, every piece drawn, no group on it', () => {
        const root = model(group('A', node('a')), group('B', node('b')), node('c'),
            edge('a', 'b'), edge('b', 'c'));
        const { result, classes } = trace(root, 'a');
        expect(sorted(result.downstream)).toEqual(sorted([
            'b', 'c',
            // a -> b: out of A, across (the middle piece keeps the edge's id), into B.
            'A::out::a.out::piece', 'a->b', 'B::in::b.in::piece',
            // b -> c: out of B to c at the root.
            'B::out::b.out::piece', 'b->c',
            // The boundary ports the pieces meet at.
            'A::out::a.out', 'B::in::b.in', 'B::out::b.out'
        ]));
        expect(classes.A).toBeUndefined();
        expect(classes.B).toBeUndefined();
    });

    it('crosses two frames on each side', () => {
        // a in A1 in A, b in B1 in B.
        const root = model(group('A', group('A1', node('a'))), group('B', group('B1', node('b'))), edge('a', 'b'));
        const { graph, result } = trace(root, 'b');
        expect(result.upstream).toContain('a');
        expect([...graph.edges.keys()].every(id => result.upstream.has(id))).toBe(true);
        expect(sorted([...result.upstream].filter(id => graph.passThrough.has(id))).length).toBe(4);
    });

    it('reaches only the side a shared way in leads to', () => {
        // x and y both enter G to reach m: they share one boundary port and one piece.
        const root = model(node('x'), node('y'), group('G', node('m')), node('z'), edge('x', 'm'), edge('y', 'm'), edge('x', 'z'));
        expect(sorted(trace(root, 'm').result.upstream).filter(id => !id.includes('::') && !id.includes('->'))).toEqual(['x', 'y']);
        const fromY = trace(root, 'y').result.downstream;
        expect(fromY).toContain('m');
        expect(fromY).not.toContain('z');
    });

    it('a selected piece draws the whole edge and its two ends', () => {
        const root = model(group('A', node('a')), group('B', node('b')), node('c'), edge('a', 'b'), edge('a', 'c'));
        const { graph, result } = trace(root, 'a->b');
        expect(sorted(result.upstream)).toEqual(['a']);
        expect(sorted(result.downstream)).toEqual(['b']);
        const pieces = [...graph.edges.keys()].filter(id => result.focus.has(id));
        expect(pieces).toContain('a->b');
        expect(pieces.length).toBe(3);
        expect(result.focus).not.toContain('a->c');
    });

    it('a selected container draws what feeds it and what it feeds, and leaves what it holds alone', () => {
        const root = model(node('x'), group('G', node('g1'), node('g2')), node('y'), node('far'),
            edge('x', 'g1'), edge('g1', 'g2'), edge('g2', 'y'), edge('y', 'far'));
        const { result, classes } = trace(root, 'G');
        expect(result.upstream).toContain('x');
        expect(result.downstream).toContain('y');
        // One hop: what it feeds, not everything after that.
        expect(result.downstream).not.toContain('far');
        expect(sorted([...result.scope].filter(id => !id.includes('::')))).toEqual(['g1', 'g1->g2', 'g2']);
        expect(classes.g1).toEqual([TraceCss.SCOPE]);
        expect(classes.far).toEqual([TraceCss.FADED]);
        expect(result.upstream).not.toContain('g1');
        expect(result.downstream).not.toContain('g2');
    });
});

describe('the classes on the model', () => {
    it('go on and come off, leaving the classes the element had', () => {
        const root = model(node('a'), node('b'), edge('a', 'b'));
        root.children![0].cssClasses = ['mine', TraceCss.FOCUS];
        const { classes } = trace(root, 'b');
        applyTraceClasses(root, classes);
        expect(root.children![0].cssClasses).toEqual(['mine', TraceCss.FOCUS, TraceCss.UPSTREAM]);
        applyTraceClasses(root, classes, true);
        // FOCUS was there before the trace: not the trace's to take off.
        expect(root.children![0].cssClasses).toEqual(['mine', TraceCss.FOCUS]);
    });
});

describe('the listener', () => {
    afterEach(() => {
        delete (globalThis as any).diagramIdentifier;
    });

    function listener() {
        const registered: Array<{ actions: SelectionTraceFeedbackAction[]; dispose: ReturnType<typeof vi.fn> }> = [];
        const dispatcher = {
            registerFeedback: vi.fn((_emitter: unknown, actions: SelectionTraceFeedbackAction[]) => {
                const entry = { actions, dispose: vi.fn() };
                registered.push(entry);
                return { dispose: entry.dispose };
            })
        };
        const instance = new SelectionTraceListener();
        (instance as any).feedbackDispatcher = dispatcher;
        return { instance, dispatcher, registered };
    }

    const root = () => model(node('a'), node('b'), edge('a', 'b'));

    it('draws nothing unless the product asks for it', () => {
        const { instance, dispatcher } = listener();
        instance.selectionChanged(root() as any, ['a']);
        expect(dispatcher.registerFeedback).not.toHaveBeenCalled();
    });

    it('registers the trace as feedback, once per trace, and withdraws it on the next', () => {
        (globalThis as any).diagramIdentifier = { clientBehavior: { selectionTrace: true } };
        const { instance, dispatcher, registered } = listener();
        instance.selectionChanged(root() as any, ['a']);
        expect(registered[0].actions[0].classes.b).toEqual([TraceCss.DOWNSTREAM]);
        instance.selectionChanged(root() as any, ['a']);
        expect(dispatcher.registerFeedback).toHaveBeenCalledTimes(1);
        instance.selectionChanged(root() as any, ['b']);
        expect(registered[0].dispose).toHaveBeenCalled();
        expect(registered[1].actions[0].classes.a).toEqual([TraceCss.UPSTREAM]);
        instance.selectionChanged(root() as any, []);
        expect(registered[1].dispose).toHaveBeenCalled();
        expect(dispatcher.registerFeedback).toHaveBeenCalledTimes(2);
    });
});
