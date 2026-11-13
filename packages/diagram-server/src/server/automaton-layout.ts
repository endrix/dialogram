/**
 * Where the states of an automaton go.
 *
 * Most automata are a program: they start somewhere and go through their
 * states in an order, branching and coming back. Those are laid out in
 * layers from the top down, the state they start in on top, so they read the
 * way they run; a transition back up goes round the states in its way.
 *
 * A hub is not: one state that every other is reached from and goes back to
 * (a dispatcher and its cases). In layers it is a row of cases under one
 * state with every way back crossing every other. ELK's stress placement
 * puts each state at a distance from the others that follows how many
 * transitions lie between them, which gives a hub the shape a reader
 * expects: the state in the middle of what it leads to.
 *
 * Only places are computed. A transition has no route: the client draws it
 * from where its states are (transition-geometry.ts there), so there is
 * nothing to route here and nothing to route again when a state is dragged.
 */
import {
    WorkflowDiagramConstants,
    WorkflowDiagramMetadata,
    WorkflowDiagramTypes,
    automatonBounds,
    automatonGeometry,
    initialMarkOf,
    type GeometryBox,
    type GeometryTransition
} from '@dialogram/shared';
import type { ElkNode } from 'elkjs';

/** A state as the placement sees it. */
export interface AutomatonState {
    id: string;
    width: number;
    height: number;
    /** The automaton starts in it: it goes on top. */
    initial?: boolean;
}

/** A transition as the placement sees it. */
export interface AutomatonTransition {
    sourceId: string;
    targetId: string;
    /** How wide its label is drawn. */
    labelWidth: number;
    /** Drawn as a stub at its source (a way into a hub): it does not pull its two states together. */
    stub?: boolean;
}

/** Around the automaton, so that a loop and its labels on an outer state stay in the drawing. */
export const AUTOMATON_MARGIN_PX = 110;
/** Between what is drawn of an automaton (its loops and labels too) and its unit's ports beside it. */
export const PORT_COLUMN_GAP_PX = 40;
/**
 * From how many states an automaton is placed in layers even when it is a
 * hub: stress stretches the long paths of a large one into lines across the
 * page.
 */
export const LAYERED_MIN_STATES = 16;
/** The least between two states with a transition between them: room for the two lines and their arrow heads. */
const MIN_BETWEEN_PX = 90;
/** How many other states a hub's state is next to, at least. */
const HUB_MIN_NEIGHBOURS = 4;
/** The share of the pairs of states with a transition between them that a hub's state is in, at least. */
const HUB_MIN_SHARE = 2 / 3;

/**
 * Whether an automaton is a hub: one of its states is next to at least four
 * others and is one of the two states of two thirds of the pairs with a
 * transition between them, loops and stubs aside.
 */
export function isHub(states: readonly AutomatonState[], transitions: readonly AutomatonTransition[]): boolean {
    const ids = new Set(states.map(state => state.id));
    const pairs = new Set<string>();
    for (const t of transitions) {
        if (!t.stub && t.sourceId !== t.targetId && ids.has(t.sourceId) && ids.has(t.targetId)) {
            pairs.add([t.sourceId, t.targetId].sort().join('\u0000'));
        }
    }
    const touching = new Map<string, number>();
    for (const pair of pairs) {
        for (const id of pair.split('\u0000')) {
            touching.set(id, (touching.get(id) ?? 0) + 1);
        }
    }
    const most = Math.max(0, ...touching.values());
    return most >= HUB_MIN_NEIGHBOURS && most >= HUB_MIN_SHARE * pairs.size;
}

/**
 * The graph ELK places. In layers: the states, the one it starts in first,
 * and one edge per pair of states and way, with room beside the lines for
 * their labels and between the layers for the most labels stacked on one
 * line. For a hub: one edge per pair of states with a transition either way,
 * as long as the labels drawn beside its lines need. A stub pulls nothing.
 */
