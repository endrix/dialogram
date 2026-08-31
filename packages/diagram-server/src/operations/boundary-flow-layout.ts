import { GPort, LayoutEngine } from '@eclipse-glsp/server';
import { WorkflowDiagramMetadata, WorkflowDiagramTypes } from '@dialogram/shared';
import { clearAllEdgeRoutingPoints } from '../routing/clear-edge-routes';

/**
 * Shared boundary-flow layout routine.
 *
 * The manual auto-layout operation (`dialogram.layoutBoundaryFlow`) and the initial
 * automatic layout on fresh open must produce the same geometry. The distinguishing
 * behaviour over plain ELK is that one-sided task nodes (only inputs, or only outputs)
 * are pinned to dedicated outer layers (FIRST_SEPARATE / LAST_SEPARATE) via temporary
 * ELK layout options, so sources and sinks do not share a column with regular
 * processing nodes. These helpers are extracted here so both call sites reuse the exact
 * same logic instead of diverging.
 */

function isTaskNode(element: any): boolean {
    const type = element?.type as string | undefined;
    return type === WorkflowDiagramTypes.NODE_ACTOR || type === WorkflowDiagramTypes.NODE_EXTERNAL_ACTOR;
}

function nodeHasPortDirection(node: any, direction: 'input' | 'output'): boolean {
    const ports: any[] = [];

    const collectPorts = (element: any): void => {
        if (!element) {
            return;
        }
        if (element instanceof GPort) {
            ports.push(element);
        }
        const children = element.children as any[] | undefined;
        if (Array.isArray(children)) {
            for (const child of children) {
                collectPorts(child);
            }
        }
    };

    collectPorts(node);

    return ports.some(port => {
        const portDirection = (port as any).args?.[WorkflowDiagramMetadata.PORT_DIRECTION] as string | undefined;
        if (direction === 'input') {
            return portDirection === 'input' || port.type === WorkflowDiagramTypes.PORT_INPUT;
        }
        return portDirection === 'output' || port.type === WorkflowDiagramTypes.PORT_OUTPUT;
    });
}

/**
 * Apply boundary-flow layer constraints to one-sided task nodes. Returns the previous
 * layout options per node id so {@link restoreNodeLayoutOptions} can undo them after ELK.
 */
export function applyBoundaryFlowLayerConstraints(
    root: any,
    selectedMovableNodeIds: Set<string>,
    hasSelection: boolean
): Map<string, Record<string, unknown> | undefined> {
    const previousLayoutOptionsByNodeId = new Map<string, Record<string, unknown> | undefined>();

    const visit = (element: any): void => {
        if (!element) {
            return;
        }

        if (isTaskNode(element)) {
            const nodeId = String(element.id);
            if (!hasSelection || selectedMovableNodeIds.has(nodeId)) {
                const hasInput = nodeHasPortDirection(element, 'input');
                const hasOutput = nodeHasPortDirection(element, 'output');

                if (!hasInput || !hasOutput) {
                    const previousLayoutOptions = (element as any).layoutOptions as Record<string, unknown> | undefined;
                    previousLayoutOptionsByNodeId.set(nodeId, previousLayoutOptions ? { ...previousLayoutOptions } : undefined);

                    // Keep one-sided nodes on dedicated outer layers so they do not
                    // share a column with regular processing nodes.
                    const nodeLayerConstraint = !hasInput ? 'FIRST_SEPARATE' : 'LAST_SEPARATE';
                    (element as any).layoutOptions = {
                        ...(previousLayoutOptions ?? {}),
                        'elk.layered.layering.layerConstraint': nodeLayerConstraint,
                        'org.eclipse.elk.layered.layering.layerConstraint': nodeLayerConstraint
                    };
                }
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
    return previousLayoutOptionsByNodeId;
}


/**
 * Let the network's boundary ports float, for the compact layout.
 *
 * A boundary node carries `FIRST_SEPARATE` / `LAST_SEPARATE` from the moment it
 * is built, so every input pill sits in one column before the whole graph and
 * every output pill in one column after it. That is what makes a diagram read
 * as a dataflow network — interface on the left, results on the right — and it
 * is the right default.
 *
 * It is also expensive. An input feeding a node six layers in has to cross all
 * six. Measured on the reference network, releasing the pins:
 *
 *     crossings 228 -> 191, long-haul edges 15 -> 9, edge length -15%
 *
 * The pills then sit beside whatever they connect to instead of on the border,
 * which is the trade the compact layout exists to make: a tighter drawing, at
 * the cost of no longer being able to read the interface down the edges.
 *
 * Returns the previous options so {@link restoreNodeLayoutOptions} can put the
 * pins back afterwards — the constraint belongs to the model, not to one
 * layout run.
 */
export function releaseBoundaryNodeConstraints(root: any): Map<string, Record<string, unknown> | undefined> {
    const previousLayoutOptionsByNodeId = new Map<string, Record<string, unknown> | undefined>();

    const visit = (element: any): void => {
        if (!element) {
            return;
        }
        const type = element.type as string | undefined;
        if (type === WorkflowDiagramTypes.NODE_BOUNDARY_INPUT || type === WorkflowDiagramTypes.NODE_BOUNDARY_OUTPUT) {
            const nodeId = String(element.id);
            const previousLayoutOptions = element.layoutOptions as Record<string, unknown> | undefined;
            previousLayoutOptionsByNodeId.set(nodeId, previousLayoutOptions ? { ...previousLayoutOptions } : undefined);

            // NONE beats the configurator: the engine merges a node's own
            // layoutOptions over whatever the LayoutConfigurator produced, so
            // this is what actually reaches ELK.
            element.layoutOptions = {
                ...(previousLayoutOptions ?? {}),
                'elk.layered.layering.layerConstraint': 'NONE',
                'org.eclipse.elk.layered.layering.layerConstraint': 'NONE'
            };
        }

        const children = element.children as any[] | undefined;
        if (Array.isArray(children)) {
            for (const child of children) {
                visit(child);
            }
        }
    };

    visit(root);
    return previousLayoutOptionsByNodeId;
}

/** Restore the layout options captured by {@link applyBoundaryFlowLayerConstraints}. */
export function restoreNodeLayoutOptions(
    root: any,
    previousLayoutOptionsByNodeId: Map<string, Record<string, unknown> | undefined>
): void {
    if (previousLayoutOptionsByNodeId.size === 0) {
        return;
    }

    const visit = (element: any): void => {
        if (!element) {
            return;
        }

        const nodeId = typeof element.id === 'string' ? element.id : undefined;
        if (nodeId && previousLayoutOptionsByNodeId.has(nodeId)) {
            const previous = previousLayoutOptionsByNodeId.get(nodeId);
            (element as any).layoutOptions = previous ? { ...previous } : undefined;
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

/**
 * Run the full-diagram boundary-flow layout: pin one-sided task nodes to outer layers,
 * clear stale edge routes, run ELK once, then restore the temporary layout options.
 * Single-shot; performs no model submission or persistence (the caller owns those).
 */
export async function runBoundaryFlowLayout(root: any, layoutEngine: LayoutEngine): Promise<void> {
    const previousLayoutOptionsByNodeId = applyBoundaryFlowLayerConstraints(root, new Set<string>(), false);
    clearAllEdgeRoutingPoints(root);
    await layoutEngine.layout();
    restoreNodeLayoutOptions(root, previousLayoutOptionsByNodeId);
}
