/**
 * The mark of the group a diagram's flow starts in (`initial` on its scope,
 * on the wire the group's `GROUP_INITIAL` argument): the initial state of a
 * state machine, the first stage of a pipeline.
 *
 * A filled dot and a short arrow, as a statechart marks its initial state,
 * at the top left of the frame: before the title in the header band, or
 * alone in the room every frame keeps for a header when the group has no
 * title. It is inside the frame and takes nothing from the layout; what it
 * takes is {@link GROUP_INITIAL_MARK_ROOM_PX} of the title's room, and a
 * frame is not made wider for its title, with the mark or without.
 */
import type { VNode } from 'snabbdom';
import { svg } from '@eclipse-glsp/client';
import { WorkflowDiagramMetadata } from '@dialogram/shared';

const DOT_RADIUS_PX = 4;
const SHAFT_PX = 6;
const HEAD_PX = 5;
/** The mark's own width: the dot, the shaft, the head. */
export const GROUP_INITIAL_MARK_WIDTH_PX = 2 * DOT_RADIUS_PX + SHAFT_PX + HEAD_PX;
/** What the mark takes of the header band: its width and the gap before the title. */
export const GROUP_INITIAL_MARK_ROOM_PX = GROUP_INITIAL_MARK_WIDTH_PX + 5;

/** Is this group marked as where the flow starts? Only a plain `true` counts. */
export function isGroupInitial(node: { args?: Record<string, unknown> }): boolean {
    return node.args?.[WorkflowDiagramMetadata.GROUP_INITIAL] === true;
}

/** The mark, its left edge at `x`, centred on `cy`. */
export function groupInitialMark(x: number, cy: number): VNode {
    const shaftStart = x + 2 * DOT_RADIUS_PX;
    const tip = x + GROUP_INITIAL_MARK_WIDTH_PX;
    return svg('g', { class: { 'group-initial-mark': true } },
        svg('title', {}, 'Starts here'),
        svg('circle', { class: { 'group-initial-dot': true }, attrs: { cx: x + DOT_RADIUS_PX, cy, r: DOT_RADIUS_PX } }),
        svg('path', {
            class: { 'group-initial-arrow': true },
            attrs: { d: `M${shaftStart},${cy} H${tip - HEAD_PX} M${tip},${cy} l${-HEAD_PX},${-HEAD_PX / 2 - 0.5} v${HEAD_PX + 1} Z` }
        })
    );
}
