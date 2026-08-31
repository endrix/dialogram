/**
 * The geometry of a boundary port: a schematic port symbol, not a box.
 *
 * A network's inputs and outputs used to draw as rounded pills with the name
 * centred and the type under it. Two lines of text inside a 50px box, the wire
 * meeting it at the box's vertical centre — which is the gap BETWEEN the two
 * lines, so the wire ran through the middle of the label.
 *
 * This is the schematic treatment instead: an arrow glyph sitting on the wire's
 * own axis, with the text running outward from it, away from the wire. The name
 * sits ON the axis so the wire enters on the name line; the type sits on a
 * second line below, clear of the wire entirely. Names are right-aligned on
 * inputs and left-aligned on outputs, so both text columns run away from the
 * glyph column and the glyphs stay in a straight line.
 *
 * It lives in shared because the two halves of it are computed in different
 * processes and must agree exactly: the SERVER sizes the node and places the
 * port (which is what the edge routers anchor to), the CLIENT draws the glyph
 * and the two text lines. If the client's glyph and the server's port anchor
 * disagree, the wire visibly misses the arrow it is supposed to touch.
 */

/** Arrow, bar, or hit-target extents. */
export interface BoundaryGlyphBox {
    width: number;
    height: number;
}

export namespace BoundaryPortGeometry {
    // The drawing these came from is set at a finer weight than the diagram
    // actually renders at: against a 3px wire, a 9.5px name and an 8px arrow
    // read as fine print beside a cable. Everything below is that drawing scaled
    // by about a quarter, keeping its proportions — the arrow still spans most
    // of the name's line, the type still sits a little under two thirds of the
    // name's size, and the gap still reads as one space.

    /** Total height of one port: the name line plus the type line. */
    export const ROW_PITCH_PX = 28;
    /** The name's line box. Its centre is the axis. */
    export const NAME_LINE_HEIGHT_PX = 15;
    /** The type's line box, directly below the name's. */
    export const TYPE_LINE_HEIGHT_PX = 13;

    export const NAME_FONT_PX = 12;
    export const TYPE_FONT_PX = 10;

    /** Between the glyph and the first character of text. */
    export const GLYPH_TEXT_GAP_PX = 5;

    /** An input's glyph: a plain arrow, pointing into the diagram. */
    export const SOURCE_ARROW: BoundaryGlyphBox = { width: 10, height: 12 };
    /** An output's glyph: an arrow that stops against a bar, like a terminal. */
    export const SINK_ARROW: BoundaryGlyphBox = { width: 9, height: 12 };
    export const SINK_BAR: BoundaryGlyphBox = { width: 2.5, height: 14 };

    /**
     * The grab target: the node's whole row, not a box around the arrow.
     *
     * It started as a small rectangle centred on the glyph, on the reasoning
     * that a 10px arrow is too small to hit reliably. True, but it made the name
     * something that merely sat NEXT to the port rather than part of it — you
     * could not click or drag a port by its own name, and selecting one outlined
     * the arrow while leaving the name outside. A port is one object; its whole
     * row is that object.
     *
     * The width is the node's, so it is the caller that supplies it. The height
     * stays the fixed row pitch rather than anything measured from the text,
     * which is what keeps the original property: hiding the type line at low
     * zoom moves nothing, because the target never depended on it.
     */
    export const HIT_HEIGHT_PX = ROW_PITCH_PX;

    /** Where the wire meets the port, measured down from the node's top. */
    export const AXIS_Y_PX = NAME_LINE_HEIGHT_PX / 2;

    /** Centre of the type line, measured down from the node's top. */
    export const TYPE_Y_PX = NAME_LINE_HEIGHT_PX + TYPE_LINE_HEIGHT_PX / 2;

    /**
     * A rough width for a run of text, used ONLY to size the grab target.
     *
     * The real width is a browser measurement the model has no access to, and
     * asking for one would mean a render pass. An estimate is fine here because
     * nothing about the drawing depends on it: the glyph, the text and the port
     * anchor are all positioned from fixed geometry, and this decides only how
     * far the clickable area reaches. Being a few pixels out makes the target
     * slightly generous or slightly tight, and nothing moves either way.
     *
     * It must never be used to lay anything out.
     */
    export function approximateTextWidth(text: string, fontPx: number): number {
        // Averaged across the mixed-case identifiers these labels actually hold;
        // the UI font is proportional, so no single ratio is right for all of
        // them, and erring wide costs nothing but a slightly larger target.
        return text.length * fontPx * 0.6;
    }

    /** Full width of a glyph, including an output's bar. */
    export function glyphWidth(isInput: boolean): number {
        return isInput ? SOURCE_ARROW.width : SINK_ARROW.width + SINK_BAR.width;
    }

    /**
     * Where text starts, as an offset from the node's own inner edge.
     *
     * Inputs read right-to-left from the node's right edge; outputs left-to-right
     * from its left edge. Either way the text begins one gap past the glyph.
     */
    export function textOffset(isInput: boolean): number {
        return glyphWidth(isInput) + GLYPH_TEXT_GAP_PX;
    }
}
