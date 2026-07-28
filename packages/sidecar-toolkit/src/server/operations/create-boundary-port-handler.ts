import { Action } from '@eclipse-glsp/protocol';
import { Command, ModelState, OperationHandler } from '@eclipse-glsp/server';
import { inject, injectable } from 'inversify';
import * as vscode from 'vscode';
import { readAuthoritativeSourceText } from './authoritative-source-text';
import { WorkflowDiagramMetadata } from '@dialogram/shared';

import { ReversibleWorkspaceEditCommand } from '@dialogram/diagram-server/operations/reversible-workspace-edit-command';
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
        const vscodeUri = vscode.Uri.parse(sourceUri);
        const root = this.modelState.root;
        const workflowName = root.args?.[WorkflowDiagramMetadata.WORKFLOW_NAME] as string | undefined;
        const command = new ReversibleWorkspaceEditCommand({
            label: 'Create Boundary Port' + this.sidecar.undoLabelSuffix(),
            uri: vscodeUri,
            computeEdits: async () => {
                const beforeText = (await vscode.workspace.openTextDocument(vscodeUri)).getText();
                const ok = await this.sendSidecarOp(sourceUri, {
                    op: this.sidecar.sidecarOp('createPort'),
                    args: {
                        workflow: workflowName,
                        direction: operation.direction,
                        portName: operation.portName,
                        portType: operation.portType || 'Any'
                    }
                });
                if (!ok) {
                    return undefined;
                }
                const afterText = await readAuthoritativeSourceText(vscodeUri);
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