export function automatonElkGraph(states: readonly AutomatonState[], transitions: readonly AutomatonTransition[]): ElkNode {
    // The state it starts in first: the layers break its cycles in this order.
    states = [...states.filter(state => state.initial), ...states.filter(state => !state.initial)];
    const byId = new Map(states.map(state => [state.id, state]));
    const pairs = new Map<string, { a: string; b: string; labelWidth: number }>();
    for (const transition of transitions) {
        if (transition.stub || transition.sourceId === transition.targetId || !byId.has(transition.sourceId) || !byId.has(transition.targetId)) {
            continue;
        }
        const [a, b] = [transition.sourceId, transition.targetId].sort();
        const key = `${a}\u0000${b}`;
        const pair = pairs.get(key) ?? { a, b, labelWidth: 0 };
        pair.labelWidth = Math.max(pair.labelWidth, transition.labelWidth);
        pairs.set(key, pair);
    }
    if (states.length >= LAYERED_MIN_STATES || !isHub(states, transitions)) {
        // One edge per pair of states and way, for the layers to follow.
        const seen = new Map<string, number>();
        const directed = transitions.filter(t => {
            const key = `${t.sourceId}\u0000${t.targetId}`;
            if (t.stub || t.sourceId === t.targetId || !byId.has(t.sourceId) || !byId.has(t.targetId)) {
                return false;
            }
            seen.set(key, (seen.get(key) ?? 0) + 1);
            return seen.get(key) === 1;
        });
        const large = states.length >= LAYERED_MIN_STATES;
        // Beside a line, its widest label; between two layers, the most labels stacked on one line.
        const widest = Math.max(0, ...directed.map(t => t.labelWidth));
        const stacked = Math.max(1, ...seen.values());
        const k = WorkflowDiagramConstants;
        return {
            id: 'automaton',
            layoutOptions: {
                'elk.algorithm': 'layered',
                'elk.direction': 'DOWN',
                'elk.layered.spacing.nodeNodeBetweenLayers': large ? '90' : String(Math.max(60, stacked * k.TRANSITION_LABEL_HEIGHT_PX + 28)),
                'elk.spacing.nodeNode': large ? '140' : String(Math.round(Math.min(160, Math.max(60, widest * 0.6 + 30)))),
                'elk.layered.cycleBreaking.strategy': 'MODEL_ORDER',
                'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
                'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX'
            },
            children: states.map(state => ({ id: state.id, width: state.width, height: state.height })),
            edges: directed.map((t, k) => ({ id: `d${k}`, sources: [t.sourceId], targets: [t.targetId] }))
        };
    }
    return {
        id: 'automaton',
        layoutOptions: {
            'elk.algorithm': 'stress',
            'elk.stress.desiredEdgeLength': String(MIN_BETWEEN_PX + 60)
        },
        children: states.map(state => ({ id: state.id, width: state.width, height: state.height })),
        edges: [...pairs.values()].map((pair, k) => {
            // Centre to centre: the two states' own halves, the room between,
            // and the labels, which sit beside the lines half way.
            const halves = (byId.get(pair.a)!.width + byId.get(pair.b)!.width) / 2;
            return {
                id: `pair${k}`,
                sources: [pair.a],
                targets: [pair.b],
                layoutOptions: { 'elk.stress.desiredEdgeLength': String(Math.round(halves + MIN_BETWEEN_PX + pair.labelWidth * 0.5)) }
            };
        })
    };
}

/** The states' places from what ELK returned, moved so that the margin is kept on the top and the left. */
export function automatonPlaces(laidOut: ElkNode): Map<string, { x: number; y: number }> {
    const children = laidOut.children ?? [];
    const left = Math.min(...children.map(child => child.x ?? 0));
    const top = Math.min(...children.map(child => child.y ?? 0));
    return new Map(children.map(child => [child.id, {
        x: Math.round((child.x ?? 0) - left + AUTOMATON_MARGIN_PX),
        y: Math.round((child.y ?? 0) - top + AUTOMATON_MARGIN_PX)
    }]));
}

/** Is this element type a state's? */
export function isStateType(type: string): boolean {
    return type === WorkflowDiagramTypes.NODE_STATE;
}

/** How wide a transition's label is drawn, from its arguments. */
export function transitionLabelWidthOf(args: Record<string, unknown> | undefined): number {
    const width = args?.[WorkflowDiagramMetadata.TRANSITION_LABEL_WIDTH];
    return typeof width === 'number' && Number.isFinite(width) ? width : 0;
}

/** A state of the model as the drawing's box needs it. */
interface PlacedState {
    id: string;
    position?: { x: number; y: number };
    size?: { width: number; height: number };
    args?: Record<string, unknown>;
}

/** A transition of the model as the drawing's box needs it. */
interface PlacedTransition {
    id: string;
    sourceId: string;
    targetId: string;
    args?: Record<string, unknown>;
}

/**
 * What the client will draw of an automaton whose states are placed: where
 * its states, its curves and loops, their labels, the chips of its stubs and
 * its initial mark reach (automaton-geometry.ts, the arithmetic the client
 * draws with). What goes round the automaton keeps clear of this box, not
 * only of the states: a loop and its labels stand out of a state on the edge.
 * The states are the root's, so their places are the diagram's.
 */
export function automatonDrawingBox(states: readonly PlacedState[], transitions: readonly PlacedTransition[]): GeometryBox | undefined {
    const boxes = new Map<string, GeometryBox>();
    const names = new Map<string, string>();
    let initial: string | undefined;
    for (const state of states) {
        if (!state.position || !state.size) {
            continue;
        }
        const box: GeometryBox = { x: state.position.x, y: state.position.y, width: state.size.width, height: state.size.height };
        // A state that lists the steps of a run has the corners of a pill of a state's height.
        const steps = state.args?.[WorkflowDiagramMetadata.STATE_STEPS];
        if (Array.isArray(steps) && steps.length > 0) {
            box.radius = WorkflowDiagramConstants.STATE_HEIGHT_PX / 2;
        }
        boxes.set(state.id, box);
        const name = state.args?.[WorkflowDiagramMetadata.ENTITY_NAME];
        names.set(state.id, typeof name === 'string' ? name : state.id);
        if (state.args?.[WorkflowDiagramMetadata.STATE_INITIAL] === true) {
            initial = state.id;
        }
    }
    const drawn: GeometryTransition[] = transitions.map(transition => {
        const order = transition.args?.[WorkflowDiagramMetadata.TRANSITION_ORDER];
        return {
            id: transition.id,
            sourceId: transition.sourceId,
            targetId: transition.targetId,
            ...(typeof order === 'number' ? { order } : {}),
            stub: transition.args?.[WorkflowDiagramMetadata.TRANSITION_STUB] === true,
            labelWidth: transitionLabelWidthOf(transition.args),
            targetName: names.get(transition.targetId) ?? transition.targetId
        };
    });
    const geometry = automatonGeometry(boxes, drawn);
    const start = initial !== undefined ? { stateId: initial, direction: initialMarkOf(initial, boxes, drawn, geometry) } : undefined;
    return automatonBounds(boxes, geometry, start);
}
