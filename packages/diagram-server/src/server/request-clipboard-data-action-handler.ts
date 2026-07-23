import { RequestClipboardDataAction, SetClipboardDataAction, type Action } from '@eclipse-glsp/protocol';
import { ActionHandler, ModelState, type MaybePromise } from '@eclipse-glsp/server';
import { inject, injectable } from 'inversify';
import { WORKFLOW_NETWORK_MODEL_KEY } from '@dialogram/shared';
import type { WorkflowDiagramModel } from '@dialogram/shared';
import { buildWorkflowClipboardPayload, clipboardDataFromPayload } from '../clipboard/clipboard';

@injectable()
export class WorkflowRequestClipboardDataActionHandler implements ActionHandler {
    @inject(ModelState)
    protected readonly modelState!: ModelState;

    readonly actionKinds: string[] = [RequestClipboardDataAction.KIND];

    async execute(action: RequestClipboardDataAction): Promise<Action[]> {
        const diagramModel = this.modelState.get(WORKFLOW_NETWORK_MODEL_KEY) as WorkflowDiagramModel | undefined;
        const sourceUri = this.modelState.sourceUri ?? diagramModel?.documentUri;

        if (!sourceUri) {
            return [SetClipboardDataAction.create({}, { responseId: action.requestId })];
        }

        const payload = await buildWorkflowClipboardPayload(this.modelState, sourceUri, action.editorContext.selectedElementIds);
        const clipboardData = clipboardDataFromPayload(payload);

        return [SetClipboardDataAction.create(clipboardData, { responseId: action.requestId })];
    }
}
