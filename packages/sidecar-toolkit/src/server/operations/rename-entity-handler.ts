import { Action, Command, ModelState, OperationHandler } from '@eclipse-glsp/server';
import { inject, injectable } from 'inversify';
import { URI } from 'vscode-uri';
import * as vscode from 'vscode';
import { WORKFLOW_NETWORK_MODEL_KEY, WorkflowDiagramMetadata, WorkflowDiagramTypes } from '@dialogram/shared';
import { LayoutPersistenceService } from '@dialogram/diagram-server/services/layout-persistence-service';

import { producerWriteCommand } from './producer-write';
import { SidecarInvoker } from './sidecar-invoker';

export namespace RenameEntityOperation {
    export const KIND = 'dialogram.renameEntity';

    export interface Operation extends Action {
        kind: typeof KIND;
        elementId: string;
        newName: string;
    }

    export function is(action: unknown): action is Operation {
        return !!action && typeof action === 'object' && (action as any).kind === KIND;
    }
}

@injectable()
export class RenameEntityOperationHandler extends OperationHandler {
    readonly operationType = RenameEntityOperation.KIND;

    @inject(ModelState)
    protected override modelState!: ModelState;

    @inject(LayoutPersistenceService)
    protected readonly layoutPersistence!: LayoutPersistenceService;

    @inject(SidecarInvoker)
    protected readonly sidecar!: SidecarInvoker;

    private lastRename?: { oldName: string; newName: string; sourceUri: string; workflowName?: string };

    createCommand(operation: Action): Command | undefined {
        if (!RenameEntityOperation.is(operation)) {
            return undefined;
        }

        const sourceUri = this.modelState.sourceUri;
        if (!sourceUri) {
            return undefined;
        }

        return this.createPythonCommand(operation, sourceUri);
    }

    private createPythonCommand(operation: RenameEntityOperation.Operation, sourceUri: string): Command | undefined {
        const vscodeUri = vscode.Uri.parse(sourceUri);
        const root = this.modelState.root;
        const workflowName = root.args?.['wf:workflowName'] as string | undefined;

        // The producer writes the rename; undo puts back the file it wrote.
        const element: any = this.modelState.index.find(operation.elementId);
        const shownName = element?.args?.[WorkflowDiagramMetadata.ENTITY_NAME] as string | undefined;
        // This rename's names: the layout follows them forward, and back on undo.
        let rename: { oldName: string; newName: string; sourceUri: string; workflowName?: string } | undefined;
        return producerWriteCommand({
            label: 'Rename' + this.sidecar.undoLabelSuffix(),
            sidecar: this.sidecar,
            failed: `'${shownName ?? operation.elementId}' was not renamed.`,
            request: () => {
                const entityName = shownName;
                if (!entityName) {
                    return undefined;
                }
                rename = {
                    oldName: entityName,
                    newName: operation.newName,
                    sourceUri,
                    workflowName
                };
                return {
                    fileUri: vscodeUri.toString(),
                    payload: {
                        op: this.sidecar.sidecarOp('renameNode'),
                        args: { workflow: workflowName, old: entityName, new: operation.newName }
                    }
                };
            },
            afterApply: async phase => {
                this.lastRename = rename;
                const renameInfo = rename && (phase === 'undo'
                    ? { ...rename, oldName: rename.newName, newName: rename.oldName }
                    : rename);
                if (renameInfo?.oldName && renameInfo.newName) {
                    try {
                        const networkId = renameInfo.workflowName && renameInfo.workflowName.trim() !== ''
                            ? renameInfo.workflowName.trim()
                            : renameInfo.oldName;
                        await this.layoutPersistence.renameNode(
                            URI.parse(renameInfo.sourceUri).fsPath,
                            networkId,
                            renameInfo.oldName,
                            renameInfo.newName
                        );
                        // A nested view in place keeps its layout per instance,
                        // in the root's store: the node is renamed there too.
                        const diagramModel = this.modelState.get(WORKFLOW_NETWORK_MODEL_KEY) as any;
                        const target = diagramModel?.layoutTarget as { filePath: string; networkId: string } | undefined;
                        if (
                            target
                            && (target.filePath !== URI.parse(renameInfo.sourceUri).fsPath || target.networkId !== networkId)
                        ) {
                            await this.layoutPersistence.renameNode(
                                target.filePath,
                                target.networkId,
                                renameInfo.oldName,
                                renameInfo.newName
                            );
                        }
                    } catch {
                        // Ignore layout migration errors; rename already applied.
                    }
                }
            }
        });
    }

}
