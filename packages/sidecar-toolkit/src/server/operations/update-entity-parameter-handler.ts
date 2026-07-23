import { Action, Command, ModelState, OperationHandler } from '@eclipse-glsp/server';
import { inject, injectable } from 'inversify';
import * as vscode from 'vscode';
import { WorkflowDiagramMetadata } from '@dialogram/shared';

import { ReversibleWorkspaceEditCommand } from '@dialogram/diagram-server/operations/reversible-workspace-edit-command';
import { SidecarInvoker } from './sidecar-invoker';

export namespace UpdateEntityParameterOperation {
    export const KIND = 'dialogram.updateEntityParameter';

    export interface Operation extends Action {
        kind: typeof KIND;
        elementId: string;
        parameterName: string;
        newValue: string;
    }

    export function is(action: unknown): action is Operation {
        return !!action && typeof action === 'object' && (action as any).kind === KIND;
    }
}

@injectable()
export class UpdateEntityParameterOperationHandler extends OperationHandler {
    readonly operationType = UpdateEntityParameterOperation.KIND;

    @inject(ModelState)
    protected override modelState!: ModelState;

    @inject(SidecarInvoker)
    protected readonly sidecar!: SidecarInvoker;

    createCommand(operation: Action): Command | undefined {
        if (!UpdateEntityParameterOperation.is(operation)) {
            return undefined;
        }

        const sourceUri = this.modelState.sourceUri;
        if (!sourceUri) {
            return undefined;
        }

        return this.createPythonCommand(operation, sourceUri);
    }

    private createPythonCommand(operation: UpdateEntityParameterOperation.Operation, sourceUri: string): Command | undefined {
        const vscodeUri = vscode.Uri.parse(sourceUri);
        const root = this.modelState.root;
        const workflowName = root.args?.['wf:workflowName'] as string | undefined;

        const command = new ReversibleWorkspaceEditCommand({
            label: 'Update Entity Parameter' + this.sidecar.undoLabelSuffix(),
            uri: vscodeUri,
            computeEdits: async () => {
                const beforeText = (await vscode.workspace.openTextDocument(vscodeUri)).getText();
                const element: any = this.modelState.index.find(operation.elementId);
                const entityName = element?.args?.[WorkflowDiagramMetadata.ENTITY_NAME] as string | undefined;
                if (!entityName) {
                    return undefined;
                }
                const ok = await this.sendSidecarOp(sourceUri, {
                    op: this.sidecar.sidecarOp('updateNodeParameter'),
                    args: {
                        workflow: workflowName,
                        entity: entityName,
                        parameterName: operation.parameterName,
                        newValue: operation.newValue
                    }
                });
                if (!ok) {
                    return undefined;
                }
                const afterText = (await vscode.workspace.openTextDocument(vscodeUri)).getText();
                (command as any)._sourceBeforeText = beforeText;
                (command as any)._sourceAfterText = afterText;
                return [new vscode.TextEdit(new vscode.Range(0, 0, 0, 0), '')];
            },
        });
        return command;
    }

    private async sendSidecarOp(sourceUri: string, payload: { op: string; args: Record<string, unknown> }): Promise<boolean> {
        return this.sidecar.sendSidecarOp(sourceUri, payload);
    }
}
