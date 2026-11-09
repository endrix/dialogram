/**
 * A port's name: how wide it is estimated before the client measures it, and
 * where it sits against its port. One copy, for the server's model, its
 * placement on every submit, and the client's view.
 */
import { WorkflowDiagramConstants } from './diagram-constants';

/** A port name's box before the client has measured it. */
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
