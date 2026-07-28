import { DeleteElementOperation } from '@eclipse-glsp/protocol';
import { OperationHandler, MaybePromise, Action, ModelState, Command } from '@eclipse-glsp/server';
import { inject, injectable } from 'inversify';
import * as vscode from 'vscode';
import { readAuthoritativeSourceText } from './authoritative-source-text';
import { WORKFLOW_NETWORK_MODEL_KEY } from '@dialogram/shared';
import { WorkflowDiagramMetadata, WorkflowDiagramTypeGuards, WorkflowDiagramTypes } from '@dialogram/shared';

import { ReversibleWorkspaceEditCommand } from '@dialogram/diagram-server/operations/reversible-workspace-edit-command';
import { SidecarInvoker } from './sidecar-invoker';
import { escapePythonStringLiteral } from '../python-text';

@injectable()
export class DeleteElementOperationHandler extends OperationHandler {
    readonly operationType = DeleteElementOperation.KIND;

    @inject(ModelState)
    protected override modelState!: ModelState;

    @inject(SidecarInvoker)
    protected readonly sidecar!: SidecarInvoker;

    constructor() {
        super();
    }

    createCommand(operation: Action): Command | undefined {
        const sourceUri = this.modelState.root.args?.['sourceUri'] as string;
        if (!sourceUri) {
            return undefined;
        }

        return this.createPythonCommand(operation as DeleteElementOperation, sourceUri);
    }

    private createPythonCommand(operation: DeleteElementOperation, sourceUri: string): Command | undefined {
        const elementIds = operation.elementIds ?? [];
        if (elementIds.length === 0) {
            return undefined;
        }

        const vscodeUri = vscode.Uri.parse(sourceUri);
        const root = this.modelState.root;
        const workflowName = root.args?.['wf:workflowName'] as string | undefined;

        const command = new ReversibleWorkspaceEditCommand({
            label: 'Delete' + this.sidecar.undoLabelSuffix(),
            uri: vscodeUri,
            computeEdits: async () => {
                const beforeText = (await vscode.workspace.openTextDocument(vscodeUri)).getText();
                for (const id of elementIds) {
                    const gmodelElement = this.modelState.index.get(id);
                    if (gmodelElement) {
                        const elementType = (gmodelElement as any).type as string;
                        const elementArgs = (gmodelElement as any).args as Record<string, unknown> | undefined;
                        if (WorkflowDiagramTypeGuards.isReadOnlyElement(elementType, elementArgs)) {
                            continue;
                        }
                    }

                    const element = this.modelState.index.get(id) as any;
                    const elementArgs = element?.args as Record<string, unknown> | undefined;
                    const elementType = element?.type as string | undefined;

                    if (elementType && (elementType.startsWith('node:') || elementType.startsWith('node ')) && elementArgs?.[WorkflowDiagramMetadata.ENTITY_NAME]) {
                        const ok = await this.sendSidecarOp(sourceUri, {
                            op: this.sidecar.sidecarOp('deleteNode'),
                            args: { workflow: workflowName, name: elementArgs[WorkflowDiagramMetadata.ENTITY_NAME] }
                        });
                        if (!ok) return undefined;
                        continue;
                    }

                    if (elementType === WorkflowDiagramTypes.EDGE_CONNECTION && elementArgs) {
                        const fromName = elementArgs['wf:from'] as string | undefined;
                        const toName = elementArgs['wf:to'] as string | undefined;
                        const outPort = elementArgs['wf:outPort'] as string | undefined;
                        const inPort = elementArgs['wf:inPort'] as string | undefined;
                        if (!outPort || !inPort) continue;
                        const fromExpr = this.edgeEndpointExpr(fromName, outPort);
                        const toExpr = this.edgeEndpointExpr(toName, inPort);
                        const ok = await this.sendSidecarOp(sourceUri, {
                            op: this.sidecar.sidecarOp('deleteEdge'),
                            args: { workflow: workflowName, from_expr: fromExpr, to_expr: toExpr }
                        });
                        if (!ok) return undefined;
                        continue;
                    }

                    if (elementType && elementType.startsWith('port:') && elementArgs) {
                        const portName = elementArgs[WorkflowDiagramMetadata.PORT_NAME] as string | undefined;
                        const portDirection = elementArgs[WorkflowDiagramMetadata.PORT_DIRECTION] as string | undefined;
                        if (portName && portDirection) {
                            const ok = await this.sendSidecarOp(sourceUri, {
                                op: this.sidecar.sidecarOp('deletePort'),
                                args: { workflow: workflowName, direction: portDirection, portName }
                            });
                            if (!ok) return undefined;
                        }
                        continue;
                    }
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

    private edgeEndpointExpr(entityName: string | undefined, portName: string): string {
        if (entityName && entityName !== 'boundary') {
            return `${entityName}.${portName}`;
        }
        return `'${escapePythonStringLiteral(portName)}'`;
    }
}
