import { EditorContextService, IActionDispatcher, TYPES } from '@eclipse-glsp/client';
import type { GModelElement, SEdgeImpl } from '@eclipse-glsp/client';
import { Action, IActionHandler, MoveAction } from '@eclipse-glsp/sprotty';
import { inject, injectable } from 'inversify';
import { WorkflowDiagramTypes } from '@dialogram/shared';
import { WorkflowRerouteEdgesAvoidOverlapsOperation } from './editing-action-handlers';

type ModelIndexLike = {
    getById?: (id: string) => any;
    get?: (id: string) => any;
    all?: () => Iterable<any>;
};

function getById(index: ModelIndexLike | undefined, id: string): any | undefined {
    return (typeof index?.getById === 'function' ? index.getById(id) : undefined)
        ?? (typeof index?.get === 'function' ? index.get(id) : undefined);
}

function isNodeElement(el: any): boolean {
    return typeof el?.type === 'string' && el.type.startsWith('node:');
}

function isPortElement(el: any): boolean {
    const t = el?.type as string | undefined;
    return t === WorkflowDiagramTypes.PORT_INPUT || t === WorkflowDiagramTypes.PORT_OUTPUT;
}

function findParentNodeId(el: any): string | undefined {
    let cur = el;
    while (cur) {
        const t = cur.type as string | undefined;
        if (typeof t === 'string' && t.startsWith('node:') && typeof cur.id === 'string') {
            return cur.id;
        }
        cur = cur.parent;
    }
    return undefined;
}

function nowMs(): number {
    // performance.now() exists in webview, but Date.now is fine here.
    return Date.now();
}

const edgeDragActiveUntilMs = new Map<string, number>();

// A "drag session" is detected heuristically (MoveAction stream). While active, we keep
// a set of incident edges so the view can freeze non-incident edges to their last stable route.
const dragActiveUntilMs = new Map<string, number>();
const dragIncidentEdgeIds = new Map<string, Set<string>>();

function getDragKey(root: Readonly<GModelElement>): string {
    // Root id should be stable within a diagram.
    const id = (root as any)?.id;
    return typeof id === 'string' ? id : '__root__';
}

export function isAnyDragActive(root: Readonly<GModelElement> | undefined): boolean {
    if (!root) return false;
    const key = getDragKey(root);
    const until = dragActiveUntilMs.get(key);
    return typeof until === 'number' && until > nowMs();
}

export function isIncidentEdgeInActiveDrag(root: Readonly<GModelElement> | undefined, edgeId: string): boolean {
    if (!root || typeof edgeId !== 'string') return false;
    const key = getDragKey(root);
    const until = dragActiveUntilMs.get(key);
    if (typeof until !== 'number' || until <= nowMs()) {
        return false;
    }
    const set = dragIncidentEdgeIds.get(key);
    return !!set && set.has(edgeId);
}

export function isDragActiveForEdge(edgeId: string): boolean {
    const until = edgeDragActiveUntilMs.get(edgeId);
    return typeof until === 'number' && until > nowMs();
}

function markDragActive(edgeId: string, ttlMs: number): void {
    edgeDragActiveUntilMs.set(edgeId, nowMs() + ttlMs);
}

function markAnyDragActive(root: Readonly<GModelElement>, ttlMs: number): void {
    dragActiveUntilMs.set(getDragKey(root), nowMs() + ttlMs);
}

function setIncidentEdgesForDrag(root: Readonly<GModelElement>, edgeIds: Set<string>): void {
    dragIncidentEdgeIds.set(getDragKey(root), edgeIds);
}

@injectable()
export class WorkflowElkLiveDragRouter implements IActionHandler {
    @inject(EditorContextService)
    protected readonly editorContextService!: EditorContextService;

    @inject(TYPES.IActionDispatcher)
    protected readonly actionDispatcher!: IActionDispatcher;

    private pendingMovedElementIds = new Set<string>();
    private pendingMovedPositions = new Map<string, { x: number; y: number }>();

    private dispatchPendingEdgeIds = new Set<string>();
    private dispatchPendingMovedElements = new Map<string, { x: number; y: number }>();
    private dispatchInFlight = false;
    private dispatchNeedsAnotherFlush = false;
    private forceNonPreviewFlush = false;

    // If the preview flush drains the queue, a later non-preview flush can end up with
    // nothing to send. Track the most recent dispatch payload so we can still persist
    // the final route on drag end.
    private lastDispatchedEdgeIds: string[] = [];

    private dragEndTimer: ReturnType<typeof setTimeout> | undefined;

