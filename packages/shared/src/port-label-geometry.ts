/**
 * A port's name: how wide it is estimated before the client measures it, and
 * where it sits against its port. One copy, for the server's model, its
 * placement on every submit, and the client's view.
 */
import { WorkflowDiagramConstants } from './diagram-constants';

/** Whether a character takes two columns of a fixed-width font: East Asian wide and fullwidth forms, emoji. */
function isWide(codePoint: number): boolean {
    return (codePoint >= 0x1100 && codePoint <= 0x115f)
        || (codePoint >= 0x2e80 && codePoint <= 0xa4cf)
        || (codePoint >= 0xac00 && codePoint <= 0xd7a3)
        || (codePoint >= 0xf900 && codePoint <= 0xfaff)
        || (codePoint >= 0xfe30 && codePoint <= 0xfe4f)
        || (codePoint >= 0xff00 && codePoint <= 0xff60)
        || (codePoint >= 0xffe0 && codePoint <= 0xffe6)
        || (codePoint >= 0x1f300 && codePoint <= 0x1faff)
        || (codePoint >= 0x20000 && codePoint <= 0x3fffd);
}

/** The columns a text takes in a fixed-width font: two for a wide character, one for any other. */
export function textColumns(text: string): number {
    let columns = 0;
    for (const char of text) {
        columns += isWide(char.codePointAt(0)!) ? 2 : 1;
    }
    return columns;
}

/**
 * A text's box before the client has measured it: a fixed width per column
 * (a producer's names are any text, and a wide character is two), a line's
 * height. The one estimate, for the server's model and the client's view.
 */
export function estimateTextSize(text: string, fontSizePx: number): { width: number; height: number } {
    const columnWidth = Math.max(5, Math.round(fontSizePx * 0.6));
    return {
        width: Math.max(0, textColumns(text) * columnWidth),
        height: Math.max(10, Math.round(fontSizePx * 1.2))
    };
}

/** A port name's box before the client has measured it. */
export function estimatePortLabelSize(text: string): { width: number; height: number } {
    return estimateTextSize(text, WorkflowDiagramConstants.PORT_LABEL_FONT_SIZE_PX);
}

/**
 * How far a port's box sits above its row: a port's box is the row's height
 * (`PORT_HEIGHT_PX`) and sits on it; a taller one (a bus's dot) is centred on
 * it, so it starts above.
 */
export function portRowOffset(boxHeight: number): number {
    return (WorkflowDiagramConstants.PORT_HEIGHT_PX - boxHeight) / 2;
}

/**
 * A port name's top, relative to its port's box: centred on the row, on a
 * whole pixel of the row whatever the box's height, so a bus's name lines up
 * with its neighbours'.
 */
export function portLabelY(boxHeight: number, labelHeight: number): number {
    return Math.round((WorkflowDiagramConstants.PORT_HEIGHT_PX - labelHeight) / 2) - portRowOffset(boxHeight);
}

/** A port name's left, relative to its port's box: inside the node, `gap` from the dot. */
export function portLabelX(east: boolean, boxWidth: number, labelWidth: number, gap: number): number {
    return east ? -gap - labelWidth : boxWidth + gap;
}
