/**
 * The ids nodes and ports get in the model.
 *
 * A node's label is the id people see and a saved layout keys on, so it is
 * the id wherever it can be. It cannot always be: an HDL producer labels an
 * expression node with the expression, and the same expression on two ports
 * (`{tid, tpl}` into two RAMs, `mul_result[63:0]` four times) is two nodes
 * with one label. Two elements with one id is a model the client refuses
 * whole, drawing nothing.
 *
 * So the first node to carry a label keeps it, in the document's order (a
 * producer lists its named things, instances and ports, before the
 * expressions between them, so adding a duplicate does not move a named
 * node's saved position), and every later one takes the producer's id,
 * unique by contract. A label that is the id another node ends up with, or is
 * blank, is not used either.
 *
 * A port's id is its node's id and its name, and a name can repeat on one
 * node too: a concatenation reading one net twice (`{lead0, lead0}`), an
 * expression reading the net its port is named after (`.rdy(rdy != 0)`), an
 * assignment reading its own target (`q = rst ? d : q`). The same rule
 * settles them, among the ports of one node.
 */
import type { PyGraphNode, PyGraphPort } from './graph-gmodel-source';

/** The model id of each node, by the producer's id. Every node has one. */
export type StableNodeIds = ReadonlyMap<string, string>;

export function stableNodeIds(nodes: readonly PyGraphNode[]): StableNodeIds {
    return firstClaimKeepsName(nodes, node => node.label, node => node.id);
}

/**
 * The name each port of one node is addressed by in its model id
 * (`<node id>_port_<name>`), by the producer's port id: its own name where no
 * port before it on the node has it, the producer's port id otherwise.
 */
export function stablePortNames(ports: readonly PyGraphPort[]): ReadonlyMap<string, string> {
    return firstClaimKeepsName(ports, port => port.name, port => port.id);
}

/**
 * Each item's key, by its id: its name for the first item that carries the
 * name, its id for later ones, and for any item whose name is blank or is the
 * key another item ends up with. Every key is distinct when the ids are.
 */
function firstClaimKeepsName<T>(items: readonly T[], nameOf: (item: T) => string | undefined,
    idOf: (item: T) => string): ReadonlyMap<string, string> {
    const named = (item: T): string | undefined => {
        const name = nameOf(item)?.trim();
        return name ? name : undefined;
    };
    // First claim on each name, in order.
    const claims = new Set<string>();
    const keepsName = new Set<string>();
    for (const item of items) {
        const name = named(item);
        if (name !== undefined && !claims.has(name)) {
            claims.add(name);
            keepsName.add(idOf(item));
        }
    }
    // An item that keeps its name must not take a key another item ends up
    // with: an item falling back to its id can take that key from a name,
    // and that can make another fall back in turn. Settles within as many
    // passes as there are items.
    let changed = true;
    while (changed) {
        changed = false;
        const fallbackIds = new Set(items.map(idOf).filter(id => !keepsName.has(id)));
        for (const item of items) {
            const id = idOf(item);
            if (keepsName.has(id) && fallbackIds.has(named(item)!) && named(item) !== id) {
                keepsName.delete(id);
                changed = true;
            }
        }
    }
    const keys = new Map<string, string>();
    for (const item of items) {
        const id = idOf(item);
        keys.set(id, keepsName.has(id) ? named(item)! : id);
    }
    return keys;
}

/** A node's model id. */
export function stableNodeId(ids: StableNodeIds, node: PyGraphNode): string {
    return ids.get(node.id) ?? node.id;
}
