/**
 * A large automaton made small enough to read: runs folded into one state
 * that lists their steps, and the ways into a hub drawn as stubs.
 */
import { describe, expect, it } from 'vitest';
import { GModelIndex } from '@eclipse-glsp/server';
import { ToggleNodeOpenOperation, WorkflowDiagramConstants, WorkflowDiagramMetadata, WorkflowDiagramTypes, stateSize } from '@dialogram/shared';
import { convertToGModelRoot } from '../src/server/gmodel-convert';
import { WorkflowToggleNodeOpenOperationHandler } from '../src/operations/toggle-node-open-handler';
import { compressAutomaton, foldId, foldableRuns, stepsOf, FOLD_MIN_STATES, HUB_MIN_SOURCES } from '../src/model/automaton-compress';
import { GraphGModelSource, type PyGraphDocument } from '../src/model/graph-gmodel-source';
import { automatonElkGraph, LAYERED_MIN_STATES } from '../src/server/automaton-layout';

const state = (name: string, meta: Record<string, unknown> = {}): any =>
    ({ id: `state:${name}`, kind: 'state', label: name, scope: 'root', ports: [], meta });
const t = (from: string, action: string, to: string, meta: Record<string, unknown> = {}): any =>
    ({ id: `t:${from}:${action}->${to}`, from: `state:${from}`, to: `state:${to}`, scope: 'root', meta: { label: action, ...meta } });
const doc = (nodes: any[], edges: any[]): PyGraphDocument => ({ version: '1', graph: { id: 'root', nodes, edges } } as PyGraphDocument);

/** read → a → b → c → d → read, and read stays: a, b, c, d is a run. */
const PROGRAM = doc(
    [state('read', { initial: true }), state('a'), state('b'), state('c'), state('d')],
    [
        t('read', 'go', 'a', { order: 1 }),
        t('read', 'idle', 'read', { order: 2 }),
        t('a', 'pred', 'b'),
        t('b', 'pred', 'c'),
        t('c', 'mag', 'd'),
        t('d', 'done', 'read', { condition: 'self.last()' })
    ]
);

