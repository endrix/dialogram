/**
 * A node drawn as a symbol rather than a box: a gate, a mux, a register, an
 * operator.
 *
 * A producer says what a node is drawn as (`meta.symbol`: `and`, `or`, `xor`,
 * `xnor`, `not`, `mux`, `register`, `operator`, the last with the glyph it
 * shows in `meta.operator`) and, on each port, the pins it is wired to
 * (`port.pins`, data first, then controls, then the result). The server sizes
 * the node and places its pins from these measures; the client draws the body
 * between the pin stubs. Both read them here, so the pins sit where the body's
 * edges are drawn.
 *
 * The node's box is the body plus a short stub on each side: pins sit on the
 * box's edges, centred on its border as every port does, and the stub joins
 * each to the body, the way a schematic draws a gate's pins.
 */
export type SymbolKind = 'and' | 'or' | 'xor' | 'xnor' | 'not' | 'mux' | 'register' | 'operator';

export namespace SymbolGeometry {
    export const KINDS: readonly SymbolKind[] = ['and', 'or', 'xor', 'xnor', 'not', 'mux', 'register', 'operator'];
    /** Length of a pin's stub, between the box's edge and the body. */
    export const STUB_PX = 10;
    /** Distance between two pins' rows. */
    export const PIN_PITCH_PX = 14;
    /** Margin above the first pin and below the last. */
    export const PIN_MARGIN_PX = 8;
    /** The body's width, and the least height it is drawn at. */
    export const BODY: Readonly<Record<SymbolKind, { width: number; minHeight: number }>> = {
        and: { width: 30, minHeight: 28 },
        or: { width: 32, minHeight: 28 },
        xor: { width: 36, minHeight: 28 },
        xnor: { width: 40, minHeight: 28 },
        not: { width: 26, minHeight: 22 },
        mux: { width: 20, minHeight: 36 },
        register: { width: 44, minHeight: 36 },
        operator: { width: 30, minHeight: 26 }
    };
    /** The back of an OR and an XOR curves in by this share of the body's width. */
    export const BACK_CURVE = 0.25;
    /** An XOR's second back line sits this far behind its body. */
    export const XOR_GAP_PX = 5;
    /** The bubble on a NOT's or an XNOR's output. */
    export const BUBBLE_RADIUS_PX = 3;
    /** Room under a symbol for its caption: a register's name, or the one its producer gives. */
    export const CAPTION_HEIGHT_PX = 14;

    /** The order pins are placed in on a side: data, then controls, then the result. */
    export const PIN_ORDER: readonly string[] = ['a', 'b', 'c', 'd', 's', 'en', 'arst', 'srst', 'aload', 'ad', 'set', 'clr', 'clk', 'y', 'q'];

    /** Where a port goes among a symbol's pins: by the first pin it is wired to. */
    export function pinRank(pins: readonly string[] | undefined): number {
        if (!pins || pins.length === 0) {
            return PIN_ORDER.length + 1;
        }
        // A port feeding a mux's select and its data is drawn at the select:
        // the select is the pin a reader looks for.
        if (pins.includes('s')) {
            return PIN_ORDER.indexOf('s');
        }
        const rank = PIN_ORDER.indexOf(pins[0]);
        return rank < 0 ? PIN_ORDER.length : rank;
    }

    export function isKind(value: unknown): value is SymbolKind {
        return typeof value === 'string' && (KINDS as readonly string[]).includes(value);
    }

    /** The node's box: the body, its stubs, and its caption under it (a
     * register always has one). `bodyWidth` widens a body past its kind's (a
     * register's pin names). */
    export function size(kind: SymbolKind, inputs: number, outputs: number, bodyWidth?: number,
        captioned = kind === 'register'): { width: number; height: number } {
        const body = BODY[kind];
        // A register keeps a row under its inputs for the clock wedge.
        const rows = Math.max(inputs + (kind === 'register' ? 1 : 0), outputs, 1);
        const height = Math.max(body.minHeight, (rows - 1) * PIN_PITCH_PX + 2 * PIN_MARGIN_PX);
        const width = Math.max(body.width, bodyWidth ?? 0);
        return { width: width + 2 * STUB_PX, height: height + (captioned ? CAPTION_HEIGHT_PX : 0) };
    }

    /** The height the body is drawn at: the box less its caption's room. */
    export function bodyHeight(kind: SymbolKind, boxHeight: number, captioned = kind === 'register'): number {
        return captioned ? boxHeight - CAPTION_HEIGHT_PX : boxHeight;
    }

    /** Whether a symbol has a caption under it: a register always, another
     * symbol when it has a caption to show. */
    export function isCaptioned(kind: SymbolKind, caption: string | undefined): boolean {
        return kind === 'register' || !!caption;
    }

