import { CutOperation } from '@eclipse-glsp/protocol';
import { OperationHandler, ModelState, type Command, type MaybePromise } from '@eclipse-glsp/server';
import { inject, injectable } from 'inversify';
import * as vscode from 'vscode';
import { readAuthoritativeSourceText } from './authoritative-source-text';
import { buildClipboardPayload, clipboardDataFromPayload } from '@dialogram/diagram-server/clipboard/clipboard';
import { WORKFLOW_NETWORK_MODEL_KEY } from '@dialogram/shared';
import type { WorkflowDiagramModel } from '@dialogram/shared';
import { WorkflowDiagramTypeGuards } from '@dialogram/shared';
import { ReversibleWorkspaceEditCommand } from '@dialogram/diagram-server/operations/reversible-workspace-edit-command';
import { SidecarInvoker } from './sidecar-invoker';
import { escapePythonStringLiteral } from '../python-text';
import { mayRemove } from './delete-handler';

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
        // A cut takes out what a delete of the selection would: never a
        // read-only element, and nothing of a read-only view (a transition,
        // which a delete may take out of one, the clipboard does not carry).
        // What it takes out is known before a command is made, and a cut of
        // nothing makes none; what was selected has been copied all the
        // same, by the client, before it asked to cut.
        const root = this.modelState.root;
        const elementIds = (operation.editorContext?.selectedElementIds ?? [])
            .filter(id => mayRemove(root, this.modelState.index.get(id)));
        const payload = buildClipboardPayload(this.modelState, sourceUri, elementIds);
        if (payload.items.length === 0) {
            return undefined;
        }
        const vscodeUri = vscode.Uri.parse(sourceUri);
        const workflowName = root.args?.['wf:workflowName'] as string | undefined;

        const command = new ReversibleWorkspaceEditCommand({
            label: 'Cut' + this.sidecar.undoLabelSuffix(),
            uri: vscodeUri,
            computeEdits: async () => {
                const beforeText = (await vscode.workspace.openTextDocument(vscodeUri)).getText();
                await vscode.env.clipboard.writeText(JSON.stringify(clipboardDataFromPayload(payload)));
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
