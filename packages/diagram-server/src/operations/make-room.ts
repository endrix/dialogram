/**
 * Room for a node that grew in place: a bus opened grows its node downward,
 * onto whatever was laid out under it.
 *
 * The nodes stacked under it move with its bottom edge, so each keeps the gap
 * it had: those the growth would reach, and those close enough below to read
 * as one column with it (a layered layout stacks a layer's nodes a
 * node-spacing apart). A node moved this way moves the ones stacked under it
 * in turn, so a column moves as one and nothing it holds is pushed into
 * anything else.
 *
 * Only growing makes room. Which nodes a growth pushed cannot be read back
 * off the layout afterwards (a node pushed from 100 px below and one placed
 * 40 px below look the same), so a shrink moves nothing here: the toggle
 * remembers what its opening moved and moves exactly that back.
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
 * How far each sibling moves down when `resizedId`, now its box's height, was
 * `oldHeight` tall. Nodes that do not move are absent; a node that did not
 * grow moves nothing.
 */
export function makeRoom(boxes: readonly Box[], resizedId: string, oldHeight: number): Map<string, number> {
    const resized = boxes.find(box => box.id === resizedId);
    const moves = new Map<string, number>();
    const delta = resized ? resized.height - oldHeight : 0;
    if (!resized || delta < 0.5) {
        return moves;
    }

    const overlapsX = (a: Box, b: Box): boolean => a.x < b.x + b.width && b.x < a.x + a.width;
    const bottomBefore = (box: Box): number => box.y + (box.id === resizedId ? oldHeight : box.height);
    // Everything the growth would reach moves, however far apart it was.
    const reach = Math.max(STACK_REACH_PX, delta + MIN_GAP_PX);

    const queue: Box[] = [resized];
    while (queue.length > 0) {
        const above = queue.shift()!;
        for (const box of boxes) {
            if (box.id === resizedId || moves.has(box.id) || box.y < above.y || !overlapsX(above, box)) {
                continue;
            }
            if (box.y - bottomBefore(above) < reach) {
                moves.set(box.id, delta);
                queue.push(box);
            }
        }
    }
    return moves;
}
