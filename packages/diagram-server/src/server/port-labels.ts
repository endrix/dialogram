/**
 * Where each port's label goes: inside the node, beside its port, a fixed gap
 * from the port's dot (`PORT_LABEL_GAP_PX`, or the root's `cal:portLabelGapPx`).
 *
 * Every submit applies it, so a label is placed the same way whether the
 * layout ran (ELK places labels too) or a saved layout was reopened (ELK did
 * not run). The headless renderer applies it as well, so a render shows the
 * labels where the editor does.
 */
import { GLabel, GModelRoot, GPort } from '@eclipse-glsp/server';
import { WorkflowDiagramConstants, WorkflowDiagramMetadata, WorkflowDiagramTypes, portSide } from '@dialogram/shared';

export function placePortLabels(root: GModelRoot): void {
        const portLabelGapPx = (() => {
            const raw = (root as any)?.args?.['cal:portLabelGapPx'];
            const n = typeof raw === 'number' ? raw : Number(raw);
            return Number.isFinite(n) ? n : WorkflowDiagramConstants.PORT_LABEL_GAP_PX;
        })();

        const estimateLabelSizeFallback = (text: string): { width: number; height: number } => {
            // Keep aligned with WorkflowDiagramModelSource sizing.
            const fontSizePx = WorkflowDiagramConstants.PORT_LABEL_FONT_SIZE_PX;
            const avgCharWidth = fontSizePx * 0.7;
            const padding = 3;
            return {
                width: Math.max(1, Math.ceil(text.length * avgCharWidth + padding * 2)),
                height: Math.max(1, Math.ceil(fontSizePx * 1.25)),
            };
        };

        const visit = (element: any): void => {
            if (!element) return;

            if (element instanceof GPort) {
                const portW = element.size?.width ?? WorkflowDiagramConstants.PORT_WIDTH_PX;
                const portH = element.size?.height ?? WorkflowDiagramConstants.PORT_HEIGHT_PX;
                // The label sits inside the node, on the port's SIDE — which is
                // the direction unless the producer placed the port with its
                // bundle (`cal:portSide`).
                const east = portSide({
                    absolute: { x: 0, y: 0 },
                    direction: element.args?.[WorkflowDiagramMetadata.PORT_DIRECTION] as string | undefined,
                    side: element.args?.[WorkflowDiagramMetadata.PORT_SIDE] as string | undefined,
                    type: element.type
                }) === 'EAST';

                const children = (element.children as any[] | undefined) ?? [];
                for (const child of children) {
                    if (!(child instanceof GLabel)) continue;
                    if (child.type !== WorkflowDiagramTypes.LABEL_PORT) continue;

                    const text = child.text ?? '';
                    const fallback = estimateLabelSizeFallback(text);
                    const labelW = child.size?.width ?? fallback.width;
                    const labelH = child.size?.height ?? fallback.height;

                    const y = Math.round((portH - labelH) / 2);
                    // Port labels are positioned relative to the port. For output labels, the label box
                    // sits to the *left* of the port marker with a fixed gap. Client-side alignment
                    // transforms for port labels are intentionally disabled (see ComputedBounds handling),
                    // so we use the label's top-left origin here.
                    const x = east
                        ? -portLabelGapPx - labelW
                        : portW + portLabelGapPx;

                    child.position = { x, y };

                    // Ensure port-label rendering is driven purely by position/size.
                    // Any previously stored alignment (e.g., from an older computed-bounds
                    // cycle) can introduce an additional client-side translate().
                    (child as any).alignment = undefined;
                }
            }

            const children = element.children as any[] | undefined;
            if (Array.isArray(children)) {
                for (const child of children) {
                    visit(child);
                }
            }
        };

        visit(root);
}
