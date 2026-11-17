import { PasteOperation } from '@eclipse-glsp/protocol';
import { OperationHandler, ModelState, type Command, type MaybePromise } from '@eclipse-glsp/server';
import { inject, injectable } from 'inversify';
import * as vscode from 'vscode';
import { readAuthoritativeSourceText } from './authoritative-source-text';
import { WORKFLOW_NETWORK_MODEL_KEY } from '@dialogram/shared';
import type { WorkflowDiagramModel } from '@dialogram/shared';
import { ReversibleWorkspaceEditCommand } from '@dialogram/diagram-server/operations/reversible-workspace-edit-command';
import { parseClipboardPayload } from '@dialogram/diagram-server/clipboard/clipboard';
import { SidecarInvoker } from './sidecar-invoker';
import { recreateItems } from './recreate-items';

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
        const fileBeforeWrite = await recreateItems(this.sidecar, sourceUri, workflowName, payload, taken);
        if (fileBeforeWrite === undefined) {
            return undefined;
        }
        (command as any)._fileBeforeWrite = fileBeforeWrite;
        const afterText = await readAuthoritativeSourceText(vscode.Uri.parse(sourceUri));
        (command as any)._sourceBeforeText = beforeText;
        (command as any)._sourceAfterText = afterText;
        return [new vscode.TextEdit(new vscode.Range(0, 0, 0, 0), '')];
    }

    private async sendSidecarList(sourceUri: string, payload: { op: string; args: Record<string, unknown> }): Promise<any | undefined> {
        return this.sidecar.sendSidecarList(sourceUri, payload);
    }
}
