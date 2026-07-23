import { CenterAction } from '@eclipse-glsp/protocol';
import { TYPES, type IActionDispatcher, EditorContextService } from '@eclipse-glsp/client';
import { inject, injectable } from 'inversify';

type RootArgs = {
    sourceUri?: string;
    'wf:selectedWorkflow'?: string;
    'cal:networkName'?: string;
    'wf:workflowName'?: string;
};

@injectable()
export class InitialViewportService {
    private readonly centeredKeys = new Set<string>();

    constructor(
        @inject(TYPES.IActionDispatcher) private readonly actionDispatcher: IActionDispatcher,
        @inject(EditorContextService) private readonly editorContext: EditorContextService
    ) {}

    /**
     * Center the diagram once when a workflow model is first shown.
     *
     * Uses a double-rAF so we run after the first paint/bounds computation.
     */
    maybeCenterOnInitialModel(root: unknown): void {
        const args = ((root as any)?.args ?? {}) as RootArgs;
        const sourceUri = args.sourceUri ?? this.editorContext.sourceUri;
        const workflowName = args['wf:selectedWorkflow'] ?? args['cal:networkName'] ?? args['wf:workflowName'];
        if (!sourceUri || !workflowName) {
            return;
        }

        const key = `${sourceUri}::${workflowName}`;
        if (this.centeredKeys.has(key)) {
            return;
        }
        this.centeredKeys.add(key);

        // Run after initial render so viewport has a real size.
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                void this.actionDispatcher.dispatch(CenterAction.create([], { animate: false }));
            });
        });
    }
}
