/**
 * Keep a toggled node where it was on screen.
 *
 * Opening or closing a bus, or a node in place, lays the whole view out again
 * (the server's toggle-port-bus-handler.ts), so the node pressed can land
 * anywhere in the diagram. When the new model comes in, the view is scrolled
 * by however far the toggle moved: it stands where it stood, under the
 * pointer that pressed it, and the rest of the diagram moves around it.
 *
 * The update that carries the new model moves the nodes in an animation; the
 * scroll is a step of the same animation (`AnchoredUpdateModelCommand`), so
 * the node pressed stays still while the rest slides. A model that comes as a
 * whole new one (`SetModelAction`) is scrolled after it is drawn.
 */
import { inject, injectable } from 'inversify';
import { TYPES, type IActionDispatcher } from '@eclipse-glsp/client';
import { SetViewportAction } from '@eclipse-glsp/protocol';
import { WorkflowDiagramMetadata } from '@dialogram/shared';

export type Point = { x: number; y: number };

/** How long a press waits for the model it asked for. A large view takes a while to lay out. */
export const TOGGLE_ANCHOR_TIMEOUT_MS = 60_000;

/** What a toggle's answer does to the view: where the element pressed was and goes, and the scroll that keeps it still. */
export interface Anchored {
    /** The view's scroll that keeps it where it was on screen. */
    scroll: Point;
    /** Where it was and where it goes, in diagram coordinates. */
    from: Point;
    to: Point;
    /** The element pressed, and the one it is now: another when a node opened into its frame or a frame closed. */
    pressed: string;
    id: string;
}

/** A toggle pressed: the element it names, where it was, and what it was. */
interface Pending {
    id: string;
    /** Closed, the node's key: its frame, once open, names it. */
    key?: string;
    /** Open, the node's key: the node, once closed, is it. */
    openKey?: string;
    /** A run of an automaton's states: the state that names it, folded or unfolded, is it. */
    run?: string;
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
export function toggledIn(root: any, pending: Pick<Pending, 'id' | 'key' | 'openKey' | 'run'>): any {
    const byId = root?.index?.getById?.(pending.id);
    if (byId) {
        return byId;
    }
    return find(root, element => {
        const args = element?.args ?? {};
        return (pending.run !== undefined && args[WorkflowDiagramMetadata.STATE_RUN] === pending.run)
            || (pending.key !== undefined && args[WorkflowDiagramMetadata.OPEN_NODE_KEY] === pending.key)
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
        const run = args[WorkflowDiagramMetadata.STATE_RUN];
        this.pending = {
            id,
            key: typeof key === 'string' ? key : undefined,
            openKey: typeof openKey === 'string' ? openKey : undefined,
            run: typeof run === 'string' ? run : undefined,
            at: absolutePosition(element),
            state: stateOf(element),
            since: Date.now()
        };
    }

    /**
     * The scroll that keeps the element pressed where it is on screen, when
     * `newRoot` is the model the toggle asked for (the bus opened or closed,
     * the node opened into its frame or closed back); nothing otherwise, nor
     * when it did not move. Taking it ends the wait. `oldRoot` is the model
     * drawn now, when there is one; else the press's own record is the
     * place, and `newRoot`'s scroll the view's.
     */
    take(newRoot: any, oldRoot?: any): Anchored | undefined {
        const pending = this.pending;
        if (!pending) {
            return undefined;
        }
        if (Date.now() - pending.since > TOGGLE_ANCHOR_TIMEOUT_MS) {
            this.pending = undefined;
            return undefined;
        }
        const element = toggledIn(newRoot, pending);
        // Not the model the toggle asked for yet (a status update, a run):
        // keep waiting for the one where the bus or the node changed.
        if (!element || stateOf(element) === pending.state) {
            return undefined;
        }
        this.pending = undefined;
        const scroll = (oldRoot ?? newRoot)?.scroll;
        if (!scroll) {
            return undefined;
        }
        const before = oldRoot?.index?.getById?.(pending.id);
        const from = before ? absolutePosition(before) : pending.at;
        const to = absolutePosition(element);
        if (Math.abs(to.x - from.x) < 0.5 && Math.abs(to.y - from.y) < 0.5) {
            return undefined;
        }
        return { scroll: anchoredScroll(scroll, from, to), from, to, pressed: pending.id, id: String(element.id) };
    }

    /** A model that came whole (`SetModelAction`): scrolled once it is drawn. An update has been taken already. */
    modelRootChanged(root: any): void {
        const next = this.take(root)?.scroll;
        const zoom = root?.zoom;
        if (!next || typeof zoom !== 'number') {
            return;
        }
        // After the view has rendered the new model.
        setTimeout(() => {
            void this.dispatcher.dispatch(SetViewportAction.create(root.id, { scroll: next, zoom }, { animate: true }) as never);
        }, 0);
    }
}
