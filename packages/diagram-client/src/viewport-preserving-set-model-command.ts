import { FeedbackAwareSetModelCommand } from '@eclipse-glsp/client';
import type { CommandExecutionContext, GModelRoot } from '@eclipse-glsp/sprotty';
import { inject, injectable, optional } from 'inversify';
import { TYPES, type IActionDispatcher } from '@eclipse-glsp/client';
import { SelectAction } from '@eclipse-glsp/protocol';
import { PostEditSelectionService } from './post-edit-selection-service';
import { WorkflowNavigationUi } from './navigation-ui';
import { InitialViewportService } from './initial-viewport-service';

type RootArgs = {
    sourceUri?: string;
    'wf:selectedWorkflow'?: string;
    'cal:networkName'?: string;
    'wf:workflowName'?: string;
};

/** One-shot guard for the always-on `firstSetModel` webview breadcrumb (see below). */
let firstSetModelLogged = false;

/**
 * Which view a model root is: its file, its workflow, and -- for a nested
 * workflow shown in place -- the instance path that reached it, so two
 * instances of one workflow are two views.
 */
export function modelViewportKey(root: unknown): string | undefined {
    const args = ((root as any)?.args ?? {}) as RootArgs & { 'wf:navTrail'?: unknown };
    const sourceUri = typeof args.sourceUri === 'string' ? args.sourceUri : undefined;
    const workflowName =
        (typeof args['wf:selectedWorkflow'] === 'string' ? args['wf:selectedWorkflow'] : undefined)
        ?? (typeof args['cal:networkName'] === 'string' ? args['cal:networkName'] : undefined)
        ?? (typeof args['wf:workflowName'] === 'string' ? args['wf:workflowName'] : undefined);
    if (!sourceUri || !workflowName) {
        return undefined;
    }
    return `${sourceUri}::${workflowName}${instancePathKey(args['wf:navTrail'])}`;
}

function instancePathKey(rawTrail: unknown): string {
    try {
        const trail = typeof rawTrail === 'string' ? JSON.parse(rawTrail) : rawTrail;
        if (!Array.isArray(trail) || trail.length < 2) {
            return '';
        }
        return '::' + trail.slice(1).map((crumb: any) => crumb?.workflowInstanceName ?? crumb?.workflowName ?? '').join('/');
    } catch {
        return '';
    }
}

/**
 * The viewport each view was last left at, so navigating back to one returns
 * to where it was -- as a browser's back does -- rather than to the default
 * scroll, which puts the graph off-center. Per webview: one editor's views.
 */
const viewportsByView = new Map<string, { zoom: number; scroll: { x: number; y: number } }>();

type Viewport = { zoom: number; scroll: { x: number; y: number } };
type ViewportRoot = { zoom?: number; scroll?: { x: number; y: number } };

/**
 * Where the new model's viewport should be, decided across a `SetModelAction`:
 *
 * - the same view refreshed (a save, a run, a live preview): kept as it is;
 * - a view navigated to that this editor showed before: back where it was left;
 * - a view never shown here: centered (returns `'center'`).
 *
 * The view left is remembered in `store` first. Sets `newRoot`'s zoom and
 * scroll in place for the first two cases.
 */
export function settleViewport(
    previousRoot: ViewportRoot,
    newRoot: ViewportRoot,
    store: Map<string, Viewport>
): 'center' | undefined {
    const previousKey = modelViewportKey(previousRoot);
    const nextKey = modelViewportKey(newRoot);
    const sameView = !!previousKey && !!nextKey && previousKey === nextKey;
    const hasViewport = (root: ViewportRoot): root is Viewport => typeof root.zoom === 'number' && !!root.scroll;

    if (sameView) {
        if (hasViewport(previousRoot) && hasViewport(newRoot)) {
            newRoot.zoom = previousRoot.zoom;
            newRoot.scroll = { ...previousRoot.scroll };
        }
        return undefined;
    }
    if (previousKey && hasViewport(previousRoot)) {
        store.set(previousKey, { zoom: previousRoot.zoom, scroll: { ...previousRoot.scroll } });
    }
    const remembered = nextKey ? store.get(nextKey) : undefined;
    if (remembered) {
        newRoot.zoom = remembered.zoom;
        newRoot.scroll = { ...remembered.scroll };
        return undefined;
    }
    return 'center';
}

/**
 * Preserves the viewport across `SetModelAction`s.
 *
 * GLSP refreshes often use `SetModelAction`, which creates a brand-new model root.
 * The default `SetModelCommand` resets viewport state (scroll/zoom) to defaults,
 * which causes the diagram to "jump" after server-driven refreshes.
 */
@injectable()
export class ViewportPreservingSetModelCommand extends FeedbackAwareSetModelCommand {
    @inject(PostEditSelectionService)
    protected readonly postEditSelection!: PostEditSelectionService;

    @inject(TYPES.IActionDispatcher)
    protected readonly actionDispatcher!: IActionDispatcher;

    // Stock-only network-navigation UI. Bound by `workflowFeaturesModule`; a
    // custom-view consumer (mlir) loads the neutral base WITHOUT that module, so
    // this stays unbound there. Optional + guarded call keeps the base module
    // self-sufficient — the viewport preservation this command exists for is
    // neutral and must boot for every consumer. Stock behaviour is unchanged:
    // when the feature module is present the binding resolves exactly as before.
    @optional()
    @inject(WorkflowNavigationUi)
    protected readonly workflowNavUi?: WorkflowNavigationUi;

    @inject(InitialViewportService)
    protected readonly initialViewport!: InitialViewportService;

    override execute(context: CommandExecutionContext): GModelRoot {
        // Always-on webview breadcrumb: first model render. `performance.now()` is ms since the
        // webview document began loading, so this is the wall-clock time to first paintable model —
        // the number that, next to `starterReady`, shows where a slow open actually spends its time.
        if (!firstSetModelLogged) {
            firstSetModelLogged = true;
            try {
                // eslint-disable-next-line no-console
                console.log(`[dialogram perf] webview: firstSetModel=${Math.round(performance.now())}ms (since page load)`);
            } catch {
                // best-effort only
            }
        }

        const previousRoot = context.root as unknown as {
            zoom?: number;
            scroll?: { x: number; y: number };
        };

        const newRoot = super.execute(context) as unknown as {
            zoom?: number;
            scroll?: { x: number; y: number };
        };

        this.workflowNavUi?.onModelChanged(newRoot);

        if (settleViewport(previousRoot, newRoot, viewportsByView) === 'center') {
            this.initialViewport.centerSoon();
        }

        const idsToSelect = this.postEditSelection.consumeMatchingIds(newRoot);
        if (idsToSelect.length > 0) {
            queueMicrotask(() => {
                void this.actionDispatcher.dispatch(SelectAction.setSelection(idsToSelect));
            });
        }

        return newRoot as unknown as GModelRoot;
    }
}
