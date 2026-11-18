/**
 * A port's name: how wide it is estimated before the client measures it, and
 * where it sits against its port. One copy, for the server's model, its
 * placement on every submit, and the client's view.
 */
import { WorkflowDiagramConstants } from './diagram-constants';
import { WorkflowDiagramCss, WorkflowDiagramMetadata } from './diagram-types';

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

/** The columns one character (a code point) takes in a fixed-width font: two if it is wide, else one. */
export function charColumns(char: string): number {
    return isWide(char.codePointAt(0)!) ? 2 : 1;
}

/** The columns a text takes in a fixed-width font: two for a wide character, one for any other. */
export function textColumns(text: string): number {
    let columns = 0;
    for (const char of text) {
        columns += charColumns(char);
    }
    return columns;
}

/** A line of text's height at a font size, before the client has measured it. */
function textHeight(fontSizePx: number): number {
    return Math.max(10, Math.round(fontSizePx * 1.2));
}

/** A text's width per character (per column, of a fixed-width font) at a font size. */
function columnWidth(fontSizePx: number): number {
    return Math.max(5, Math.round(fontSizePx * 0.6));
}

/**
 * A text's box before the client has measured it, as the server sizes its
 * nodes by it: a fixed width per character, a line's height.
 */
export function estimateTextSize(text: string, fontSizePx: number): { width: number; height: number } {
    return { width: Math.max(0, text.length * columnWidth(fontSizePx)), height: textHeight(fontSizePx) };
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

/**
 * A symbol pin's name before the client has measured it, and the pin said
 * before it: as the server sizes a symbol's body. By columns, a wide
 * character two: a register's names are a producer's fields, any text.
 */
export function estimatePinLabelSize(name: string, pin?: string): { width: number; height: number } {
    const fontSizePx = WorkflowDiagramConstants.PORT_LABEL_FONT_SIZE_PX;
    return {
        width: portLabelParts(name, pin).reduce((width, part) => width + part.dx + textColumns(part.text) * columnWidth(fontSizePx), 0),
        height: textHeight(fontSizePx)
    };
}

/** A port name's box before the client has measured it: 0.7 of the font a character, 3 px each side, a line and a quarter high. */
export function estimatePortLabelSize(text: string): { width: number; height: number } {
    const fontSizePx = WorkflowDiagramConstants.PORT_LABEL_FONT_SIZE_PX;
    const avgCharWidth = fontSizePx * 0.7;
    const padding = 3;
    return {
        width: Math.max(1, Math.ceil(text.length * avgCharWidth + padding * 2)),
        height: Math.max(1, Math.ceil(fontSizePx * 1.25))
    };
}

/**
 * The room in front of a port's name: a bus's inset for its larger dot, a
 * member of an open bus's slot for its rail, so its name sits under the
 * bundle's, one step in; none for any other port.
 */
export function portLabelSlot(port: { bus: boolean; busMember: boolean }): number {
    return port.bus
        ? WorkflowDiagramConstants.PORT_BUS_LABEL_INSET_PX
        : port.busMember ? WorkflowDiagramConstants.PORT_BUS_RAIL_SLOT_PX : 0;
}

/**
 * A port label's box before the client has measured it, the same on the
 * server, which places it (`port-labels.ts`), and in the client, which draws
 * it: a symbol's pin name as the server sized it, the pin said before it; any
 * other port's name by `estimatePortLabelSize`; and in front of either, the
 * port's slot (`portLabelSlot`). Read from the model, as both sides have it.
 */
export function estimatePortLabelBox(
    port: { cssClasses?: readonly string[]; args?: Record<string, unknown> } | undefined,
    label: { text?: string; args?: Record<string, unknown> }
): { width: number; height: number; slot: number } {
    const text = label.text ?? '';
    const symbolPin = Array.isArray(port?.cssClasses) && port!.cssClasses!.includes(WorkflowDiagramCss.SYMBOL_PIN);
    const size = symbolPin
        ? estimatePinLabelSize(text, label.args?.[WorkflowDiagramMetadata.PORT_LABEL_PIN] as string | undefined)
        : estimatePortLabelSize(text);
    const slot = portLabelSlot({
        bus: port?.args?.[WorkflowDiagramMetadata.PORT_BUS_GROUP] !== undefined,
        busMember: port?.args?.[WorkflowDiagramMetadata.PORT_BUS_MEMBER_OF] !== undefined
    });
    return { width: size.width + slot, height: size.height, slot };
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
