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
 * around it (the engine's second probe) 173, against 150 with each node in an
 * order of its own and 236 in the declared order.
 *
 * An order is said side by side, a list of port names for each: a task may
 * have an input and an output of one name.
 */
import { GNode, GPort } from '@eclipse-glsp/server';
import { WorkflowDiagramMetadata, portSide, type PortSide } from '@dialogram/shared';

/**
 * Graph layout option: the port order given for a definition, as JSON
 * `{ [definition]: { west?: portName[], east?: portName[] } }`, the names of
 * each side top to bottom. A definition is named by its key
 * (`definitionKeyOf`) or by its name alone (`definitionNameOf`), which then
 * says it for every definition of that name. A side not listed keeps the
 * order it would have had; a listed side that does not name each of its
 * ports exactly once is not used.
 */
export const PORT_ORDERS_OPTION = 'dialogram.portOrders';

/** Port names, top to bottom, by side. */
export interface SideOrder {
    west?: string[];
    east?: string[];
}

const SIDES = ['west', 'east'] as const;
type Side = typeof SIDES[number];

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

function sideOf(port: GPort): Side | undefined {
    const side = gportSide(port);
    return side === 'WEST' ? 'west' : side === 'EAST' ? 'east' : undefined;
}

/** A port's name: as the producer names it, else its id under its node's. */
export function portNameOf(node: GNode, port: GPort): string {
    const name = textOf((port.args as Record<string, unknown> | undefined)?.[WorkflowDiagramMetadata.PORT_NAME]);
    if (name) {
        return name;
    }
    return port.id.startsWith(node.id) ? port.id.slice(node.id.length) : port.id;
}

/** The name of what a node is an instance of: the definition it names, else its type. */
export function definitionNameOf(node: GNode): string | undefined {
    const args = (node.args ?? {}) as Record<string, unknown>;
    return textOf(args[WorkflowDiagramMetadata.REFERENCED_ENTITY_NAME]) ?? textOf(args[WorkflowDiagramMetadata.ENTITY_TYPE]);
}

/**
 * What a node is an instance of, as a key: the definition's name, the file
 * that defines it when the producer says so, and its ports by side and name.
 * Two nodes of one definition whose ports differ (a bus drawn open on one)
 * are kept apart. Without the file, two definitions of one name and the same
 * ports in two modules are taken for one: a diagram showing both is rare,
 * and drawing them alike does no harm. `undefined` for a node that names no
 * definition.
 */
export function definitionKeyOf(node: GNode): string | undefined {
    const name = definitionNameOf(node);
    if (!name) {
        return undefined;
    }
    const args = (node.args ?? {}) as Record<string, unknown>;
    const file = args[WorkflowDiagramMetadata.REFERENCED_IS_DEFINITION] === true
        ? textOf(args[WorkflowDiagramMetadata.REFERENCED_URI]) ?? ''
        : '';
    const ports = portsOf(node).map(port => `${gportSide(port)}:${portNameOf(node, port)}`).sort();
    return JSON.stringify([name, file, ports]);
}

function namesOrUndefined(value: unknown): string[] | undefined {
    return Array.isArray(value) && value.every(name => typeof name === 'string') ? value as string[] : undefined;
}

/** The given orders out of the graph's options: `PORT_ORDERS_OPTION`, when it is valid JSON. */
export function givenPortOrders(options: Record<string, unknown> | undefined): Record<string, SideOrder> {
    const raw = options?.[PORT_ORDERS_OPTION];
    if (typeof raw !== 'string' || raw.trim() === '') {
        return {};
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return {};
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return {};
    }
    const orders: Record<string, SideOrder> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            continue;
        }
        const order: SideOrder = {};
        for (const side of SIDES) {
            const names = namesOrUndefined((value as Record<string, unknown>)[side]);
            if (names) {
                order[side] = names;
            }
        }
        if (order.west || order.east) {
            orders[key] = order;
        }
    }
    return orders;
}

