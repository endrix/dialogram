/**
 * One port order for all the instances of a definition.
 *
 * The Free Ports layout lets a probe layout choose each node's port order
 * against crossings (WorkflowElkLayoutEngine). Chosen node by node, two
 * instances of one task or workflow could show their ports in two orders,
 * though the source declares them once, for both. So the nodes are grouped
 * by what they are an instance of (`definitionKeyOf`), and a group's nodes
 * all take one order: the one given for that definition (`PORT_ORDERS_OPTION`),
 * else the consensus of the orders the probe found for them, each port at its
 * mean place, the instances with more edges weighing more. A node that is the
 * only instance of its definition keeps the order the probe found for it.
 *
 * On the speculation flow of chips/workflow (four instances of each of five
 * definitions), the most connected instance's order alone gave 198 crossings,
 * the consensus 189, and the consensus with the other nodes ordered again
 * around it (the engine's second probe) 172, against 150 with each node in an
 * order of its own and 236 in the declared order.
 *
 * An order is a list of port names, read side by side: the ports of each
 * side take the order their names have in it.
 */
import { GNode, GPort } from '@eclipse-glsp/server';
import { WorkflowDiagramMetadata, portSide, type PortSide } from '@dialogram/shared';

/**
 * Graph layout option: the port order given for a definition, as JSON
 * `{ [definitionKey]: portName[] }` (keys from `definitionKeyOf`). A list
 * that does not name each port of an instance exactly once is not used for it.
 */
export const PORT_ORDERS_OPTION = 'dialogram.portOrders';

/** A node's ports, top to bottom, as the probe layout placed them. */
export interface ProbedOrder {
    node: GNode;
    /** Its ports' ids, top to bottom. */
    order: string[];
    /** How many edges end on the node or its ports. */
    edges: number;
}

function textOf(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function portsOf(node: GNode): GPort[] {
    return (node.children ?? []).filter((child): child is GPort => child instanceof GPort);
}

/** Which side of its node a GPort sits on: the producer's placement, else its direction or type. */
export function gportSide(port: GPort): PortSide {
    const args = (port.args ?? {}) as Record<string, unknown>;
    return portSide({
        absolute: { x: 0, y: 0 },
        direction: args[WorkflowDiagramMetadata.PORT_DIRECTION] as string | undefined,
        side: args[WorkflowDiagramMetadata.PORT_SIDE] as string | undefined,
        type: port.type
    });
}

/** A port's name: as the producer names it, else its id under its node's. */
export function portNameOf(node: GNode, port: GPort): string {
    const name = textOf((port.args as Record<string, unknown> | undefined)?.[WorkflowDiagramMetadata.PORT_NAME]);
    if (name) {
        return name;
    }
    return port.id.startsWith(node.id) ? port.id.slice(node.id.length) : port.id;
}

/**
 * What a node is an instance of, as a key: the definition's name, the file
 * that defines it when the producer says so, and its ports by side and name.
 * Two nodes of one definition whose ports differ (a bus drawn open on one)
 * are kept apart. `undefined` for a node that names no definition.
 */
export function definitionKeyOf(node: GNode): string | undefined {
    const args = (node.args ?? {}) as Record<string, unknown>;
    const name = textOf(args[WorkflowDiagramMetadata.REFERENCED_ENTITY_NAME]) ?? textOf(args[WorkflowDiagramMetadata.ENTITY_TYPE]);
    if (!name) {
        return undefined;
    }
    const file = args[WorkflowDiagramMetadata.REFERENCED_IS_DEFINITION] === true
        ? textOf(args[WorkflowDiagramMetadata.REFERENCED_URI]) ?? ''
        : '';
    const ports = portsOf(node).map(port => `${gportSide(port)}:${portNameOf(node, port)}`).sort();
    return JSON.stringify([name, file, ports]);
}

/** The given orders out of the graph's options: `PORT_ORDERS_OPTION`, when it is valid JSON. */
export function givenPortOrders(options: Record<string, unknown> | undefined): Record<string, string[]> {
    const raw = options?.[PORT_ORDERS_OPTION];
    if (typeof raw !== 'string' || raw.trim() === '') {
        return {};
    }
    try {
        const parsed = JSON.parse(raw) as unknown;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return {};
        }
        const orders: Record<string, string[]> = {};
        for (const [key, names] of Object.entries(parsed as Record<string, unknown>)) {
            if (Array.isArray(names) && names.every(name => typeof name === 'string')) {
                orders[key] = names as string[];
            }
        }
        return orders;
    } catch {
        return {};
    }
}

