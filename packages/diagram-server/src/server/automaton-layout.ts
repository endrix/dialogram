/**
 * Where the states of an automaton go.
 *
 * An automaton is not a flow from left to right: a state leads to states
 * that lead back to it. So it is not laid out in layers. ELK's stress
 * placement puts each state at a distance from the others that follows how
 * many transitions lie between them, which gives the shape a reader expects:
 * a state in the middle of what it leads to, a ring for a cycle.
 *
 * Only places are computed. A transition has no route: the client draws it
 * from where its states are (transition-geometry.ts there), so there is
 * nothing to route here and nothing to route again when a state is dragged.
 */
import { WorkflowDiagramMetadata, WorkflowDiagramTypes } from '@dialogram/shared';
import type { ElkNode } from 'elkjs';

/** A state as the placement sees it. */
export interface AutomatonState {
    id: string;
    width: number;
    height: number;
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
/**
 * From how many states an automaton is placed in layers, from the top down,
 * rather than by stress. A large automaton is most often a program with
 * branches (a parser going through a stream's headers): stress stretches its
 * long paths into lines across the page, and layers show it the way it runs.
 * A small one keeps the textbook shape stress gives it.
 */
export const LAYERED_MIN_STATES = 16;
/** The least between two states with a transition between them: room for the two lines and their arrow heads. */
const MIN_BETWEEN_PX = 120;

/**
 * The graph ELK places: the states, and one edge per pair of states with a
 * transition either way, as long as the labels drawn beside its lines need;
 * for a large automaton, layers from the top down with one edge per pair and
 * way. A stub pulls nothing.
 */
export function automatonElkGraph(states: readonly AutomatonState[], transitions: readonly AutomatonTransition[]): ElkNode {
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
    if (states.length >= LAYERED_MIN_STATES) {
        // One edge per pair of states and way, for the layers to follow.
        const seen = new Set<string>();
        const directed = transitions.filter(t => {
            const key = `${t.sourceId}\u0000${t.targetId}`;
            if (t.stub || t.sourceId === t.targetId || !byId.has(t.sourceId) || !byId.has(t.targetId) || seen.has(key)) {
                return false;
            }
            seen.add(key);
            return true;
        });
        return {
            id: 'automaton',
            layoutOptions: {
                'elk.algorithm': 'layered',
                'elk.direction': 'DOWN',
                'elk.layered.spacing.nodeNodeBetweenLayers': '90',
                'elk.spacing.nodeNode': '140',
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
            'elk.stress.desiredEdgeLength': String(MIN_BETWEEN_PX + 100)
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
                layoutOptions: { 'elk.stress.desiredEdgeLength': String(Math.round(halves + MIN_BETWEEN_PX + pair.labelWidth * 0.6)) }
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
