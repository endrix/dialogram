/**
 * An automaton: states, and transitions between them.
 *
 * A node of kind `state` is a state, and an edge from a state to a state is a
 * transition. The server's part: the two reach the model as their own types
 * with what the drawing needs (a state's size from its name, a transition's
 * order, condition and label width); ELK's stress placement puts the states
 * apart; and a transition, which the client draws from its states' places,
 * never gets a route, neither from the layout file nor into it.
 */
import { describe, expect, it } from 'vitest';
import ELK from 'elkjs/lib/elk.bundled.js';
import { GEdge, GGraph, GNode } from '@eclipse-glsp/server';
import { DefaultElementFilter } from '@eclipse-glsp/layout-elk';
import { WorkflowDiagramConstants, WorkflowDiagramMetadata, WorkflowDiagramTypes, stateWidth, transitionLabelWidth } from '@dialogram/shared';
import { GraphGModelSource, type PyGraphDocument } from '../src/model/graph-gmodel-source';
import { convertToGModelRoot } from '../src/server/gmodel-convert';
import { WorkflowElkLayoutEngine } from '../src/server/elk-layout-engine';
import { WorkflowLayoutConfigurator } from '../src/server/layout-configurator';
import { applyPersistedEdgeRoutes } from '../src/routing/persisted-edge-routes';
import { collectEdgeRoutes } from '../src/server/layout-snapshot';
import { automatonElkGraph, isHub } from '../src/server/automaton-layout';

const state = (name: string, meta: Record<string, unknown> = {}): any =>
    ({ id: `state:${name}`, kind: 'state', label: name, scope: 'root', ports: [], meta });
const transition = (from: string, action: string, to: string, meta: Record<string, unknown> = {}): any =>
    ({ id: `t:${from}:${action}->${to}`, from: `state:${from}`, to: `state:${to}`, scope: 'root', meta: { label: action, ...meta } });

/** A counter: `idle` starts it, `run` steps or stops, in that order. */
const COUNTER: PyGraphDocument = {
    version: '1',
    graph: {
        id: 'root',
        nodes: [state('idle', { initial: true }), state('run')],
        edges: [
            transition('idle', 'start', 'run'),
            transition('run', 'stop', 'idle', { order: 1, condition: 'self.full()' }),
            transition('run', 'step', 'run', { order: 2 }),
            // An order that is no place in an order is not one.
            transition('run', 'odd', 'run', { order: 1.5 })
        ]
    }
} as PyGraphDocument;

function find(element: any, id: string): any {
    if (element?.id === id) {
        return element;
    }
    for (const child of element?.children ?? []) {
        const hit = find(child, id);
        if (hit) {
            return hit;
        }
    }
    return undefined;
}

function model(doc: PyGraphDocument = COUNTER): GGraph {
    return convertToGModelRoot(new GraphGModelSource({} as any).transform(doc) as any) as unknown as GGraph;
}

