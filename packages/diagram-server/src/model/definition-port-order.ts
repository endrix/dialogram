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
 * have an input and an output of one name. A bus is one name in it, open or
 * closed: an open bus's members are drawn under it and move with it.
 *
 * An order a definition is drawn in, when it is not the source's, is kept
 * with the diagram's layout (`portOrders` in the layout file): the model is
 * built in it ({@link applyKeptPortOrders}), and every save of the layout says
 * it again from the drawing ({@link keptPortOrderChanges}). A node's ports
 * stay its children in the source's order whatever rows they are drawn on.
 */
import { GNode, GPort, type GModelElement } from '@eclipse-glsp/server';
import { WorkflowDiagramConstants, WorkflowDiagramMetadata, WorkflowDiagramTypes, isBoundaryNodeType, portRowOffset, portSide, type PortSide } from '@dialogram/shared';

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

/** The bundle an open bus's member is drawn under, by the bus's name. */
function busMemberOf(port: GPort): string | undefined {
    return textOf((port.args as Record<string, unknown> | undefined)?.[WorkflowDiagramMetadata.PORT_BUS_MEMBER_OF]);
}

/**
 * The ports that take a place of their own in an order: every port but an
 * open bus's members, which go where their bus goes. A bus is named and
 * keyed alike open or closed.
 */
function placedPortsOf(node: GNode): GPort[] {
    return portsOf(node).filter(port => busMemberOf(port) === undefined);
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
 * that defines it when the producer says so, and its ports by side and name,
 * a bus by its own (open or closed, it is one). Two nodes of one definition
 * whose ports differ are kept apart. Without the file, two definitions of one name and the same
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
    const ports = placedPortsOf(node).map(port => `${gportSide(port)}:${portNameOf(node, port)}`).sort();
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
    try {
        return keptPortOrdersOf(JSON.parse(raw)) ?? {};
    } catch {
        return {};
    }
}

/**
 * The ids of `node`'s placed ports (an open bus's members go with it), top
 * to bottom: each side listed in `order` as its names say, each other side
 * as in `fallback` (port ids). `undefined` when a listed side does not name
 * each of its ports exactly once, or two ports of that side share a name.
 */
