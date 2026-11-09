/**
 * Where each port's label goes: inside the node, beside its port, a fixed gap
 * from the port's dot (`PORT_LABEL_GAP_PX`, or the root's `cal:portLabelGapPx`),
 * centred on the port's row.
 *
 * Every submit applies it, and the bounds pass re-anchors measured labels with
 * it, so a label is placed the same way whether the layout ran (ELK places
 * labels too) or a saved layout was reopened (ELK did not run). The headless
 * renderer applies it as well, so a render shows the labels where the editor
 * does.
 */
import { GLabel, GModelRoot, GPort } from '@eclipse-glsp/server';
import {
    WorkflowDiagramConstants,
    WorkflowDiagramMetadata,
    WorkflowDiagramTypes,
    estimatePortLabelSize,
    portLabelX,
    portLabelY,
    portSide
} from '@dialogram/shared';

/** The gap between a port's dot and its name, in this diagram. */
export function portLabelGapOf(root: GModelRoot | undefined): number {
    const raw = (root as any)?.args?.['cal:portLabelGapPx'];
    const n = typeof raw === 'number' ? raw : Number(raw);
    return Number.isFinite(n) ? n : WorkflowDiagramConstants.PORT_LABEL_GAP_PX;
}

/** Place one port label against its port. */
export function placePortLabel(label: any, port: any, gap: number): void {
    const portW = port?.size?.width ?? WorkflowDiagramConstants.PORT_WIDTH_PX;
    const portH = port?.size?.height ?? WorkflowDiagramConstants.PORT_HEIGHT_PX;
    // The label sits inside the node, on the port's SIDE, which is the
    // direction unless the producer placed the port with its bundle.
    const east = portSide({
        absolute: { x: 0, y: 0 },
        direction: port?.args?.[WorkflowDiagramMetadata.PORT_DIRECTION] as string | undefined,
        side: port?.args?.[WorkflowDiagramMetadata.PORT_SIDE] as string | undefined,
        type: port?.type
    }) === 'EAST';
    const fallback = estimatePortLabelSize(label.text ?? '');
    const labelW = label.size?.width ?? fallback.width;
    const labelH = label.size?.height ?? fallback.height;
    // Positioned by its top-left: client-side alignment for port labels is
    // switched off (see the ComputedBounds handling), and any alignment left
    // from an earlier bounds pass would add a translate of its own.
    label.position = { x: portLabelX(east, portW, labelW, gap), y: portLabelY(portH, labelH) };
    label.alignment = undefined;
}

/** Place every port label of `root`. */
export function placePortLabels(root: GModelRoot): void {
    const gap = portLabelGapOf(root);
    const visit = (element: any): void => {
        if (element instanceof GPort) {
            for (const child of (element.children as any[] | undefined) ?? []) {
                if (child instanceof GLabel && child.type === WorkflowDiagramTypes.LABEL_PORT) {
                    placePortLabel(child, element, gap);
                }
            }
        }
        for (const child of (element?.children as any[] | undefined) ?? []) {
            visit(child);
        }
    };
    visit(root);
}
