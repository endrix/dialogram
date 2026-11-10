/**
 * Keep a toggled node where it was on screen.
 *
 * Opening or closing a bus, or a node in place, lays the whole view out again
 * (the server's toggle-port-bus-handler.ts), so the node pressed can land
 * anywhere in the diagram. When the new model comes in, the view is scrolled
 * by however far the toggle moved: it stands where it stood, under the
 * pointer that pressed it, and the rest of the diagram moves around it.
 */
import { inject, injectable } from 'inversify';
import { TYPES, type IActionDispatcher } from '@eclipse-glsp/client';
import { SetViewportAction } from '@eclipse-glsp/protocol';
import { WorkflowDiagramMetadata } from '@dialogram/shared';

type Point = { x: number; y: number };

/** How long a press waits for the model it asked for. A large view takes a while to lay out. */
export const TOGGLE_ANCHOR_TIMEOUT_MS = 60_000;

/** A toggle pressed: the element it names, where it was, and what it was. */
interface Pending {
    id: string;
    /** Closed, the node's key: its frame, once open, names it. */
    key?: string;
    /** Open, the node's key: the node, once closed, is it. */
    openKey?: string;
    at: Point;
    state: string;
    since: number;
}

/** The element's position in diagram coordinates: its own and its parents', up to the root. */
export function absolutePosition(element: any): Point {
    let x = 0;
    let y = 0;
    for (let at = element; at && at.parent && at.parent !== at; at = at.parent) {
        x += at.position?.x ?? 0;
        y += at.position?.y ?? 0;
    }
    return { x, y };
}

/** What a toggle changes: a node opened becomes its frame, a bus opens. */
function stateOf(element: any): string {
    return `${element.id}|${element.args?.[WorkflowDiagramMetadata.PORT_BUS_EXPANDED] === true}`;
}

function find(root: any, match: (element: any) => boolean): any {
    const stack = [root];
    while (stack.length > 0) {
        const element = stack.pop();
        if (match(element)) {
            return element;
        }
        stack.push(...(element?.children ?? []));
    }
    return undefined;
}

/** The element a press named, in `root`: itself, the frame a node opened into, or the node a frame closed into. */
export function toggledIn(root: any, pending: Pick<Pending, 'id' | 'key' | 'openKey'>): any {
    const byId = root?.index?.getById?.(pending.id);
    if (byId) {
        return byId;
    }
    return find(root, element => {
        const args = element?.args ?? {};
        return (pending.key !== undefined && args[WorkflowDiagramMetadata.OPEN_NODE_KEY] === pending.key)
            || (pending.openKey !== undefined
                && (element?.id === pending.openKey || args[WorkflowDiagramMetadata.AST_PATH] === pending.openKey));
    });
}

/**
 * The scroll that puts an element back where it was on screen: moved by
 * `from` → `to` in diagram coordinates, the view scrolls by as much.
 */
export function anchoredScroll(scroll: Point, from: Point, to: Point): Point {
    return { x: scroll.x + (to.x - from.x), y: scroll.y + (to.y - from.y) };
}

@injectable()
export class ToggleAnchor {
    @inject(TYPES.IActionDispatcher) protected readonly dispatcher!: IActionDispatcher;

    private pending: Pending | undefined;

    /** A toggle naming `id` was pressed, in the model drawn now. */
    remember(root: any, id: string): void {
        const element = root?.index?.getById?.(id);
        if (!element) {
            return;
        }
        const args = element.args ?? {};
        const key = args[WorkflowDiagramMetadata.AST_PATH] ?? element.id;
        const openKey = args[WorkflowDiagramMetadata.OPEN_NODE_KEY];
        this.pending = {
            id,
            key: typeof key === 'string' ? key : undefined,
            openKey: typeof openKey === 'string' ? openKey : undefined,
            at: absolutePosition(element),
            state: stateOf(element),
            since: Date.now()
        };
    }

    modelRootChanged(root: any): void {
        const pending = this.pending;
        if (!pending) {
            return;
        }
        if (Date.now() - pending.since > TOGGLE_ANCHOR_TIMEOUT_MS) {
            this.pending = undefined;
            return;
        }
        const element = toggledIn(root, pending);
        // Not the model the toggle asked for yet (a status update, a run):
        // keep waiting for the one where the bus or the node changed.
        if (!element || stateOf(element) === pending.state) {
            return;
        }
        this.pending = undefined;
        const scroll = root?.scroll;
        const zoom = root?.zoom;
        if (!scroll || typeof zoom !== 'number') {
            return;
        }
        const to = absolutePosition(element);
        if (Math.abs(to.x - pending.at.x) < 0.5 && Math.abs(to.y - pending.at.y) < 0.5) {
            return;
        }
        const next = anchoredScroll(scroll, pending.at, to);
        // After the view has rendered the new model.
        setTimeout(() => {
            void this.dispatcher.dispatch(SetViewportAction.create(root.id, { scroll: next, zoom }, { animate: true }) as never);
        }, 0);
    }
}