/**
 * The ids of `node`'s ports, top to bottom: each side listed in `order` as
 * its names say, each other side as in `fallback` (port ids). `undefined`
 * when a listed side does not name each of its ports exactly once, or two
 * ports of that side share a name.
 */
export function orderBySides(node: GNode, order: SideOrder, fallback: readonly string[] = []): string[] | undefined {
    const ports = portsOf(node);
    const rank = new Map(fallback.map((id, k) => [id, k] as const));
    const ids: string[] = [];
    for (const side of SIDES) {
        const own = ports.filter(port => sideOf(port) === side);
        const names = order[side];
        if (!names) {
            ids.push(...own.sort((a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity)).map(port => port.id));
            continue;
        }
        const byName = new Map(own.map(port => [portNameOf(node, port), port] as const));
        if (byName.size !== own.length || names.length !== own.length || new Set(names).size !== names.length) {
            return undefined;
        }
        for (const name of names) {
            const port = byName.get(name);
            if (!port) {
                return undefined;
            }
            ids.push(port.id);
        }
    }
    // A port on neither side (north, south) stays where its fallback has it.
    ids.push(...ports.filter(port => sideOf(port) === undefined).map(port => port.id));
    return ids;
}

/** A probed node's port names, top to bottom, side by side. */
export function probedSides(entry: ProbedOrder): Required<SideOrder> {
    const ports = portsOf(entry.node);
    const rank = new Map(entry.order.map((id, k) => [id, k] as const));
    const sides = { west: [] as string[], east: [] as string[] };
    for (const side of SIDES) {
        sides[side] = ports
            .filter(port => sideOf(port) === side)
            .sort((a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity))
            .map(port => portNameOf(entry.node, port));
    }
    return sides;
}

/**
 * Each port at its mean place among the instances, side by side, weighted
 * by their edges; ties as the first of the most connected has them.
 */
function consensusSides(group: readonly ProbedOrder[]): Required<SideOrder> {
    const leader = probedSides(group.reduce((best, entry) => (entry.edges > best.edges ? entry : best)));
    const result = { west: [] as string[], east: [] as string[] };
    for (const side of SIDES) {
        const sum = new Map<string, number>();
        let weight = 0;
        for (const entry of group) {
            const w = Math.max(1, entry.edges);
            weight += w;
            probedSides(entry)[side].forEach((name, k) => sum.set(name, (sum.get(name) ?? 0) + w * k));
        }
        const place = (name: string): number => (sum.get(name) ?? 0) / weight;
        const order = leader[side];
        result[side] = [...order].sort((a, b) => place(a) - place(b) || order.indexOf(a) - order.indexOf(b));
    }
    return result;
}

/**
 * The order each probed node's ports take, top to bottom: one per definition
 * (see the file's comment), the probe's own for a node alone of its kind.
 * `shared` holds the nodes given a definition's order; `unmatched` the given
 * definitions no probed node is an instance of.
 */
export function onePortOrderPerDefinition(
    probed: readonly ProbedOrder[],
    given: Readonly<Record<string, SideOrder>> = {}
): { orders: Map<GNode, string[]>; shared: Set<GNode>; unmatched: string[] } {
    const orders = new Map<GNode, string[]>();
    const shared = new Set<GNode>();
    const groups = new Map<string, ProbedOrder[]>();
    for (const entry of probed) {
        orders.set(entry.node, entry.order);
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
    const used = new Set<string>();
    for (const [key, group] of groups) {
        const name = definitionNameOf(group[0].node)!;
        const said = given[key] ?? given[name];
        if (said) {
            used.add(given[key] ? key : name);
        }
        const base = group.length > 1 ? consensusSides(group) : undefined;
        if (!said && !base) {
            continue;
        }
        for (const entry of group) {
            const order = orderBySides(entry.node, { ...base, ...said }, entry.order);
            if (order) {
                orders.set(entry.node, order);
                shared.add(entry.node);
            }
        }
    }
    return { orders, shared, unmatched: Object.keys(given).filter(key => !used.has(key)) };
}
