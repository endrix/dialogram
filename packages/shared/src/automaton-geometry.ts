/**
 * The drawing of a whole automaton, from where its states are: every
 * transition's curve and the place of its label, and where the drawing
 * reaches.
 *
 * The client draws from it (automaton-views.ts) and the server lays out with
 * it: the things round an automaton (its unit's ports, the frames beside it)
 * are placed against what its loops and labels reach, which only this
 * arithmetic knows (transition-geometry.ts has the shapes).
 *
 * Pure: states are boxes and transitions are ids, as either side holds them.
 */
import { WorkflowDiagramConstants } from './diagram-constants';
import { stubChipWidth } from './transition-label';
import {
    labelCandidates,
    labelLineBox,
    loopDirection,
    placeLabelBlocks,
    transitionAround,
    transitionBetween,
    transitionLoop,
    transitionStub,
    unionBox,
    type Box,
    type Point,
    type TransitionShape
} from './transition-geometry';

/** A transition as the drawing needs it. */
export interface GeometryTransition {
    id: string;
    sourceId: string;
    targetId: string;
    /** Its place in the order its state tries its transitions in; none sorts last. */
    order?: number;
    /** Drawn as a stub at its source (a way into a hub), not as a curve. */
    stub?: boolean;
    /** How wide its label is drawn. */
    labelWidth: number;
    /** The name of the state it leads to, which a stub's chip shows. */
    targetName: string;
}

export interface TransitionDrawing {
    shape: TransitionShape;
    /** Where the transition's label is. */
    label: Box;
    /** Whether it is the first of the transitions that share its line: the one that draws it. */
    first: boolean;
    /** A stub's: the chip at its end and the name of the state it leads to, and the curve it stands for. */
    chip?: { box: Box; name: string; way: TransitionShape };
}

export interface AutomatonGeometry {
    transitions: Map<string, TransitionDrawing>;
    /** Per state, the directions its loop and its stubs leave in, which its initial mark keeps clear of. */
    away: Map<string, Point[]>;
}

const centreOf = (box: Box): Point => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 });

/**
 * Where the transitions of a state that are no loops and no stubs lead: the
 * other states' centres. (A stub goes where there is room.)
 */
export function stateNeighbours(stateId: string, states: ReadonlyMap<string, Box>, transitions: readonly GeometryTransition[]): Point[] {
    const others: Point[] = [];
    for (const transition of transitions) {
        if (transition.sourceId === transition.targetId || transition.stub) {
            continue;
        }
        const far = transition.sourceId === stateId ? transition.targetId : transition.targetId === stateId ? transition.sourceId : undefined;
        const box = far === undefined ? undefined : states.get(far);
        if (box) {
            others.push(centreOf(box));
        }
    }
    return others;
}

/**
 * The drawing: the transitions between the same two states, the same way,
 * are one line with their labels stacked beside it, in the order their state
 * tries them, then as `transitions` has them.
 */
export function automatonGeometry(states: ReadonlyMap<string, Box>, transitions: readonly GeometryTransition[]): AutomatonGeometry {
    const orderOf = (t: GeometryTransition): number => t.order ?? Number.MAX_SAFE_INTEGER;
    const lines = new Map<string, Array<{ transition: GeometryTransition; index: number }>>();
    transitions.forEach((transition, index) => {
        const line = `${transition.sourceId}\u0000${transition.targetId}`;
        lines.set(line, [...(lines.get(line) ?? []), { transition, index }]);
    });
    const drawn: Array<{ members: GeometryTransition[]; shape: TransitionShape; widths: number[]; loop: boolean; bowed: boolean; chip?: TransitionDrawing['chip'] }> = [];
    const away = new Map<string, Point[]>();
    const stubs: GeometryTransition[][] = [];
    for (const entries of lines.values()) {
        const members = entries.sort((a, b) => orderOf(a.transition) - orderOf(b.transition) || a.index - b.index).map(entry => entry.transition);
        const { sourceId, targetId } = members[0];
        const source = states.get(sourceId);
        const target = states.get(targetId);
        if (!source || !target) {
            continue;
        }
        const loop = sourceId === targetId;
        if (!loop && members[0].stub) {
            stubs.push(members);
            continue;
        }
        const back = lines.get(`${targetId}\u0000${sourceId}`);
        const bowed = !loop && !!back && !back[0].transition.stub;
        let shape: TransitionShape;
        if (loop) {
            const direction = loopDirection(centreOf(source), stateNeighbours(sourceId, states, transitions));
            away.set(sourceId, [direction]);
            shape = transitionLoop(source, direction);
        } else {
            // Round the states in its way.
            const others = [...states].filter(([id]) => id !== sourceId && id !== targetId).map(([, box]) => box);
            shape = transitionAround(source, target, bowed, others);
        }
        drawn.push({ members, shape, widths: members.map(m => m.labelWidth), loop, bowed });
    }
    // A stub leaves its state into the widest room left by the state's other
    // lines, its loop and the stubs placed before it: it names where it goes,
    // so it need not point there, and pointing there laid it on the curve
    // that comes from there more often than not.
    const k = WorkflowDiagramConstants;
    for (const members of stubs.sort((a, b) => a[0].sourceId.localeCompare(b[0].sourceId) || a[0].targetName.localeCompare(b[0].targetName))) {
        const { sourceId, targetId, targetName: name } = members[0];
        const source = states.get(sourceId)!;
        const target = states.get(targetId)!;
        const centre = centreOf(source);
        const taken = [
            ...stateNeighbours(sourceId, states, transitions),
            ...(away.get(sourceId) ?? []).map(d => ({ x: centre.x + d.x * 100, y: centre.y + d.y * 100 }))
        ];
        const direction = loopDirection(centre, taken);
        away.set(sourceId, [...(away.get(sourceId) ?? []), direction]);
        const stub = transitionStub(source, { x: centre.x + direction.x * 100, y: centre.y + direction.y * 100 },
            stubChipWidth(name), k.TRANSITION_STUB_CHIP_HEIGHT_PX, k.TRANSITION_STUB_PX);
        drawn.push({ members, shape: stub, widths: members.map(m => m.labelWidth), loop: false, bowed: false, chip: { box: stub.chip, name, way: transitionBetween(source, target, false) } });
    }

    const lineHeight = k.TRANSITION_LABEL_HEIGHT_PX;
    const blocks = placeLabelBlocks(
        drawn.map(line => ({
            candidates: labelCandidates(line.shape, line.loop, line.bowed),
            width: Math.max(0, ...line.widths),
            height: lineHeight * line.members.length
        })),
        // A stub's chip is in the way of labels as a state is.
        [...states.values(), ...drawn.flatMap(line => (line.chip ? [line.chip.box] : []))],
        drawn.map(line => line.shape.controls)
    );
    const result = new Map<string, TransitionDrawing>();
    drawn.forEach((line, n) => {
        line.members.forEach((member, position) => {
            result.set(member.id, {
                shape: line.shape,
                label: labelLineBox(blocks[n], line.widths, lineHeight, position),
                first: position === 0,
                ...(line.chip ? { chip: line.chip } : {})
            });
        });
    });
    return { transitions: result, away };
}

