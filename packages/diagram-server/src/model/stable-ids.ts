/**
 * The id a node gets in the model, and the key its position and open bundles
 * are saved under.
 *
 * A node's label is the id people see and a saved layout keys on, so it is
 * the id wherever it names one node. It does not have to: an HDL producer
 * labels an expression node with the expression, and the same expression on
 * two ports (`{tid, tpl}` into two RAMs, `mul_result[63:0]` four times) is
 * two nodes with one label. Two nodes with one id is a model the client
 * refuses whole, drawing nothing. So a label that more than one node carries,
 * or that is another node's id, is no node's id; those nodes take the
 * producer's id, which is unique by contract.
 */
import type { PyGraphNode } from './graph-gmodel-source';

/** The model id of each node, by the producer's id. */
export function stableNodeIds(nodes: readonly PyGraphNode[]): Map<string, string> {
    const labelCount = new Map<string, number>();
    const producerIds = new Set<string>();
    for (const node of nodes) {
        producerIds.add(node.id);
        if (node.label) {
            labelCount.set(node.label, (labelCount.get(node.label) ?? 0) + 1);
        }
    }
    const ids = new Map<string, string>();
    for (const node of nodes) {
        const label = node.label;
        const ownsLabel = !!label && labelCount.get(label) === 1 && (!producerIds.has(label) || label === node.id);
        ids.set(node.id, ownsLabel ? label : node.id);
    }
    return ids;
}
