/**
 * What a node says, drawn: the paragraph the server wrapped
 * (`wf:nodeSummary`, from `meta.summary`; shared/node-summary.ts) in the
 * node's body, under its ports and above its lines, in the place of its
 * family's mark.
 *
 * Each line is a text in the UI font (`text.node-summary`), a code span in
 * it a `tspan.node-summary-code` in the editor's, without its backticks. The
 * text is detail (zoom-detail.ts): drawn only close in, as a node's lines.
 */
import type { VNode } from 'snabbdom';
import { svg } from '@eclipse-glsp/client';
import { summaryHeight, summaryRuns, WorkflowDiagramConstants, WorkflowDiagramMetadata } from '@dialogram/shared';
import { ZOOM_TEXT_CLASSES } from './zoom-detail';

/** The lines of a node's paragraph; none for a node without one. */
export function nodeSummaryOf(node: { args?: Record<string, unknown> }): string[] {
    const raw = node.args?.[WorkflowDiagramMetadata.NODE_SUMMARY];
    return Array.isArray(raw) ? raw.filter((line): line is string => typeof line === 'string') : [];
}

/** The height the paragraph takes in the body. */
export function nodeSummaryHeight(lines: readonly string[]): number {
    return summaryHeight(lines.length);
}

/** The paragraph's lines in a body whose part above the node's lines ends at `bottom`. */
export function renderNodeSummary(lines: readonly string[], bottom: number): VNode[] {
    const pad = WorkflowDiagramConstants.SUMMARY_PADDING_PX;
    const lineHeight = WorkflowDiagramConstants.SUMMARY_LINE_HEIGHT_PX;
    const top = bottom - nodeSummaryHeight(lines) + pad;
    return lines.map((line, index) => svg('text', {
        class: { 'node-summary': true, [ZOOM_TEXT_CLASSES.detail]: true },
        attrs: {
            x: pad,
            y: top + index * lineHeight + lineHeight / 2,
            'text-anchor': 'start',
            'dominant-baseline': 'central'
        }
    }, ...summaryRuns(line).map(run => run.code
        ? svg('tspan', { class: { 'node-summary-code': true } }, run.text)
        : svg('tspan', {}, run.text))));
}
