import { CutOperation } from '@eclipse-glsp/protocol';
import { OperationHandler, ModelState, type Command, type MaybePromise } from '@eclipse-glsp/server';
import { inject, injectable } from 'inversify';
import * as vscode from 'vscode';
import { buildPyClipboardPayload, pyClipboardDataFromPayload } from '@dialogram/diagram-server/clipboard/py-clipboard';
import { WORKFLOW_NETWORK_MODEL_KEY } from '@dialogram/shared';
import type { WorkflowDiagramModel } from '@dialogram/shared';
import { WorkflowDiagramTypeGuards } from '@dialogram/shared';
import { ReversibleWorkspaceEditCommand } from '@dialogram/diagram-server/operations/reversible-workspace-edit-command';
import { SidecarInvoker } from './sidecar-invoker';
import { escapePythonStringLiteral } from '../python-text';

@injectable()
export class CutOperationHandler extends OperationHandler {
    readonly operationType = CutOperation.KIND;

    @inject(ModelState)
    protected override modelState!: ModelState;

    @inject(SidecarInvoker)
    protected readonly sidecar!: SidecarInvoker;

    override createCommand(operation: CutOperation): MaybePromise<Command | undefined> {
        const sourceUri = this.modelState.root.args?.['sourceUri'] as string;
        if (!sourceUri) {
            return undefined;
        }

        return this.createPythonCommand(operation, sourceUri);
    }

    private createPythonCommand(operation: CutOperation, sourceUri: string): Command | undefined {
        const elementIds = operation.editorContext?.selectedElementIds ?? [];
        if (elementIds.length === 0) {
            return undefined;
        }
        const vscodeUri = vscode.Uri.parse(sourceUri);
        const root = this.modelState.root;
        const workflowName = root.args?.['wf:workflowName'] as string | undefined;

        const command = new ReversibleWorkspaceEditCommand({
            label: 'Cut' + this.sidecar.undoLabelSuffix(),
            uri: vscodeUri,
            computeEdits: async () => {
                const beforeText = (await vscode.workspace.openTextDocument(vscodeUri)).getText();
                const payload = await buildPyClipboardPayload(this.modelState, sourceUri, elementIds);
                if (payload.items.length === 0) {
                    return undefined;
                }
                await vscode.env.clipboard.writeText(JSON.stringify(pyClipboardDataFromPayload(payload)));
                for (const item of payload.items) {
                    if (item.kind === 'entity') {
                        await this.sendSidecarOp(sourceUri, {
                            op: this.sidecar.sidecarOp('deleteNode'),
                            args: { workflow: workflowName, name: item.name }
                        });
                    } else if (item.kind === 'connection') {
                        if (!item.outPort || !item.inPort) continue;
                        const fromExpr = this.edgeEndpointExpr(item.from, item.outPort);
                        const toExpr = this.edgeEndpointExpr(item.to, item.inPort);
                        await this.sendSidecarOp(sourceUri, {
                            op: this.sidecar.sidecarOp('deleteEdge'),
                            args: { workflow: workflowName, from_expr: fromExpr, to_expr: toExpr }
                        });
                    } else if (item.kind === 'boundaryPort') {
                        await this.sendSidecarOp(sourceUri, {
                            op: this.sidecar.sidecarOp('deletePort'),
                            args: { workflow: workflowName, direction: item.direction, portName: item.portName }
                        });
                    }
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

    private edgeEndpointExpr(entityName: string | undefined, portName: string): string {
        if (entityName && entityName !== 'boundary') {
            return `${entityName}.${portName}`;
        }
        return `'${escapePythonStringLiteral(portName)}'`;
    }
}