/**
 * The ids of `node`'s ports in the order of `names`, side by side; `undefined`
 * when the names are not exactly its ports' (one missing, one too many, or
 * two ports of a side named alike).
 */
export function orderByNames(node: GNode, names: readonly string[]): string[] | undefined {
    const ports = portsOf(node);
    const rank = new Map<string, number>();
    names.forEach((name, k) => {
        if (!rank.has(name)) {
            rank.set(name, k);
        }
    });
    if (rank.size !== names.length || names.length !== ports.length) {
        return undefined;
    }
    const seen = new Set<string>();
    for (const port of ports) {
        const named = `${gportSide(port)}:${portNameOf(node, port)}`;
        if (!rank.has(portNameOf(node, port)) || seen.has(named)) {
            return undefined;
        }
        seen.add(named);
    }
    return [...ports]
        .sort((a, b) => rank.get(portNameOf(node, a))! - rank.get(portNameOf(node, b))!)
        .map(port => port.id);
}

/**
 * The order each probed node's ports take, top to bottom: one per definition
 * (see the file's comment), the probe's own for a node alone of its kind.
 */
export function onePortOrderPerDefinition(
    probed: readonly ProbedOrder[],
    given: Readonly<Record<string, string[]>> = {}
): { orders: Map<GNode, string[]>; shared: Set<GNode> } {
    const result = new Map<GNode, string[]>();
    const shared = new Set<GNode>();
    const groups = new Map<string, ProbedOrder[]>();
    for (const entry of probed) {
        result.set(entry.node, entry.order);
        const key = definitionKeyOf(entry.node);
        if (key !== undefined) {
            const group = groups.get(key);
            if (group) {
                group.push(entry);
            } else {
                groups.set(key, [entry]);
            }
        }
    }
    for (const [key, group] of groups) {
        let names: readonly string[] | undefined = given[key];
        if (!names && group.length > 1) {
            names = consensusNames(group);
        }
        if (!names) {
            continue;
        }
        for (const entry of group) {
            const order = orderByNames(entry.node, names);
            if (order) {
                result.set(entry.node, order);
                shared.add(entry.node);
            }
        }
    }
    return { orders: result, shared };
}

/** A node's port names in the order the probe found, then any port it did not place, as declared. */
function namesOf(entry: ProbedOrder): string[] {
    const byId = new Map(portsOf(entry.node).map(port => [port.id, portNameOf(entry.node, port)] as const));
    const names = entry.order.filter(id => byId.has(id)).map(id => byId.get(id)!);
    const placed = new Set(entry.order);
    return [...names, ...portsOf(entry.node).filter(port => !placed.has(port.id)).map(port => portNameOf(entry.node, port))];
}

/** The order of the first of the most connected instances, so equal counts keep the document's order. */
function leaderNames(group: readonly ProbedOrder[]): string[] {
    return namesOf(group.reduce((best, entry) => (entry.edges > best.edges ? entry : best)));
}

/** Each port at its mean place among the instances, weighted by their edges; ties as the most connected has them. */
function consensusNames(group: readonly ProbedOrder[]): string[] {
    const leader = leaderNames(group);
    const sum = new Map<string, number>();
    let weight = 0;
    for (const entry of group) {
        const w = Math.max(1, entry.edges);
        weight += w;
        namesOf(entry).forEach((name, k) => sum.set(name, (sum.get(name) ?? 0) + w * k));
    }
    const place = (name: string): number => (sum.get(name) ?? 0) / weight;
    return [...leader].sort((a, b) => place(a) - place(b) || leader.indexOf(a) - leader.indexOf(b));
}
