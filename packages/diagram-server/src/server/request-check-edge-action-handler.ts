import { CheckEdgeResultAction, RequestCheckEdgeAction, type Action } from '@eclipse-glsp/protocol';
import { inject, injectable, optional } from 'inversify';
import { ActionHandler, DiagramConfiguration, EdgeCreationChecker, type MaybePromise, ModelState } from '@eclipse-glsp/server';

@injectable()
export class WorkflowRequestCheckEdgeActionHandler implements ActionHandler {
    @inject(ModelState)
    protected modelState!: ModelState;

    @inject(DiagramConfiguration)
    protected diagramConfiguration!: DiagramConfiguration;

    @inject(EdgeCreationChecker)
    @optional()
    protected edgeCreationChecker?: EdgeCreationChecker;

    readonly actionKinds: string[] = [RequestCheckEdgeAction.KIND];

    execute(action: RequestCheckEdgeAction): MaybePromise<Action[]> {
        const hasDynamicHint = this.diagramConfiguration.edgeTypeHints.some(hint => hint.elementTypeId === action.edgeType && hint.dynamic);
        const { edgeType, sourceElementId, targetElementId } = action;

        const isValid = this.edgeCreationChecker && hasDynamicHint ? this.validate(action) : true;

        const mode = targetElementId ? 'source+target' : 'source-only';
        console.log('[WorkflowRequestCheckEdgeActionHandler]', {
            edgeType,
            mode,
            source: sourceElementId,
            target: targetElementId,
            isValid
        });

        return [CheckEdgeResultAction.create({ edgeType, isValid, sourceElementId, targetElementId })];
    }

    protected validate(action: RequestCheckEdgeAction): boolean {
        const sourceElement = this.modelState.index.get(action.sourceElementId);
        if (!sourceElement) {
            console.log('[WorkflowRequestCheckEdgeActionHandler] Missing source element:', action.sourceElementId);
            return false;
        }

        const targetElement = action.targetElementId ? this.modelState.index.get(action.targetElementId) : undefined;
        if (action.targetElementId && !targetElement) {
            console.log('[WorkflowRequestCheckEdgeActionHandler] Missing target element:', action.targetElementId);
            return false;
        }

        return targetElement
            ? this.edgeCreationChecker!.isValidTarget(action.edgeType, sourceElement, targetElement)
            : this.edgeCreationChecker!.isValidSource(action.edgeType, sourceElement);
    }
}
