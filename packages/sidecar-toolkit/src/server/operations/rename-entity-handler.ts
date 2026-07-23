import { Action, Command, ModelState, OperationHandler } from '@eclipse-glsp/server';
import { inject, injectable } from 'inversify';
import { URI } from 'vscode-uri';
import * as vscode from 'vscode';
import { WorkflowDiagramMetadata, WorkflowDiagramTypes } from '@dialogram/shared';
import { LayoutPersistenceService } from '@dialogram/diagram-server/services/layout-persistence-service';

import { ReversibleMultiWorkspaceEditCommand } from '@dialogram/diagram-server/operations/reversible-multi-workspace-edit-command';
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

        return new ReversibleMultiWorkspaceEditCommand({
            label: 'Rename' + this.sidecar.undoLabelSuffix(),
            computeEdits: async () => {
                const element: any = this.modelState.index.find(operation.elementId);
                const entityName = element?.args?.[WorkflowDiagramMetadata.ENTITY_NAME] as string | undefined;
                if (!entityName) {
                    return undefined;
                }
                this.lastRename = {
                    oldName: entityName,
                    newName: operation.newName,
                    sourceUri,
                    workflowName
                };

                const ok = await this.sendSidecarOp(sourceUri, {
                    op: this.sidecar.sidecarOp('renameNode'),
                    args: { workflow: workflowName, old: entityName, new: operation.newName }
                });
                if (!ok) {
                    return undefined;
                }

                return [{ uri: vscodeUri, edits: [] }];
            },
            afterApply: async () => {
                const renameInfo = this.lastRename;
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
                    } catch {
                        // Ignore layout migration errors; rename already applied.
                    }
                }
            }
        });
    }

    private async sendSidecarOp(sourceUri: string, payload: { op: string; args: Record<string, unknown> }): Promise<boolean> {
        return this.sidecar.sendSidecarOp(sourceUri, payload);
    }
}
