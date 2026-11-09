/**
 * Room for a node whose height changed in place: a bus opened grows its node
 * downward, onto whatever was laid out under it.
 *
 * The nodes stacked under it move with its bottom edge, so each keeps the gap
 * it had: those a growth would reach, and those close enough below to read as
 * one column with it (a layered layout stacks a layer's nodes a node-spacing
 * apart). A node moved this way moves the ones stacked under it in turn, so a
 * column moves as one and nothing it holds is pushed into anything else. When
 * the node shrinks, the same column moves back up, as far as nothing above it
 * stands in the way.
 *
 * Only the node's siblings move: positions are relative to the parent, and a
 * node in another container is not under it.
 */

export interface Box {
    id: string;
    x: number;
    y: number;
    width: number;
    height: number;
}

/**
 * A gap under which a node below reads as stacked under the one above. The
 * layout stacks a layer's nodes `elk.spacing.nodeNode` (50) apart, and
 * alignment adds a little.
 */
export const STACK_REACH_PX = 80;

/** The least gap left between two nodes when a column moves. */
export const MIN_GAP_PX = 20;

/**
 * How far each sibling moves down (negative: up) when `resizedId`, now its
 * box's height, was `oldHeight` tall. Nodes that do not move are absent.
 */
export function makeRoom(boxes: readonly Box[], resizedId: string, oldHeight: number): Map<string, number> {
    const resized = boxes.find(box => box.id === resizedId);
    const moves = new Map<string, number>();
    if (!resized) {
        return moves;
    }
    const delta = resized.height - oldHeight;
    if (Math.abs(delta) < 0.5) {
        return moves;
    }

    const overlapsX = (a: Box, b: Box): boolean => a.x < b.x + b.width && b.x < a.x + a.width;
    const bottomBefore = (box: Box): number => box.y + (box.id === resizedId ? oldHeight : box.height);
    // Growing, everything the growth would reach moves, however far apart it was.
    const reach = delta > 0 ? Math.max(STACK_REACH_PX, delta + MIN_GAP_PX) : STACK_REACH_PX;

    const column = new Set<string>();
    const queue: Box[] = [resized];
    while (queue.length > 0) {
        const above = queue.shift()!;
        for (const box of boxes) {
            if (box.id === resizedId || column.has(box.id) || box.y < above.y || !overlapsX(above, box)) {
                continue;
            }
            if (box.y - bottomBefore(above) < reach) {
                column.add(box.id);
                queue.push(box);
            }
        }
    }
    if (column.size === 0) {
        return moves;
    }

    let shift = delta;
    if (delta < 0) {
        // Back up by what the node shrank, but not into anything above the
        // column that is not part of it.
        let room = -delta;
        for (const box of boxes) {
            if (!column.has(box.id)) {
                continue;
            }
            for (const other of boxes) {
                if (column.has(other.id) || other.id === box.id || other.y >= box.y || !overlapsX(other, box)) {
                    continue;
                }
                room = Math.min(room, box.y - (other.y + other.height) - MIN_GAP_PX);
            }
        }
        if (room < 0.5) {
            return moves;
        }
        shift = -room;
    }
    for (const id of column) {
        moves.set(id, shift);
    }
    return moves;
}
