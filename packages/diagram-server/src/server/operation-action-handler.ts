import type { Action, MaybePromise, Operation } from '@eclipse-glsp/protocol';
import { CreateEdgeOperation } from '@eclipse-glsp/protocol';
import { inject, injectable } from 'inversify';
import { OperationActionHandler } from '@eclipse-glsp/server';
import { Operations } from '@eclipse-glsp/server';

@injectable()
export class WorkflowOperationActionHandler extends OperationActionHandler {
    constructor(@inject(Operations) actionKinds: string[]) {
        super(actionKinds);
    }

    override execute(action: Operation): MaybePromise<Action[]> {
        if (action.kind === CreateEdgeOperation.KIND) {
            const op = action as CreateEdgeOperation;
            console.log('[WorkflowOperationActionHandler] createEdge received', {
                elementTypeId: op.elementTypeId,
                sourceElementId: op.sourceElementId,
                targetElementId: op.targetElementId
            });
        } else {
            console.log('[WorkflowOperationActionHandler] operation received', { kind: action.kind });
        }

        return super.execute(action);
    }
}
