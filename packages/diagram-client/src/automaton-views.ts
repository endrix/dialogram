/**
 * An automaton on the canvas: its states and its transitions.
 *
 * A state (`node:state`, a node of kind `state` in the document) is its name
 * in a pill, with the mark a statechart gives the state it starts in. A
 * transition (`edge:transition`, an edge between two states) is a curve from
 * state to state, or a loop on one, with what takes it written beside it: an
 * order badge when its state tries its transitions in an order, the label,
 * and a mark when it is taken under a condition.
 *
 * The transitions between the same two states, the same way, are one line
 * with their labels stacked beside it. Each is still an element of its own,
 * selected by its label: the first of them draws the line, and another draws
 * it again, over the first, only while it is selected or under the pointer,
 * so that the line lights up with whichever label is picked.
 *
 * Nothing here has a route in the model (transition-geometry.ts): a state
 * that is dragged keeps its transitions.
 */
import {
    RenderingContext,
    SEdgeImpl,
    ShapeView,
    deletableFeature,
    hoverFeedbackFeature,
    selectFeature,
    svg,
    type IView,
    type IViewArgs
} from '@eclipse-glsp/client';
import { WorkflowDiagramConstants, WorkflowDiagramMetadata, WorkflowDiagramTypes, stateStepText, stubChipWidth, transitionLabelTextX, type StateStep } from '@dialogram/shared';
import { injectable } from 'inversify';
import type { VNode } from 'snabbdom';
import { WorkflowEdge, WorkflowNode } from './model';
import { nodeOpenToggle } from './node-open-toggle';
import {
    labelCandidates,
    labelLineBox,
    leaveState,
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

/** A state of an automaton. */
export class StateNode extends WorkflowNode {
    override type = WorkflowDiagramTypes.NODE_STATE;
}

/** A transition of an automaton: no route to edit, and its bounds are its shape's. */
export class TransitionEdge extends WorkflowEdge {
    static override readonly DEFAULT_FEATURES = [selectFeature, deletableFeature, hoverFeedbackFeature];

    override type = WorkflowDiagramTypes.EDGE_TRANSITION;

    /** What the server says of it: its label, its order, its condition. */
    args?: Record<string, unknown>;

    /** Where a link to what its action works with meets it: its label, which is what is picked. */
    get linkAnchor(): Box | undefined {
        return transitionDrawing(this)?.label;
    }

    /** The curve and the label: what a fit, a centring or an export takes it to cover. */
    override get bounds(): Box {
        const drawn = transitionDrawing(this);
        return drawn ? unionBox(unionBox(drawn.shape.box, drawn.label), drawn.chip?.box ?? drawn.label) : { x: 0, y: 0, width: -1, height: -1 };
    }
}

type Shaped = { position?: Point; size?: { width: number; height: number }; parent?: unknown; args?: Record<string, unknown> };

/** The steps of the run a state stands for, when it stands for one. */
export function stepsOfState(state: unknown): StateStep[] | undefined {
    const steps = (state as Shaped | undefined)?.args?.[WorkflowDiagramMetadata.STATE_STEPS];
    return Array.isArray(steps) && steps.length > 0 ? steps as StateStep[] : undefined;
}

/** A state's box in the diagram's coordinates; one that lists steps has the corners of a pill of a state's height. */
function boxOf(state: unknown): Box | undefined {
    const shaped = state as Shaped | undefined;
    if (!shaped?.position || !shaped.size) {
        return undefined;
    }
    let { x, y } = shaped.position;
    for (let parent = shaped.parent as Shaped | undefined; parent?.position; parent = parent.parent as Shaped | undefined) {
        x += parent.position.x;
        y += parent.position.y;
    }
    const box: Box = { x, y, width: shaped.size.width, height: shaped.size.height };
    if (stepsOfState(state)) {
        box.radius = WorkflowDiagramConstants.STATE_HEIGHT_PX / 2;
    }
    return box;
}

const centreOf = (box: Box): Point => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 });

function isTransition(element: unknown): element is SEdgeImpl {
    return (element as { type?: string } | undefined)?.type === WorkflowDiagramTypes.EDGE_TRANSITION;
}

