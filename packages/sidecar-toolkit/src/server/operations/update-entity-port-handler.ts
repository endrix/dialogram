import { Action } from '@eclipse-glsp/protocol';
import { Command, ModelState, OperationHandler } from '@eclipse-glsp/server';
import { inject, injectable } from 'inversify';
import * as vscode from 'vscode';
import { readAuthoritativeSourceText } from './authoritative-source-text';
import { ReversibleMultiWorkspaceEditCommand } from '@dialogram/diagram-server/operations/reversible-multi-workspace-edit-command';
import { SidecarInvoker } from './sidecar-invoker';

export namespace UpdateEntityPortOperation {
    export const KIND = 'dialogram.updateEntityPort';

    export interface Operation extends Action {
        kind: typeof KIND;
        entityType: string;
        entityDocumentUri?: string;
        portDirection: 'input' | 'output';
        portName: string;
        portElementId: string;
        field: 'name' | 'type';
        newValue: string;
    }
}

@injectable()
export class UpdateEntityPortOperationHandler extends OperationHandler {
    readonly operationType = UpdateEntityPortOperation.KIND;

    @inject(ModelState)
    protected override modelState!: ModelState;

    @inject(SidecarInvoker)
    protected readonly sidecar!: SidecarInvoker;

    createCommand(operation: Action): Command | undefined {
        if ((operation as any)?.kind !== UpdateEntityPortOperation.KIND) {
            return undefined;
        }
        const sourceUri = this.modelState.sourceUri;
        if (!sourceUri) {
            return undefined;
        }

        return this.createPythonCommand(operation as UpdateEntityPortOperation.Operation, sourceUri);
    }

    private createPythonCommand(operation: UpdateEntityPortOperation.Operation, sourceUri: string): Command | undefined {
        const command = new ReversibleMultiWorkspaceEditCommand({
            label: 'Update Port' + this.sidecar.undoLabelSuffix(),
            computeEdits: async () => {
                const entityName = String(operation.entityType ?? '').trim();
                if (!entityName) {
                    return undefined;
                }

                const beforeText = (await vscode.workspace.openTextDocument(vscode.Uri.parse(sourceUri))).getText();

                const opName = operation.field === 'name'
                    ? this.sidecar.sidecarOp('renamePort')
                    : this.sidecar.sidecarOp('updatePortType');

                const ok = await this.sendSidecarOp(sourceUri, {
                    op: opName,
                    args: {
                        entity: entityName,
                        portDirection: operation.portDirection,
                        portName: operation.portName,
                        newValue: operation.newValue
                    }
                });
                if (!ok) {
                    return undefined;
                }

                const afterText = await readAuthoritativeSourceText(vscode.Uri.parse(sourceUri));
                (command as any)._sourceBeforeText = beforeText;
                (command as any)._sourceAfterText = afterText;
                return [{ uri: vscode.Uri.parse(sourceUri), edits: [] }];
            },
        });
        return command;
    }

    private async sendSidecarOp(sourceUri: string, payload: { op: string; args: Record<string, unknown> }): Promise<boolean> {
        return this.sidecar.sendSidecarOp(sourceUri, payload);
    }
}
