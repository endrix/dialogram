import { Action } from '@eclipse-glsp/protocol';
import { Command, ModelState, OperationHandler } from '@eclipse-glsp/server';
import { inject, injectable } from 'inversify';
import * as vscode from 'vscode';
import { entityPortWrite } from './entity-port-write';
import { producerWriteCommand } from './producer-write';
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

    /**
     * Rename or retype the port where its entity is declared
     * (entity-port-write.ts): a rename has the connections here follow it.
     */
    private createPythonCommand(operation: UpdateEntityPortOperation.Operation, sourceUri: string): Command | undefined {
        const renames = operation.field === 'name';
        return producerWriteCommand({
            label: 'Update Port' + this.sidecar.undoLabelSuffix(),
            sidecar: this.sidecar,
            failed: renames ? `Port '${operation.portName}' was not renamed.` : `Port '${operation.portName}' kept its type.`,
            request: async () => {
                const entityName = String(operation.entityType ?? '').trim();
                if (!entityName) {
                    return undefined;
                }
                const write = await entityPortWrite(
                    this.sidecar,
                    this.modelState,
                    sourceUri,
                    { entityType: entityName, entityDocumentUri: operation.entityDocumentUri, elementId: operation.portElementId },
                    {
                        op: this.sidecar.sidecarOp(renames ? 'renamePort' : 'updatePortType'),
                        args: {
                            entity: entityName,
                            portDirection: operation.portDirection,
                            portName: operation.portName,
                            newValue: operation.newValue
                        }
                    },
                    renames
                );
                if ('refused' in write) {
                    void vscode.window.showWarningMessage(write.refused);
                    return undefined;
                }
                return write;
            }
        });
    }
}
