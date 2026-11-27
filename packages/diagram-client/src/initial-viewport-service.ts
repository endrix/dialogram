import { CenterAction, FitToScreenAction, type Action } from '@eclipse-glsp/protocol';
import { TYPES, type IActionDispatcher } from '@eclipse-glsp/client';
import { inject, injectable, optional, postConstruct } from 'inversify';
import { DiagramSurfaceHost, type ViewportRoot } from './diagram-surface-host';
import { clientBehavior } from './profile';

/** The viewport a view was set with, to tell whether the reader has moved it since. */
type Snapshot = { zoom: number; scroll: { x: number; y: number } };

/** The size HTML gives a frame nobody has sized: the canvas of a webview VS Code has not laid out yet. */
export const UNSIZED_FRAME = { width: 300, height: 150 } as const;

function sameViewport(a: Snapshot, b: Snapshot): boolean {
    return a.zoom === b.zoom && a.scroll.x === b.scroll.x && a.scroll.y === b.scroll.y;
}

/** What the first view of a diagram is: the profile's `clientBehavior.initialView`, centre by default. */
export function initialViewAction(view: unknown): Action {
    return view === 'fit'
        ? FitToScreenAction.create([], { animate: false })
        : CenterAction.create([], { animate: false });
}

/**
 * Shows a view the first time it is set: centred at zoom 1, or fitted when the
 * profile asks for it (`clientBehavior.initialView: 'fit'`).
 *
 * Which views that is, is decided by `ViewportPreservingSetModelCommand`: a view
 * never shown in this editor gets a first view, a view navigated back to returns
 * to where it was left, and a refresh of the view shown keeps its viewport.
 *
 * The first view is done once, as soon as it can be right: when the canvas
 * has a size and the content has bounds (a surface that has `bounds` must have
 * answered; the graph's are measured before its model arrives). It used to be
 * a centre two frames after every model set, Sprotty's empty placeholder root
 * included, so the empty root's centre could land after the real model's, and
 * a surface whose data came later was centred on nothing. If the reader moves
 * the view before then, theirs stands: nothing is done.
 *
 * A webview can draw a model built quickly before VS Code has sized its frame,
 * whose canvas is then an iframe's default 300 × 150 (`UNSIZED_FRAME`), and a
 * view fitted or centred on it is wrong once the frame has its size. A first
 * view done on that canvas is done once more when the canvas first takes
 * another size, unless the view was moved in between.
 */
@injectable()
export class InitialViewportService {
    @inject(TYPES.IActionDispatcher)
    protected readonly actionDispatcher!: IActionDispatcher;

    @inject(DiagramSurfaceHost) @optional()
    protected readonly surfaceHost?: DiagramSurfaceHost;

    /** The viewport the view waiting for its first view was set with. */
    private pending: Snapshot | undefined;

    /**
     * A first view done on an unsized frame's canvas, until that canvas first
     * takes another size: the viewport before it, and the one it gave, once
     * its action has been handled.
     */
    private shownOn: { before: Snapshot; after?: Snapshot } | undefined;

    /** How many first views were done, for the tests and the live check. */
    shown = 0;

    @postConstruct()
    protected listen(): void {
        this.surfaceHost?.onRender(root => this.check(root));
        this.surfaceHost?.onBoundsChanged(() => {
            const root = this.surfaceHost?.currentRoot();
            if (root) {
                this.check(root);
            }
        });
    }

    /**
     * A view never shown here was set with this root: give it its first view
     * once it can be right. Sprotty's empty placeholder (`NONE`) is no view.
     */
    arm(root: { type?: string; zoom?: number; scroll?: { x: number; y: number } }): void {
        if (root.type === 'NONE' || typeof root.zoom !== 'number' || !root.scroll) {
            return;
        }
        this.shownOn = undefined;
        this.pending = { zoom: root.zoom, scroll: { ...root.scroll } };
        if (!this.surfaceHost) {
            // No renders heard (a container without the base's host): as before, after two frames.
            this.later(() => this.fire());
        }
    }

    /**
     * @deprecated The first view is armed with the model's root (`arm`) and
     * done once it can be right. Kept, with its old behaviour (the first view
     * two frames from now, unconditionally), for a caller of the old name.
     */
    centerSoon(): void {
        this.later(() => {
            this.shown++;
            void this.actionDispatcher.dispatch(initialViewAction(clientBehavior().initialView));
        });
    }

    /** Whether a first view is waiting. */
    waiting(): boolean {
        return this.pending !== undefined;
    }

    /** After a render or the surface's bounds changing: is it time? */
    check(root: ViewportRoot): void {
        if (root.type === 'NONE') {
            return;
        }
        const pending = this.pending;
        if (!pending) {
            this.followCanvas(root);
            return;
        }
        if (!sameViewport(root, pending)) {
            // Moved since it was set: by the reader, or by a reveal the product asked for.
            this.pending = undefined;
            return;
        }
        if (!(root.canvasBounds.width > 0 && root.canvasBounds.height > 0)) {
            return;
        }
        if (this.surfaceHost && !this.surfaceHost.surfaceReady()) {
            return;
        }
        this.fire(root);
    }

    /**
     * A first view done on an unsized frame's canvas, at the canvas's first
     * other size: done once more, unless the view moved in between. The view
     * counts as not moved while it is where it was set, or where the first
     * view put it (not known yet: the frame is sized within a frame or two,
     * before anyone can move it).
     */
    private followCanvas(root: ViewportRoot): void {
        const shown = this.shownOn;
        const canvas = root.canvasBounds;
        if (!shown || (canvas.width === UNSIZED_FRAME.width && canvas.height === UNSIZED_FRAME.height)) {
            return;
        }
        this.shownOn = undefined;
        if (!(canvas.width > 0 && canvas.height > 0)) {
            return;
        }
        if (sameViewport(root, shown.before) || !shown.after || sameViewport(root, shown.after)) {
            this.pending = { zoom: root.zoom, scroll: { ...root.scroll } };
            this.fire();
        }
    }

    private fire(root?: ViewportRoot): void {
        const before = this.pending;
        if (!before) {
            return;
        }
        this.pending = undefined;
        const unsized = !!root && root.canvasBounds.width === UNSIZED_FRAME.width && root.canvasBounds.height === UNSIZED_FRAME.height;
        const shown = unsized ? { before } as { before: Snapshot; after?: Snapshot } : undefined;
        this.shownOn = shown;
        this.shown++;
        void Promise.resolve(this.actionDispatcher.dispatch(initialViewAction(clientBehavior().initialView))).then(() => {
            const now = this.surfaceHost?.currentRoot();
            if (shown && this.shownOn === shown && now) {
                shown.after = { zoom: now.zoom, scroll: { ...now.scroll } };
            }
        }, () => undefined);
    }

    private later(run: () => void): void {
        if (typeof requestAnimationFrame === 'function') {
            requestAnimationFrame(() => requestAnimationFrame(run));
        } else {
            setTimeout(run, 0);
        }
    }
}
