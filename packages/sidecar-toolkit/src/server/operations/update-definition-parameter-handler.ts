import { Action, Command, ModelState, OperationHandler } from '@eclipse-glsp/server';
import { inject, injectable } from 'inversify';
import * as vscode from 'vscode';
import { WorkflowDiagramMetadata } from '@dialogram/shared';
import { ReversibleWorkspaceEditCommand } from '@dialogram/diagram-server/operations/reversible-workspace-edit-command';
import { SidecarInvoker } from './sidecar-invoker';

const MAX_PARAMETER_TEXT_LENGTH = 4096;

export namespace UpdateDefinitionParameterOperation {
    export const KIND = 'dialogram.updateDefinitionParameter';

    export type UpdateAction = 'upsert' | 'remove';

    export interface Operation extends Action {
        kind: typeof KIND;
        elementId: string;
        action: UpdateAction;
        parameterName: string;
        parameterText?: string;
    }

    export function is(action: unknown): action is Operation {
        return !!action && typeof action === 'object' && (action as any).kind === KIND;
    }
}

@injectable()
export class UpdateDefinitionParameterOperationHandler extends OperationHandler {
    readonly operationType = UpdateDefinitionParameterOperation.KIND;

    @inject(ModelState)
    protected override modelState!: ModelState;

    @inject(SidecarInvoker)
    protected readonly sidecar!: SidecarInvoker;

    createCommand(operation: Action): Command | undefined {
        if (!UpdateDefinitionParameterOperation.is(operation)) {
            return undefined;
        }

        const sourceUri = this.modelState.sourceUri;
        if (!sourceUri) {
            return undefined;
        }

        return this.createPythonCommand(operation, sourceUri);
    }

    private createPythonCommand(operation: UpdateDefinitionParameterOperation.Operation, sourceUri: string): Command | undefined {
        const element: any = this.modelState.index.find(operation.elementId);
        const args: any = element?.args ?? {};
        // A parameterized network's parameters live in its factory function
        // (`def make_top(...)`), whose name differs from the network name that
        // ENTITY_TYPE carries — so prefer the factory name when it's present.
        const entityType = ((args[WorkflowDiagramMetadata.NETWORK_FACTORY_NAME] as string | undefined)
            ?? (args[WorkflowDiagramMetadata.ENTITY_TYPE] as string | undefined)
            ?? '');
        const defName = unqualifyName(entityType);
        if (!defName) {
            void vscode.window.showErrorMessage('Cannot determine which definition to update.');
            return undefined;
        }
        if (operation.action !== 'upsert') {
            void vscode.window.showErrorMessage('Removing definition parameters is not supported yet.');
            return undefined;
        }
        if ((operation.parameterText?.length ?? 0) > MAX_PARAMETER_TEXT_LENGTH) {
            void vscode.window.showErrorMessage('Parameter text is too large to apply safely.');
            return undefined;
        }

        const vscodeUri = vscode.Uri.parse(sourceUri);

        const command = new ReversibleWorkspaceEditCommand({
            label: 'Update Definition Parameter',
            uri: vscodeUri,
            computeEdits: async () => {
                const beforeText = (await vscode.workspace.openTextDocument(vscodeUri)).getText();
                const ok = await this.sendSidecarOp(sourceUri, {
                    op: this.sidecar.sidecarOp('updateDefinitionParameter'),
                    args: {
                        entityType: defName,
                        parameterName: operation.parameterName,
                        parameterText: operation.parameterText ?? ''
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

function unqualifyName(name: string): string {
    const afterDots = name.split('.').pop() ?? name;
    const parts = afterDots.split('__');
    return parts.length > 0 ? (parts[parts.length - 1] ?? '') : afterDots;
}
