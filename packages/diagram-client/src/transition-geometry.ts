/**
 * The shape of a transition of an automaton, from where its two states are.
 *
 * A transition stores no route. Between two states it is one curve, straight
 * when it is the only way between them and bowed to its right when the other
 * way exists too, so that the two never lie on each other. On one state it is
 * a loop, turned to the widest gap between the directions the state's other
 * transitions leave in. Its labels (one per transition between the same two
 * states, the same way) are a block beside the curve, half way along.
 *
 * Because the shape is a function of the states' places alone, a state that
 * is dragged keeps its transitions without anything being routed again, and
 * the same arithmetic answers what the drawing is asked elsewhere: its
 * bounds, for a fit or an export.
 *
 * Where a block of labels goes is decided for the whole automaton at once
 * (`placeLabelBlocks`): each block has a few places beside its curve, and
 * takes the first that keeps it off the states, off the blocks placed before
 * it and off the other curves, or the one that comes closest.
 *
 * Pure: no model, no DOM.
 */

export interface Point { x: number; y: number }
export interface Box {
    x: number;
    y: number;
    width: number;
    height: number;
    /** The radius of its corners, for a state: half its height (a pill) when not given. */
    radius?: number;
}

const centre = (box: Box): Point => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
const unit = (p: Point): Point => {
    const length = Math.hypot(p.x, p.y) || 1;
    return { x: p.x / length, y: p.y / length };
};
const fixed = (n: number): string => (Math.round(n * 10) / 10).toString();

/** How far the two ways between a pair of states bow apart, at their middle. */
const BOW_PX = 24;
/** How far a loop reaches from its state. */
const LOOP_REACH_PX = 40;
/** How far apart a loop's two ends are on its state, as a share of the direction it turns to. */
const LOOP_SPREAD = 0.36;
/** Between a state's outline and where a transition leaves it, and where its arrow head ends. */
const LEAVE_GAP_PX = 1;
const ARRIVE_GAP_PX = 5;
/** Between a curve and the block of its labels. */
const LABEL_GAP_PX = 6;

/**
 * Where the ray from a state's centre towards `to` leaves the state, `gap`
 * further out. A state is a rectangle with round corners: a pill (corners of
 * half its height) when it is a name, a box when it lists the steps of a run.
 */
export function leaveState(state: Box, to: Point, gap = 0): Point {
    const c = centre(state);
    const d = unit({ x: to.x - c.x, y: to.y - c.y });
    const hw = state.width / 2;
    const hh = state.height / 2;
    const r = Math.min(state.radius ?? Math.min(hw, hh), hw, hh);
    // Where it leaves the rectangle, then, if that is in a corner, the corner's arc.
    let t = Math.min(Math.abs(d.x) > 1e-9 ? hw / Math.abs(d.x) : Infinity, Math.abs(d.y) > 1e-9 ? hh / Math.abs(d.y) : Infinity);
    const qx = d.x * t;
    const qy = d.y * t;
    if (Math.abs(qx) > hw - r + 1e-9 && Math.abs(qy) > hh - r + 1e-9) {
        const kx = Math.sign(qx) * (hw - r);
        const ky = Math.sign(qy) * (hh - r);
        const along = d.x * kx + d.y * ky;
        t = along + Math.sqrt(Math.max(0, along * along - (kx * kx + ky * ky - r * r)));
    }
    return { x: c.x + d.x * (t + gap), y: c.y + d.y * (t + gap) };
}

export interface TransitionShape {
    /** The curve, as the `d` of an SVG path. */
    path: string;
    /** Where the arrow head's tip is, and the direction it points in, in degrees. */
    tip: Point;
    angle: number;
    /** The point of the curve its labels are set beside, and the side they go to. */
    anchor: Point;
    side: Point;
    /** A box the curve is inside. */
    box: Box;
    /** The curve's control points, its two ends included: a quadratic (three) or a cubic (four). */
    controls: Point[];
}

