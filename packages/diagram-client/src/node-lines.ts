/**
 * The lines of text a producer puts in a node (`meta.lines`, on the wire the
 * node's `NODE_LINES` argument): what a reader zooms in for, such as the
 * condition under which a step runs or what it takes and gives.
 *
 * Each line is a band across the bottom of the node's body, in the producer's
 * order, the last following the body's rounded corners. The band is always
 * drawn, so a kind of line a product colours (`node-line-<kind>`) is seen
 * from afar: which nodes have a condition is read at a glance. The text is
 * detail (zoom-detail.ts): drawn only close in.
 *
 * The server sizes the node for its lines (graph-gmodel-source.ts): it is
 * taller by them and at least as wide as the longest.
 */
import type { VNode } from 'snabbdom';
import { svg } from '@eclipse-glsp/client';
import { WorkflowDiagramConstants, WorkflowDiagramMetadata, type NodeLine } from '@dialogram/shared';
import { ZOOM_TEXT_CLASSES } from './zoom-detail';

/** How far a band stays inside the body's outline, so it does not paint over it. */
const INSET_PX = 1;
/** The body's corner radius, less the inset. */
const CORNER_PX = 3;

/** The lines of a node; none for a node without, or with something else in their place. */
export function nodeLinesOf(node: { args?: Record<string, unknown> }): NodeLine[] {
    const raw = node.args?.[WorkflowDiagramMetadata.NODE_LINES];
    return Array.isArray(raw)
        ? raw.filter((line): line is NodeLine => !!line && typeof (line as NodeLine).text === 'string')
        : [];
}

/** The height the lines take at the bottom of a node's body. */
export function nodeLinesHeight(lines: readonly NodeLine[]): number {
    return lines.length * WorkflowDiagramConstants.NODE_LINE_HEIGHT_PX;
}

/**
 * The drawing of a node's lines, for a body `width` by `bodyHeight`: per
 * line its band and its text.
 */
export function renderNodeLines(lines: readonly NodeLine[], width: number, bodyHeight: number): VNode[] {
    const lineHeight = WorkflowDiagramConstants.NODE_LINE_HEIGHT_PX;
    const top = bodyHeight - nodeLinesHeight(lines);
    const left = INSET_PX;
    const right = width - INSET_PX;
    return lines.flatMap((line, index) => {
        const y = top + index * lineHeight;
        const kind = line.kind ? { [`node-line-${line.kind}`]: true } : {};
        const last = index === lines.length - 1;
        const bottom = last ? y + lineHeight - INSET_PX : y + lineHeight;
        const band = last
            ? `M${left},${y} H${right} V${bottom - CORNER_PX} A${CORNER_PX},${CORNER_PX} 0 0 1 ${right - CORNER_PX},${bottom}`
                + ` H${left + CORNER_PX} A${CORNER_PX},${CORNER_PX} 0 0 1 ${left},${bottom - CORNER_PX} Z`
            : `M${left},${y} H${right} V${bottom} H${left} Z`;
        return [
            svg('path', { class: { 'node-line': true, ...kind }, attrs: { d: band } }),
            svg('text', {
                class: { 'node-line-text': true, [ZOOM_TEXT_CLASSES.detail]: true, ...kind },
                attrs: {
                    x: WorkflowDiagramConstants.NODE_LINE_PADDING_PX,
                    y: y + lineHeight / 2,
                    'text-anchor': 'start',
                    'dominant-baseline': 'central'
                }
            }, line.text)
        ];
    });
}
