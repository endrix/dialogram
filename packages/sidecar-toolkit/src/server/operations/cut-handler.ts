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
import { SidecarSteps } from './sidecar-edit';
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
        // same, by the client, before it asked to cut. (A read-only element
        // is on neither clipboard: `buildClipboardPayload` leaves it out.)
        const root = this.modelState.root;
        const elementIds = (operation.editorContext?.selectedElementIds ?? [])
            .filter(id => mayRemove(root, this.modelState.index.get(id)));
        const payload = buildClipboardPayload(this.modelState, sourceUri, elementIds);
        if (payload.items.length === 0) {
            return undefined;
        }
        // The connections first: a node taken out takes the connections at
        // it with it, and one cut with its node would then be asked for
        // when it is already gone.
        const removing = [
            ...payload.items.filter(item => item.kind === 'connection'),
            ...payload.items.filter(item => item.kind !== 'connection')
        ];
        const vscodeUri = vscode.Uri.parse(sourceUri);
        const workflowName = root.args?.['wf:workflowName'] as string | undefined;

        const command = new ReversibleWorkspaceEditCommand({
            label: 'Cut' + this.sidecar.undoLabelSuffix(),
            uri: vscodeUri,
            computeEdits: async () => {
                const beforeText = (await vscode.workspace.openTextDocument(vscodeUri)).getText();
                await vscode.env.clipboard.writeText(JSON.stringify(clipboardDataFromPayload(payload)));
                const steps = await SidecarSteps.begin(this.sidecar, sourceUri);
                for (const item of removing) {
                    if (item.kind === 'entity') {
                        if (!await steps.send({
                            op: this.sidecar.sidecarOp('deleteNode'),
                            args: { workflow: workflowName, name: item.name }
                        }, `'${item.name}' was not cut.`)) {
                            return undefined;
                        }
                    } else if (item.kind === 'connection') {
                        if (!item.outPort || !item.inPort) continue;
                        const fromExpr = this.edgeEndpointExpr(item.from, item.outPort);
                        const toExpr = this.edgeEndpointExpr(item.to, item.inPort);
                        if (!await steps.send({
                            op: this.sidecar.sidecarOp('deleteEdge'),
                            args: { workflow: workflowName, from_expr: fromExpr, to_expr: toExpr }
                        }, `The connection ${fromExpr} → ${toExpr} was not cut.`)) {
                            return undefined;
                        }
                    } else if (item.kind === 'boundaryPort') {
                        if (!await steps.send({
                            op: this.sidecar.sidecarOp('deletePort'),
                            args: { workflow: workflowName, direction: item.direction, portName: item.portName }
                        }, `Port '${item.portName}' was not cut.`)) {
                            return undefined;
                        }
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

    private edgeEndpointExpr(entityName: string | undefined, portName: string): string {
        if (entityName && entityName !== 'boundary') {
            return `${entityName}.${portName}`;
        }
        return `'${escapePythonStringLiteral(portName)}'`;
    }
}
