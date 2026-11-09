/**
 * The id a node gets in the model, and the key its position and open bundles
 * are saved under.
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
 * assignment reading its own target (`q = rst ? d : q`). There the first
 * output keeps the name and the others number it (`stablePortNames`).
 */
import type { PyGraphNode, PyGraphPort } from './graph-gmodel-source';

/** The model id of each node, by the producer's id. Every node has one. */
export type StableNodeIds = ReadonlyMap<string, string>;

export function stableNodeIds(nodes: readonly PyGraphNode[]): StableNodeIds {
    const labelOf = (node: PyGraphNode): string | undefined => {
        const label = node.label?.trim();
        return label ? label : undefined;
    };
    // First claim on each label, in order.
    const claims = new Map<string, string>();
    const keepsLabel = new Set<string>();
    for (const node of nodes) {
        const label = labelOf(node);
        if (label !== undefined && !claims.has(label)) {
            claims.set(label, node.id);
            keepsLabel.add(node.id);
        }
    }
    // A node that keeps its label must not take an id another node ends up
    // with: a node falling back to its producer id can take that id from a
    // label, and that can make another fall back in turn. Settles within as
    // many passes as there are nodes.
    let changed = true;
    while (changed) {
        changed = false;
        const fallbackIds = new Set(nodes.filter(n => !keepsLabel.has(n.id)).map(n => n.id));
        for (const node of nodes) {
            if (keepsLabel.has(node.id) && fallbackIds.has(labelOf(node)!) && labelOf(node) !== node.id) {
                keepsLabel.delete(node.id);
                changed = true;
            }
        }
    }
    const ids = new Map<string, string>();
    for (const node of nodes) {
        ids.set(node.id, keepsLabel.has(node.id) ? labelOf(node)! : node.id);
    }
    return ids;
}

/** A node's model id. */
export function stableNodeId(ids: StableNodeIds, node: PyGraphNode): string {
    return ids.get(node.id) ?? node.id;
}

/**
 * The name each port of one node is addressed by in its model id
 * (`<node id>_port_<name>`), by the producer's port id. A port's own name,
 * as written, where no other port on the node has it. Where several do, the
 * first output keeps it (the first input, when none of them is an output),
 * so the end most wires leave from keeps its id whatever order the producer
 * lists the ports in; the others take it with a number (`din#1`), never a
 * name a port on the node has.
 */
export function stablePortNames(ports: readonly PyGraphPort[]): ReadonlyMap<string, string> {
    const nameOf = (port: PyGraphPort): string => port.name ?? 'Port';
    const names = new Set(ports.map(nameOf));
    const keys = new Map<string, string>();
    if (names.size === ports.length) {
        for (const port of ports) {
            keys.set(port.id, nameOf(port));
        }
        return keys;
    }
    const used = new Set<string>();
    const settled = new Map<string, string>();
    const outputsFirst = [...ports.filter(p => p.direction === 'out'), ...ports.filter(p => p.direction !== 'out')];
    for (const port of outputsFirst) {
        const name = nameOf(port);
        let key = name;
        for (let k = 1; used.has(key) || (key !== name && names.has(key)); k++) {
            key = `${name}#${k}`;
        }
        used.add(key);
        settled.set(port.id, key);
    }
    for (const port of ports) {
        keys.set(port.id, settled.get(port.id)!);
    }
    return keys;
}
