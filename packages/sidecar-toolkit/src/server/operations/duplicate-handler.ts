import { Operation } from '@eclipse-glsp/protocol';
import { OperationHandler, ModelState, type Command, type MaybePromise } from '@eclipse-glsp/server';
import { inject, injectable } from 'inversify';
import * as vscode from 'vscode';
import { readAuthoritativeSourceText } from './authoritative-source-text';
import { WORKFLOW_NETWORK_MODEL_KEY } from '@dialogram/shared';
import type { WorkflowDiagramModel } from '@dialogram/shared';
import { ReversibleWorkspaceEditCommand } from '@dialogram/diagram-server/operations/reversible-workspace-edit-command';
import { buildClipboardPayload } from '@dialogram/diagram-server/clipboard/clipboard';
import { SidecarInvoker } from './sidecar-invoker';
import { recreateItems } from './recreate-items';

const WORKFLOW_DUPLICATE_OPERATION_KIND = 'dialogram.duplicate' as const;

interface DuplicateOperation extends Operation {
    kind: typeof WORKFLOW_DUPLICATE_OPERATION_KIND;
    elementIds: string[];
}

@injectable()
export class DuplicateOperationHandler extends OperationHandler {
    static readonly KIND = WORKFLOW_DUPLICATE_OPERATION_KIND;

    @inject(ModelState)
    protected override modelState!: ModelState;

    @inject(SidecarInvoker)
    protected readonly sidecar!: SidecarInvoker;

    override operationType = WORKFLOW_DUPLICATE_OPERATION_KIND;

    override createCommand(operation: DuplicateOperation): MaybePromise<Command | undefined> {
        const diagramModel = this.modelState.get(WORKFLOW_NETWORK_MODEL_KEY) as WorkflowDiagramModel | undefined;
        const sourceUri = this.modelState.sourceUri ?? diagramModel?.documentUri;
        if (!diagramModel || !sourceUri) {
            return undefined;
        }

        const vscodeUri = vscode.Uri.parse(sourceUri);

        const command = new ReversibleWorkspaceEditCommand({
            label: 'Duplicate',
            uri: vscodeUri,
            computeEdits: async () => {
                const beforeText = (await vscode.workspace.openTextDocument(vscodeUri)).getText();
                const payload = buildClipboardPayload(this.modelState, sourceUri, operation.elementIds ?? []);
                if (payload.items.length === 0) return undefined;
                const workflowName = this.modelState.root.args?.['wf:workflowName'] as string | undefined;
                const takenResp = await this.sendSidecarList(sourceUri, {
                    op: this.sidecar.sidecarOp('listInstanceNames'),
                    args: { workflow: workflowName }
                });
                const taken = new Set((takenResp?.diagnostic?.names as string[] | undefined) ?? []);
                const fileBeforeWrite = await recreateItems(this.sidecar, sourceUri, workflowName, payload, taken);
                if (fileBeforeWrite === undefined) {
                    return undefined;
                }
                (command as any)._fileBeforeWrite = fileBeforeWrite;
                const afterText = await readAuthoritativeSourceText(vscodeUri);
                (command as any)._sourceBeforeText = beforeText;
                (command as any)._sourceAfterText = afterText;
                return [new vscode.TextEdit(new vscode.Range(0, 0, 0, 0), '')];
            },
        });
        return command;
    }

    private async sendSidecarList(sourceUri: string, payload: { op: string; args: Record<string, unknown> }): Promise<any | undefined> {
        return this.sidecar.sendSidecarList(sourceUri, payload);
    }
}
