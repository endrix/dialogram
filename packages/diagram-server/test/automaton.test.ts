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
import { WorkflowDiagramConstants, WorkflowDiagramMetadata, WorkflowDiagramTypes, automatonGeometry, overlapArea, stateWidth, transitionLabelWidth } from '@dialogram/shared';
import { GraphGModelSource, type PyGraphDocument } from '../src/model/graph-gmodel-source';
import { convertToGModelRoot } from '../src/server/gmodel-convert';
import { WorkflowElkLayoutEngine } from '../src/server/elk-layout-engine';
import { WorkflowLayoutConfigurator } from '../src/server/layout-configurator';
import { applyPersistedEdgeRoutes } from '../src/routing/persisted-edge-routes';
import { collectEdgeRoutes } from '../src/server/layout-snapshot';
import { automatonClutter, automatonElkGraph, clearEnough, isHub, transitionLabelWidthOf } from '../src/server/automaton-layout';

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

    it('gives a transition the tokens its action takes and gives, for its tooltip, not its label', () => {
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
        // They are said in the label's tooltip, not on it: the label is as wide as its action's name.
        expect(edge('t:idle:start->run').args[WorkflowDiagramMetadata.TRANSITION_LABEL_WIDTH]).toBe(transitionLabelWidth('start', false, false));
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

    /** Lay `doc` out, and draw its transitions where they go. */
    async function placeAndDraw(doc: { nodes: any[]; edges: any[] }) {
        const root = model({ version: '1', graph: { id: 'root', ...doc } } as PyGraphDocument);
        const modelState: any = { root, index: { get: (id: string) => find(root, id), findByClass: (id: string) => find(root, id) } };
        await new WorkflowElkLayoutEngine(
            () => new (ELK as any)({ algorithms: ['layered', 'stress'] }),
            new DefaultElementFilter(),
            new WorkflowLayoutConfigurator(),
            modelState
        ).layout();
        const states = (root.children ?? []).filter(child => child.type === WorkflowDiagramTypes.NODE_STATE) as GNode[];
        const boxes = new Map(states.map(s => [s.id, { x: s.position!.x, y: s.position!.y, width: s.size!.width, height: s.size!.height }]));
        const names = new Map(states.map(s => [s.id, String(s.args?.[WorkflowDiagramMetadata.ENTITY_NAME])]));
        // As the client draws them: in their order, a stub as a stub.
        const transitions = (root.children ?? []).filter((child): child is GEdge => child instanceof GEdge && child.type === WorkflowDiagramTypes.EDGE_TRANSITION)
            .map(edge => {
                const args = edge.args as Record<string, unknown> | undefined;
                const order = args?.[WorkflowDiagramMetadata.TRANSITION_ORDER];
                return {
                    id: edge.id,
                    sourceId: edge.sourceId,
                    targetId: edge.targetId,
                    ...(typeof order === 'number' ? { order } : {}),
                    stub: args?.[WorkflowDiagramMetadata.TRANSITION_STUB] === true,
                    labelWidth: transitionLabelWidthOf(args),
                    targetName: names.get(edge.targetId) ?? edge.targetId
                };
            });
        return { boxes, transitions, drawn: automatonGeometry(boxes, transitions) };
    }

    it('places a state whose only transitions are loops clear of the others, its loops and their labels on no state and no other loop', async () => {
        const loops = (state: string, ...labels: string[]) => labels.map(label => transition(state, label, state));
        for (const doc of [
            // Two states with only a loop each, and a program beside a third.
            { nodes: [state('a', { initial: true }), state('b')], edges: [transition('a', 'x', 'a'), transition('b', 'a_longer_label', 'b')] },
            {
                nodes: [state('a', { initial: true }), state('b'), state('c'), state('lonely')],
                edges: [transition('a', 'go', 'b'), transition('b', 'go', 'c'), transition('c', 'back', 'a'), transition('lonely', 'spin', 'lonely')]
            },
            // Any state, with a loop, beside a program whose first state has four stacked.
            {
                nodes: [state('idle', { initial: true }), state('run'), state('*')],
                edges: [transition('idle', 'start', 'run'), transition('run', 'stop', 'idle'), ...loops('idle', 'poll', 'tick', 'nop', 'skip'), transition('*', 'reset', '*')]
            },
            // Two chains, each with a loop: they meet where the components do.
            {
                nodes: [state('p', { initial: true }), state('q'), state('r'), state('s')],
                edges: [transition('p', 'go', 'q'), ...loops('q', 'step'), transition('r', 'go', 's'), ...loops('r', 'tick')]
            }
        ]) {
            const { boxes, transitions, drawn } = await placeAndDraw(doc);
            const hits: string[] = [];
            for (const t of transitions) {
                const shape = drawn.transitions.get(t.id)!;
                for (const [id, box] of boxes) {
                    if (id !== t.sourceId && id !== t.targetId && (overlapArea(shape.label, box) > 0 || overlapArea(shape.shape.box, box) > 0)) {
                        hits.push(`${t.id} on ${id}`);
                    }
                }
            }
            const ownLoops = transitions.filter(t => t.sourceId === t.targetId);
            for (const a of ownLoops) {
                for (const b of ownLoops) {
                    if (a.sourceId < b.sourceId) {
                        const [one, other] = [drawn.transitions.get(a.id)!, drawn.transitions.get(b.id)!];
                        if ([[one.shape.box, other.shape.box], [one.shape.box, other.label], [one.label, other.shape.box], [one.label, other.label]]
                            .some(([x, y]) => overlapArea(x, y) > 0)) {
                            hits.push(`${a.id} on ${b.id}`);
                        }
                    }
                }
            }
            expect(hits).toEqual([]);
        }
    });

    it('places a state whose only transitions are loops after the program, under the state it starts in', async () => {
        const { boxes } = await placeAndDraw({
            nodes: [state('idle', { initial: true }), state('run'), state('*')],
            edges: [transition('idle', 'start', 'run'), transition('run', 'stop', 'idle'), transition('*', 'reset', '*')]
        });
        const [idle, anyState] = [boxes.get('idle')!, boxes.get('*')!];
        expect(anyState.y).toBeGreaterThan(idle.y);
    });

    // A processor's control: a state it fetches in that most others go back
    // to (drawn as stubs), one it decodes in that leads to most others, a
    // loop on nearly every state, and three or more labels on some lines.
    const when = { condition: 'c' };
    const PROCESSOR = {
        nodes: ['fetch', 'trap', 'ld_rs1', 'exec', 'shift', 'stmem', 'ldmem', 'ld_rs2'].map(name => state(name, name === 'fetch' ? { initial: true } : {})),
        edges: [
            transition('fetch', 'take_irq', 'fetch', { order: 1 }),
            ...['boot', 'irq_save'].map(action => transition('fetch', action, 'fetch', { order: 1, ...when })),
            ...['discard', 'wait_resume', 'fetch_stay'].map(action => transition('fetch', action, 'fetch', { order: 2, ...when })),
            transition('fetch', 'launch_trap', 'trap', { order: 2, ...when }),
            transition('fetch', 'launch', 'ld_rs1', { order: 2, ...when }),
            transition('trap', 'trap_halt', 'trap', when),
            ...([['pcpi_done', 'fetch'], ['pcpi_hold', 'ld_rs1'], ['pcpi_expire', 'trap'], ['to_exec', 'exec'], ['to_shift', 'shift'], ['to_stmem', 'stmem'],
                ['to_ldmem', 'ldmem'], ['to_fetch', 'fetch'], ['to_offer', 'ld_rs1'], ['to_trap', 'trap'], ['to_rs2', 'ld_rs2']] as const)
                .map(([action, to]) => transition('ld_rs1', action, to, when)),
            transition('exec', 'exec_wait', 'exec', when),
            transition('exec', 'exec_done', 'fetch', when),
            transition('shift', 'shift_step', 'shift', when),
            transition('shift', 'shift_done', 'fetch', when),
            ...(['st', 'ld'] as const).flatMap(kind => {
                const unit = `${kind}mem`;
                return [
                    transition(unit, `${kind}_issue`, unit, { order: 1, ...when }),
                    transition(unit, `${kind}_misalign`, 'trap', { order: 1, ...when }),
                    transition(unit, `${kind}_finish`, 'fetch', { order: 2, ...when })
                ];
            }),
            ...['exec', 'shift', 'stmem'].map(to => transition('ld_rs2', `rs2_${to}`, to, when))
        ]
    };

    it('keeps the states of a layer apart where a line that skips the layer passes between them', async () => {
        // From `ld_rs1` to `ld_rs2`, a layer apart, the line passes between two
        // of the units, drawn there with its label beside it.
        const { boxes } = await placeAndDraw(PROCESSOR);
        const layers = new Map<number, Array<{ x: number; width: number }>>();
        for (const box of boxes.values()) {
            layers.set(box.y, [...(layers.get(box.y) ?? []), box]);
        }
        const gaps = [...layers.values()].flatMap(layer => layer
            .sort((a, b) => a.x - b.x)
            .slice(1)
            .map((box, n) => box.x - (layer[n].x + layer[n].width)));
        expect(gaps.length).toBeGreaterThan(0);
        expect(Math.min(...gaps)).toBeGreaterThanOrEqual(60);
    });

    it('spreads a processor\u2019s control until no label lies on another, on a state or on a chip, and few lines run through one', async () => {
        const { boxes, transitions } = await placeAndDraw(PROCESSOR);
        expect(transitions.some(t => t.stub)).toBe(true);
        const clutter = automatonClutter(boxes, transitions);
        expect(clutter.overlap).toBe(0);
        expect(clearEnough(clutter, transitions.length)).toBe(true);
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
