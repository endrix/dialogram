/**
 * The body of a node drawn as a symbol: a gate's IEEE shape, a mux's
 * trapezoid, a register's box with its clock wedge, an operator's box with its
 * glyph, and each pin's stub between the box's edge and the body.
 *
 * The server sized the node and placed its pins from `SymbolGeometry`; this
 * draws the body between them with the same measures, so the stubs end on the
 * body's edges. Everything is a path in the node's own coordinates, drawn in
 * the editor's colours by the stylesheet.
 */
import { svg } from '@eclipse-glsp/client';
import { SymbolGeometry, type SymbolKind } from '@dialogram/shared';
import type { VNode } from 'snabbdom';

/** The rows of a symbol's pins, by side, in the node's coordinates. */
export interface SymbolPins {
    west: number[];
    east: number[];
}

/** The y of each pin of a node's children, by side: the middle of each port's box. */
export function symbolPinsOf(children: readonly unknown[], width: number): SymbolPins {
    const west: number[] = [];
    const east: number[] = [];
    for (const child of children) {
        const c = child as { type?: string; position?: { x: number; y: number }; size?: { width: number; height: number } };
        if (typeof c.type !== 'string' || !c.type.startsWith('port') || !c.position) {
            continue;
        }
        const h = c.size?.height ?? 0;
        const w = c.size?.width ?? 0;
        const y = c.position.y + h / 2;
        (c.position.x + w / 2 < width / 2 ? west : east).push(y);
    }
    return { west, east };
}

/** The body's outline, for the kinds drawn as one closed shape. */
export function symbolPath(kind: SymbolKind, width: number, height: number): string {
    const stub = SymbolGeometry.STUB_PX;
    const bubble = kind === 'not' || kind === 'xnor' ? 2 * SymbolGeometry.BUBBLE_RADIUS_PX : 0;
    const left = stub + (kind === 'xor' || kind === 'xnor' ? SymbolGeometry.XOR_GAP_PX : 0);
    const right = width - stub - bubble;
    const w = right - left;
    const mid = height / 2;
    switch (kind) {
        case 'and':
            // Flat back, a half-ellipse front.
            return `M ${left} 0 H ${left + w / 2} A ${w / 2} ${mid} 0 0 1 ${left + w / 2} ${height} H ${left} Z`;
        case 'or':
        case 'xor':
        case 'xnor':
            return SymbolGeometry.backCurvePath(kind, left, height)
                + ` Q ${left + w * 0.65} ${height} ${right} ${mid}`
                + ` Q ${left + w * 0.65} 0 ${left} 0 Z`;
        case 'not':
            return `M ${left} 0 L ${right} ${mid} L ${left} ${height} Z`;
        case 'mux':
            // Wide where the data come in, narrow where the result leaves.
            return `M ${left} 0 L ${right} ${height * 0.2} L ${right} ${height * 0.8} L ${left} ${height} Z`;
        case 'register':
        case 'operator':
        default:
            return `M ${left + 2} 0 H ${right - 2} Q ${right} 0 ${right} 2 V ${height - 2} Q ${right} ${height} ${right - 2} ${height}`
                + ` H ${left + 2} Q ${left} ${height} ${left} ${height - 2} V 2 Q ${left} 0 ${left + 2} 0 Z`;
    }
}

/** Everything drawn for a symbol's body: outline, extras, stubs and glyph. */
export function renderSymbolBody(
    kind: SymbolKind,
    size: { width: number; height: number },
    pins: SymbolPins,
    operator?: string,
    caption?: string
): VNode[] {
    const height = SymbolGeometry.bodyHeight(kind, size.height);
    const width = size.width;
    const stub = SymbolGeometry.STUB_PX;
    const out: VNode[] = [
        // The whole box takes the pointer, not only the shape: a click beside
        // a mux's narrow end or in an OR's back selects the node.
        svg('rect', { class: { 'symbol-hit': true }, attrs: { x: 0, y: 0, width, height } }),
        svg('path', { class: { 'node-body': true, 'symbol-body': true }, attrs: { d: symbolPath(kind, width, height) } })
    ];
    if (kind === 'xor' || kind === 'xnor') {
        out.push(svg('path', { class: { 'symbol-line': true }, attrs: { d: SymbolGeometry.backCurvePath(kind, stub, height) } }));
    }
    if (kind === 'not' || kind === 'xnor') {
        const r = SymbolGeometry.BUBBLE_RADIUS_PX;
        out.push(svg('circle', {
            class: { 'symbol-body': true, 'symbol-bubble': true },
            attrs: { cx: width - stub - r, cy: height / 2, r }
        }));
    }
    if (kind === 'register') {
        // The clock wedge, on the back in the row under the inputs: the clock
        // net itself is hidden.
        const y = SymbolGeometry.clockY(height);
        out.push(svg('path', {
            class: { 'symbol-line': true },
            attrs: { d: `M ${stub} ${y - 5} L ${stub + 7} ${y} L ${stub} ${y + 5}` }
        }));
    }
    for (const y of pins.west) {
        out.push(svg('line', {
            class: { 'symbol-stub': true },
            attrs: { x1: 0, y1: y, x2: SymbolGeometry.backX(kind, height, y), y2: y }
        }));
    }
    for (const y of pins.east) {
        out.push(svg('line', {
            class: { 'symbol-stub': true },
            attrs: { x1: SymbolGeometry.frontX(kind, width, height, y), y1: y, x2: width, y2: y }
        }));
    }
    if (kind === 'operator' && operator) {
        out.push(svg('text', {
            class: { 'symbol-operator': true },
            attrs: { x: width / 2, y: height / 2, 'text-anchor': 'middle', 'dominant-baseline': 'central' }
        }, operator));
    }
    if (caption) {
        out.push(svg('text', {
            class: { 'type-footer-label': true, 'symbol-caption': true },
            attrs: { x: width / 2, y: height + 3, 'text-anchor': 'middle', 'dominant-baseline': 'hanging' }
        }, caption));
    }
    return out;
}
