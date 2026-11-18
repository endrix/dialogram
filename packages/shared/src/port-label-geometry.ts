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
 * height. The server sizes its nodes by it.
 */
export function estimateTextSize(text: string, fontSizePx: number): { width: number; height: number } {
    const columnWidth = Math.max(5, Math.round(fontSizePx * 0.6));
    return {
        width: Math.max(0, textColumns(text) * columnWidth),
        height: Math.max(10, Math.round(fontSizePx * 1.2))
    };
}

/** One part of a port's label as it is drawn: its text, whether it is the pin, how far it is set from the part before. */
export interface PortLabelPart {
    text: string;
    pin: boolean;
    dx: number;
}

/**
 * A port's label as it is drawn: its name, or the symbol pin said before it
 * (`cal:portLabelPin`, a register's `en` among the `d`s of its bus) and then
 * the name, `PORT_LABEL_PIN_GAP_PX` apart. The server sizes the label by these
 * parts and the client draws them.
 */
export function portLabelParts(name: string, pin?: string): PortLabelPart[] {
    return pin
        ? [{ text: pin, pin: true, dx: 0 }, { text: name, pin: false, dx: WorkflowDiagramConstants.PORT_LABEL_PIN_GAP_PX }]
        : [{ text: name, pin: false, dx: 0 }];
}

/** A symbol pin's name before the client has measured it, and the pin said before it: as the server sizes a symbol's body. */
export function estimatePinLabelSize(name: string, pin?: string): { width: number; height: number } {
    const fontSizePx = WorkflowDiagramConstants.PORT_LABEL_FONT_SIZE_PX;
    return {
        width: portLabelParts(name, pin).reduce((width, part) => width + part.dx + estimateTextSize(part.text, fontSizePx).width, 0),
        height: estimateTextSize(name, fontSizePx).height
    };
}

/**
 * A port name's box before the client has measured it, as the client draws it
 * and the server places it until then. A symbol's pin (`symbol`, with the pin
 * said before the name if there is one) is as the server sized it; any other
 * port's name keeps the estimate every product's labels have been placed by:
 * 0.7 of the font a column, 3 px each side.
 */
export function estimatePortLabelSize(text: string, symbol?: { pin?: string }): { width: number; height: number } {
    if (symbol) {
        return estimatePinLabelSize(text, symbol.pin);
    }
    const fontSizePx = WorkflowDiagramConstants.PORT_LABEL_FONT_SIZE_PX;
    const avgCharWidth = fontSizePx * 0.7;
    const padding = 3;
    return {
        width: Math.max(1, Math.ceil(textColumns(text) * avgCharWidth + padding * 2)),
        height: Math.max(1, Math.ceil(fontSizePx * 1.25))
    };
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
