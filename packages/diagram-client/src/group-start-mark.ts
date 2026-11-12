/**
 * The mark of a group where the diagram's flow starts (`start` on its scope,
 * on the wire the group's `GROUP_START` argument): the initial state of a
 * state machine, the first stage of a pipeline.
 *
 * A filled dot in the group's header band, before its title, as a statechart
 * marks its initial state. It is inside the frame, so it takes no room of
 * the layout's; the title moves over by {@link GROUP_START_MARK_ROOM_PX}. A
 * group with no title has no band, and so no mark.
 */
import type { VNode } from 'snabbdom';
import { svg } from '@eclipse-glsp/client';
import { WorkflowDiagramMetadata } from '@dialogram/shared';

export const GROUP_START_MARK_RADIUS_PX = 4;
/** What the mark takes of the header band: its width and the gap before the title. */
export const GROUP_START_MARK_ROOM_PX = 2 * GROUP_START_MARK_RADIUS_PX + 6;

/** Is this group marked as where the flow starts? */
export function isGroupStart(node: { args?: Record<string, unknown> }): boolean {
    return node.args?.[WorkflowDiagramMetadata.GROUP_START] === true;
}

/** The mark, its left edge at `x`, centred on `cy`. */
export function groupStartMark(x: number, cy: number): VNode {
    return svg('circle', {
        class: { 'group-start-mark': true },
        attrs: { cx: x + GROUP_START_MARK_RADIUS_PX, cy, r: GROUP_START_MARK_RADIUS_PX }
    }, svg('title', {}, 'Starts here'));
}