    /** The y of pin `index` of `count` on one side, centred on a height. */
    export function pinY(bodyHeightPx: number, count: number, index: number): number {
        return bodyHeightPx / 2 + (index - (count - 1) / 2) * PIN_PITCH_PX;
    }

    /** Whether a port is a register's clock: drawn at the wedge, not on a stub row. */
    export function isClockPin(kind: SymbolKind, pins: readonly string[] | undefined): boolean {
        return kind === 'register' && !!pins?.includes('clk');
    }

    /**
     * The y of pin `index` of a side's `count` pins: centred on the body; on
     * a register's inputs, centred on the body less the clock's row at its
     * bottom.
     */
    export function symbolPinY(kind: SymbolKind, bodyHeightPx: number, west: boolean, count: number, index: number): number {
        if (kind === 'register' && west) {
            return pinY(bodyHeightPx - PIN_PITCH_PX, count, index);
        }
        return pinY(bodyHeightPx, count, index);
    }

    /** Where a register's clock wedge is centred: the row under its inputs. */
    export function clockY(bodyHeightPx: number): number {
        return bodyHeightPx - PIN_MARGIN_PX;
    }

    /** Gap between a register's pin name and the body's edge. */
    export const PIN_NAME_INSET_PX = 3;
    /** Least gap between a register's input names and its output names. */
    export const PIN_NAME_SPACING_PX = 6;

    /**
     * The gap between a symbol pin's box and its name (`portLabelX`'s), so
     * the name sits inside the body, past the stub, on either side.
     */
    export function pinNameGap(portBoxWidth: number): number {
        return STUB_PX + PIN_NAME_INSET_PX - portBoxWidth / 2;
    }

    /** A register's body wide enough for its widest input and output names side by side. */
    export function registerBodyWidth(widestInput: number, widestOutput: number): number {
        return Math.max(BODY.register.width, widestInput + widestOutput + 2 * PIN_NAME_INSET_PX + PIN_NAME_SPACING_PX);
    }

    /** How far an OR's (an XOR's, an XNOR's) back curves in at its middle. */
    export function backDepth(kind: SymbolKind): number {
        return BODY[kind].width * BACK_CURVE;
    }

    /**
     * The back curve of an OR from top to bottom at `x`: a quadratic with its
     * control at mid-height, `backDepth` in. The body's outline, an XOR's
     * second line and the stubs' ends all follow it.
     */
    export function backCurvePath(kind: SymbolKind, x: number, bodyHeightPx: number): string {
        return `M ${x} 0 Q ${x + backDepth(kind)} ${bodyHeightPx / 2} ${x} ${bodyHeightPx}`;
    }

    /**
     * Where the body's back is at height `y` (relative to the body's top), as
     * an x in the node's box: an input pin's stub runs to here. Straight for
     * most; on the curve for an OR, and on the second back line (the same
     * curve, at the stub's end) for an XOR and an XNOR.
     */
    export function backX(kind: SymbolKind, bodyHeightPx: number, y: number): number {
        if (kind !== 'or' && kind !== 'xor' && kind !== 'xnor') {
            return STUB_PX;
        }
        const t = Math.min(1, Math.max(0, y / bodyHeightPx));
        return STUB_PX + 2 * t * (1 - t) * backDepth(kind);
    }

    /**
     * Where the body's front is at height `y`, as an x in the node's box: an
     * output pin's stub runs from here. On the half-ellipse for an AND, the
     * front curve for an OR, the slant for a NOT and a mux, past the bubble
     * for a NOT and an XNOR.
     */
    export function frontX(kind: SymbolKind, width: number, bodyHeightPx: number, y: number): number {
        const bubble = kind === 'not' || kind === 'xnor' ? 2 * BUBBLE_RADIUS_PX : 0;
        const right = width - STUB_PX;
        const front = right - bubble;
        const left = STUB_PX + (kind === 'xor' || kind === 'xnor' ? XOR_GAP_PX : 0);
        const mid = bodyHeightPx / 2;
        // How far from the middle, 0 there, 1 at the top or bottom.
        const off = Math.min(1, Math.abs(y - mid) / Math.max(mid, 1));
        if (bubble && off === 0) {
            return right;
        }
        switch (kind) {
            case 'and':
                return left + (front - left) / 2 * (1 + Math.sqrt(1 - off * off));
            case 'or':
            case 'xor':
            case 'xnor':
                // The two front quadratics meet at the tip; a parabola is near enough.
                return left + (front - left) * (1 - 0.65 * off * off);
            case 'not':
                return left + (front - left) * (1 - off);
            case 'mux': {
                // Straight between 20% and 80% of its height, slanting back above and below.
                const edge = 0.2 * bodyHeightPx;
                const fromEnd = Math.min(y, bodyHeightPx - y);
                return fromEnd >= edge ? right : left + (right - left) * Math.max(0, fromEnd) / edge;
            }
            default:
                return right;
        }
    }
}