/** The transitions of the diagram an edge is in. */
function transitionsOf(edge: SEdgeImpl): SEdgeImpl[] {
    return (edge.root?.children ?? []).filter(isTransition);
}

function orderOf(edge: SEdgeImpl): number {
    const order = (edge as unknown as { args?: Record<string, unknown> }).args?.[WorkflowDiagramMetadata.TRANSITION_ORDER];
    return typeof order === 'number' ? order : Number.MAX_SAFE_INTEGER;
}

/** Whether a transition is drawn as a stub at its source (a way into a hub). */
export function isStub(edge: unknown): boolean {
    return (edge as { args?: Record<string, unknown> } | undefined)?.args?.[WorkflowDiagramMetadata.TRANSITION_STUB] === true;
}

function nameOf(state: unknown): string {
    const name = (state as Shaped | undefined)?.args?.[WorkflowDiagramMetadata.ENTITY_NAME];
    return typeof name === 'string' ? name : String((state as { id?: string } | undefined)?.id ?? '');
}

function labelWidthOf(edge: SEdgeImpl): number {
    const width = (edge as unknown as { args?: Record<string, unknown> }).args?.[WorkflowDiagramMetadata.TRANSITION_LABEL_WIDTH];
    return typeof width === 'number' && Number.isFinite(width) ? width : 0;
}

/**
 * Where the transitions of a state that are no loops and no stubs lead: the
 * other states' centres. (A stub goes where there is room, see below.)
 */
