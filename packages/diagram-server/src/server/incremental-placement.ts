/**
 * Where the nodes a diagram gained go, when the diagram grows.
 *
 * A producer may say its graph grows (`graph.meta.incremental`): a schematic
 * of a netlist is drawn a part at a time, each step adding the cells a pin's
 * fan-in or fan-out reaches. Laying the whole diagram out again at every step
 * would move what the reader has just read, so the nodes a saved layout
 * places stay exactly where they are and each new node is put beside the
 * node it is wired to:
 *
 * - a node that drives a placed one goes in the column to its left, a node a
 *   placed one drives in the column to its right, at the height that makes
 *   the wire between them straight;
 * - where that place is taken it goes to the nearest free one: along its
 *   column, above or below, or in the next column out when that is nearer
 *   than the column's own free place, and as many columns out as it takes:
 *   a pin with a thousand loads fills column after column, and no node is
 *   ever put on another;
 * - a node placed this way is a neighbour the next can be placed beside, so
 *   a chain added in one step unrolls a column at a time;
 * - a piece wired to nothing placed (a cell picked from a list, with the
 *   stubs of its pins) is started under the diagram from the node of it with
 *   the most wires, and grows from that node as the rest does; a node wired
 *   to nothing at all is parked there.
 *
 * It is not a layout: it moves nothing, and it does not untangle. It keeps a
 * picture still while it grows; Layout Diagram is what tidies it.
 */

export interface PlacedNode {
    id: string;
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface FreshNode {
    id: string;
    width: number;
    height: number;
}

/** A wire between two nodes, with the height it leaves `from` and enters `to` at, inside each. */
export interface NodeLink {
    from: string;
    to: string;
    fromY: number;
    toY: number;
}

export interface PlacementOptions {
    /** Room between two columns, for the wires that turn in it. */
    gapX?: number;
    /** Room between two nodes of a column. */
    gapY?: number;
    /** How far a node slides along its column before the next column is tried, in gaps. */
    reach?: number;
}

export const INCREMENTAL_GAP_X = 70;
export const INCREMENTAL_GAP_Y = 18;
export const INCREMENTAL_REACH = 160;
/** What a column out costs, in column widths of sliding along the column. */
const COLUMN_COST = 2;

interface Box {
    x: number;
    y: number;
    width: number;
    height: number;
}

/** Boxes by the cells of a grid they touch, so a free place is found without asking every box. */
class BoxIndex {
    private readonly cells = new Map<string, Box[]>();

    constructor(private readonly cell: number) { }

    private keys(box: Box, margin: number): string[] {
        const keys: string[] = [];
        const x0 = Math.floor((box.x - margin) / this.cell);
        const x1 = Math.floor((box.x + box.width + margin) / this.cell);
        const y0 = Math.floor((box.y - margin) / this.cell);
        const y1 = Math.floor((box.y + box.height + margin) / this.cell);
        for (let cx = x0; cx <= x1; cx++) {
            for (let cy = y0; cy <= y1; cy++) {
                keys.push(`${cx},${cy}`);
            }
        }
        return keys;
    }

    add(box: Box): void {
        for (const key of this.keys(box, 0)) {
            const list = this.cells.get(key);
            if (list) {
                list.push(box);
            } else {
                this.cells.set(key, [box]);
            }
        }
    }