describe('an automaton in the model', () => {
    const graph = new GraphGModelSource().transform(COUNTER).graph;
    const byId = (id: string): any => graph.children?.find((child: any) => child.id === id);

    it('makes a state of a node of kind state, as wide as its name and with no port', () => {
        const idle = byId('idle') ?? graph.children?.find((child: any) => child.args?.[WorkflowDiagramMetadata.ENTITY_NAME] === 'idle');
        expect(idle.type).toBe(WorkflowDiagramTypes.NODE_STATE);
        expect(idle.size).toEqual({ width: stateWidth('idle'), height: WorkflowDiagramConstants.STATE_HEIGHT_PX });
        expect(idle.args[WorkflowDiagramMetadata.STATE_INITIAL]).toBe(true);
        expect((idle.children ?? []).filter((child: any) => String(child.type).startsWith('port'))).toEqual([]);
        const run = graph.children?.find((child: any) => child.args?.[WorkflowDiagramMetadata.ENTITY_NAME] === 'run');
        expect(run.args[WorkflowDiagramMetadata.STATE_INITIAL]).toBeUndefined();
    });

    it('makes a transition of an edge between two states, from state to state', () => {
        const stop = byId('t:run:stop->idle');
        const states = new Map((graph.children ?? []).filter((c: any) => c.type === WorkflowDiagramTypes.NODE_STATE)
            .map((c: any) => [c.args[WorkflowDiagramMetadata.ENTITY_NAME], c.id]));
        expect(stop.type).toBe(WorkflowDiagramTypes.EDGE_TRANSITION);
        expect([stop.sourceId, stop.targetId]).toEqual([states.get('run'), states.get('idle')]);
        expect([stop.args['wf:from'], stop.args['wf:to']]).toEqual(['run', 'idle']);
        expect(stop.args[WorkflowDiagramMetadata.EDGE_LABEL]).toBe('stop');
        expect(stop.args[WorkflowDiagramMetadata.TRANSITION_ORDER]).toBe(1);
        expect(stop.args[WorkflowDiagramMetadata.TRANSITION_CONDITION]).toBe('self.full()');
        expect(stop.args[WorkflowDiagramMetadata.TRANSITION_LABEL_WIDTH]).toBe(transitionLabelWidth('stop', true, true));
    });

    it('gives a transition the tokens its action takes and gives, and room for them in its label', () => {
        const rated = new GraphGModelSource().transform({
            version: '1',
            graph: {
                id: 'root',
                nodes: [state('idle', { initial: true }), state('run')],
                edges: [
                    transition('idle', 'start', 'run', { tokens: 'In×384 → Out' }),
                    transition('run', 'stop', 'idle', { tokens: 7 })
                ]
            }
        } as PyGraphDocument).graph;
        const edge = (id: string): any => rated.children?.find((child: any) => child.id === id);
        expect(edge('t:idle:start->run').args[WorkflowDiagramMetadata.TRANSITION_TOKENS]).toBe('In×384 → Out');
        expect(edge('t:idle:start->run').args[WorkflowDiagramMetadata.TRANSITION_LABEL_WIDTH])
            .toBe(transitionLabelWidth('start', false, false, 'In×384 → Out'));
        expect(transitionLabelWidth('start', false, false, 'In×384 → Out')).toBeGreaterThan(transitionLabelWidth('start', false, false));
        // Tokens that are no text are none.
        expect(edge('t:run:stop->idle').args[WorkflowDiagramMetadata.TRANSITION_TOKENS]).toBeUndefined();
        expect(edge('t:run:stop->idle').args[WorkflowDiagramMetadata.TRANSITION_LABEL_WIDTH]).toBe(transitionLabelWidth('stop', false, false));
    });

    it('gives a transition an order only where it is a place in one', () => {
        expect(byId('t:idle:start->run').args[WorkflowDiagramMetadata.TRANSITION_ORDER]).toBeUndefined();
        expect(byId('t:run:odd->run').args[WorkflowDiagramMetadata.TRANSITION_ORDER]).toBeUndefined();
        expect(byId('t:run:step->run').args[WorkflowDiagramMetadata.TRANSITION_LABEL_WIDTH]).toBe(transitionLabelWidth('step', true, false));
    });
});

