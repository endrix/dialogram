import { PasteOperation } from '@eclipse-glsp/protocol';
import { OperationHandler, ModelState, type Command, type MaybePromise } from '@eclipse-glsp/server';
import { inject, injectable } from 'inversify';
import * as vscode from 'vscode';
import { readAuthoritativeSourceText } from './authoritative-source-text';
import { nextFreeName, WORKFLOW_NETWORK_MODEL_KEY } from '@dialogram/shared';
import type { WorkflowDiagramModel } from '@dialogram/shared';
import { ReversibleWorkspaceEditCommand } from '@dialogram/diagram-server/operations/reversible-workspace-edit-command';
import { parseClipboardPayload } from '@dialogram/diagram-server/clipboard/clipboard';
import { SidecarInvoker } from './sidecar-invoker';

@injectable()
export class PasteOperationHandler extends OperationHandler {
    @inject(ModelState)
    protected override modelState!: ModelState;

    @inject(SidecarInvoker)
    protected readonly sidecar!: SidecarInvoker;

    override operationType = PasteOperation.KIND;

    override createCommand(operation: PasteOperation): MaybePromise<Command | undefined> {
        const diagramModel = this.modelState.get(WORKFLOW_NETWORK_MODEL_KEY) as WorkflowDiagramModel | undefined;
        const sourceUri = this.modelState.sourceUri ?? diagramModel?.documentUri;
        if (!diagramModel || !sourceUri) {
            return undefined;
        }

        const vscodeUri = vscode.Uri.parse(sourceUri);

        const command = new ReversibleWorkspaceEditCommand({
            label: 'Paste',
            uri: vscodeUri,
            computeEdits: () => this.computeEdits(operation, diagramModel, command, sourceUri),
        });
        return command;
    }

    protected async computeEdits(
        operation: PasteOperation,
        diagramModel: WorkflowDiagramModel,
        command: ReversibleWorkspaceEditCommand,
        sourceUri: string,
    ): Promise<vscode.TextEdit[] | undefined> {
        const payload = parseClipboardPayload(operation.clipboardData as Record<string, string> | undefined);
        if (!payload || payload.items.length === 0) {
            void vscode.window.showWarningMessage('The clipboard holds no diagram elements to paste.');
            return undefined;
        }
        const workflowName = this.modelState.root.args?.['wf:workflowName'] as string | undefined;
        const takenResp = await this.sendSidecarList(sourceUri, {
            op: this.sidecar.sidecarOp('listInstanceNames'),
            args: { workflow: workflowName }
        });
        const taken = new Set((takenResp?.diagnostic?.names as string[] | undefined) ?? []);
        const beforeText = (await vscode.workspace.openTextDocument(vscode.Uri.parse(sourceUri))).getText();
        // A pasted connection joins the pasted copies, not the entities it was copied from.
        const renamed = new Map<string, string>();
        for (const item of payload.items) {
            if (item.kind === 'entity') {
                const name = nextFreeName(item.name, taken);
                taken.add(name);
                renamed.set(item.name, name);
                await this.sendSidecarOp(sourceUri, {
                    op: this.sidecar.sidecarOp('createNode'),
                    args: { workflow: workflowName, type: item.typeName, name }
                });
            } else if (item.kind === 'boundaryPort') {
                await this.sendSidecarOp(sourceUri, {
                    op: this.sidecar.sidecarOp('createPort'),
                    args: { workflow: workflowName, direction: item.direction, portName: item.portName, portType: item.portType ?? 'Any' }
                });
            } else if (item.kind === 'connection') {
                if (!item.outPort || !item.inPort) continue;
                const fromPort = item.from
                    ? { type: 'actor', actor: renamed.get(item.from) ?? item.from, port: item.outPort }
                    : { type: 'workflow', name: item.outPort };
                const toPort = item.to
                    ? { type: 'actor', actor: renamed.get(item.to) ?? item.to, port: item.inPort }
                    : { type: 'workflow', name: item.inPort };
                await this.sendSidecarOp(sourceUri, {
                    op: this.sidecar.sidecarOp('connect'),
                    args: { workflow: workflowName, from_port: fromPort, to_port: toPort }
                });
            }
        }
        const afterText = await readAuthoritativeSourceText(vscode.Uri.parse(sourceUri));
        (command as any)._sourceBeforeText = beforeText;
        (command as any)._sourceAfterText = afterText;
        return [new vscode.TextEdit(new vscode.Range(0, 0, 0, 0), '')];
    }

    private async sendSidecarOp(sourceUri: string, payload: { op: string; args: Record<string, unknown> }): Promise<boolean> {
        return this.sidecar.sendSidecarOp(sourceUri, payload);
    }

    private async sendSidecarList(sourceUri: string, payload: { op: string; args: Record<string, unknown> }): Promise<any | undefined> {
        return this.sidecar.sendSidecarList(sourceUri, payload);
    }
}