export function orderBySides(node: GNode, order: SideOrder, fallback: readonly string[] = []): string[] | undefined {
    const ports = placedPortsOf(node);
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
    const ports = placedPortsOf(entry.node);
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

/**
 * Whether Free Ports may put `node`'s ports in another order: an ordinary
 * node, not an if, a loop, a group, a view's own port, or a cell drawn as
 * its symbol, whose pins are where the symbol has them (a mux's select, a
 * register's clock at its wedge).
 */
export function portsMayReorder(node: GNode): boolean {
    return node.type !== WorkflowDiagramTypes.NODE_STRUCTURE_IF
        && node.type !== WorkflowDiagramTypes.NODE_STRUCTURE_FOREACH
        && node.type !== WorkflowDiagramTypes.NODE_GROUP
        && !isBoundaryNodeType(node.type)
        && (node.args as Record<string, unknown> | undefined)?.[WorkflowDiagramMetadata.SYMBOL] === undefined;
}

/**
 * `node`'s port names by side, top to bottom, an open bus's members left out
 * (they go with it): as they are drawn now, or in the order the source
 * declares them, which is the order of the node's children (a reorder moves
 * a port to another row, never among them).
 */
export function sidesOf(node: GNode, as: 'drawn' | 'source'): Required<SideOrder> {
    const ports = placedPortsOf(node);
    const sides = { west: [] as string[], east: [] as string[] };
    for (const side of SIDES) {
        const own = ports.filter(port => sideOf(port) === side);
        if (as === 'drawn') {
            // A stable sort: two ports on one row keep the source's order.
            own.sort((a, b) => (a.position?.y ?? 0) - (b.position?.y ?? 0));
        }
        sides[side] = own.map(port => portNameOf(node, port));
    }
    return sides;
}

/** Whether two orders list the same names on each side, in the same order. */
export function sameSides(a: SideOrder, b: SideOrder): boolean {
    return SIDES.every(side => (a[side] ?? []).join('\u0000') === (b[side] ?? []).join('\u0000'));
}

/**
 * The node's ports of each side take the rows that side already occupies, in
 * the order given (port ids, top to bottom); a side not all of whose placed
 * ports the order names keeps its rows. An open bus takes its members with
 * it, in their order, on the rows after its own; where the order names a
 * member is not read. A port's box sits on its row, or above it when taller
 * (a bus's dot, centred on the row): the rows are read without that offset
 * and each port keeps its own. The labels are the ports' children and move
 * with them; nothing else about the node changes.
 */
export function regridPortRows(node: GNode, orderedIds: readonly string[]): void {
    const offsetOf = (port: GPort): number =>
        portRowOffset(port.size?.height ?? WorkflowDiagramConstants.PORT_HEIGHT_PX);
    const rowOf = (port: GPort): number => (port.position?.y ?? 0) - offsetOf(port);
    const rank = new Map(orderedIds.map((id, k) => [id, k] as const));
    for (const side of ['WEST', 'EAST'] as const) {
        const ports = portsOf(node).filter(port => gportSide(port) === side);
        const placed = ports.filter(port => busMemberOf(port) === undefined);
        if (placed.length < 2 || !placed.every(port => rank.has(port.id))) {
            continue;
        }
        const membersOf = (port: GPort): GPort[] => {
            const group = textOf((port.args as Record<string, unknown> | undefined)?.[WorkflowDiagramMetadata.PORT_BUS_GROUP]);
            return group === undefined ? [] : ports.filter(member => busMemberOf(member) === group).sort((a, b) => rowOf(a) - rowOf(b));
        };
        const rows = ports.map(rowOf).sort((a, b) => a - b);
        const order = [...placed].sort((a, b) => rank.get(a.id)! - rank.get(b.id)!).flatMap(port => [port, ...membersOf(port)]);
        if (order.length !== ports.length) {
            // A member whose bus is not on this side: the rows are left as they are.
            continue;
        }
        order.forEach((port, k) => {
            port.position = { x: port.position?.x ?? 0, y: rows[k] + offsetOf(port) };
        });
    }
}

/** The ids of `node`'s ports in the source's order. */
function sourceIds(node: GNode): string[] {
    return portsOf(node).map(port => port.id);
}

/**
 * Draw each definition `kept` names in its kept order, every instance of it
 * under `root`: the model as just built from the source, its ports on the
 * source's rows. An order that no longer fits the definition's ports (one
 * added, renamed or removed since) changes the key, and the source's order
 * stands. How many nodes were reordered.
 */
export function applyKeptPortOrders(root: GModelElement, kept: Readonly<Record<string, SideOrder>> | undefined): number {
    if (!kept || Object.keys(kept).length === 0) {
        return 0;
    }
    let reordered = 0;
    for (const [key, nodes] of definitionsUnder(root)) {
        const order = kept[key];
        if (!order) {
            continue;
        }
        for (const node of nodes) {
            const ids = orderBySides(node, order, sourceIds(node));
            if (ids) {
                regridPortRows(node, ids);
                reordered++;
            }
        }
    }
    return reordered;
}

/** What a save of the layout changes in the kept orders (see {@link keptPortOrderChanges}). */
export interface PortOrderChanges {
    /** The definitions now drawn in an order that is not the source's, and that order. */
    set: Record<string, Required<SideOrder>>;
    /** The definitions drawn in the source's order again. */
    remove: string[];
}

/**
 * The kept orders as the drawing under `root` says them: each definition
 * whose instances are all drawn in one order is kept in it when that is not
 * the source's order, and kept no more when it is. A definition whose
 * instances are drawn in different orders, and every definition not drawn
 * here, is left as the layout file has it.
 */
export function keptPortOrderChanges(root: GModelElement): PortOrderChanges {
    const changes: PortOrderChanges = { set: {}, remove: [] };
    for (const [key, nodes] of definitionsUnder(root)) {
        const drawn = sidesOf(nodes[0], 'drawn');
        if (nodes.some(node => !sameSides(sidesOf(node, 'drawn'), drawn))) {
            continue;
        }
        if (sameSides(drawn, sidesOf(nodes[0], 'source'))) {
            changes.remove.push(key);
        } else {
            changes.set[key] = drawn;
        }
    }
    return changes;
}

/** `kept` with `changes` made: what the layout file holds after the save. */
export function withPortOrderChanges(
    kept: Readonly<Record<string, SideOrder>> | undefined,
    changes: PortOrderChanges | undefined
): Record<string, SideOrder> {
    const next: Record<string, SideOrder> = { ...(kept ?? {}) };
    if (!changes) {
        return next;
    }
    for (const key of changes.remove) {
        delete next[key];
    }
    Object.assign(next, changes.set);
    return next;
}

/** The kept orders out of what a layout file holds: each entry with at least one side listed by name. */
export function keptPortOrdersOf(raw: unknown): Record<string, SideOrder> | undefined {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return undefined;
    }
    const orders: Record<string, SideOrder> = {};
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
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
    return Object.keys(orders).length > 0 ? orders : undefined;
}

/** The instances of each definition under `root` whose ports Free Ports may reorder, by key (`definitionKeyOf`). */
export function definitionsUnder(root: GModelElement): Map<string, GNode[]> {
    const groups = new Map<string, GNode[]>();
    const visit = (element: GModelElement): void => {
        if (element instanceof GNode && portsMayReorder(element)) {
            const key = definitionKeyOf(element);
            if (key !== undefined && placedPortsOf(element).length > 1) {
                groups.set(key, [...(groups.get(key) ?? []), element]);
            }
        }
        for (const child of element.children ?? []) {
            visit(child);
        }
    };
    visit(root);
    return groups;
}

/** The order the last Free Ports probe found for each node on its own, by node id, per laid-out graph. */
const probes = new WeakMap<object, Map<string, Required<SideOrder>>>();

/** Keep what the probe found for `root`'s nodes, each on its own (see {@link lastProbe}). */
export function recordProbe(root: object, probed: readonly ProbedOrder[]): void {
    probes.set(root, new Map(probed.map(entry => [entry.node.id, probedSides(entry)] as const)));
}

/**
 * The order the last Free Ports layout of `root` found for each node on its
 * own, before the instances of a definition were given one: by node id;
 * nothing when `root` has not been laid out with Free Ports since {@link forgetProbe}.
 */
export function lastProbe(root: object): ReadonlyMap<string, Required<SideOrder>> | undefined {
    return probes.get(root);
}

export function forgetProbe(root: object): void {
    probes.delete(root);
}
