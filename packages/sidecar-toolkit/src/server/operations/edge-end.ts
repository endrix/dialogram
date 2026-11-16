/**
 * The port an edge is drawn from or to, as the operation names it.
 *
 * A network's own port is drawn as a node (`NODE_BOUNDARY_INPUT` /
 * `NODE_BOUNDARY_OUTPUT`) with its port hidden inside it: the pointer is on
 * the node, and the connection hints accept it as an edge's end, so a new
 * edge or a reconnected one names the node. Its port is the one the producer
 * knows.
 */
import type { GPort } from '@eclipse-glsp/server';
import { WorkflowDiagramTypes } from '@dialogram/shared';

export function portAt(index: { get(id: string): unknown }, elementId: string): GPort | undefined {
    const element = index.get(elementId) as (GPort & { type?: string; children?: unknown[] }) | undefined;
    const type = element?.type;
    if (type === WorkflowDiagramTypes.NODE_BOUNDARY_INPUT || type === WorkflowDiagramTypes.NODE_BOUNDARY_OUTPUT) {
        return (element!.children as GPort[] | undefined)?.find(child => typeof child.type === 'string' && child.type.startsWith('port'));
    }
    return element;
}
