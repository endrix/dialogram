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
    /** Room under a register for its name. */
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

    /** The node's box: the body, its stubs, and a register's name under it. */
    export function size(kind: SymbolKind, inputs: number, outputs: number): { width: number; height: number } {
        const body = BODY[kind];
        // A register keeps a row under its inputs for the clock wedge.
        const rows = Math.max(inputs + (kind === 'register' ? 1 : 0), outputs, 1);
        const height = Math.max(body.minHeight, (rows - 1) * PIN_PITCH_PX + 2 * PIN_MARGIN_PX);
        return { width: body.width + 2 * STUB_PX, height: height + (kind === 'register' ? CAPTION_HEIGHT_PX : 0) };
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

    /**
     * The gap between a symbol pin's box and its name (`portLabelX`'s), so
     * the name sits inside the body, past the stub, on either side.
     */
    export function pinNameGap(portBoxWidth: number): number {
        return STUB_PX + PIN_NAME_INSET_PX - portBoxWidth / 2;
    }

    /** The height the body is drawn at: the box less a register's caption. */
    export function bodyHeight(kind: SymbolKind, boxHeight: number): number {
        return kind === 'register' ? boxHeight - CAPTION_HEIGHT_PX : boxHeight;
    }

    /** The y of pin `index` of `count` on one side, centred on the body. */
    export function pinY(bodyHeightPx: number, count: number, index: number): number {
        return bodyHeightPx / 2 + (index - (count - 1) / 2) * PIN_PITCH_PX;
    }

    /**
     * Where the body's back is at height `y` (relative to the body's top), as
     * an x in the node's box: the stub of an input pin runs to here. Straight
     * for most; curved in for an OR, an XOR and an XNOR, whose second back
     * line is where an XOR's pins end.
     */
    export function backX(kind: SymbolKind, bodyHeightPx: number, y: number): number {
        const left = STUB_PX + (kind === 'xor' || kind === 'xnor' ? XOR_GAP_PX : 0);
        if (kind !== 'or' && kind !== 'xor' && kind !== 'xnor') {
            return STUB_PX;
        }
        const t = Math.min(1, Math.max(0, y / bodyHeightPx));
        const depth = BODY[kind].width * BACK_CURVE;
        // A quadratic from the top to the bottom with its control at mid-height,
        // `depth` in: x(t) = left + 2t(1-t)·depth. An XOR's pins end on its
        // second back line, the same curve `XOR_GAP_PX` behind.
        const curve = 2 * t * (1 - t) * depth;
        return kind === 'or' ? left + curve : left - XOR_GAP_PX + curve;
    }
}