    handle(action: Action): void {
        if (action.kind !== MoveAction.KIND) {
            return;
        }

        const root = this.editorContextService.modelRoot as unknown as Readonly<GModelElement> | undefined;
        if (!root) {
            return;
        }

        const moves: Array<{ elementId?: string; toPosition?: { x?: number; y?: number } }> = Array.isArray((action as any).moves)
            ? (action as any).moves
            : [];

        for (const move of moves) {
            const id = move?.elementId;
            if (typeof id !== 'string' || id.length === 0) {
                continue;
            }
            this.pendingMovedElementIds.add(id);

            const to = move?.toPosition;
            const x = Number((to as any)?.x);
            const y = Number((to as any)?.y);
            if (Number.isFinite(x) && Number.isFinite(y)) {
                this.pendingMovedPositions.set(id, { x, y });
            }
        }

        if (this.pendingMovedElementIds.size === 0) {
            return;
        }

        // Mark a global "drag active" window. We refresh this on every MoveAction.
        // Keep this comfortably above our "quiet" timer so we don't accidentally
        // treat brief pauses mid-drag as a drag end.
        markAnyDragActive(root, 650);

        // Schedule a final reroute shortly after the MoveAction stream goes quiet.
        if (this.dragEndTimer) {
            clearTimeout(this.dragEndTimer);
        }
        this.dragEndTimer = setTimeout(() => {
            void this.flushPendingReroute(false);
        }, 700);

        // If this MoveAction marks the end of the drag, reroute right after release.
        if ((action as any).finished === true) {
            // Cancel the quiet-timer fallback armed above — otherwise it fires a
            // SECOND, redundant reroute ~700ms later, making the edges visibly
            // shift again well after the drag ended (the "slow edge change"). The
            // mouse-up reroute below is the authoritative one.
            if (this.dragEndTimer) {
                clearTimeout(this.dragEndTimer);
                this.dragEndTimer = undefined;
            }
            // Delay slightly so the server has a chance to process the final ChangeBounds.
            // Important: final reroute must be based on authoritative positions, not on
            // transient drag coordinates (which breaks ESC cancel and can leave bendpoints behind).
            setTimeout(() => {
                void this.flushPendingReroute(false);
            }, 60);
        }

        // Preview rerouting is disabled; compute incident edges once on drag-end/quiet.
    }

    private collectIncidentEdgesFromMovedElements(
        root: Readonly<GModelElement>,
        movedElementIds: Set<string>,
        movedPositions: Map<string, { x: number; y: number }>
    ): { incidentEdgeIds: Set<string>; movedElements: Map<string, { x: number; y: number }> } {
        const incidentEdgeIds = new Set<string>();
        const movedElements = new Map<string, { x: number; y: number }>();

        const index: ModelIndexLike | undefined = (root as any)?.index;
        if (!index || typeof index.all !== 'function') {
            return { incidentEdgeIds, movedElements };
        }

        const movedNodeIds = new Set<string>();
        const movedPortIds = new Set<string>();
        for (const id of movedElementIds) {
            const el = getById(index, id);
            if (!el) {
                continue;
            }
            if (isNodeElement(el)) {
                movedNodeIds.add(id);
            } else if (isPortElement(el)) {
                movedPortIds.add(id);
            } else {
                continue;
            }

            const pos = movedPositions.get(id);
            if (pos) {
                movedElements.set(id, pos);
            }
        }

        if (movedNodeIds.size === 0 && movedPortIds.size === 0) {
            return { incidentEdgeIds, movedElements };
        }

        const edges: SEdgeImpl[] = [];
        for (const el of index.all()) {
            const t = (el as any)?.type as string | undefined;
            if (typeof t === 'string' && t.startsWith('edge:')) {
                edges.push(el as any);
            }
        }

        for (const edge of edges) {
            const sourceId: string | undefined = (edge as any).sourceId;
            const targetId: string | undefined = (edge as any).targetId;
            if (typeof sourceId !== 'string' || typeof targetId !== 'string') {
                continue;
            }

            const sourcePort = getById(index, sourceId);
            const targetPort = getById(index, targetId);
            if (!sourcePort || !targetPort || !isPortElement(sourcePort) || !isPortElement(targetPort)) {
                continue;
            }

            const sourceNodeId = findParentNodeId(sourcePort);
            const targetNodeId = findParentNodeId(targetPort);
            if (!sourceNodeId || !targetNodeId) {
                continue;
            }

            const incident =
                movedNodeIds.has(sourceNodeId)
                || movedNodeIds.has(targetNodeId)
                || movedPortIds.has(sourceId)
                || movedPortIds.has(targetId);
            if (!incident) {
                continue;
            }

            incidentEdgeIds.add(edge.id);
        }

        return { incidentEdgeIds, movedElements };
    }

