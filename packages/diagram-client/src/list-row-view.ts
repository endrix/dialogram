/**
 * A member of a list (a group whose scope says `list`): one row of a table
 * instead of a card. Its name, then its lines, in the columns the server gave
 * the list's rows (list-rows.ts there), in one fixed-width font; the
 * family's colour as a band down its left edge. A kind of line a product
 * colours is `list-row-cell-<kind>`.
 *
 * It is a node as a card is (selected, opened at its source, the end of a
 * link), drawn smaller: the rows of a list stand on each other with nothing
 * between, so their outlines are the lines of the table.
 */
import type { VNode } from 'snabbdom';
import { svg, type RenderingContext } from '@eclipse-glsp/client';
import { WorkflowDiagramConstants, WorkflowDiagramMetadata, type ListRow } from '@dialogram/shared';

/** What a node's row shows, when it is a member of a list. */
export function listRowOf(node: { args?: Record<string, unknown> }): ListRow | undefined {
    const raw = node.args?.[WorkflowDiagramMetadata.LIST_ROW] as ListRow | undefined;
    return raw && typeof raw === 'object' && typeof raw.nameX === 'number' ? raw : undefined;
}

/** The row of `node`, `width` by `height`, with the classes its kind and family give it. */
export function renderListRow(
    node: { args?: Record<string, unknown>; position: { x: number; y: number }; selected?: boolean; hoverFeedback?: boolean; children?: readonly unknown[] },
    row: ListRow,
    size: { width: number; height: number },
    classes: Record<string, boolean>,
    context: RenderingContext
): VNode {
    const { width, height } = size;
    const name = node.args?.[WorkflowDiagramMetadata.ENTITY_NAME];
    const middle = height / 2;
    const text = (cssClass: string, x: number, value: string, kind?: string): VNode => svg('text', {
        class: { 'list-row-text': true, [cssClass]: true, ...(kind && /^[a-z][a-z0-9-]*$/.test(kind) ? { [`list-row-cell-${kind}`]: true } : {}) },
        attrs: { x, y: middle }
    }, value);
    return svg('g', {
        class: {
            'workflow-node': true,
            ...classes,
            'list-row': true,
            selected: !!node.selected,
            hover: !!node.hoverFeedback
        },
        attrs: { transform: `translate(${node.position.x}, ${node.position.y})` }
    },
        svg('rect', { class: { 'node-body': true, 'list-row-body': true }, attrs: { x: 0, y: 0, width, height } }),
        svg('rect', { class: { 'list-row-mark': true }, attrs: { x: 0, y: 0, width: WorkflowDiagramConstants.LIST_ROW_MARK_PX, height } }),
        text('list-row-name', row.nameX, typeof name === 'string' ? name : ''),
        ...(Array.isArray(row.cells) ? row.cells : []).map(cell => text('list-row-cell', cell.x, cell.text, cell.kind)),
        ...context.renderChildren(node as any)
    ) as VNode;
}