describe('a run of states with one way in and one way out', () => {
    it('is found, from its first state to its last, and only with enough states', () => {
        const states = PROGRAM.graph.nodes;
        expect(foldableRuns(states, PROGRAM.graph.edges)).toEqual([['state:a', 'state:b', 'state:c', 'state:d']]);
        expect(FOLD_MIN_STATES).toBe(3);
        // Two states are no run worth folding.
        const short = doc([state('read', { initial: true }), state('a'), state('b')],
            [t('read', 'go', 'a'), t('a', 'x', 'b'), t('b', 'y', 'read')]);
        expect(foldableRuns(short.graph.nodes, short.graph.edges)).toEqual([]);
    });

    it('lists the actions along it, one taken again in a row counted once', () => {
        expect(stepsOf(['state:a', 'state:b', 'state:c', 'state:d'], PROGRAM.graph.edges))
            .toEqual([{ action: 'pred', count: 2 }, { action: 'mag', count: 1 }]);
    });

    it('is not a run when it goes round to itself, has a loop, or holds the state the automaton starts in', () => {
        const ring = doc([state('a'), state('b'), state('c')], [t('a', 'x', 'b'), t('b', 'y', 'c'), t('c', 'z', 'a')]);
        expect(foldableRuns(ring.graph.nodes, ring.graph.edges)).toEqual([]);
        const looped = doc([state('s', { initial: true }), state('a'), state('b'), state('c')],
            [t('s', 'go', 'a'), t('a', 'x', 'b'), t('b', 'wait', 'b'), t('b', 'y', 'c'), t('c', 'z', 's')]);
        expect(foldableRuns(looped.graph.nodes, looped.graph.edges)).toEqual([]);
    });

    it('becomes one state, named for its ends, that its ways in and out come to and leave from', () => {
        const out = compressAutomaton(PROGRAM).graph;
        expect(out.nodes.map(n => n.id)).toEqual(['state:read', foldId('state:a')]);
        const fold = out.nodes[1];
        expect(fold.label).toBe('a … d');
        expect(fold.meta?.['steps']).toEqual([{ action: 'pred', count: 2 }, { action: 'mag', count: 1 }]);
        expect(fold.meta?.['folded']).toEqual(['a', 'b', 'c', 'd']);
        // The ways inside are gone; every other transition keeps its id and what it says.
        expect(out.edges.map(e => [e.id, e.from, e.to])).toEqual([
            ['t:read:go->a', 'state:read', 'fold:state:a'],
            ['t:read:idle->read', 'state:read', 'state:read'],
            ['t:d:done->read', 'fold:state:a', 'state:read']
        ]);
        expect(out.edges[2].meta?.['condition']).toBe('self.last()');
    });

    it('stays as it is when the reader has unfolded it, its first state the one that folds it again', () => {
        const out = compressAutomaton(PROGRAM, new Set([foldId('state:a')])).graph;
        expect(out.nodes).toHaveLength(5);
        expect(out.edges).toHaveLength(PROGRAM.graph.edges.length);
        const marked = out.nodes.filter(n => n.meta?.['run'] !== undefined);
        expect(marked.map(n => [n.id, n.meta?.['run'], n.meta?.['runOpen']])).toEqual([['state:a', 'fold:state:a', true]]);
    });

    it('is folded or unfolded as the reader chose, the choice kept under the run’s id', () => {
        const opened = (open: boolean) => new GraphGModelSource().transform(PROGRAM,
            { portBuses: { isExpanded: (key, name) => open && key === 'fold:state:a' && name === ToggleNodeOpenOperation.OPEN } }).graph;
        const runState = (graph: any): any => graph.children?.find((c: any) => c.args?.[WorkflowDiagramMetadata.STATE_RUN] === 'fold:state:a');
        // Folded: the run's state names the run, and makes room for its toggle.
        const folded = runState(opened(false));
        expect(folded.args[WorkflowDiagramMetadata.ENTITY_NAME]).toBe('a … d');
        expect(folded.args[WorkflowDiagramMetadata.STATE_RUN_OPEN]).toBeUndefined();
        const steps = [{ action: 'pred', count: 2 }, { action: 'mag', count: 1 }];
        expect(folded.size.width).toBe(stateSize('a … d', steps).width + WorkflowDiagramConstants.STATE_RUN_TOGGLE_PX);
        // Unfolded: its first state does, open.
        const first = runState(opened(true));
        expect(first.args[WorkflowDiagramMetadata.ENTITY_NAME]).toBe('a');
        expect(first.args[WorkflowDiagramMetadata.STATE_RUN_OPEN]).toBe(true);
        expect(first.size.width).toBe(stateSize('a', undefined).width + WorkflowDiagramConstants.STATE_RUN_TOGGLE_PX);
        expect(opened(true).children?.filter((c: any) => c.type === WorkflowDiagramTypes.NODE_STATE)).toHaveLength(5);
    });

    it('is the node a toggle names, open while its first state stands unfolded', () => {
        for (const open of [false, true]) {
            const graph: any = new GraphGModelSource().transform(PROGRAM,
                { portBuses: { isExpanded: (key, name) => open && key === 'fold:state:a' && name === ToggleNodeOpenOperation.OPEN } });
            const root: any = convertToGModelRoot(graph);
            const index = new GModelIndex();
            index.indexRoot(root);
            const handler = new WorkflowToggleNodeOpenOperationHandler();
            (handler as any).modelState = { root, index, get: () => ({ documentUri: 'file:///w/unit.py', workflowName: 'Unit' }) };
            const state = (root.children ?? []).find((c: any) => c.args?.[WorkflowDiagramMetadata.STATE_RUN] === 'fold:state:a');
            const target = handler.nodeTargetOf(String(state.id))!;
            expect(target).toMatchObject({ nodeKey: 'fold:state:a', producerId: 'fold:state:a', run: true });
            expect(handler.isOpen(target)).toBe(open);
            expect(handler.elementOf(target)?.id).toBe(state.id);
        }
    });

    it('is drawn as a state that lists its steps, as big as they need', () => {
        const graph = new GraphGModelSource().transform(PROGRAM).graph;
        const fold: any = graph.children?.find((c: any) => c.args?.[WorkflowDiagramMetadata.ENTITY_NAME] === 'a … d');
        expect(fold.type).toBe(WorkflowDiagramTypes.NODE_STATE);
        expect(fold.args[WorkflowDiagramMetadata.STATE_STEPS]).toEqual([{ action: 'pred', count: 2 }, { action: 'mag', count: 1 }]);
        const size = stateSize('a … d', [{ action: 'pred', count: 2 }, { action: 'mag', count: 1 }]);
        // Room at its right end for the toggle that unfolds it.
        expect(fold.size).toEqual({ width: size.width + WorkflowDiagramConstants.STATE_RUN_TOGGLE_PX, height: size.height });
        expect(fold.size.height).toBeGreaterThan(stateSize('read', undefined).height);
    });
});

