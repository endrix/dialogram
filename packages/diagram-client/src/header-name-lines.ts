/**
 * A node's name as its header draws it: the lines the server broke it into
 * (`wf:headerLines`, header-lines.ts), or its text on one line; and the
 * header's height for them, which is where the node's body starts.
 */
import { headerHeight, WorkflowDiagramMetadata, WorkflowDiagramTypes } from '@dialogram/shared';

interface LabelLike {
    readonly text?: string;
    readonly args?: Record<string, unknown>;
}

interface ElementLike {
    readonly type?: string;
    readonly children?: readonly unknown[];
}

/** The lines a name label is drawn in: the server's, when it broke the name; else its text. */
export function nameLinesOf(label: LabelLike): string[] {
    const lines = label.args?.[WorkflowDiagramMetadata.HEADER_LINES];
    if (Array.isArray(lines) && lines.length > 1 && lines.every(line => typeof line === 'string')) {
        return lines as string[];
    }
    return [label.text ?? ''];
}

/** How tall a node's header is: one line's, and a line more for each its name breaks onto. */
export function nodeHeaderHeight(node: ElementLike): number {
    const header = node.children?.find((child): child is ElementLike =>
        (child as ElementLike)?.type === WorkflowDiagramTypes.COMPARTMENT_HEADER);
    const name = header?.children?.find((child): child is LabelLike & ElementLike =>
        (child as ElementLike)?.type === WorkflowDiagramTypes.LABEL_NAME);
    return headerHeight(name ? nameLinesOf(name).length : 1);
}
