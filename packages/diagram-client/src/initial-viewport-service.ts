import { CenterAction } from '@eclipse-glsp/protocol';
import { TYPES, type IActionDispatcher } from '@eclipse-glsp/client';
import { inject, injectable } from 'inversify';

/**
 * Centers the diagram when a view is shown for the first time.
 *
 * Which views that is, is decided by `ViewportPreservingSetModelCommand`: a view
 * never shown in this editor is centered, a view navigated back to returns to
 * where it was left, and a refresh of the view shown keeps its viewport.
 */
@injectable()
export class InitialViewportService {
    constructor(
        @inject(TYPES.IActionDispatcher) private readonly actionDispatcher: IActionDispatcher
    ) {}

    /**
     * Center the diagram once it has rendered.
     *
     * Uses a double-rAF so it runs after the first paint/bounds computation,
     * when the viewport has a real size.
     */
    centerSoon(): void {
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                void this.actionDispatcher.dispatch(CenterAction.create([], { animate: false }));
            });
        });
    }
}
