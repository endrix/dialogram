import { Action } from '@eclipse-glsp/protocol';
import { Command, ModelState, OperationHandler } from '@eclipse-glsp/server';
import { inject, injectable } from 'inversify';
import { WorkflowDiagramMetadata } from '@dialogram/shared';

import { producerWriteCommand } from './producer-write';
import { SidecarInvoker } from './sidecar-invoker';

export namespace CreateBoundaryPortOperation {
    export const KIND = 'dialogram.createBoundaryPort';

    export interface Operation extends Action {
        kind: typeof KIND;
        direction: 'input' | 'output';
        portName: string;
        portType: string;
    }

    export function is(action: unknown): action is Operation {
        return !!action && typeof action === 'object' && (action as any).kind === KIND;
    }
}

@injectable()
export class CreateBoundaryPortOperationHandler extends OperationHandler {
    readonly operationType = CreateBoundaryPortOperation.KIND;

    @inject(ModelState)
    protected override modelState!: ModelState;

    @inject(SidecarInvoker)
    protected readonly sidecar!: SidecarInvoker;

    createCommand(operation: Action): Command | undefined {
        if (!CreateBoundaryPortOperation.is(operation)) {
            return undefined;
        }

        const sourceUri = this.modelState.sourceUri;
        if (!sourceUri) {
            return undefined;
        }

        return this.createPythonCommand(operation, sourceUri);
    }

    private createPythonCommand(operation: CreateBoundaryPortOperation.Operation, sourceUri: string): Command | undefined {
        const workflowName = this.modelState.root.args?.[WorkflowDiagramMetadata.WORKFLOW_NAME] as string | undefined;
        return producerWriteCommand({
            label: 'Create Boundary Port' + this.sidecar.undoLabelSuffix(),
            sidecar: this.sidecar,
            failed: `The ${operation.direction} port '${operation.portName}' was not added.`,
            request: () => ({
                fileUri: sourceUri,
                payload: {
                    op: this.sidecar.sidecarOp('createPort'),
                    args: {
                        workflow: workflowName,
                        direction: operation.direction,
                        portName: operation.portName,
                        portType: operation.portType || 'Any'
                    }
                }
            })
        });
    }
}