/** How many directions around a state its initial mark is tried in. */
const MARK_DIRECTIONS = 16;

/**
 * The direction a state's initial mark comes from: of the directions around
 * it, the one furthest from where its transitions leave and from its loop.
 * West when nothing is in the way, as a statechart draws it, and the first
 * found going round from there when several are as free.
 */
export function initialMarkDirection(state: Point, neighbours: readonly Point[], loop: Point | undefined): Point {
    const taken = neighbours.map(other => Math.atan2(other.y - state.y, other.x - state.x));
    if (loop) {
        taken.push(Math.atan2(loop.y, loop.x));
    }
    const clearance = (angle: number): number => Math.min(Math.PI, ...taken.map(other => {
        const apart = Math.abs(angle - other) % (2 * Math.PI);
        return Math.min(apart, 2 * Math.PI - apart);
    }));
    let best = Math.PI;
    for (let k = 1; k < MARK_DIRECTIONS; k++) {
        const angle = Math.PI + k * 2 * Math.PI / MARK_DIRECTIONS;
        if (clearance(angle) > clearance(best) + 1e-6) {
            best = angle;
        }
    }
    return { x: Math.cos(best), y: Math.sin(best) };
}

/** Where a state's initial mark comes from: clear of its lines, its loop and its stubs. */
export function initialMarkOf(stateId: string, states: ReadonlyMap<string, Box>, transitions: readonly GeometryTransition[], geometry: AutomatonGeometry): Point {
    const state = states.get(stateId)!;
    const centre = centreOf(state);
    const away = geometry.away.get(stateId) ?? [];
    const neighbours = [...stateNeighbours(stateId, states, transitions), ...away.map(d => ({ x: centre.x + d.x * 100, y: centre.y + d.y * 100 }))];
    return initialMarkDirection(centre, neighbours, undefined);
}

/** The initial mark's parts, from the state's outline outwards: its arrow head, its shaft, its dot. */
export const INITIAL_MARK = { DOT: 4.5, SHAFT: 16, HEAD: 7 } as const;

/** How far the initial mark reaches from the state's outline. */
export const INITIAL_MARK_REACH_PX = INITIAL_MARK.HEAD + INITIAL_MARK.SHAFT + 2 * INITIAL_MARK.DOT + 1;

/**
 * What the drawing covers: its states, its curves and loops, their labels,
 * the chips of its stubs and the mark of the state it starts in.
 */
export function automatonBounds(states: ReadonlyMap<string, Box>, geometry: AutomatonGeometry, initial?: { stateId: string; direction: Point }): Box | undefined {
    let bounds: Box | undefined;
    const add = (box: Box): void => {
        bounds = bounds ? unionBox(bounds, box) : { x: box.x, y: box.y, width: box.width, height: box.height };
    };
    for (const box of states.values()) {
        add(box);
    }
    for (const drawing of geometry.transitions.values()) {
        add(drawing.shape.box);
        add(drawing.label);
        if (drawing.chip) {
            add(drawing.chip.box);
        }
    }
    const start = initial ? states.get(initial.stateId) : undefined;
    if (start && initial) {
        const centre = centreOf(start);
        // From the centre past the outline, which is no further than the half diagonal.
        const reach = Math.hypot(start.width, start.height) / 2 + INITIAL_MARK_REACH_PX;
        const dot = { x: centre.x + initial.direction.x * reach, y: centre.y + initial.direction.y * reach };
        add({ x: dot.x - INITIAL_MARK.DOT, y: dot.y - INITIAL_MARK.DOT, width: 2 * INITIAL_MARK.DOT, height: 2 * INITIAL_MARK.DOT });
    }
    return bounds;
}