function neighboursOf(stateId: string, transitions: readonly SEdgeImpl[]): Point[] {
    const others: Point[] = [];
    for (const transition of transitions) {
        if (transition.sourceId === transition.targetId || isStub(transition)) {
            continue;
        }
        const far = transition.sourceId === stateId ? transition.target : transition.targetId === stateId ? transition.source : undefined;
        const box = boxOf(far);
        if (box) {
            others.push(centreOf(box));
        }
    }
    return others;
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

/** What is drawn of an automaton, and the states' places it was worked out for. */
interface AutomatonDrawing {
    key: string;
    transitions: Map<string, TransitionDrawing>;
    /** Per state, the directions its loop and its stubs leave in, which its initial mark keeps clear of. */
    away: Map<string, Point[]>;
}

/**
 * Worked out once per root and per places of its states: every transition's
 * view asks for its own, and the blocks of labels are placed all together.
 */
const drawings = new WeakMap<object, AutomatonDrawing>();

function isState(element: unknown): boolean {
    return (element as { type?: string } | undefined)?.type === WorkflowDiagramTypes.NODE_STATE;
}

/** The drawing of the automaton a root holds: each transition's curve, and where its label is. */
function automatonDrawing(root: { children?: readonly unknown[] }): AutomatonDrawing {
    const children = root.children ?? [];
    const states = new Map<string, Box>();
    for (const child of children) {
        const box = isState(child) ? boxOf(child) : undefined;
        if (box) {
            states.set(String((child as { id: string }).id), box);
        }
    }
    const all = children.filter(isTransition);
    const key = [...states].map(([id, box]) => `${id}:${box.x},${box.y},${box.width},${box.height}`).join('|') + `#${all.length}`;
    const cached = drawings.get(root);
    if (cached?.key === key) {
        return cached;
    }

    // The lines: the transitions between the same two states, the same way,
    // in the order their state tries them, then as the document has them.
    const lines = new Map<string, Array<{ edge: SEdgeImpl; index: number }>>();
    all.forEach((edge, index) => {
        const line = `${edge.sourceId}\u0000${edge.targetId}`;
        lines.set(line, [...(lines.get(line) ?? []), { edge, index }]);
    });
    const drawn: Array<{ members: SEdgeImpl[]; shape: TransitionShape; widths: number[]; loop: boolean; bowed: boolean; chip?: TransitionDrawing['chip'] }> = [];
    const away = new Map<string, Point[]>();
    const stubs: SEdgeImpl[][] = [];
    for (const entries of lines.values()) {
        const members = entries.sort((a, b) => orderOf(a.edge) - orderOf(b.edge) || a.index - b.index).map(entry => entry.edge);
        const { sourceId, targetId } = members[0];
        const source = states.get(sourceId);
        const target = states.get(targetId);
        if (!source || !target) {
            continue;
        }
        const loop = sourceId === targetId;
        if (!loop && isStub(members[0])) {
            stubs.push(members);
            continue;
        }
        const bowed = !loop && lines.has(`${targetId}\u0000${sourceId}`) && !isStub(lines.get(`${targetId}\u0000${sourceId}`)![0].edge);
        let shape: TransitionShape;
        if (loop) {
            const direction = loopDirection(centreOf(source), neighboursOf(sourceId, all));
            away.set(sourceId, [direction]);
            shape = transitionLoop(source, direction);
        } else {
            // Round the states in its way.
            const others = [...states].filter(([id]) => id !== sourceId && id !== targetId).map(([, box]) => box);
            shape = transitionAround(source, target, bowed, others);
        }
        drawn.push({ members, shape, widths: members.map(labelWidthOf), loop, bowed });
    }
    // A stub leaves its state into the widest room left by the state's other
    // lines, its loop and the stubs placed before it: it names where it goes,
    // so it need not point there, and pointing there laid it on the curve
    // that comes from there more often than not.
    const k = WorkflowDiagramConstants;
    for (const members of stubs.sort((a, b) => a[0].sourceId.localeCompare(b[0].sourceId) || nameOf(a[0].target).localeCompare(nameOf(b[0].target)))) {
        const { sourceId, targetId } = members[0];
        const source = states.get(sourceId)!;
        const target = states.get(targetId)!;
        const centre = centreOf(source);
        const taken = [
            ...neighboursOf(sourceId, all),
            ...(away.get(sourceId) ?? []).map(d => ({ x: centre.x + d.x * 100, y: centre.y + d.y * 100 }))
        ];
        const direction = loopDirection(centre, taken);
        away.set(sourceId, [...(away.get(sourceId) ?? []), direction]);
        const name = nameOf(members[0].target);
        const stub = transitionStub(source, { x: centre.x + direction.x * 100, y: centre.y + direction.y * 100 },
            stubChipWidth(name), k.TRANSITION_STUB_CHIP_HEIGHT_PX, k.TRANSITION_STUB_PX);
        drawn.push({ members, shape: stub, widths: members.map(labelWidthOf), loop: false, bowed: false, chip: { box: stub.chip, name, way: transitionBetween(source, target, false) } });
    }

    const lineHeight = WorkflowDiagramConstants.TRANSITION_LABEL_HEIGHT_PX;
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
    const transitions = new Map<string, TransitionDrawing>();
    drawn.forEach((line, k) => {
        line.members.forEach((edge, position) => {
            transitions.set(edge.id, {
                shape: line.shape,
                label: labelLineBox(blocks[k], line.widths, lineHeight, position),
                first: position === 0,
                ...(line.chip ? { chip: line.chip } : {})
            });
        });
    });
    const result = { key, transitions, away };
    drawings.set(root, result);
    return result;
}

/** What is drawn of a transition, from where its states are now. */
export function transitionDrawing(edge: SEdgeImpl): TransitionDrawing | undefined {
    const root = edge.root as unknown as { children?: readonly unknown[] } | undefined;
    return root ? automatonDrawing(root).transitions.get(edge.id) : undefined;
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

/** The mark of the state an automaton starts in: a dot and an arrow into the state, from `direction`. */
function initialMark(state: Box, direction: Point): VNode {
    const DOT = 4.5;
    const SHAFT = 16;
    const HEAD = 7;
    // Where the arrow ends, on the state's outline, in the state's own coordinates.
    const centre = centreOf(state);
    const at = leaveState(state, { x: centre.x + direction.x * 100, y: centre.y + direction.y * 100 }, 1);
    // Drawn pointing east into the origin, then turned to point at the state.
    const angle = Math.atan2(-direction.y, -direction.x) * 180 / Math.PI;
    return svg('g', { class: { 'state-initial-mark': true }, attrs: { transform: `translate(${at.x - state.x}, ${at.y - state.y}) rotate(${angle})` } },
        svg('title', {}, 'Starts here'),
        svg('circle', { class: { 'state-initial-dot': true }, attrs: { cx: -(SHAFT + HEAD + DOT), cy: 0, r: DOT } }),
        svg('path', {
            class: { 'state-initial-arrow': true },
            attrs: { d: `M${-(SHAFT + HEAD)},0 H${-HEAD} M-1,0 l${-HEAD},${-HEAD / 2} v${HEAD} Z` }
        })
    ) as VNode;
}

/** Where a state's initial mark comes from, given the diagram's transitions. */
function initialMarkFor(state: Box, stateId: string, transitions: readonly SEdgeImpl[], root: unknown): Point {
    const centre = centreOf(state);
    // Its loop and its stubs are in the way as its lines are.
    const away = (root ? automatonDrawing(root as { children?: readonly unknown[] }).away.get(stateId) : undefined) ?? [];
    const neighbours = [...neighboursOf(stateId, transitions), ...away.map(d => ({ x: centre.x + d.x * 100, y: centre.y + d.y * 100 }))];
    return initialMarkDirection(centre, neighbours, undefined);
}

@injectable()
export class StateNodeView extends ShapeView {
    override render(node: Readonly<StateNode>, context: RenderingContext, _args?: IViewArgs): VNode | undefined {
        if (!this.isVisible(node, context)) {
            return undefined;
        }
        const { width, height } = node.size;
        const args = node.args ?? {};
        const name = args[WorkflowDiagramMetadata.ENTITY_NAME];
        const initial = args[WorkflowDiagramMetadata.STATE_INITIAL] === true;
        const transitions = (node.root?.children ?? []).filter(isTransition);
        const box = boxOf(node);
        const steps = stepsOfState(node);
        const k = WorkflowDiagramConstants;
        const radius = steps ? k.STATE_HEIGHT_PX / 2 : height / 2;
        const top = steps ? k.STATE_HEIGHT_PX / 2 : height / 2;
        // The run it folds, or opens: a toggle at its right end, the name centred left of it.
        const run = typeof args[WorkflowDiagramMetadata.STATE_RUN] === 'string';
        const runOpen = args[WorkflowDiagramMetadata.STATE_RUN_OPEN] === true;
        const toggleRoom = run ? k.STATE_RUN_TOGGLE_PX : 0;
        const label = typeof name === 'string' ? name : '';
        return svg('g', {
            class: {
                'workflow-node': true,
                'state-node': true,
                'state-initial': initial,
                'state-run': !!steps,
                selected: node.selected,
                hover: node.hoverFeedback
            },
            attrs: { transform: `translate(${node.position.x}, ${node.position.y})` }
        },
            svg('rect', { class: { 'node-body': true }, attrs: { x: 0, y: 0, width, height, rx: radius, ry: radius } }),
            ...(initial && box ? [initialMark(box, initialMarkFor(box, node.id, transitions, node.root))] : []),
            svg('text', { class: { 'state-name': true }, attrs: { x: (width - toggleRoom) / 2, y: top } }, label),
            ...(run
                ? [nodeOpenToggle(node.id, runOpen, label, width - toggleRoom / 2 - 2, top,
                    runOpen ? 'Fold the run this state starts into one state' : `Unfold ${label}: show its states`)]
                : []),
            ...(steps
                ? [
                    svg('line', { class: { 'state-steps-rule': true }, attrs: { x1: 0, y1: k.STATE_HEIGHT_PX, x2: width, y2: k.STATE_HEIGHT_PX } }),
                    ...steps.map((step, n) => svg('text', {
                        class: { 'state-step': true },
                        attrs: { x: k.STATE_LABEL_PADDING_PX, y: k.STATE_HEIGHT_PX + (n + 0.5) * k.STATE_STEP_HEIGHT_PX + 2 }
                    }, stateStepText(step)))
                ]
                : []),
            ...context.renderChildren(node)
        ) as VNode;
    }
}

@injectable()
export class TransitionEdgeView implements IView {
    render(edge: Readonly<TransitionEdge>, _context: RenderingContext, _args?: IViewArgs): VNode | undefined {
        const drawn = transitionDrawing(edge);
        if (!drawn) {
            return undefined;
        }
        const { shape, label, first, chip } = drawn;
        // A stub shows the whole way to its state while it, or that state, is picked.
        const picked = edge.selected || edge.hoverFeedback || (edge.target as unknown as { selected?: boolean } | undefined)?.selected === true;
        const args = edge.args ?? {};
        const text = typeof args[WorkflowDiagramMetadata.EDGE_LABEL] === 'string' ? args[WorkflowDiagramMetadata.EDGE_LABEL] as string : '';
        const order = args[WorkflowDiagramMetadata.TRANSITION_ORDER];
        const hasOrder = typeof order === 'number';
        const condition = args[WorkflowDiagramMetadata.TRANSITION_CONDITION];
        const middle = label.height / 2;
        const badge = WorkflowDiagramConstants.TRANSITION_ORDER_BADGE_PX;
        // The line is the first's; another draws it over the first while it is picked.
        const line = first || edge.selected || edge.hoverFeedback
            ? [
                ...(first ? [svg('path', { class: { 'transition-reach': true }, attrs: { d: shape.path } })] : []),
                svg('path', { class: { 'edge-line': true }, attrs: { d: shape.path, fill: 'none' } }),
                svg('polygon', {
                    class: { 'edge-arrow': true },
                    attrs: { points: '-7.5,-3.75 0,0 -7.5,3.75', transform: `translate(${shape.tip.x},${shape.tip.y}) rotate(${shape.angle})` }
                })
            ]
            : [];
        const stubParts = chip
            ? [
                ...(picked ? [svg('path', { class: { 'transition-stub-way': true }, attrs: { d: chip.way.path, fill: 'none' } })] : []),
                ...(first
                    ? [svg('g', { class: { 'transition-stub-chip': true }, attrs: { transform: `translate(${chip.box.x}, ${chip.box.y})` } },
                        svg('title', {}, `To ${chip.name}`),
                        svg('rect', { class: { 'transition-stub-chip-box': true }, attrs: { x: 0, y: 0, width: chip.box.width, height: chip.box.height, rx: chip.box.height / 2, ry: chip.box.height / 2 } }),
                        svg('text', { class: { 'transition-stub-chip-text': true }, attrs: { x: chip.box.width / 2, y: chip.box.height / 2 } }, chip.name))]
                    : [])
            ]
            : [];
        return svg('g', { class: { 'sprotty-edge': true, mouseover: edge.hoverFeedback } },
            svg('g', {
                class: {
                    'workflow-edge': true,
                    'transition-edge': true,
                    'transition-stub': !!chip,
                    selected: edge.selected,
                    hover: edge.hoverFeedback,
                    'read-only': edge.readOnly
                }
            },
                ...stubParts,
                ...line,
                svg('g', { class: { 'transition-label': true }, attrs: { transform: `translate(${label.x}, ${label.y})` } },
                    svg('title', {}, typeof condition === 'string' ? `${text}, when ${condition}` : text),
                    svg('rect', { class: { 'transition-label-box': true }, attrs: { x: -4, y: 0, width: label.width + 8, height: label.height, rx: 4, ry: 4 } }),
                    ...(hasOrder
                        ? [
                            svg('circle', { class: { 'transition-order': true }, attrs: { cx: badge / 2, cy: middle, r: badge / 2 } }),
                            svg('text', { class: { 'transition-order-text': true }, attrs: { x: badge / 2, y: middle } }, String(order))
                        ]
                        : []),
                    // The condition's mark follows the label in the same text, so it sits where the label ends in any font.
                    svg('text', { class: { 'transition-label-text': true }, attrs: { x: transitionLabelTextX(hasOrder), y: middle } },
                        text,
                        ...(typeof condition === 'string' ? [svg('tspan', { class: { 'transition-condition': true }, attrs: { dx: 4 } }, '◆')] : []))
                )
            )
        ) as VNode;
    }
}
