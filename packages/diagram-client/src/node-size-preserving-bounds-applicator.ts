/**
 * Measured bounds applied without resizing a workflow node.
 *
 * Sprotty measures elements in its hidden model and applies what it measured
 * through this applicator, which writes `size` directly. That is right for an
 * element whose size the client works out (a label, a compartment), and wrong
 * for a node: a node's size comes from the server, and what the client
 * measures is its box plus whatever is drawn past it (ports, badges, the type
 * line below), so applying it grows the node. GLSP measures this way on more
 * than a model load (the start of a resize measures the element and every
 * child it holds), and the `bounds` setter `WorkflowNode` overrides for the
 * same reason is not on this path.
 *
 * So a workflow node takes the measured position and keeps its size, as it
 * does through `bounds`, and as the server keeps it (`WorkflowComputedBounds
 * ActionHandler`, `WorkflowChangeBoundsOperationHandler`). Everything else is
 * applied as sprotty applies it.
 */
import { injectable } from 'inversify';
import { ComputedBoundsApplicator } from '@eclipse-glsp/client';
import { WorkflowNode } from './model';

type Point = { x: number; y: number };
type Dimension = { width: number; height: number };

@injectable()
export class NodeSizePreservingBoundsApplicator extends ComputedBoundsApplicator {
    protected override applyBounds(element: any, newPosition: Point | undefined, newSize: Dimension): void {
        const size = (element as { size?: Dimension }).size;
        if (element instanceof WorkflowNode && size && size.width > 0 && size.height > 0) {
            if (newPosition) {
                element.position = { x: newPosition.x, y: newPosition.y };
            }
            return;
        }
        super.applyBounds(element, newPosition as any, newSize);
    }
}
