/**
 * The toggle in the header of a node that holds a graph of its own: `+`
 * opens it in place, as the group frame of what it holds, and the `−` in that
 * frame's header closes it again. The server keeps which nodes are open, in
 * the layout file (node-open.ts).
 */
import { Ranked, svg } from '@eclipse-glsp/client';
import { Action, GModelElement, MouseListener } from '@eclipse-glsp/sprotty';
import { injectable } from 'inversify';
import type { VNode } from 'snabbdom';
import { ToggleNodeOpenOperation } from '@dialogram/shared';
import { pressToggle, toggleTargetOf } from './port-bus-toggle';

/** The attribute a header's toggle carries: the id of the node, or of the frame, it toggles. */
export const NODE_OPEN_TOGGLE_ATTR = 'data-node-open-toggle';

/** Radius of the toggle's ring. */
export const NODE_OPEN_TOGGLE_RADIUS_PX = 6;

/** The toggle, centred at (cx, cy): `+` to open, `−` to close. */
export function nodeOpenToggle(elementId: string, open: boolean, label: string, cx: number, cy: number): VNode {
    const r = NODE_OPEN_TOGGLE_RADIUS_PX;
    const arm = r - 2.5;
    return svg('g', {
        class: { 'node-open-toggle': true, open },
        attrs: { [NODE_OPEN_TOGGLE_ATTR]: elementId }
    },
        svg('title', {}, open ? `Close ${label}` : `Open ${label}: show what it is made of`),
        svg('circle', { class: { 'node-open-toggle-ring': true }, attrs: { cx, cy, r } }),
        svg('line', { class: { 'node-open-toggle-mark': true }, attrs: { x1: cx - arm, y1: cy, x2: cx + arm, y2: cy } }),
        ...(open ? [] : [svg('line', { class: { 'node-open-toggle-mark': true }, attrs: { x1: cx, y1: cy - arm, x2: cx, y2: cy + arm } })])
    ) as unknown as VNode;
}

/** The node or frame whose toggle the event landed on, if it landed on one. */
export function nodeOpenToggleOf(event: Pick<MouseEvent, 'target'>): string | undefined {
    return toggleTargetOf(event, NODE_OPEN_TOGGLE_ATTR);
}

@injectable()
export class NodeOpenToggleMouseListener extends MouseListener implements Ranked {
    // Ahead of the tools, so the press is a toggle and not the start of a drag.
    rank = 9;

    override mouseDown(_target: GModelElement, event: MouseEvent): (Action | Promise<Action>)[] {
        return pressToggle(event, NODE_OPEN_TOGGLE_ATTR, nodeId => ToggleNodeOpenOperation.create({ nodeId }));
    }
}