function boxAround(points: readonly Point[]): Box {
    const xs = points.map(p => p.x);
    const ys = points.map(p => p.y);
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

const degrees = (from: Point, to: Point): number => Math.atan2(to.y - from.y, to.x - from.x) * 180 / Math.PI;

/**
 * A transition between two states: straight, or bowed to its right when the
 * other way exists too. `bow` bends it further (to its left when negative),
 * as far out at its middle: round a state in its way.
 */
export function transitionBetween(source: Box, target: Box, bowed: boolean, bow: number = bowed ? BOW_PX : 0): TransitionShape {
    const a = centre(source);
    const b = centre(target);
    const along = unit({ x: b.x - a.x, y: b.y - a.y });
    // To the right of the way it goes, on a screen (y grows downwards).
    const right = { x: -along.y, y: along.x };
    const control = { x: (a.x + b.x) / 2 + right.x * bow * 2, y: (a.y + b.y) / 2 + right.y * bow * 2 };
    const start = leaveState(source, control, LEAVE_GAP_PX);
    const end = leaveState(target, control, ARRIVE_GAP_PX);
    return {
        path: `M${fixed(start.x)},${fixed(start.y)} Q${fixed(control.x)},${fixed(control.y)} ${fixed(end.x)},${fixed(end.y)}`,
        tip: end,
        angle: degrees(control, end),
        anchor: { x: 0.25 * start.x + 0.5 * control.x + 0.25 * end.x, y: 0.25 * start.y + 0.5 * control.y + 0.25 * end.y },
        side: right,
        box: boxAround([start, control, end]),
        controls: [start, control, end]
    };
}

/**
 * A transition drawn as a stub: a short arrow out of its source, pointing at
 * where its target is, and the chip that names the target at its end.
 */
export function transitionStub(source: Box, towards: Point, chipWidth: number, chipHeight: number, length: number): TransitionShape & { chip: Box } {
    const c = centre(source);
    const dir = unit({ x: towards.x - c.x, y: towards.y - c.y });
    const start = leaveState(source, towards, LEAVE_GAP_PX);
    const end = { x: start.x + dir.x * length, y: start.y + dir.y * length };
    const control = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
    // The chip just past the arrow's tip, as far out as its half extent that way.
    const reach = 3 + Math.abs(dir.x) * chipWidth / 2 + Math.abs(dir.y) * chipHeight / 2;
    const chip = { x: end.x + dir.x * reach - chipWidth / 2, y: end.y + dir.y * reach - chipHeight / 2, width: chipWidth, height: chipHeight };
    return {
        path: `M${fixed(start.x)},${fixed(start.y)} L${fixed(end.x)},${fixed(end.y)}`,
        tip: end,
        angle: degrees(start, end),
        anchor: control,
        side: { x: -dir.y, y: dir.x },
        box: boxAround([start, end, { x: chip.x, y: chip.y }, { x: chip.x + chip.width, y: chip.y + chip.height }]),
        controls: [start, control, end],
        chip
    };
}

/** A loop on a state, turned towards `away`. */
export function transitionLoop(state: Box, away: Point): TransitionShape {
    const c = centre(state);
    const dir = unit(away);
    const across = { x: -dir.y, y: dir.x };
    const aim = (sign: number): Point => ({
        x: c.x + (dir.x + across.x * LOOP_SPREAD * sign) * 100,
        y: c.y + (dir.y + across.y * LOOP_SPREAD * sign) * 100
    });
    const start = leaveState(state, aim(-1), LEAVE_GAP_PX);
    const end = leaveState(state, aim(1), ARRIVE_GAP_PX);
    const out = (from: Point, sign: number): Point => ({
        x: from.x + dir.x * LOOP_REACH_PX + across.x * LOOP_REACH_PX * 0.55 * sign,
        y: from.y + dir.y * LOOP_REACH_PX + across.y * LOOP_REACH_PX * 0.55 * sign
    });
    const c1 = out(start, -1);
    const c2 = out(end, 1);
    // A cubic whose two controls are `reach` out is furthest out at three quarters of it.
    const top = {
        x: (start.x + end.x) / 2 + dir.x * LOOP_REACH_PX * 0.75,
        y: (start.y + end.y) / 2 + dir.y * LOOP_REACH_PX * 0.75
    };
    return {
        path: `M${fixed(start.x)},${fixed(start.y)} C${fixed(c1.x)},${fixed(c1.y)} ${fixed(c2.x)},${fixed(c2.y)} ${fixed(end.x)},${fixed(end.y)}`,
        tip: end,
        angle: degrees(c2, end),
        anchor: top,
        side: dir,
        box: boxAround([start, c1, c2, end]),
        controls: [start, c1, c2, end]
    };
}

/**
 * The direction a state's loop turns to: the middle of the widest gap between
 * the directions its other transitions leave in (`others`: where they lead);
 * straight up when it has none.
 */
export function loopDirection(state: Point, others: readonly Point[]): Point {
    if (others.length === 0) {
        return { x: 0, y: -1 };
    }
    const angles = others.map(other => Math.atan2(other.y - state.y, other.x - state.x)).sort((p, q) => p - q);
    let widest = -1;
    let middle = -Math.PI / 2;
    angles.forEach((angle, k) => {
        const next = k + 1 < angles.length ? angles[k + 1] : angles[0] + 2 * Math.PI;
        if (next - angle > widest + 1e-6) {
            widest = next - angle;
            middle = angle + (next - angle) / 2;
        }
    });
    return { x: Math.cos(middle), y: Math.sin(middle) };
}

/** The point of a Bézier curve at `t` (0 at its start, 1 at its end). */
export function curveAt(controls: readonly Point[], t: number): Point {
    let points = controls.map(p => ({ ...p }));
    while (points.length > 1) {
        points = points.slice(1).map((p, k) => ({ x: points[k].x + (p.x - points[k].x) * t, y: points[k].y + (p.y - points[k].y) * t }));
    }
    return points[0];
}

/** How far a transition may bend round a state in its way, tried in this order, right then left. */
const DETOURS_PX = [40, 70, 110, 160, 230];
/** Kept between a curve and a state it goes round. */
const CLEARANCE_PX = 8;

/** How many of `boxes` (padded) a curve passes through, by samples along it. */
export function boxesCrossed(controls: readonly Point[], boxes: readonly Box[], samples = 24): number {
    let crossed = 0;
    for (const box of boxes) {
        for (let k = 1; k < samples; k++) {
            const p = curveAt(controls, k / samples);
            if (p.x > box.x - CLEARANCE_PX && p.x < box.x + box.width + CLEARANCE_PX
                && p.y > box.y - CLEARANCE_PX && p.y < box.y + box.height + CLEARANCE_PX) {
                crossed++;
                break;
            }
        }
    }
    return crossed;
}

/**
 * A transition between two states that goes round the states in its way:
 * as `transitionBetween` when its line is clear, else bent out by the least
 * of a few amounts that clears it (to its right first; to its right only
 * when it is one of two ways, so that the two stay apart), or that crosses
 * fewest.
 */
export function transitionAround(source: Box, target: Box, bowed: boolean, others: readonly Box[]): TransitionShape {
    const plain = transitionBetween(source, target, bowed);
    let best = plain;
    let fewest = boxesCrossed(plain.controls, others);
    if (fewest === 0) {
        return plain;
    }
    const base = bowed ? BOW_PX : 0;
    for (const detour of DETOURS_PX) {
        for (const sign of bowed ? [1] : [1, -1]) {
            const shape = transitionBetween(source, target, bowed, base + sign * detour);
            const crossed = boxesCrossed(shape.controls, others);
            if (crossed < fewest) {
                best = shape;
                fewest = crossed;
                if (crossed === 0) {
                    return best;
                }
            }
        }
    }
    return best;
}

/** A place for a block of labels: the point of the curve it is set beside, and the side it goes to. */
export interface LabelCandidate { at: Point; side: Point }

/** Along a curve between two states, the places its labels are tried at, the middle first. */
const ALONG = [0.5, 0.38, 0.62, 0.28, 0.72];

/**
 * The places a block of labels is tried at, the one it is drawn at when
 * nothing is in the way first. A loop's block sits beyond its top. A curve's
 * sits beside it, half way along and then further towards either end, to its
 * right; to its left too when it is straight (a bowed curve has the other way
 * on its left).
 */
export function labelCandidates(shape: TransitionShape, loop: boolean, bowed: boolean): LabelCandidate[] {
    if (loop || shape.controls.length !== 3) {
        return [{ at: shape.anchor, side: shape.side }];
    }
    const result: LabelCandidate[] = [];
    for (const t of ALONG) {
        const before = curveAt(shape.controls, Math.max(0, t - 0.01));
        const after = curveAt(shape.controls, Math.min(1, t + 0.01));
        const tangent = unit({ x: after.x - before.x, y: after.y - before.y });
        const right = { x: -tangent.y, y: tangent.x };
        const at = curveAt(shape.controls, t);
        result.push({ at, side: right });
        if (!bowed) {
            result.push({ at, side: { x: -right.x, y: -right.y } });
        }
    }
    return result;
}

/** The box of a block of labels `width` by `height` at a place beside its curve. */
export function labelBlockAt(candidate: LabelCandidate, width: number, height: number): Box {
    const { at, side } = candidate;
    const reach = LABEL_GAP_PX + Math.abs(side.x) * width / 2 + Math.abs(side.y) * height / 2;
    return { x: at.x + side.x * reach - width / 2, y: at.y + side.y * reach - height / 2, width, height };
}

/** The area two boxes share. */
export function overlapArea(a: Box, b: Box): number {
    const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
    const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
    return w > 0 && h > 0 ? w * h : 0;
}

/** A block of labels to place: where it may go, and how big it is. */
export interface LabelBlock {
    candidates: readonly LabelCandidate[];
    width: number;
    height: number;
}

/** How much a block lying on a state or on another block weighs, per unit of area shared, against one on a curve. */
const COVER_WEIGHT = 10;
const CURVE_WEIGHT = 40;
/** How far around a block another one or a state is kept, so that two never touch. */
const BLOCK_MARGIN_PX = 3;
/** How many points of each curve a block is checked against. */
const CURVE_SAMPLES = 12;

/**
 * Where each block goes (in `blocks`' order; each block's own curve is the
 * curve of the same index, which it may lie against). The blocks are placed
 * in turn, one with a single place first, so that a loop's block, which can
 * go nowhere else, is in the way of the others rather than the reverse; each
 * takes the place that covers the least of the states, of the blocks placed
 * so far and of the other curves, the earlier of its places when two cover
 * as little.
 */
export function placeLabelBlocks(blocks: readonly LabelBlock[], states: readonly Box[], curves: readonly (readonly Point[])[]): Box[] {
    const samples = curves.map(controls => controls.length < 2
        ? []
        : Array.from({ length: CURVE_SAMPLES - 1 }, (_, k) => curveAt(controls, (k + 1) / CURVE_SAMPLES)));
    const order = blocks
        .map((block, index) => ({ block, index }))
        .sort((a, b) => Number(a.block.candidates.length > 1) - Number(b.block.candidates.length > 1) || a.index - b.index);
    const placed: Box[] = [];
    const result: Box[] = new Array(blocks.length);
    for (const { block, index } of order) {
        let best: Box | undefined;
        let bestCost = Infinity;
        block.candidates.forEach((candidate, rank) => {
            const box = labelBlockAt(candidate, block.width, block.height);
            const kept = { x: box.x - BLOCK_MARGIN_PX, y: box.y - BLOCK_MARGIN_PX, width: box.width + 2 * BLOCK_MARGIN_PX, height: box.height + 2 * BLOCK_MARGIN_PX };
            let cost = rank;
            for (const other of [...states, ...placed]) {
                cost += COVER_WEIGHT * overlapArea(kept, other);
            }
            samples.forEach((points, curve) => {
                if (curve === index) {
                    return;
                }
                for (const p of points) {
                    if (p.x > box.x && p.x < box.x + box.width && p.y > box.y && p.y < box.y + box.height) {
                        cost += CURVE_WEIGHT;
                    }
                }
            });
            if (cost < bestCost) {
                bestCost = cost;
                best = box;
            }
        });
        result[index] = best ?? labelBlockAt(block.candidates[0], block.width, block.height);
        placed.push(result[index]);
    }
    return result;
}

/** The box of line `line` of a block of labels, whose lines are `widths` wide. */
export function labelLineBox(block: Box, widths: readonly number[], lineHeight: number, line: number): Box {
    return { x: block.x, y: block.y + lineHeight * line, width: widths[line] ?? block.width, height: lineHeight };
}

/** The box around two boxes. */
export function unionBox(a: Box, b: Box): Box {
    const x = Math.min(a.x, b.x);
    const y = Math.min(a.y, b.y);
    return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
}