describe('a state entered from many', () => {
    const many = ['a', 'b', 'c', 'd', 'e'];
    const HUBBED = doc(
        [state('s', { initial: true }), ...many.map(n => state(n)), state('fail')],
        [
            ...many.map((n, k) => t(k === 0 ? 's' : many[k - 1], 'next', n)),
            t('e', 'again', 's'),
            ...many.map(n => t(n, 'failure', 'fail')),
            t('fail', 'resync', 's')
        ]
    );

    it('is a hub: every way into it is a stub, and no other', () => {
        expect(HUB_MIN_SOURCES).toBe(5);
        const out = compressAutomaton(HUBBED).graph;
        const stubs = out.edges.filter(e => e.meta?.['stub'] === true).map(e => e.id).sort();
        expect(stubs).toEqual(many.map(n => `t:${n}:failure->fail`).sort());
    });

    it('carries the mark to the model, where the placement leaves the stubs out', () => {
        const graph = new GraphGModelSource().transform(HUBBED).graph;
        const stub: any = graph.children?.find((c: any) => c.id === 't:a:failure->fail' || c.args?.['wf:from'] === 'a' && c.args?.['wf:to'] === 'fail');
        expect(stub.args[WorkflowDiagramMetadata.TRANSITION_STUB]).toBe(true);
        const elk = automatonElkGraph(
            [{ id: 'x', width: 50, height: 36 }, { id: 'y', width: 50, height: 36 }],
            [{ sourceId: 'x', targetId: 'y', labelWidth: 10, stub: true }]
        );
        expect(elk.edges).toHaveLength(0);
    });

    it('is left alone when fewer states lead to it', () => {
        const few = doc([state('s', { initial: true }), state('a'), state('fail')],
            [t('s', 'go', 'a'), t('a', 'failure', 'fail'), t('s', 'failure', 'fail'), t('fail', 'back', 's'), t('a', 'done', 's')]);
        expect(compressAutomaton(few)).toBe(few);
    });
});

describe('a large automaton', () => {
    it('is placed in layers from the top down, a hub too; a small hub by stress', () => {
        const states = Array.from({ length: LAYERED_MIN_STATES }, (_, k) => ({ id: `s${k}`, width: 60, height: 36 }));
        const chain = states.slice(1).map((s, k) => ({ sourceId: states[k].id, targetId: s.id, labelWidth: 30 }));
        const big = automatonElkGraph(states, chain);
        expect(big.layoutOptions?.['elk.algorithm']).toBe('layered');
        expect(big.layoutOptions?.['elk.direction']).toBe('DOWN');
        expect(big.edges).toHaveLength(chain.length);
        // A star is a hub, but a large one: stress would stretch it across the page.
        const star = states.slice(1).map(s => ({ sourceId: states[0].id, targetId: s.id, labelWidth: 30 }));
        expect(automatonElkGraph(states, star).layoutOptions?.['elk.algorithm']).toBe('layered');
        expect(automatonElkGraph(states.slice(0, 5), star.slice(0, 4)).layoutOptions?.['elk.algorithm']).toBe('stress');
    });
});