describe('where the states of an automaton go', () => {
    /** `h` and four states it goes to and comes back from. */
    const hub = {
        states: ['h', 'a', 'b', 'c', 'd'].map(id => ({ id, width: 60, height: 36 })),
        transitions: ['a', 'b', 'c', 'd'].flatMap(id => [
            { sourceId: 'h', targetId: id, labelWidth: 40 },
            { sourceId: id, targetId: 'h', labelWidth: id === 'a' ? 180 : 40 }
        ])
    };

    it('tells a hub from a program: one state in most of the pairs with a transition between them', () => {
        expect(isHub(hub.states, hub.transitions)).toBe(true);
        // Three cases are too few.
        expect(isHub(hub.states.slice(0, 4), hub.transitions.slice(0, 6))).toBe(false);
        // A ring of the four cases: `h` is in half the pairs, no more.
        const ring = ['a', 'b', 'c', 'd'].map((id, k, all) => ({ sourceId: id, targetId: all[(k + 1) % 4], labelWidth: 10 }));
        expect(isHub(hub.states, [...hub.transitions, ...ring])).toBe(false);
        // Loops and stubs are no pairs.
        expect(isHub(hub.states, [
            ...hub.transitions.slice(0, 6),
            { sourceId: 'h', targetId: 'h', labelWidth: 10 },
            { sourceId: 'd', targetId: 'h', labelWidth: 10, stub: true }
        ])).toBe(false);
    });

    it('places a program in layers, the state it starts in first, one edge per pair of states and way', () => {
        const elk = automatonElkGraph(
            [{ id: 'a', width: 60, height: 36 }, { id: 'b', width: 80, height: 36, initial: true }],
            [
                { sourceId: 'a', targetId: 'b', labelWidth: 40 },
                { sourceId: 'a', targetId: 'b', labelWidth: 60 },
                { sourceId: 'b', targetId: 'a', labelWidth: 90 },
                { sourceId: 'a', targetId: 'a', labelWidth: 200 }
            ]
        );
        expect(elk.layoutOptions).toMatchObject({
            'elk.algorithm': 'layered',
            'elk.direction': 'DOWN',
            'elk.layered.cycleBreaking.strategy': 'MODEL_ORDER'
        });
        expect(elk.children!.map(child => child.id)).toEqual(['b', 'a']);
        expect(elk.edges!.map(edge => [edge.sources[0], edge.targets[0]])).toEqual([['a', 'b'], ['b', 'a']]);
        // Room between the layers for the two labels stacked on a→b.
        expect(Number(elk.layoutOptions!['elk.layered.spacing.nodeNodeBetweenLayers']))
            .toBeGreaterThanOrEqual(2 * WorkflowDiagramConstants.TRANSITION_LABEL_HEIGHT_PX);
    });

    it('places a hub by stress, one edge per pair of states whichever way, as long as its longest label needs', () => {
        const elk = automatonElkGraph(hub.states, hub.transitions);
        expect(elk.layoutOptions?.['elk.algorithm']).toBe('stress');
        expect(elk.edges).toHaveLength(4);
        const length = (edge: any): number => Number(edge.layoutOptions['elk.stress.desiredEdgeLength']);
        const [toA, ...others] = elk.edges!;
        expect(toA.targets[0] === 'a' || toA.sources[0] === 'a').toBe(true);
        expect(length(toA)).toBeGreaterThan(length(others[0]) + 60);
    });

    it('places every state, apart from the others, and the same way twice', async () => {
        const place = async (): Promise<Map<string, { x: number; y: number }>> => {
            const root = model();
            const modelState: any = { root, index: { get: (id: string) => find(root, id), findByClass: (id: string) => find(root, id) } };
            const engine = new WorkflowElkLayoutEngine(
                () => new (ELK as any)({ algorithms: ['layered', 'stress'] }),
                new DefaultElementFilter(),
                new WorkflowLayoutConfigurator(),
                modelState
            );
            await engine.layout();
            const states = (root.children ?? []).filter(child => child.type === WorkflowDiagramTypes.NODE_STATE) as GNode[];
            return new Map(states.map(s => [String(s.args?.[WorkflowDiagramMetadata.ENTITY_NAME]), { ...s.position! }]));
        };
        const first = await place();
        expect(first.size).toBe(2);
        // A program: `idle`, where it starts, above `run`, a layer's room between for the lines.
        const [idle, run] = [first.get('idle')!, first.get('run')!];
        expect(run.y - (idle.y + WorkflowDiagramConstants.STATE_HEIGHT_PX)).toBeGreaterThanOrEqual(60);
        expect([...(await place())]).toEqual([...first]);
    });
});

describe('a transition has no route', () => {
    it('is not saved with the routes of the layout file', () => {
        const root = model();
        for (const edge of (root.children ?? []).filter(child => child instanceof GEdge) as GEdge[]) {
            (edge as any).routingPoints = [{ x: 0, y: 0 }, { x: 10, y: 10 }];
        }
        expect([...collectEdgeRoutes(root as any).keys()]).toEqual([]);
    });

    it('takes none back from a layout file an older build wrote', () => {
        const root = model();
        const routes = new Map<string, { x: number; y: number }[]>();
        for (const edge of (root.children ?? []).filter(child => child instanceof GEdge) as GEdge[]) {
            routes.set(String(edge.id), [{ x: 0, y: 0 }, { x: 10, y: 10 }]);
            routes.set(String(edge.args?.[WorkflowDiagramMetadata.AST_PATH]), [{ x: 0, y: 0 }, { x: 10, y: 10 }]);
        }
        const unrouted = applyPersistedEdgeRoutes(root as any, routes);
        expect(unrouted).toEqual([]);
        for (const edge of (root.children ?? []).filter(child => child instanceof GEdge) as GEdge[]) {
            expect((edge as any).routingPoints ?? []).toEqual([]);
        }
    });
});