    /** Whether `box`, with `gapX` beside it and `gapY` above and below, touches any box held. */
    collides(box: Box, gapX: number, gapY: number): boolean {
        for (const key of this.keys(box, Math.max(gapX, gapY))) {
            for (const other of this.cells.get(key) ?? []) {
                if (
                    box.x - gapX < other.x + other.width && box.x + box.width + gapX > other.x
                    && box.y - gapY < other.y + other.height && box.y + box.height + gapY > other.y
                ) {
                    return true;
                }
            }
        }
        return false;
    }
}

interface Anchor {
    /** The placed neighbour. */
    other: string;
    /** Whether the new node drives it (so goes to its left). */
    drives: boolean;
    /** Where the wire meets the new node, and the neighbour, inside each. */
    ownY: number;
    otherY: number;
    /** The wire's place among the links, for a stable order. */
    order: number;
}

/**
 * The position of every fresh node, by id. The placed nodes are not moved and
 * are not in the result.
 */
export function placeBesideNeighbours(
    placed: readonly PlacedNode[],
    fresh: readonly FreshNode[],
    links: readonly NodeLink[],
    options: PlacementOptions = {}
): Map<string, { x: number; y: number }> {
    const gapX = options.gapX ?? INCREMENTAL_GAP_X;
    const gapY = options.gapY ?? INCREMENTAL_GAP_Y;
    const reach = options.reach ?? INCREMENTAL_REACH;
    const result = new Map<string, { x: number; y: number }>();
    if (fresh.length === 0) {
        return result;
    }

    const at = new Map<string, Box>();
    const index = new BoxIndex(256);
    // The diagram's left edge and its foot, as it grows: where a piece of its own starts.
    let left = Infinity;
    let foot = -Infinity;
    const settle = (id: string, box: Box): void => {
        at.set(id, box);
        index.add(box);
        left = Math.min(left, box.x);
        foot = Math.max(foot, box.y + box.height);
    };
    for (const node of placed) {
        settle(node.id, { x: node.x, y: node.y, width: node.width, height: node.height });
    }
    const sizes = new Map(fresh.map(node => [node.id, node] as const));
    const order = new Map(fresh.map((node, k) => [node.id, k] as const));
    const pending = new Set(fresh.map(node => node.id));

    // Each fresh node's wires, by the node at their other end.
    const wires = new Map<string, Anchor[]>();
    links.forEach((link, k) => {
        if (link.from === link.to) {
            return;
        }
        if (sizes.has(link.from)) {
            const list = wires.get(link.from) ?? [];
            list.push({ other: link.to, drives: true, ownY: link.fromY, otherY: link.toY, order: k });
            wires.set(link.from, list);
        }
        if (sizes.has(link.to)) {
            const list = wires.get(link.to) ?? [];
            list.push({ other: link.from, drives: false, ownY: link.toY, otherY: link.fromY, order: k });
            wires.set(link.to, list);
        }
    });

    // The columns found full, by where a search began and what it was for:
    // nothing is ever taken away, so a full column stays full, and the next
    // of a pin's thousand loads does not walk every full one again.
    const fullColumns = new Map<string, number>();

    const place = (id: string, anchor: Anchor): void => {
        const size = sizes.get(id)!;
        const neighbour = at.get(anchor.other)!;
        const wanted = neighbour.y + anchor.otherY - anchor.ownY;
        const step = Math.max(6, gapY);
        const stride = Math.max(1, size.width + gapX);
        const first = anchor.drives ? neighbour.x - gapX - size.width : neighbour.x + neighbour.width + gapX;
        const search = `${first}:${wanted}:${size.width}:${size.height}:${anchor.drives}`;
        const from = fullColumns.get(search) ?? 0;
        // The nearest free place of each column, the node's own and the next
        // ones out; the one taken is the nearest overall, a column out
        // counting as twice its width: a pin's fan-out fills a column before
        // it starts the next, and a node keeps close to its pin rather than
        // sliding the length of a full column to stay in it. The columns go
        // on until one has room: past the last node there is always room, so
        // the search ends, and it never ends on a place that is taken.
        let best: { x: number; y: number; cost: number } | undefined;
        let full = from;
        for (let column = from; ; column++) {
            const x = first + (anchor.drives ? -column : column) * stride;
            const columnCost = column * stride * COLUMN_COST;
            if (best && columnCost >= best.cost) {
                break;
            }
            let found = false;
            for (let k = 0; k <= reach; k++) {
                const cost = columnCost + k * step;
                if (best && cost >= best.cost) {
                    found = true; // not searched to its end: not known to be full
                    break;
                }
                const free = (k === 0 ? [wanted] : [wanted + k * step, wanted - k * step])
                    .find(y => !index.collides({ x, y, width: size.width, height: size.height }, gapX / 2, gapY));
                if (free !== undefined) {
                    best = { x, y: free, cost };
                    found = true;
                    break;
                }
            }
            if (!found && column === full) {
                full = column + 1;
            }
        }
        if (full > from) {
            fullColumns.set(search, full);
        }
        const spot = { x: best!.x, y: best!.y };
        settle(id, { x: spot.x, y: spot.y, width: size.width, height: size.height });
        result.set(id, spot);
        pending.delete(id);
    };

    /** The pending node with the most wires to other pending nodes: what a piece of its own is started from. */
    const hub = (): string | undefined => {
        let found: string | undefined;
        let most = 0;
        for (const id of pending) {
            const count = (wires.get(id) ?? []).filter(wire => pending.has(wire.other)).length;
            if (count > most || (count === most && count > 0 && order.get(id)! < order.get(found!)!)) {
                found = id;
                most = count;
            }
        }
        return found;
    };

    /**
     * Start a piece under the diagram at its hub, with the room its
     * neighbours take: what drives it goes to its left, so it is set in by
     * that much, and a pin's worth of neighbours stacks taller than the hub,
     * so it is set down by the half that sticks out above it.
     */
    const start = (id: string): void => {
        const size = sizes.get(id)!;
        let lead = 0;
        let driversTall = 0;
        let loadsTall = 0;
        for (const wire of wires.get(id) ?? []) {
            const other = pending.has(wire.other) ? sizes.get(wire.other) : undefined;
            if (!other) {
                continue;
            }
            if (wire.drives) {
                loadsTall += other.height + gapY;
            } else {
                driversTall += other.height + gapY;
                lead = Math.max(lead, other.width + gapX);
            }
        }
        const rise = Math.max(0, (Math.max(driversTall, loadsTall) - size.height) / 2);
        const spot = {
            x: (Number.isFinite(left) ? left : 20) + lead,
            y: Number.isFinite(foot) ? foot + 3 * gapY + rise : 20 + rise
        };
        settle(id, { x: spot.x, y: spot.y, width: size.width, height: size.height });
        result.set(id, spot);
        pending.delete(id);
    };

    // Round by round: every fresh node with a placed neighbour, in the order
    // of the pins it hangs off, so a pin's fan-out reads top to bottom as the
    // pins do.
    for (;;) {
        const round: Array<{ id: string; anchor: Anchor }> = [];
        for (const id of pending) {
            const anchor = (wires.get(id) ?? [])
                .filter(wire => at.has(wire.other))
                .sort((a, b) => a.order - b.order)[0];
            if (anchor) {
                round.push({ id, anchor });
            }
        }
        if (round.length === 0) {
            // Nothing left hangs off a placed node: the next piece is started from its hub.
            const seed = hub();
            if (seed === undefined) {
                break;
            }
            start(seed);
            continue;
        }
        round.sort((a, b) => {
            const na = at.get(a.anchor.other)!;
            const nb = at.get(b.anchor.other)!;
            return (na.y + a.anchor.otherY) - (nb.y + b.anchor.otherY)
                || a.anchor.order - b.anchor.order
                || order.get(a.id)! - order.get(b.id)!;
        });
        for (const { id, anchor } of round) {
            place(id, anchor);
        }
    }

    // What is wired to nothing at all: in rows under everything.
    if (pending.size > 0) {
        const startX = Number.isFinite(left) ? left : 20;
        let x = startX;
        let y = Number.isFinite(foot) ? foot + 3 * gapY : 20;
        let rowHeight = 0;
        let inRow = 0;
        for (const id of [...pending].sort((a, b) => order.get(a)! - order.get(b)!)) {
            const size = sizes.get(id)!;
            result.set(id, { x, y });
            at.set(id, { x, y, width: size.width, height: size.height });
            rowHeight = Math.max(rowHeight, size.height);
            x += size.width + gapX;
            if (++inRow >= 6) {
                x = startX;
                y += rowHeight + gapY;
                rowHeight = 0;
                inRow = 0;
            }
        }
    }
    return result;
}

/**
 * Whether a route, a polyline of points, runs through a box: the wires a new
 * node was put on top of are routed again, the rest keep the route they had.
 */
export function routeCrosses(points: ReadonlyArray<{ x: number; y: number }>, box: Box, margin = 2): boolean {
    const left = box.x - margin;
    const right = box.x + box.width + margin;
    const top = box.y - margin;
    const bottom = box.y + box.height + margin;
    for (let k = 1; k < points.length; k++) {
        const a = points[k - 1];
        const b = points[k];
        // The segment's own box against the node's, which is exact for the
        // horizontal and vertical runs wires are made of.
        if (
            Math.min(a.x, b.x) < right && Math.max(a.x, b.x) > left
            && Math.min(a.y, b.y) < bottom && Math.max(a.y, b.y) > top
        ) {
            return true;
        }
    }
    return false;
}