    private queuePendingSessionReroute(root: Readonly<GModelElement>): void {
        if (this.pendingMovedElementIds.size === 0) {
            return;
        }

        const movedIds = new Set(this.pendingMovedElementIds);
        const movedPositions = new Map(this.pendingMovedPositions);
        this.pendingMovedElementIds.clear();
        this.pendingMovedPositions.clear();

        const { incidentEdgeIds, movedElements } = this.collectIncidentEdgesFromMovedElements(root, movedIds, movedPositions);
        if (incidentEdgeIds.size === 0) {
            return;
        }

        // Publish incident edges for this drag session so view logic can react if needed.
        setIncidentEdgesForDrag(root, incidentEdgeIds);

        // Also mark each incident edge as "drag active" for a short time window.
        // This survives model root refreshes that may change root ids on drop.
        for (const id of incidentEdgeIds) {
            markDragActive(id, 1200);
        }

        this.queueServerReroute(incidentEdgeIds, movedElements);
    }

    private queueServerReroute(edgeIds: Set<string>, movedElements?: Map<string, { x: number; y: number }>): void {
        if (!edgeIds || edgeIds.size === 0) {
            return;
        }
        for (const id of edgeIds) {
            if (typeof id === 'string' && id.length > 0) {
                this.dispatchPendingEdgeIds.add(id);
            }
        }
        if (movedElements) {
            for (const [id, pos] of movedElements) {
                this.dispatchPendingMovedElements.set(id, pos);
            }
        }
        // Intentionally do not dispatch preview reroutes on every drag frame.
        // We queue incident edges and flush once after drag-end/quiet to avoid
        // unstable comb/knot artifacts in dense fan-in/fan-out areas.
    }

    private async flushPendingReroute(preview: boolean): Promise<void> {
        const root = this.editorContextService.modelRoot as unknown as Readonly<GModelElement> | undefined;
        if (root) {
            this.queuePendingSessionReroute(root);
        }

        // If the drag ends (or MoveAction.finished fired), we must eventually send a non-preview
        // reroute so the final route is persisted and matches what the user sees.
        if (!preview) {
            this.forceNonPreviewFlush = true;
        }

        if (this.dispatchInFlight) {
            // Don't drop queued reroutes while the server is busy. We'll flush again after the
            // in-flight dispatch completes.
            this.dispatchNeedsAnotherFlush = true;
            return;
        }

        let edgeIds = Array.from(this.dispatchPendingEdgeIds);
        let movedElements = Array.from(this.dispatchPendingMovedElements.entries()).map(([elementId, position]) => ({
            elementId,
            position: { x: position.x, y: position.y }
        }));

        // If we owe a final (non-preview) flush but the preview dispatch already drained
        // the queue, reuse the most recent payload so the server persists routes.
        if (edgeIds.length === 0 && this.forceNonPreviewFlush && this.lastDispatchedEdgeIds.length > 0) {
            edgeIds = Array.from(this.lastDispatchedEdgeIds);
            movedElements = [];
        }

        if (edgeIds.length === 0) {
            if (!preview) {
                this.forceNonPreviewFlush = false;
                this.lastDispatchedEdgeIds = [];
            }
            return;
        }

        // Drain the queue. If dispatch fails, we re-queue below.
        this.dispatchPendingEdgeIds.clear();
        this.dispatchPendingMovedElements.clear();

        const effectivePreview = preview && !this.forceNonPreviewFlush;

        // Never send transient drag coordinates in the final (non-preview) reroute.
        // The server should reroute based on its current model (after ChangeBounds / cancel).
        if (!effectivePreview) {
            movedElements = [];
        }

        this.dispatchInFlight = true;
        try {
            await this.actionDispatcher.dispatch(
                WorkflowRerouteEdgesAvoidOverlapsOperation.create({
                    elementIds: edgeIds,
                    movedElements: effectivePreview && movedElements.length > 0 ? movedElements : undefined,
                    preview: effectivePreview
                }) as any
            );

            // Remember payload for potential later non-preview flush.
            this.lastDispatchedEdgeIds = Array.from(edgeIds);

            if (!effectivePreview) {
                // We've sent the required final (persistent) update.
                this.forceNonPreviewFlush = false;
                this.pendingMovedElementIds.clear();
                this.pendingMovedPositions.clear();
                this.lastDispatchedEdgeIds = [];
            }
        } catch (e) {
            // Re-queue so we can retry on the next tick; avoids getting stuck with stale routes.
            for (const id of edgeIds) {
                this.dispatchPendingEdgeIds.add(id);
            }
            for (const me of movedElements) {
                this.dispatchPendingMovedElements.set(me.elementId, me.position);
            }
            throw e;
        } finally {
            this.dispatchInFlight = false;

            // If anything queued up while we were in-flight, flush again ASAP.
            if (this.dispatchPendingEdgeIds.size > 0 || this.dispatchNeedsAnotherFlush || this.forceNonPreviewFlush) {
                this.dispatchNeedsAnotherFlush = false;
                // Flush on next macrotask; keeps UI responsive and coalesces bursts.
                setTimeout(() => {
                    void this.flushPendingReroute(false);
                }, 0);
            }
        }
    }
}
