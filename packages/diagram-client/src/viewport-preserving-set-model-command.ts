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

function modelViewportKey(root: unknown): string | undefined {
    const args = ((root as any)?.args ?? {}) as RootArgs;
    const sourceUri = typeof args.sourceUri === 'string' ? args.sourceUri : undefined;
    const workflowName =
        (typeof args['wf:selectedWorkflow'] === 'string' ? args['wf:selectedWorkflow'] : undefined)
        ?? (typeof args['cal:networkName'] === 'string' ? args['cal:networkName'] : undefined)
        ?? (typeof args['wf:workflowName'] === 'string' ? args['wf:workflowName'] : undefined);
    if (!sourceUri || !workflowName) {
        return undefined;
    }
    return `${sourceUri}::${workflowName}`;
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
        this.initialViewport.maybeCenterOnInitialModel(newRoot);

        const previousKey = modelViewportKey(previousRoot);
        const nextKey = modelViewportKey(newRoot);
        const sameWorkflowModel = !!previousKey && !!nextKey && previousKey === nextKey;

        // Preserve viewport (scroll/zoom) if present on both roots.
        // Important: do NOT carry viewport across workflow switches (e.g. parent -> child),
        // otherwise nested workflows inherit stale parent viewport framing.
        if (
            sameWorkflowModel &&
            typeof previousRoot.zoom === 'number' &&
            previousRoot.scroll &&
            typeof newRoot.zoom === 'number' &&
            newRoot.scroll
        ) {
            newRoot.zoom = previousRoot.zoom;
            newRoot.scroll = { ...previousRoot.scroll };
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
